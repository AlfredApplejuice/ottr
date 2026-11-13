import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ottr-vm-init is PID 1: it mounts kernel filesystems and ends with kill -TERM -1, so a
// test never runs the whole script (OTTR-517: no test signals processes it did not
// create). The cmdline guards sit between two stable comments and touch nothing but
// `die` and the four parsed values, so the test sources the shipped block verbatim and
// injects the values as argv. A restructure that removes the block fails the extraction
// assertion below instead of passing vacuously.

const init = readFileSync(join(import.meta.dir, "ottr-vm-init"), "utf8");
const start = init.indexOf("# The values land in /etc/hosts");
const end = init.indexOf("# The token never reaches the log.");
const guardBlock = start >= 0 && end > start ? init.slice(start, end) : "";

const root = mkdtempSync(join(tmpdir(), "ottr-vm-init-"));
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	for (const stale of ["/tmp/base", "/tmp/layer", "/tmp/scratch", "/tmp/root", "/tmp/target"])
		rmSync(stale, { recursive: true, force: true, maxRetries: 5 });
});

/** Runs the shipped guard block with the given cmdline values; `die` marks and stops. */
function runGuards(
	mode: string,
	token: string,
	board: string,
	boardhost: string,
): { exitCode: number; out: string } {
	const harness = [
		"die() {",
		'\techo "DIE: $*" >&2',
		"exit 1",
		"}",
		'mode="$1" token="$2" board="$3" boardhost="$4"',
		guardBlock,
		'echo "GUARDS-PASSED"',
	].join("\n");
	const r = Bun.spawnSync(["sh", "-c", harness, "sh", mode, token, board, boardhost], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: r.exitCode,
		out: `${r.stdout.toString()}${r.stderr.toString()}`,
	};
}

describe("ottr-vm-init cmdline guards", () => {
	test("the shipped guard block is present", () => {
		expect(guardBlock).toContain("ottr.mode must be run, bake or validate");
		expect(guardBlock).toContain("ottr.token");
		expect(guardBlock).toContain("ottr.board");
		expect(guardBlock).toContain("ottr.boardhost");
	});

	test("validate mode accepts the empty token, board and boardhost", () => {
		const r = runGuards("validate", "", "", "");
		expect(r.exitCode).toBe(0);
		expect(r.out).toContain("GUARDS-PASSED");
		expect(r.out).not.toContain("DIE:");
	});

	test("validate mode still refuses a non-hex token", () => {
		const r = runGuards("validate", "XYZ", "", "");
		expect(r.exitCode).toBe(1);
		expect(r.out).toContain("DIE:");
		expect(r.out).toContain("ottr.token");
	});

	test("validate mode still refuses a non-IPv4 board and a bad host name", () => {
		for (const [board, boardhost] of [
			["ottr", ""],
			["", "-x"],
		] as const) {
			const r = runGuards("validate", "", board, boardhost);
			expect(r.exitCode).toBe(1);
			expect(r.out).toContain("DIE:");
		}
	});

	test("run and bake modes still refuse an empty value", () => {
		for (const mode of ["run", "bake"]) {
			for (const [label, t, b, h] of [
				["ottr.token", "", "10.231.0.1", "ottr"],
				["ottr.board", "abc123", "", "ottr"],
				["ottr.boardhost", "abc123", "10.231.0.1", ""],
			] as const) {
				const r = runGuards(mode, t, b, h);
				expect(r.exitCode).toBe(1);
				expect(r.out).toContain("DIE:");
				expect(r.out).toContain(label);
			}
		}
	});

	test("run mode accepts plain values", () => {
		const r = runGuards("run", "abc123", "10.231.0.1", "ottr");
		expect(r.exitCode).toBe(0);
		expect(r.out).toContain("GUARDS-PASSED");
	});
});

describe("ottr-vm-init validate mount walk", () => {
	// The mount section sits between two stable markers and only touches the filesystem
	// under /tmp (the script's fixed m=/tmp) plus mount/umount, which the test shims:
	// the real mounts need a kernel the test must not drive. Everything else runs for
	// real, so the skeleton writes, the hosts files and the mount order are the shipped
	// script's own behavior.
	const start = init.indexOf("m=/tmp");
	const end = init.indexOf("# The kernel's ip= autoconfig");
	const mountBody = start >= 0 && end > start ? init.slice(start, end) : "";

	function walk(mode: string, board: string, boardhost: string) {
		// The script's m=/tmp is fixed, so a previous walk's dirs would trip its plain
		// mkdir; the real VM starts from a fresh tmpfs.
		for (const stale of ["base", "layer", "scratch", "root", "target"])
			rmSync(`/tmp/${stale}`, { recursive: true, force: true, maxRetries: 5 });
		rmSync(join(root, "mounts.log"), { force: true });
		const shim = join(root, "shim");
		mkdirSync(shim, { recursive: true });
		const log = join(root, "mounts.log");
		for (const tool of ["mount", "umount"]) {
			const body =
				tool === "mount"
					? // The stub stands in for the kernel building the merged tree: the base
						// rootfs's /etc must exist where an overlay would expose it. Only the
						// root mounts get it (the last argument), never the fresh tmpfs.
						'for last; do :; done\ncase "$last" in /tmp/root) mkdir -p /tmp/root/etc ;; esac\n'
					: "";
			writeFileSync(`${shim}/${tool}`, `#!/bin/sh\n${body}echo "${tool} $*" >> '${log}'\n`);
			chmodSync(`${shim}/${tool}`, 0o755);
		}
		const harness = [
			"power_off() { exit 1; }",
			'die() { echo "DIE: $*" >&2; exit 1; }',
			'mode="$1" token="" board="$2" boardhost="$3"',
			mountBody,
		].join("\n");
		const r = Bun.spawnSync(["sh", "-c", harness, "sh", mode, board, boardhost], {
			cwd: root,
			env: { PATH: `${shim}:${process.env.PATH ?? ""}` },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = `${r.stdout.toString()}${r.stderr.toString()}`;
		const mounts = readFileSync(log, "utf8");
		return { exitCode: r.exitCode, out, mounts };
	}

	test("the mount section is present", () => {
		expect(mountBody).toContain("m=/tmp");
		expect(mountBody).toContain("cannot mount the overlay root");
	});

	test("validate builds the skeleton in the setup overlay before the read-only root", () => {
		const w = walk("validate", "", "");
		expect(w.exitCode, w.out).toBe(0);
		expect(w.out).not.toContain("DIE:");
		const setup = w.mounts.indexOf("upperdir=/tmp/scratch/setup-upper");
		const unmounted = w.mounts.indexOf("umount /tmp/root");
		const final = w.mounts.indexOf(
			"lowerdir=/tmp/scratch/setup-upper:/tmp/base",
		);
		expect(setup).toBeGreaterThan(-1);
		expect(unmounted).toBeGreaterThan(setup);
		expect(final).toBeGreaterThan(unmounted);
		// The job's whole writable world is bound from the scratch; the target is bound
		// read-only from its own disk.
		for (const bind of [
			"mount --bind /tmp/target /tmp/root/target",
			"mount --bind /tmp/scratch/tmp /tmp/root/tmp",
			"mount --bind /tmp/scratch/home /tmp/root/home",
			"mount --bind /tmp/scratch/work /tmp/root/work",
			"mount --bind /tmp/scratch/job /tmp/root/job",
		])
			expect(w.mounts).toContain(bind);
		// The skeleton writes happened for real, at the paths the binds need.
		expect(readFileSync("/tmp/root/etc/hosts", "utf8")).toBe(
			"127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n",
		);
		expect(readFileSync("/tmp/root/etc/resolv.conf", "utf8")).toBe("");
		for (const dir of ["/tmp/target", "/tmp/root/target", "/tmp/root/work", "/tmp/root/job"])
			expect(() => statSync(dir)).not.toThrow();
	});

	test("run mode keeps its writable overlay and board hosts", () => {
		const w = walk("run", "10.231.0.1", "ottr");
		expect(w.exitCode, w.out).toBe(0);
		expect(w.out).not.toContain("DIE:");
		expect(w.mounts).toContain("upperdir=/tmp/scratch/upper,workdir=/tmp/scratch/work");
		expect(w.mounts).not.toContain("setup-upper");
		expect(readFileSync("/tmp/root/etc/hosts", "utf8")).toContain("10.231.0.1\tottr");
		expect(readFileSync("/tmp/root/etc/resolv.conf", "utf8")).toContain("nameserver");
	});
});

