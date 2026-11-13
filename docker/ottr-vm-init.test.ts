import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
