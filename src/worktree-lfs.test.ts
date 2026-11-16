import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	lfsPointerOids,
	pushBranch,
	pushLfsObjects,
	serverMergePush,
	setHostedGitAuth,
	setNetworkGitAuth,
} from "./worktree.ts";

/**
 * The LFS half of the server-side pushes (OTTR-1058). The board's git pins
 * core.hooksPath=/dev/null, so git-lfs's pre-push hook never runs and a merge that adds
 * an LFS file fails the remote's unknown-object rejection (GH008 on GitHub). These
 * fixtures run real git and real git-lfs against a local smart-HTTP git server whose
 * pre-receive hook rejects a push whose new commits reference an LFS object the local
 * LFS server has not stored — the GH008 check, faithfully.
 */

const id = ["-c", "user.name=t", "-c", "user.email=t@t"];

/** A fixture's own git spawn; the code under test goes through git(), never this.
 * Async on purpose: a sync spawn would block this process's event loop and starve the
 * in-process fixture server the spawned git talks to. */
const run = async (cwd: string, ...args: string[]): Promise<string> => {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
	return out.trim();
};

/** The oid of the LFS object a committed pointer file names. */
const pointerOid = async (repo: string, path: string): Promise<string> => {
	const pointer = await run(repo, "cat-file", "-p", `HEAD:${path}`);
	const oid = /oid sha256:([0-9a-f]{64})/.exec(pointer)?.[1];
	if (oid === undefined) throw new Error(`no LFS oid in ${path}: ${pointer}`);
	return oid;
};

/**
 * A local server that answers the git smart-HTTP protocol (clone and push, with hooks)
 * and the Git LFS batch/PUT protocol on one port. Every uploaded object's oid lands in
 * `storeFile` (what the pre-receive hook reads) and its bytes in `dir/lfs-store/`.
 * `batchStatus` lets a test break the LFS upload: a failing batch endpoint answers the
 * error immediately, where a failing upload would run git-lfs's retry backoff.
 */
function serveGitLfs(
	dir: string,
	bare: string,
	batchStatus = 200,
): { url: string; storeFile: string; close: () => void } {
	const storeFile = join(dir, "lfs-store.txt");
	writeFileSync(storeFile, "");
	const storeDir = join(dir, "lfs-store");
	mkdirSync(storeDir);
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const p = url.pathname;
			if (req.method === "GET" && p.endsWith("/info/refs")) {
				const svc = url.searchParams.get("service") ?? "git-upload-pack";
				const bin = svc === "git-receive-pack" ? "receive-pack" : "upload-pack";
				const adv = spawnSync(
					["git", bin, "--stateless-rpc", "--advertise-refs", bare].join(" "),
					{ shell: true, encoding: "buffer" },
				);
				const head = `# service=${svc}\n`;
				const headPkt = Buffer.from(
					(head.length + 4).toString(16).padStart(4, "0") + head,
				);
				const body = Buffer.concat([headPkt, Buffer.from("0000"), adv.stdout]);
				return new Response(body, {
					headers: { "Content-Type": `application/x-${svc}-advertisement` },
				});
			}
			const svc = p.endsWith("/git-upload-pack")
				? "upload-pack"
				: p.endsWith("/git-receive-pack")
					? "receive-pack"
					: null;
			if (req.method === "POST" && svc !== null) {
				const buf = Buffer.from(await req.arrayBuffer());
				const body =
					buf[0] === 0x1f && buf[1] === 0x8b ? Bun.gunzipSync(buf) : buf;
				const proc = Bun.spawn(["git", svc, "--stateless-rpc", bare], {
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				});
				proc.stdin.write(body);
				proc.stdin.end();
				const out = await new Response(proc.stdout).arrayBuffer();
				await proc.exited;
				return new Response(out, {
					headers: { "Content-Type": `application/x-git-${svc}-result` },
				});
			}
			if (req.method === "POST" && p.endsWith("/info/lfs/objects/batch")) {
				if (batchStatus !== 200)
					return new Response("broken", { status: batchStatus });
				const { objects } = (await req.json()) as {
					objects: { oid: string; size: number }[];
				};
				const out: {
					transfer: string;
					objects: {
						oid: string;
						size: number;
						actions?: { upload: { href: string } };
					}[];
				} = {
					transfer: "basic",
					objects: objects.map((o) =>
						existsSync(join(storeDir, o.oid))
							? { oid: o.oid, size: o.size }
							: {
									oid: o.oid,
									size: o.size,
									actions: {
										upload: {
											href: `http://127.0.0.1:${server.port}/storage/${o.oid}`,
										},
									},
								},
					),
				};
				return new Response(JSON.stringify(out), {
					headers: { "Content-Type": "application/vnd.git-lfs+json" },
				});
			}
			if (req.method === "PUT" && p.startsWith("/storage/")) {
				const oid = p.slice("/storage/".length);
				const bytes = Buffer.from(await req.arrayBuffer());
				writeFileSync(join(storeDir, oid), bytes);
				appendFileSync(
					join(dir, "hook.log"),
					`stored ${oid} ${bytes.length}\n`,
				);
				appendFileSync(storeFile, `${oid}\n`);
				return new Response(null, { status: 200 });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/origin.git`,
		storeFile,
		close: () => server.stop(true),
	};
}

/** The bare origin's GH008: a pre-receive hook that rejects pushed commits referencing an LFS object the LFS server has not stored. */
function writeLfsPreReceive(bare: string, storeFile: string): void {
	writeFileSync(
		join(bare, "hooks", "pre-receive"),
		`#!/bin/sh
while read old new ref; do
	[ "$new" = "0000000000000000000000000000000000000000" ] && continue
	for obj in $(git rev-list --objects "$new" --not --all 2>/dev/null | cut -d' ' -f1); do
		[ "$(git cat-file -t "$obj" 2>/dev/null)" = "blob" ] || continue
		[ "$(git cat-file -p "$obj" | head -c 43)" = "version https://git-lfs.github.com/spec/v1" ] || continue
		oid=$(git cat-file -p "$obj" | sed -n 's/^oid sha256://p')
		grep -qx "$oid" "${storeFile}" || {
			echo "GH008: unknown Git LFS object $oid" >&2
			exit 1
		}
	done
done
exit 0
`,
	);
	chmodSync(join(bare, "hooks", "pre-receive"), 0o755);
}

/** An LFS sprite committed on the worktree branch and merged into local main. */
async function commitSprite(main: string, wt: string): Promise<string> {
	await run(wt, "lfs", "track", "*.png");
	const props = join(wt, "assets", "art", "props", "tree_oak");
	mkdirSync(props, { recursive: true });
	writeFileSync(join(props, "oak.png"), "sprite-bytes-for-the-fixture");
	await run(wt, "add", "assets/art/props/tree_oak/oak.png", ".gitattributes");
	await run(wt, ...id, "commit", "-q", "-m", "sprites");
	await run(main, "merge", "-q", "--ff-only", "ott/x");
	return await pointerOid(main, "assets/art/props/tree_oak/oak.png");
}

/** A clone of a smart-HTTP origin whose local main holds the worktree branch's LFS sprite commit. */
async function fixture(
	o: { lfs?: boolean; batchStatus?: number } = {},
): Promise<{
	dir: string;
	bare: string;
	main: string;
	wt: string;
	url: string;
	storeFile: string;
	/** The sprite pointer's LFS oid; "" when the fixture has no LFS file. */
	oid: string;
	close: () => void;
}> {
	const dir = mkdtempSync(join(tmpdir(), "ottr-lfs-"));
	const bare = join(dir, "origin.git");
	await run(dir, "init", "-q", "--bare", "-b", "main", bare);
	const git = serveGitLfs(dir, bare, o.batchStatus);
	writeLfsPreReceive(bare, git.storeFile);
	const main = join(dir, "main");
	await run(dir, "-c", "init.defaultBranch=main", "clone", "-q", git.url, main);
	await run(main, ...id, "commit", "-q", "--allow-empty", "-m", "base");
	await run(main, "push", "-q", "origin", "main");
	const wt = join(dir, "wt");
	await run(main, "worktree", "add", "-q", "-b", "ott/x", wt);
	if (o.lfs !== false) {
		await commitSprite(main, wt);
	} else {
		// A plain commit, so the merge push has something to push.
		writeFileSync(join(wt, "notes.txt"), "plain text\n");
		await run(wt, "add", "notes.txt");
		await run(wt, ...id, "commit", "-q", "-m", "notes");
		await run(main, "merge", "-q", "--ff-only", "ott/x");
	}
	return {
		dir,
		bare,
		main,
		wt,
		url: git.url,
		storeFile: git.storeFile,
		oid:
			o.lfs !== false
				? await pointerOid(main, "assets/art/props/tree_oak/oak.png")
				: "",
		close: git.close,
	};
}

/**
 * The plain git() state the other push fixtures assume: no app resolver, no hosted
 * auth. Importing a test file that booted the app (its resolver pins transports to
 * https/ssh/file) would otherwise block this file's http:// fixture origins.
 */
beforeAll(() => {
	setNetworkGitAuth(() => ({}));
	setHostedGitAuth(null);
});
afterAll(() => {
	setNetworkGitAuth(() => ({}));
	setHostedGitAuth(null);
});

const cleanup = (dir: string, close: () => void): void => {
	close();
	rmSync(dir, { recursive: true, force: true });
};

describe("serverMergePush with Git LFS", () => {
	test("uploads the LFS objects of the pushed range before the push (GH008)", async () => {
		const f = await fixture({ lfs: true });
		try {
			const local = await run(f.main, "rev-parse", "refs/heads/main");
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.url,
			);
			expect(r.status).toBe("pushed");
			// The object reached the LFS server before the pre-receive check ran.
			const stored = readFileSync(f.storeFile, "utf8").trim().split("\n");
			expect(stored).toContain(f.oid);
			const bytes = readFileSync(join(f.dir, "lfs-store", f.oid));
			expect(bytes.toString()).toBe("sprite-bytes-for-the-fixture");
			expect(await run(f.bare, "rev-parse", "main")).toBe(local);
		} finally {
			cleanup(f.dir, f.close);
		}
	});

	test("a broken LFS upload stops the push and surfaces the git-lfs error", async () => {
		// The batch endpoint answers an error: git-lfs retries a failing upload with
		// backoff, so the batch is the fast way to break the upload.
		const f = await fixture({ lfs: true, batchStatus: 500 });
		try {
			const before = await run(f.bare, "rev-parse", "main");
			const r = await serverMergePush(
				f.main,
				f.wt,
				"origin/main",
				"ott/x",
				null,
				f.url,
			);
			if (r.status !== "failed")
				throw new Error(`expected failed, got ${r.status}`);
			// git-lfs's own error, not a generic git message.
			expect(r.error).toMatch(/batch response:|proper access/);
			expect(await run(f.bare, "rev-parse", "main")).toBe(before);
		} finally {
			cleanup(f.dir, f.close);
		}
	});

	test("a planted lfs.url cannot move the upload off the pinned origin", async () => {
		const f = await fixture({ lfs: true });
		try {
			let hijackAttempts = 0;
			const hostile = Bun.serve({
				port: 0,
				fetch: () => {
					hijackAttempts++;
					return new Response("{}", { status: 200 });
				},
			});
			try {
				await run(
					f.main,
					"config",
					"lfs.url",
					`http://127.0.0.1:${hostile.port}/hijack`,
				);
				const r = await serverMergePush(
					f.main,
					f.wt,
					"origin/main",
					"ott/x",
					null,
					f.url,
				);
				expect(r.status).toBe("pushed");
				expect(readFileSync(f.storeFile, "utf8")).toContain(f.oid);
				expect(hijackAttempts).toBe(0);
			} finally {
				hostile.stop(true);
			}
		} finally {
			cleanup(f.dir, f.close);
		}
	});
});

describe("pushBranch with Git LFS", () => {
	test("uploads the LFS objects of the pushed range before the push (PR mode)", async () => {
		const f = await fixture({ lfs: true });
		try {
			const r = await pushBranch(f.main, "main", f.url);
			expect(r.status).toBe("pushed");
			expect(readFileSync(f.storeFile, "utf8")).toContain(f.oid);
		} finally {
			cleanup(f.dir, f.close);
		}
	});
});

describe("no LFS, no git-lfs command", () => {
	test("a repo without LFS runs no git lfs command", async () => {
		const f = await fixture({ lfs: false });
		const shim = join(f.dir, "shim");
		mkdirSync(shim);
		const marker = join(f.dir, "lfs-invocations.log");
		writeFileSync(
			join(shim, "git-lfs"),
			`#!/bin/sh
echo "git-lfs $*" >> "${marker}"
exit 1
`,
		);
		chmodSync(join(shim, "git-lfs"), 0o755);
		const path = process.env.PATH;
		process.env.PATH = `${shim}:${path}`;
		try {
			const local = await run(f.main, "rev-parse", "refs/heads/main");
			expect(
				(
					await serverMergePush(
						f.main,
						f.wt,
						"origin/main",
						"ott/x",
						null,
						f.url,
					)
				).status,
			).toBe("pushed");
			expect(
				await pushBranch(f.main, "main", f.url).then((r) => r.status),
			).toBe("pushed");
			expect(existsSync(marker)).toBe(false);
			expect(await run(f.bare, "rev-parse", "main")).toBe(local);
		} finally {
			process.env.PATH = path;
			cleanup(f.dir, f.close);
		}
	});
});

describe("a file:// pinned origin stores LFS objects in the bare repo", () => {
	test("uploads via the standalone file transfer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-lfs-file-"));
		const bare = join(dir, "origin.git");
		await run(dir, "init", "-q", "--bare", "-b", "main", bare);
		const main = join(dir, "main");
		await run(dir, "-c", "init.defaultBranch=main", "clone", "-q", bare, main);
		await run(main, ...id, "commit", "-q", "--allow-empty", "-m", "base");
		await run(main, "push", "-q", "origin", "main");
		const wt = join(dir, "wt");
		await run(main, "worktree", "add", "-q", "-b", "ott/x", wt);
		const lfsOid = await commitSprite(main, wt);
		try {
			const r = await serverMergePush(
				main,
				wt,
				"origin/main",
				"ott/x",
				null,
				bare,
			);
			expect(r.status).toBe("pushed");
			const shard = join(
				bare,
				"lfs",
				"objects",
				lfsOid.slice(0, 2),
				lfsOid.slice(2, 4),
				lfsOid,
			);
			expect(readFileSync(shard).toString()).toBe(
				"sprite-bytes-for-the-fixture",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("lfsPointerOids", () => {
	/** A repo whose main goes base < steps, each step a commit. */
	const repoWith = async (
		steps: ("add" | "delete" | "text" | "big")[],
	): Promise<{ dir: string; repo: string; base: string; tip: string }> => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-lfs-scan-"));
		const repo = join(dir, "repo");
		await run(dir, "init", "-q", "-b", "main", repo);
		await run(repo, ...id, "commit", "-q", "--allow-empty", "-m", "base");
		const base = await run(repo, "rev-parse", "HEAD");
		for (const step of steps) {
			if (step === "add") {
				await run(repo, "lfs", "track", "*.png");
				writeFileSync(join(repo, "oak.png"), "scan-bytes");
				await run(repo, "add", "oak.png", ".gitattributes");
			} else if (step === "text") {
				// A text file that starts like a pointer but names no oid.
				writeFileSync(
					join(repo, "readme.md"),
					"version https://git-lfs.github.com/spec/v1\nbut no oid line\n",
				);
				await run(repo, "add", "readme.md");
			} else if (step === "big") {
				// A plain blob over the pointer size cap that looks like a pointer: the
				// size gate must keep it out of the content pass, so its fake oid never
				// surfaces.
				const fakeOid = "a".repeat(64);
				writeFileSync(
					join(repo, "large.log"),
					`version https://git-lfs.github.com/spec/v1\noid sha256:${fakeOid}\nsize 1\n${"x".repeat(4096)}\n`,
				);
				await run(repo, "add", "large.log");
			} else {
				await run(repo, "rm", "-q", "oak.png");
			}
			await run(repo, ...id, "commit", "-q", "-m", step);
		}
		return { dir, repo, base, tip: await run(repo, "rev-parse", "HEAD") };
	};

	test("finds pointer oids in the pushed range, including one added and deleted mid-range", async () => {
		const r = await repoWith(["add", "delete"]);
		try {
			expect(await lfsPointerOids(r.repo, r.tip, r.base)).toHaveLength(1);
		} finally {
			rmSync(r.dir, { recursive: true, force: true });
		}
	});

	test("finds no oid without LFS, and a pointer-like text file is no pointer", async () => {
		const r = await repoWith(["text"]);
		try {
			expect(await lfsPointerOids(r.repo, r.tip, r.base)).toEqual([]);
		} finally {
			rmSync(r.dir, { recursive: true, force: true });
		}
	});

	test("a blob over the pointer size cap never enters the content pass", async () => {
		// The big blob carries a syntactically valid pointer: only the size gate keeps
		// its fake oid out. This is the unbounded-memory fix made observable (send-back
		// on OTTR-1058): the content pass reads nothing over LFS_POINTER_MAX_BYTES.
		const r = await repoWith(["big"]);
		try {
			expect(await lfsPointerOids(r.repo, r.tip, r.base)).toEqual([]);
		} finally {
			rmSync(r.dir, { recursive: true, force: true });
		}
	});

	test("the size gate does not lose a real pointer next to a big blob, with base null too", async () => {
		const r = await repoWith(["big", "add"]);
		try {
			const oids = await lfsPointerOids(r.repo, r.tip, null);
			expect(oids).toHaveLength(1);
			// The fake oid of the oversized pointer-lookalike must not appear.
			expect(oids[0]).not.toMatch(/^a+$/);
		} finally {
			rmSync(r.dir, { recursive: true, force: true });
		}
	});
});

describe("pushLfsObjects origin schemes", () => {
	/** A repo whose main adds one LFS pointer on top of base. */
	const repoWithPointer = async (): Promise<{
		dir: string;
		repo: string;
		base: string;
		tip: string;
	}> => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-lfs-scheme-"));
		const repo = join(dir, "repo");
		await run(dir, "init", "-q", "-b", "main", repo);
		await run(repo, ...id, "commit", "-q", "--allow-empty", "-m", "base");
		const base = await run(repo, "rev-parse", "HEAD");
		await run(repo, "lfs", "track", "*.png");
		writeFileSync(join(repo, "oak.png"), "scheme-bytes");
		await run(repo, "add", "oak.png", ".gitattributes");
		await run(repo, ...id, "commit", "-q", "-m", "sprites");
		return { dir, repo, base, tip: await run(repo, "rev-parse", "HEAD") };
	};

	test("no git lfs command runs for an ssh origin: the upload cannot be pinned there", async () => {
		// Security review on OTTR-1058: for a non-http(s) origin no command-line pin
		// exists, so a planted lfs.url or .lfsconfig would move the endpoint to a
		// hostile server whose batch response can name a planted custom transfer
		// adapter. The LFS step must not run at all; the push keeps the pre-1058
		// behavior (the remote's unknown-object rejection lands on the card).
		const r = await repoWithPointer();
		const shim = join(r.dir, "shim");
		mkdirSync(shim);
		const marker = join(r.dir, "lfs-invocations.log");
		writeFileSync(
			join(shim, "git-lfs"),
			`#!/bin/sh
echo "git-lfs $*" >> "${marker}"
exit 1
`,
		);
		chmodSync(join(shim, "git-lfs"), 0o755);
		const path = process.env.PATH;
		process.env.PATH = `${shim}:${path}`;
		try {
			expect(
				await pushLfsObjects(
					r.repo,
					"ssh://git@github.com/octo/repo",
					"main",
					r.tip,
					r.base,
				),
			).toBeNull();
			expect(existsSync(marker)).toBe(false);
		} finally {
			process.env.PATH = path;
			rmSync(r.dir, { recursive: true, force: true });
		}
	});
});
