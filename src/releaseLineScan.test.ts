// Tests for the bun.lock release line scan's data side (OTTR-972): the lock
// parser on the repo's real bun.lock, the changed-set logic, the scan core
// with an injected fetch (no network, no env), the registry fetch encoding
// against a local listener, and the board's releaseLineBlocked reader in
// throwaway git dirs with fail-closed edges.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGitEnv } from "./gitRepoEnv.ts";
import {
	AGE_MS,
	CAP_MS,
	changedPackages,
	fetchReleases,
	type LockEntry,
	registryEntries,
	releaseLineBlocked,
	scanReleaseLines,
} from "./releaseLineScan.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-11-09T12:00:00Z");

describe("registryEntries", () => {
	test("parses the real bun.lock with integrity slashes intact", () => {
		const lockText = readFileSync(
			join(import.meta.dir, "..", "bun.lock"),
			"utf8",
		);
		const entries = registryEntries(lockText);
		// The count observed on the real bun.lock when this test was written.
		// It doubles as the proof that parseJsonc survives the integrity
		// hashes containing "//" (a blind comment strip would corrupt them).
		const REAL_ENTRY_COUNT = 414;
		expect(entries.length).toBe(REAL_ENTRY_COUNT);
		expect(entries.length).toBeGreaterThan(100);
		const malformed = entries.filter(
			(entry) =>
				!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version) ||
				entry.key.includes("workspace:") ||
				entry.key.includes("link:") ||
				entry.name.includes("workspace:") ||
				entry.name.includes("link:"),
		);
		expect(malformed).toEqual([]);
	});
});

describe("changedPackages", () => {
	test("added, changed, deduped, skipped, prerelease, direct flag", () => {
		const base: LockEntry[] = [
			{ key: "beta", name: "beta", version: "2.0.0-rc.1" },
			{ key: "commander", name: "commander", version: "14.0.3" },
			{ key: "mermaid", name: "mermaid", version: "12.1.0" },
		];
		const current: LockEntry[] = [
			// Version moved but stays a prerelease: never scanned.
			{ key: "beta", name: "beta", version: "2.0.0-rc.2" },
			// Unchanged: skipped.
			{ key: "commander", name: "commander", version: "14.0.3" },
			// Added nested keys resolving to one name@version: scanned once.
			{ key: "d3-dsv/commander", name: "commander", version: "7.2.0" },
			{ key: "katex/commander", name: "commander", version: "7.2.0" },
			// Version changed: scanned, flagged direct.
			{ key: "mermaid", name: "mermaid", version: "12.2.0" },
		];
		const direct = new Set(["mermaid"]);
		expect(changedPackages(current, base, direct)).toEqual([
			{ name: "commander", version: "7.2.0", direct: false },
			{ name: "mermaid", version: "12.2.0", direct: true },
		]);
	});
});

/** A synthetic lock text holding plain name@version registry entries. */
function lock(entries: Array<[string, string]>): string {
	const packages: Record<string, unknown> = {};
	for (const [key, id] of entries) packages[key] = [id, "", {}];
	return JSON.stringify({ lockfileVersion: 1, workspaces: {}, packages });
}

describe("scanReleaseLines", () => {
	test("a young line release blocks an added direct package", async () => {
		const fetched: string[] = [];
		const result = await scanReleaseLines({
			lockText: lock([["left-pad", "left-pad@1.3.0"]]),
			baseLockText: lock([]),
			directNames: new Set(["left-pad"]),
			fetch: async (name) => {
				fetched.push(name);
				return [
					{ version: "1.3.0", publishedAt: NOW - 8 * DAY_MS },
					{ version: "1.3.1", publishedAt: NOW - 2 * DAY_MS },
				];
			},
			now: NOW,
			ageMs: AGE_MS,
			capMs: CAP_MS,
		});
		// One fetch, for the one changed package.
		expect(fetched).toEqual(["left-pad"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.transitive).toEqual([]);
		// The young 1.3.1 blocks; settle time is its publish time plus AGE_MS
		// ((NOW - 2d) + 7d = NOW + 5d), below the cap end (NOW - 8d + 14d).
		expect(result.direct).toEqual([
			{
				name: "left-pad",
				version: "1.3.0",
				blocker: { version: "1.3.1", publishedAt: NOW - 2 * DAY_MS },
				waitUntilMs: NOW - 2 * DAY_MS + AGE_MS,
			},
		]);
	});

	test("the 14-day cap lifts the block of a 15-day-old install", async () => {
		const result = await scanReleaseLines({
			lockText: lock([["left-pad", "left-pad@1.3.0"]]),
			baseLockText: lock([]),
			directNames: new Set(["left-pad"]),
			fetch: async () => [
				{ version: "1.3.0", publishedAt: NOW - 15 * DAY_MS },
				{ version: "1.3.1", publishedAt: NOW - 2 * DAY_MS },
			],
			now: NOW,
			ageMs: AGE_MS,
			capMs: CAP_MS,
		});
		expect(result).toEqual({ ok: true, direct: [], transitive: [] });
	});

	test("a change outside the direct set lands in transitive", async () => {
		const result = await scanReleaseLines({
			lockText: lock([["left-pad", "left-pad@1.3.0"]]),
			baseLockText: lock([]),
			directNames: new Set<string>(),
			fetch: async () => [
				{ version: "1.3.0", publishedAt: NOW - 8 * DAY_MS },
				{ version: "1.3.1", publishedAt: NOW - 2 * DAY_MS },
			],
			now: NOW,
			ageMs: AGE_MS,
			capMs: CAP_MS,
		});
		expect(result).toEqual({
			ok: true,
			direct: [],
			transitive: [
				{
					name: "left-pad",
					version: "1.3.0",
					blocker: { version: "1.3.1", publishedAt: NOW - 2 * DAY_MS },
					waitUntilMs: NOW - 2 * DAY_MS + AGE_MS,
				},
			],
		});
	});

	test("a settled line with nothing young above scans clean", async () => {
		const result = await scanReleaseLines({
			lockText: lock([["left-pad", "left-pad@1.3.0"]]),
			baseLockText: lock([]),
			directNames: new Set(["left-pad"]),
			fetch: async () => [
				{ version: "1.3.0", publishedAt: NOW - 8 * DAY_MS },
				{ version: "1.3.1", publishedAt: NOW - 9 * DAY_MS },
			],
			now: NOW,
			ageMs: AGE_MS,
			capMs: CAP_MS,
		});
		expect(result).toEqual({ ok: true, direct: [], transitive: [] });
	});

	test("a failed fetch stops the scan naming the package", async () => {
		const result = await scanReleaseLines({
			lockText: lock([["left-pad", "left-pad@1.3.0"]]),
			baseLockText: lock([]),
			directNames: new Set(["left-pad"]),
			fetch: async () => {
				throw new Error("registry exploded");
			},
			now: NOW,
			ageMs: AGE_MS,
			capMs: CAP_MS,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failed).toEqual({
			name: "left-pad",
			message: "registry exploded",
		});
	});

	test("a broken lock reports bun.lock, not a package", async () => {
		const result = await scanReleaseLines({
			lockText: '{"packages": ',
			baseLockText: lock([]),
			directNames: new Set(["left-pad"]),
			fetch: async () => [],
			now: NOW,
			ageMs: AGE_MS,
			capMs: CAP_MS,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failed.name).toBe("bun.lock");
		expect(result.failed.message).not.toBe("");
	});

	test("a changed set over the cap stops the scan before any fetch", async () => {
		let fetches = 0;
		const result = await scanReleaseLines({
			lockText: lock([
				["a", "a@1.0.0"],
				["b", "b@1.0.0"],
				["c", "c@1.0.0"],
			]),
			baseLockText: lock([]),
			directNames: new Set(["a", "b", "c"]),
			fetch: async () => {
				fetches += 1;
				return [];
			},
			now: NOW,
			ageMs: AGE_MS,
			capMs: CAP_MS,
			maxChangedPackages: 2,
		});
		expect(fetches).toBe(0);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failed.name).toBe("bun.lock");
		expect(result.failed.message).toContain("3 packages");
	});

	test("a passed deadline stops the scan before any fetch", async () => {
		let fetches = 0;
		const result = await scanReleaseLines({
			lockText: lock([["left-pad", "left-pad@1.3.0"]]),
			baseLockText: lock([]),
			directNames: new Set(["left-pad"]),
			fetch: async () => {
				fetches += 1;
				return [];
			},
			now: NOW,
			ageMs: AGE_MS,
			capMs: CAP_MS,
			deadlineMs: Date.now() - 1,
		});
		expect(fetches).toBe(0);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failed.name).toBe("bun.lock");
	});

	test("the deadline stops a slow scan part-way", async () => {
		// Each fetch sleeps 100 ms against a 50 ms budget: the first fetch
		// passes the pre-check, the second must trip the deadline.
		let fetches = 0;
		const result = await scanReleaseLines({
			lockText: lock([
				["a", "a@1.0.0"],
				["b", "b@1.0.0"],
				["c", "c@1.0.0"],
			]),
			baseLockText: lock([]),
			directNames: new Set(["a", "b", "c"]),
			fetch: async () => {
				fetches += 1;
				await new Promise((resolve) => setTimeout(resolve, 100));
				return [];
			},
			now: NOW,
			ageMs: AGE_MS,
			capMs: CAP_MS,
			deadlineMs: Date.now() + 50,
		});
		expect(result.ok).toBe(false);
		expect(fetches).toBeLessThan(3);
	});
});

type Recorded = { method: string; url: string };

/** Local registry listener: records every request and serves packuments by
 * decoded package name; a status other than 200 answers every request. */
function listener(packuments: Record<string, unknown>, status = 200) {
	const requests: Recorded[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			requests.push({ method: req.method, url: req.url });
			if (status !== 200) return new Response("down", { status });
			const name = decodeURIComponent(new URL(req.url).pathname.slice(1));
			const body = packuments[name];
			if (body === undefined)
				return new Response("no fixture", { status: 404 });
			return Response.json(body);
		},
	});
	return {
		requests,
		base: `http://localhost.:${server.port}`,
		stop: () => server.stop(true),
	};
}

/** Seeds OTTR_NPM_REGISTRY for one test; the returned function restores the
 * previous value, also the unset case. */
function seedRegistry(base: string): () => void {
	const prev = process.env.OTTR_NPM_REGISTRY;
	process.env.OTTR_NPM_REGISTRY = base;
	return () => {
		if (prev === undefined) delete process.env.OTTR_NPM_REGISTRY;
		else process.env.OTTR_NPM_REGISTRY = prev;
	};
}

describe("fetchReleases", () => {
	test("encodes scoped names and strips the base's trailing slash", async () => {
		const reg = listener({
			"@scope/pkg": {
				versions: { "1.0.0": {} },
				time: { "1.0.0": "2026-01-01T00:00:00.000Z" },
			},
		});
		// The trailing slash must vanish: a kept one would show in the path.
		const restore = seedRegistry(`${reg.base}/`);
		try {
			const releases = await fetchReleases("@scope/pkg", 65_536);
			expect(releases).toEqual([
				{
					version: "1.0.0",
					publishedAt: Date.parse("2026-01-01T00:00:00.000Z"),
					deprecated: false,
				},
			]);
		} finally {
			restore();
			reg.stop();
		}
		// Exact equality, not substring: one GET, path "/@scope%2Fpkg".
		expect(reg.requests).toEqual([
			{ method: "GET", url: `${reg.base}/@scope%2Fpkg` },
		]);
		expect(new URL(reg.requests[0]!.url).pathname).toBe("/@scope%2Fpkg");
	});

	test("maps deprecated, absent, and time-only packument entries", async () => {
		const reg = listener({
			"left-pad": {
				versions: {
					"1.0.0": { deprecated: "upgrade to 2" },
					"1.1.0": {},
					"2.0.0": {},
				},
				time: {
					"1.0.0": "2026-01-01T00:00:00.000Z",
					"1.1.0": "2026-02-01T00:00:00.000Z",
					"2.0.0": "2026-03-01T00:00:00.000Z",
					// Listed in time but gone from versions: dropped.
					"0.9.0": "2025-12-01T00:00:00.000Z",
				},
			},
		});
		const restore = seedRegistry(reg.base);
		try {
			const releases = await fetchReleases("left-pad", 65_536);
			expect(releases).toEqual([
				{
					version: "1.0.0",
					publishedAt: Date.parse("2026-01-01T00:00:00.000Z"),
					deprecated: true,
				},
				{
					version: "1.1.0",
					publishedAt: Date.parse("2026-02-01T00:00:00.000Z"),
					deprecated: false,
				},
				{
					version: "2.0.0",
					publishedAt: Date.parse("2026-03-01T00:00:00.000Z"),
					deprecated: false,
				},
			]);
		} finally {
			restore();
			reg.stop();
		}
	});

	test("rejects on a registry error status", async () => {
		const reg = listener({}, 500);
		const restore = seedRegistry(reg.base);
		try {
			await expect(fetchReleases("left-pad", 65_536)).rejects.toThrow(
				"registry returned HTTP 500",
			);
		} finally {
			restore();
			reg.stop();
		}
	});

	test("a packument body over the cap fails the fetch", async () => {
		// A ~2 MB body (the deprecated marker is a long string): the bounded
		// read must refuse it before any JSON.parse, naming the cap.
		const reg = listener({
			"left-pad": {
				versions: { "1.0.0": { deprecated: "x".repeat(2_000_000) } },
				time: { "1.0.0": "2026-01-01T00:00:00.000Z" },
			},
		});
		const restore = seedRegistry(reg.base);
		try {
			await expect(fetchReleases("left-pad", 65_536)).rejects.toThrow(
				"packument larger than 65536 bytes",
			);
		} finally {
			restore();
			reg.stop();
		}
	});
});

/** git for fixtures with a throwaway identity — never a gate spawn. */
function must(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", ...args], {
		cwd,
		env: fixtureGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/** Real-shaped JSONC lock: a comment line, trailing commas, and an
 * integrity-looking string that carries "//". */
function jsoncLock(entries: Array<[string, string]>): string {
	const lines = [
		"{",
		'\t// The integrity hashes carry "//": a blind comment strip would corrupt them.',
		'\t"lockfileVersion": 1,',
		'\t"workspaces": { "": { "name": "release-line-fixture" } },',
		'\t"packages": {',
	];
	for (const [key, id] of entries) {
		lines.push(
			`\t\t"${key}": [`,
			`\t\t\t"${id}",`,
			'\t\t\t"",',
			"\t\t\t{},",
			'\t\t\t"sha512-QrWXB+ZQSVPm//IWIhtEO9H+gwHaMGYiF5ChvoJ+K9ZGHG/sVsa6yiesAD1GC/x46sET00Xlwo1u49RVVVzvcSkw==",',
			"\t\t],",
		);
	}
	lines.push("\t},", "}", "");
	return lines.join("\n");
}

function pkgJson(deps: Record<string, string>): string {
	return `${JSON.stringify(
		{ name: "release-line-fixture", private: true, dependencies: deps },
		null,
		"\t",
	)}\n`;
}

/** Appends a JSONC comment padded to roughly `mb` MiB: still valid lock
 * content whose only fault is its size, so a byte cap (never the parser)
 * must stop the scan. */
function padded(lockText: string, mb: number): string {
	return `${lockText}\n// ${"x".repeat(mb * 1024 * 1024)}\n`;
}

/** Packument with exact publish times: each version sits `days` days plus
 * one hour before `t0`, so the settled/young split stays stable against
 * scan-start drift. */
function packument(t0: number, versions: Array<[string, number]>): unknown {
	const time: Record<string, string> = { created: "2026-01-01T00:00:00.000Z" };
	const versionMap: Record<string, object> = {};
	for (const [version, days] of versions) {
		versionMap[version] = {};
		time[version] = new Date(t0 - days * DAY_MS - HOUR_MS).toISOString();
	}
	return { versions: versionMap, time };
}

/** Scratch git dir: package.json and the base lock (null commits none)
 * committed on main and published to the origin/main ref, then the worktree
 * lock overwritten for the case. */
function repo(
	dir: string,
	baseLock: string | null,
	pkgJsonText: string,
	workLock: string,
): void {
	writeFileSync(join(dir, "package.json"), pkgJsonText);
	if (baseLock !== null) writeFileSync(join(dir, "bun.lock"), baseLock);
	must(dir, "init", "-b", "main");
	must(dir, "add", ".");
	must(
		dir,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-m",
		"base",
	);
	must(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
	writeFileSync(join(dir, "bun.lock"), workLock);
}

/** Scratch dir with both files, no git: the reader must fail closed. */
function plainDir(lockText: string, pkgJsonText: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-plain-"));
	writeFileSync(join(dir, "bun.lock"), lockText);
	writeFileSync(join(dir, "package.json"), pkgJsonText);
	return dir;
}

describe("releaseLineBlocked", () => {
	test("an added direct dependency blocks at settle time", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-blocked-"));
		const t0 = Date.now();
		const reg = listener({
			"left-pad": packument(t0, [
				["1.3.0", 8],
				["1.3.1", 2],
			]),
		});
		const restore = seedRegistry(reg.base);
		try {
			repo(
				dir,
				jsoncLock([["commander", "commander@14.0.3"]]),
				pkgJson({ "left-pad": "^1.3.0" }),
				jsoncLock([
					["commander", "commander@14.0.3"],
					["left-pad", "left-pad@1.3.0"],
				]),
			);
			const result = await releaseLineBlocked(dir);
			// Settle time: the young 1.3.1's publish (t0 - 2d - 1h) plus AGE_MS,
			// below the cap end (t0 - 8d - 1h + 14d) — exact, drift-free.
			expect(result).toEqual([
				{
					name: "left-pad",
					version: "1.3.0",
					waitUntilMs: t0 - 2 * DAY_MS - HOUR_MS + AGE_MS,
				},
			]);
			expect(reg.requests).toEqual([
				{ method: "GET", url: `${reg.base}/left-pad` },
			]);
		} finally {
			restore();
			reg.stop();
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("a missing bun.lock fails closed to null", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-missing-"));
		try {
			writeFileSync(
				join(dir, "package.json"),
				pkgJson({ "left-pad": "^1.3.0" }),
			);
			expect(await releaseLineBlocked(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("a broken JSONC lock fails closed to null", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-brokenlock-"));
		const reg = listener({});
		const restore = seedRegistry(reg.base);
		try {
			repo(
				dir,
				jsoncLock([["commander", "commander@14.0.3"]]),
				pkgJson({ "left-pad": "^1.3.0" }),
				'{"packages": ',
			);
			expect(await releaseLineBlocked(dir)).toBeNull();
			expect(reg.requests).toEqual([]);
		} finally {
			restore();
			reg.stop();
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("a broken package.json fails closed to null", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-brokenpkg-"));
		try {
			repo(
				dir,
				jsoncLock([["commander", "commander@14.0.3"]]),
				pkgJson({ "left-pad": "^1.3.0" }),
				jsoncLock([
					["commander", "commander@14.0.3"],
					["left-pad", "left-pad@1.3.0"],
				]),
			);
			writeFileSync(join(dir, "package.json"), "{");
			expect(await releaseLineBlocked(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("a plain directory without git fails closed to null", async () => {
		const dir = plainDir(
			jsoncLock([["left-pad", "left-pad@1.3.0"]]),
			pkgJson({ "left-pad": "^1.3.0" }),
		);
		try {
			// No origin/main to compare against: null, never a block.
			expect(await releaseLineBlocked(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("an origin/main without bun.lock scans against an empty base", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-nobase-"));
		const t0 = Date.now();
		const reg = listener({
			"left-pad": packument(t0, [
				["1.3.0", 8],
				["1.3.1", 2],
			]),
		});
		const restore = seedRegistry(reg.base);
		try {
			// The base commit holds only package.json: cat-file misses bun.lock,
			// the base map is empty, and every entry counts as changed.
			repo(
				dir,
				null,
				pkgJson({ "left-pad": "^1.3.0" }),
				jsoncLock([["left-pad", "left-pad@1.3.0"]]),
			);
			const result = await releaseLineBlocked(dir);
			expect(result).toEqual([
				{
					name: "left-pad",
					version: "1.3.0",
					waitUntilMs: t0 - 2 * DAY_MS - HOUR_MS + AGE_MS,
				},
			]);
		} finally {
			restore();
			reg.stop();
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("a registry error fails closed to null", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-error-"));
		const reg = listener({}, 500);
		const restore = seedRegistry(reg.base);
		try {
			repo(
				dir,
				jsoncLock([["commander", "commander@14.0.3"]]),
				pkgJson({ "left-pad": "^1.3.0" }),
				jsoncLock([
					["commander", "commander@14.0.3"],
					["left-pad", "left-pad@1.3.0"],
				]),
			);
			expect(await releaseLineBlocked(dir)).toBeNull();
			expect(reg.requests).toEqual([
				{ method: "GET", url: `${reg.base}/left-pad` },
			]);
		} finally {
			restore();
			reg.stop();
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("a transitive-only bump returns empty, not null", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-transitive-"));
		const t0 = Date.now();
		const reg = listener({
			"left-pad": packument(t0, [
				["1.3.0", 8],
				["1.3.1", 2],
			]),
		});
		const restore = seedRegistry(reg.base);
		try {
			// left-pad changed in the lock but is not a declared dependency:
			// the hold covers direct entries only, so the array is empty.
			repo(
				dir,
				jsoncLock([["commander", "commander@14.0.3"]]),
				pkgJson({ commander: "14.0.3" }),
				jsoncLock([
					["commander", "commander@14.0.3"],
					["left-pad", "left-pad@1.3.0"],
				]),
			);
			expect(await releaseLineBlocked(dir)).toEqual([]);
			expect(reg.requests).toEqual([
				{ method: "GET", url: `${reg.base}/left-pad` },
			]);
		} finally {
			restore();
			reg.stop();
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("an over-cap worktree bun.lock keeps the park (null)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-hugelock-"));
		const t0 = Date.now();
		const reg = listener({ "left-pad": packument(t0, [["1.3.0", 8]]) });
		const restore = seedRegistry(reg.base);
		try {
			// The 5 MiB lock is valid JSONC and its left-pad line is settled
			// (8 days): the old unbounded read returned [] here. Over the cap
			// the read must fail closed to null and keep the park.
			repo(
				dir,
				jsoncLock([["commander", "commander@14.0.3"]]),
				pkgJson({ "left-pad": "^1.3.0" }),
				padded(
					jsoncLock([
						["commander", "commander@14.0.3"],
						["left-pad", "left-pad@1.3.0"],
					]),
					5,
				),
			);
			expect(await releaseLineBlocked(dir)).toBeNull();
			expect(reg.requests).toEqual([]);
		} finally {
			restore();
			reg.stop();
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("an over-cap base lock blob keeps the park (null)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-hugebase-"));
		const t0 = Date.now();
		const reg = listener({
			"left-pad": packument(t0, [
				["1.3.0", 8],
				["1.3.1", 2],
			]),
		});
		const restore = seedRegistry(reg.base);
		try {
			// The 5 MiB base blob is valid JSONC: the old tree read it whole
			// and blocked on the young 1.3.1 (non-null). Over the cap the
			// base read must fail closed to null.
			repo(
				dir,
				padded(jsoncLock([["left-pad", "left-pad@1.3.0"]]), 5),
				pkgJson({ "left-pad": "^1.3.0" }),
				jsoncLock([["left-pad", "left-pad@1.3.1"]]),
			);
			expect(await releaseLineBlocked(dir)).toBeNull();
		} finally {
			restore();
			reg.stop();
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("a multi-MB packument keeps the park (null)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-bigbody-"));
		const t0 = Date.now();
		const reg = listener({
			"left-pad": {
				versions: {
					"1.3.0": {},
					"1.3.1": { note: "x".repeat(2_000_000) },
				},
				time: {
					"1.3.0": new Date(t0 - 8 * DAY_MS).toISOString(),
					"1.3.1": new Date(t0 - 2 * DAY_MS).toISOString(),
				},
			},
		});
		const restore = seedRegistry(reg.base);
		try {
			// The 2 MB body parses on the old tree and blocks on the young
			// 1.3.1 (non-null). The body cap must stop the scan and keep the
			// park instead.
			repo(
				dir,
				jsoncLock([["commander", "commander@14.0.3"]]),
				pkgJson({ "left-pad": "^1.3.0" }),
				jsoncLock([
					["commander", "commander@14.0.3"],
					["left-pad", "left-pad@1.3.0"],
				]),
			);
			expect(await releaseLineBlocked(dir)).toBeNull();
		} finally {
			restore();
			reg.stop();
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test("a changed set over the board cap keeps the park with no registry call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-manychg-"));
		const reg = listener({});
		const restore = seedRegistry(reg.base);
		try {
			const entries: Array<[string, string]> = [];
			for (let i = 0; i < 501; i++) entries.push([`p${i}`, `p${i}@1.0.0`]);
			repo(dir, jsoncLock([]), pkgJson({ p0: "^1.0.0" }), jsoncLock(entries));
			// The old tree fetched all 501 (404s fail the scan to null, but
			// the listener saw the requests); the cap must stop it first.
			expect(await releaseLineBlocked(dir)).toBeNull();
			expect(reg.requests).toEqual([]);
		} finally {
			restore();
			reg.stop();
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});
});
