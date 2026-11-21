import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { handleGit, parseLfsBatch } from "./gitHttp.ts";
import fc from "./test/properties.ts";
import { VmTokens } from "./vmTokens.ts";
import { gitExe, setNetworkGitAuth } from "./worktree.ts";

/**
 * The LFS half of the board's git endpoint (OTTR-1152). A VM-mode clone of the card branch
 * must fetch real LFS object content through the board, and a token must only ever reach
 * its own project's objects. The fixture upstream is a two-route Git LFS server (batch and
 * storage) on 127.0.0.1 that enforces the board's credential on the batch call, so a clone
 * only passes when the board signed it. The default pinned origin is a bare URL, so the
 * clone exercises the production classic-board credential path (`git credential fill` with
 * the network-git resolver env); a second clone pins the userinfo form, the hosted/pinned
 * URL shape. The fixture repo carries a hand-written pointer, so building it needs no LFS
 * store — only the clone's smudge needs git-lfs.
 */

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs)
		rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
function dir(): string {
	const d = mkdtempSync(join(tmpdir(), "ottr-githttp-lfs-"));
	dirs.push(d);
	return d;
}

/**
 * Fixture git, async: the endpoint under test runs in this process, so a sync spawn would
 * block the server it talks to. Throwaway identity, no prompts, no global config.
 */
async function run(
	cwd: string,
	...args: string[]
): Promise<{ code: number; out: string; err: string }> {
	const p = Bun.spawn(
		[
			gitExe(),
			"-c",
			"user.name=ott",
			"-c",
			"user.email=ott@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"protocol.version=2",
			...args,
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH ?? "",
				GIT_CONFIG_GLOBAL: "/dev/null",
				HOME: tmpdir(),
				GIT_TERMINAL_PROMPT: "0",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	return { code: await p.exited, out: out.trim(), err };
}
async function must(cwd: string, ...args: string[]): Promise<string> {
	const r = await run(cwd, ...args);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
	return r.out;
}

/** The one object the fixture upstream serves: 64 random bytes, oid = their sha256. */
const LFS_CONTENT = randomBytes(64);
const LFS_OID = createHash("sha256").update(LFS_CONTENT).digest("hex");
const pointerText = () =>
	`version https://git-lfs.github.com/spec/v1\noid sha256:${LFS_OID}\nsize 64\n`;

const BRANCH = "ott/alp-1-x";
/** Fixture-only oids that drill the storage route's belt (never real objects). */
const POISON_OID = "a".repeat(64);
const REDIRECT_OID = "b".repeat(64);
/** The one credential the fixture upstream accepts on a batch call: the board's own. */
const LFS_USER = "ott";
const LFS_TOKEN = "lfs-fixture-token";
const expectedUpstreamAuth = `Basic ${btoa(`${LFS_USER}:${LFS_TOKEN}`)}`;
const tokens = new VmTokens({ file: null });
const logs: string[] = [];
let board: Server<undefined>;
let upstream: Server<undefined>;
let upstreamBase = "";
/** Repointable per test; the board's fetch reads the current binding per request. */
let originUrl: (project: string) => Promise<string | null> = async () =>
	upstreamBase;
/** Every batch the fixture upstream has seen, in order. */
const upstreamBatches: { operation: unknown; oids: unknown[] }[] = [];
/** Every oid the fixture upstream has served from /storage. */
const storageGets: string[] = [];
/** Upstream batch calls that arrived with a missing or wrong board credential. */
const upstreamAuthRejections: string[] = [];

/** The hrefs the fixture upstream hands out per oid. Built per request, so it reads the
 * servers' current ports. POISON_OID drills the belt: its href names a bracketed
 * IPv4-mapped loopback literal (the bypass form the security review found), which the
 * belt must refuse before the board fetches anything. REDIRECT_OID drills redirect
 * handling: its storage hop answers 302 with a Location on the board's own loopback. */
const fixtureHrefs = (): Record<string, string> => ({
	[LFS_OID]: `${upstreamBase}/storage/${LFS_OID}`,
	[POISON_OID]: `http://[::ffff:127.0.0.1]:${upstream.port}/storage/${POISON_OID}`,
	[REDIRECT_OID]: `${upstreamBase}/storage/${REDIRECT_OID}`,
});

let main = "";
let worktree = "";
let token = "";
let betaToken = "";

beforeAll(async () => {
	upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (
				req.method === "POST" &&
				url.pathname.endsWith("/info/lfs/objects/batch")
			) {
				// The board signs the batch with its own credential. A missing or wrong
				// header must fail loudly, not pass silently: record it and refuse.
				if (req.headers.get("authorization") !== expectedUpstreamAuth) {
					upstreamAuthRejections.push(`batch ${url.pathname}`);
					return new Response("unauthorized", { status: 401 });
				}
				const body = (await req.json()) as {
					operation?: unknown;
					objects?: { oid?: unknown }[];
				};
				upstreamBatches.push({
					operation: body.operation,
					oids: Array.isArray(body.objects)
						? body.objects.map((o) => o?.oid)
						: [],
				});
				const hrefs = fixtureHrefs();
				const objects = (
					Array.isArray(body.objects) ? body.objects : []
				).flatMap((o) =>
					typeof o?.oid === "string" && o.oid in hrefs
						? [
								{
									oid: o.oid,
									size: LFS_CONTENT.length,
									actions: { download: { href: hrefs[o.oid] } },
								},
							]
						: [],
				);
				if (objects.length === 0)
					return new Response("not found", { status: 404 });
				return new Response(JSON.stringify({ transfer: "basic", objects }), {
					headers: { "content-type": "application/vnd.git-lfs+json" },
				});
			}
			if (req.method === "GET" && url.pathname.startsWith("/storage/")) {
				const oid = url.pathname.slice("/storage/".length);
				storageGets.push(oid);
				// The redirect drill: this hop hands the board a Location the belt must refuse.
				if (oid === REDIRECT_OID)
					return new Response(null, {
						status: 302,
						headers: { location: `http://127.0.0.1:${board.port}/api/boot` },
					});
				if (oid !== LFS_OID) return new Response("not found", { status: 404 });
				return new Response(LFS_CONTENT, {
					headers: {
						"content-type": "application/octet-stream",
						"content-length": String(LFS_CONTENT.length),
					},
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	// The default pinned origin is a bare URL, so the board takes the production
	// classic-board credential path: `git credential fill` run with the network-git
	// resolver env. The resolver below is the same env shape production installs
	// (GIT_CONFIG credential helper reading its token from env), scoped to this
	// fixture's exact host:port. Restored in afterAll.
	upstreamBase = `http://localhost:${upstream.port}`;
	setNetworkGitAuth(() => ({
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "",
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "credential.helper",
		GIT_CONFIG_VALUE_0: "",
		GIT_CONFIG_KEY_1: `credential.http://localhost:${upstream.port}.helper`,
		GIT_CONFIG_VALUE_1: `!f() { test "$1" = get || exit 0; printf 'username=%s\\npassword=%s\\n' "$OTTR_LFS_TEST_USER" "$OTTR_LFS_TEST_TOKEN"; }; f`,
		OTTR_LFS_TEST_USER: LFS_USER,
		OTTR_LFS_TEST_TOKEN: LFS_TOKEN,
	}));

	board = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) =>
			handleGit(req, { tokens, log: (l) => logs.push(l), originUrl }),
	});

	const root = dir();
	main = join(root, "alpha");
	await must(root, "init", "-q", "-b", "main", main);
	writeFileSync(join(main, "a.txt"), "one\n");
	await must(main, "add", ".");
	await must(main, "commit", "-q", "-m", "init");
	// The card branch's worktree carries the LFS file. The pointer is committed by hand
	// next to .gitattributes, so no LFS store is needed to build the repo; the clone's
	// smudge must turn the pointer back into the bytes through the board.
	worktree = join(main, ".worktrees", "ALP-1");
	await must(main, "worktree", "add", "-q", "-b", BRANCH, worktree);
	mkdirSync(join(worktree, "assets"), { recursive: true });
	writeFileSync(join(worktree, "assets", "blob.bin"), pointerText());
	writeFileSync(
		join(worktree, ".gitattributes"),
		"assets/*.bin filter=lfs diff=lfs merge=lfs -text\n",
	);
	await must(worktree, "add", ".");
	await must(worktree, "commit", "-q", "-m", "track the sprite");
	// Whatever the clean filter did, the stored blob must be the pointer text.
	expect(await must(worktree, "cat-file", "-p", "HEAD:assets/blob.bin")).toBe(
		pointerText().trim(),
	);
	token = tokens.issue({
		project: "alpha",
		taskId: "ALP-1",
		branch: BRANCH,
		repoPath: main,
		worktree,
	});
	// A second project's token: its own dirs, so only the project name differs.
	const betaRoot = join(root, "beta");
	const betaWorktree = join(betaRoot, ".worktrees", "BET-1");
	mkdirSync(betaWorktree, { recursive: true });
	betaToken = tokens.issue({
		project: "beta",
		taskId: "BET-1",
		branch: "ott/bet-1-x",
		repoPath: betaRoot,
		worktree: betaWorktree,
	});
}, 60_000);
afterAll(() => {
	board?.stop(true);
	upstream?.stop(true);
	// Back to the module default: no resolver env for later test files in this process.
	setNetworkGitAuth(() => ({}));
});

const url = () => `http://127.0.0.1:${board.port}/git/alpha.git`;
const auth = (t: string) => [
	"-c",
	`http.extraHeader=Authorization: Bearer ${t}`,
];

/** The LFS batch endpoint exactly as git-lfs calls it: LFS media types, Bearer token. */
const batch = (t: string, body: unknown): Promise<Response> =>
	fetch(`${url()}/info/lfs/objects/batch`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${t}`,
			"content-type": "application/vnd.git-lfs+json",
			accept: "application/vnd.git-lfs+json",
		},
		body: JSON.stringify(body),
	});

// The clone's smudge runs real git-lfs, like the worker image pins. Without the binary
// the clone cannot produce LFS content, so that one test steps aside; the other tests
// never run git.
const hasGitLfs = Bun.which("git-lfs") !== null;

describe("handleGit LFS proxy", () => {
	test.skipIf(!hasGitLfs)(
		"a VM clone gets the real LFS content through the board's credential fill",
		async () => {
			const clone = join(dir(), "vm");
			await must(
				dir(),
				...auth(token),
				"clone",
				"-q",
				"--branch",
				BRANCH,
				"--no-single-branch",
				"--",
				url(),
				clone,
			);
			const got = readFileSync(join(clone, "assets", "blob.bin"));
			expect(got.equals(LFS_CONTENT)).toBe(true);
			expect(got.toString()).not.toContain("oid sha256:");
			// The bytes came from upstream through the board: the batch named the oid and
			// the storage endpoint served it, both under the credential fill produced.
			expect(
				upstreamBatches.some(
					(b) => b.operation === "download" && b.oids.includes(LFS_OID),
				),
			).toBe(true);
			expect(storageGets).toContain(LFS_OID);
			// The fixture enforces the board's credential: nothing was refused.
			expect(upstreamAuthRejections).toEqual([]);
		},
		60_000,
	);

	test.skipIf(!hasGitLfs)(
		"an userinfo pinned origin signs the batch with the URL credential",
		async () => {
			const saved = originUrl;
			originUrl = async () =>
				`http://${LFS_USER}:${LFS_TOKEN}@localhost:${upstream.port}`;
			try {
				const before = upstreamBatches.length;
				const clone = join(dir(), "vm-userinfo");
				await must(
					dir(),
					...auth(token),
					"clone",
					"-q",
					"--branch",
					BRANCH,
					"--no-single-branch",
					"--",
					url(),
					clone,
				);
				expect(
					readFileSync(join(clone, "assets", "blob.bin")).equals(LFS_CONTENT),
				).toBe(true);
				expect(upstreamBatches.length).toBeGreaterThan(before);
				expect(upstreamAuthRejections).toEqual([]);
			} finally {
				originUrl = saved;
			}
		},
		60_000,
	);

	test("a poisoned href on a bracketed IPv4-mapped loopback literal is refused", async () => {
		// The review's bypass: URL.hostname keeps the brackets, so an unnormalized
		// comparison never matches the reserved ranges. The board must refuse before it
		// fetches anything.
		const res = await fetch(`${url()}/info/lfs/objects/${POISON_OID}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(502);
		expect(await res.text()).toContain("reserved");
		// Refused before the fetch: the fixture never served the bytes.
		expect(storageGets).not.toContain(POISON_OID);
		expect(upstreamAuthRejections).toEqual([]);
	});

	test("a redirect hop to a literal loopback address is refused", async () => {
		// The review's bypass: redirect-following skipped the belt entirely, so a 302 from
		// an allowed host could hand the board's own loopback body to the VM.
		const res = await fetch(`${url()}/info/lfs/objects/${REDIRECT_OID}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(502);
		expect(await res.text()).toContain("reserved");
		expect(upstreamAuthRejections).toEqual([]);
	});

	test("a token of another project cannot read this project's LFS objects", async () => {
		const before = upstreamBatches.length;
		const res = await batch(betaToken, {
			operation: "download",
			objects: [{ oid: LFS_OID }],
		});
		expect(res.status).toBe(403);
		// Refused before any upstream contact: the fixture upstream saw nothing new.
		expect(upstreamBatches.length).toBe(before);
	});

	test("an upload batch is refused", async () => {
		const before = upstreamBatches.length;
		const res = await batch(token, {
			operation: "upload",
			objects: [{ oid: LFS_OID }],
		});
		expect(res.status).toBe(403);
		// The server push uploads LFS objects (OTTR-1058); this endpoint serves reads.
		expect(await res.text()).toContain("downloads only");
		expect(upstreamBatches.length).toBe(before);
	});

	test("a non-http origin names LFS in the error", async () => {
		const saved = originUrl;
		originUrl = async () => "ssh://git@github.com/octo/repo.git";
		try {
			const before = upstreamBatches.length;
			const res = await batch(token, {
				operation: "download",
				objects: [{ oid: LFS_OID }],
			});
			expect(res.status).toBe(502);
			const text = await res.text();
			expect(text).toContain("LFS");
			expect(text).toContain("ssh");
			expect(upstreamBatches.length).toBe(before);
		} finally {
			originUrl = saved;
		}
	});
});

describe("parseLfsBatch", () => {
	/** The return type the frozen contract gives parseLfsBatch. */
	type ParsedBatch =
		| { operation: "download"; objects: { oid: string; size?: number }[] }
		| { error: string };

	/** The contract: download plus vetted objects, or a non-empty error. Nothing else. */
	const check = (r: ParsedBatch): void => {
		if ("error" in r) {
			expect(r.error.length).toBeGreaterThan(0);
			return;
		}
		expect(r.operation).toBe("download");
		for (const o of r.objects) {
			expect(o.oid).toMatch(/^[0-9a-f]{64}$/);
			if (o.size !== undefined) {
				expect(typeof o.size).toBe("number");
				expect(o.size).toBeGreaterThanOrEqual(0);
			}
		}
	};
	const prop = fc.property(fc.jsonValue(), (v) => {
		let r: ParsedBatch;
		try {
			r = parseLfsBatch(v);
		} catch (err) {
			throw new Error(
				`parseLfsBatch threw on ${JSON.stringify(v)}: ${String(err)}`,
			);
		}
		check(r);
	});

	// Gate: 100 runs, fixed seed, so the mutation runs see the same inputs.
	test("arbitrary JSON never throws and only ever answers download or an error", () => {
		fc.assert(prop, { seed: 20261120, numRuns: 100 });
	});

	// Batch-shaped junk: hex64 or garbage oids, sane or hostile sizes, missing keys.
	const objectArb = fc.oneof(
		fc.record(
			{
				oid: fc.oneof(
					fc.stringMatching(/^[0-9a-f]{64}$/),
					fc.string(),
					fc.constant(42),
				),
				size: fc.oneof(
					fc.nat(),
					fc.constant(-1),
					fc.constant("5"),
					fc.constant(1.5),
				),
			},
			{ requiredKeys: [] },
		),
		fc.string(),
		fc.constant(null),
	);
	const batchArb = fc.record(
		{
			operation: fc.oneof(
				fc.constant("download"),
				fc.constant("upload"),
				fc.string(),
				fc.constant(undefined),
			),
			objects: fc.oneof(
				fc.array(objectArb, { maxLength: 4 }),
				fc.string(),
				fc.constant(null),
				fc.constant(undefined),
			),
		},
		{ requiredKeys: [] },
	);

	test("batch-shaped junk never throws and answers download or an error", () => {
		const junkProp = fc.property(batchArb, (v) => {
			let r: ParsedBatch;
			try {
				r = parseLfsBatch(v);
			} catch (err) {
				throw new Error(
					`parseLfsBatch threw on ${JSON.stringify(v)}: ${String(err)}`,
				);
			}
			check(r);
		});
		fc.assert(junkProp, { seed: 20261120, numRuns: 100 });
	});
});
