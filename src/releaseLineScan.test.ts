// Tests for the bun.lock release line scan's data side (OTTR-972): the lock
// parser on the repo's real bun.lock, the changed-set logic, the scan core
// with an injected fetch (no network, no env), the registry fetch encoding
// against a local listener, the streaming packument selector against verbatim
// real entries and a seeded JSON.parse oracle, and the board's
// releaseLineBlocked reader in throwaway git dirs with fail-closed edges.
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
	releasesOf,
	scanReleaseLines,
	streamPackument,
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

/** GET listener answering `bodyText` split into `chunkBytes`-byte chunks, so
 * tokens and multibyte characters straddle chunk boundaries. */
function rawListener(bodyText: string, chunkBytes: number) {
	const bytes = new TextEncoder().encode(bodyText);
	const requests: Recorded[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			requests.push({ method: req.method, url: req.url });
			let offset = 0;
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (offset >= bytes.length) {
						controller.close();
						return;
					}
					controller.enqueue(bytes.slice(offset, offset + chunkBytes));
					offset += chunkBytes;
				},
			});
			return new Response(stream, {
				headers: { "content-type": "application/json" },
			});
		},
	});
	return {
		requests,
		base: `http://localhost.:${server.port}`,
		stop: () => server.stop(true),
	};
}

/** A reader over `text`, served in `chunkBytes`-byte chunks. */
function streamOf(
	text: string,
	chunkBytes: number,
): ReadableStreamDefaultReader<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(offset, offset + chunkBytes));
			offset += chunkBytes;
		},
	}).getReader();
}

/** A legitimate left-pad packument inflated past 2 MB: every filler version
 * carries real manifest shapes (nested dist, escaped description with quotes,
 * backslash, tab, newline, unicode). Fillers sit in line 2.x, so they never
 * touch the 1.3 line's verdict. Line entries follow the packument()
 * convention: `days` days plus one hour before `t0`; fillers are 1000 days
 * old. Returns the serialized body text. */
function fatPackumentText(
	t0: number,
	lineEntries: Array<[string, number]>,
	fillerCount: number,
): string {
	const versions: Record<string, unknown> = {};
	const time: Record<string, string> = {
		created: "2020-01-01T00:00:00.000Z",
	};
	for (const [version, days] of lineEntries) {
		versions[version] = {
			name: "left-pad",
			version,
			dist: {
				tarball: `https://registry.npmjs.org/left-pad/-/left-pad-${version}.tgz`,
				shasum: "a".repeat(40),
			},
		};
		time[version] = new Date(t0 - days * DAY_MS - HOUR_MS).toISOString();
	}
	for (let i = 0; i < fillerCount; i++) {
		const version = `2.${i}.0`;
		versions[version] = {
			name: "left-pad",
			version,
			description:
				`Handles "quotes", a \\backslash, \ttab and \nnewline, unicode é 𝕏 🚀, padding `.repeat(
					18,
				),
			dist: {
				tarball: `https://registry.npmjs.org/left-pad/-/left-pad-${version}.tgz`,
				shasum: "a".repeat(40),
				integrity: `sha512-${"B".repeat(88)}`,
				signatures: [{ sig: "MEUCIQ".repeat(40), keyid: "SHA256:abc" }],
				nested: { a: { b: { c: [1, 2.5, -3e-7, null, true, false] } } },
			},
			engines: { node: ">=4" },
			bin: i % 3 === 0 ? { x: "bin/x" } : null,
			green: i % 2 === 0,
			weight: i * 1.5e-3,
			deprecated: i % 25 === 0 ? `use 3.${i} instead` : false,
		};
		time[version] = new Date(t0 - 1000 * DAY_MS).toISOString();
	}
	return JSON.stringify({
		_id: "left-pad",
		name: "left-pad",
		"dist-tags": { latest: lineEntries[0]?.[0] ?? "1.0.0" },
		versions,
		time,
	});
}

/** Verbatim byte slices of real packuments, fetched from registry.npmjs.org
 * on 2026-11-22: typescript 2.0.3's manifest (nested dist, maintainers, a
 * wide scripts map), uuid 0.0.1's manifest with its real string-deprecated
 * marker, and real time entries. The selector must read the real shape,
 * escapes and all, exactly as JSON.parse does. */
const REAL_TS_2_0_3 = String.raw`"2.0.3":{"name":"typescript","version":"2.0.3","keywords":["TypeScript","Microsoft","compiler","language","javascript"],"author":{"name":"Microsoft Corp."},"license":"Apache-2.0","_id":"typescript@2.0.3","maintainers":[{"name":"typescript","email":"typescript@microsoft.com"}],"homepage":"http://typescriptlang.org/","bugs":{"url":"https://github.com/Microsoft/TypeScript/issues"},"bin":{"tsc":"./bin/tsc","tsserver":"./bin/tsserver"},"dist":{"shasum":"33dec9eae86b8eee327dd419ca050c853cabd514","tarball":"https://registry.npmjs.org/typescript/-/typescript-2.0.3.tgz","integrity":"sha512-VMzzasFNZ8NAp/t4UQeOIAa6x2c3XXB6+URGufGpPPRyWm197B0dPu9S7t4MGhXCv7oCDvo+Hx/qF7LLI8dOjw==","signatures":[{"sig":"MEYCIQDQFXysFlUgO2OUZW4jF6K6AqqNBm01OVDN4JK6fLZ4sgIhAMDPq+t5+bU5zAmY+4yKRLM/ddX/1clIShmqWvzpmm6L","keyid":"SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA"}]},"main":"./lib/typescript.js","_from":".","_shasum":"33dec9eae86b8eee327dd419ca050c853cabd514","browser":{"fs":false,"os":false,"path":false,"buffer":false},"engines":{"node":">=0.8.0"},"gitHead":"4f65a2885e000c27e5f079171d440797d7307b97","scripts":{"gulp":"gulp","jake":"jake","lint":"jake lint","test":"jake runtests-parallel","build":"npm run build:compiler && npm run build:tests","clean":"jake clean","start":"node lib/tsc","pretest":"jake tests","build:tests":"jake tests","setup-hooks":"node scripts/link-hooks.js","build:compiler":"jake local"},"typings":"./lib/typescript.d.ts","_npmUser":{"name":"typescript","email":"typescript@microsoft.com"},"repository":{"url":"git+https://github.com/Microsoft/TypeScript.git","type":"git"},"_npmVersion":"3.8.6","description":"TypeScript is a language for application scale JavaScript development","directories":{},"_nodeVersion":"5.11.1","devDependencies":{"q":"latest","del":"latest","chai":"latest","gulp":"latest","jake":"latest","mocha":"latest","merge2":"latest","mkdirp":"latest","tslint":"3.15.1","sorcery":"latest","ts-node":"latest","@types/q":"latest","istanbul":"latest","minimist":"latest","through2":"latest","gulp-help":"latest","@types/del":"latest","browserify":"latest","gulp-clone":"latest","gulp-newer":"latest","typescript":"2.0.*","@types/chai":"latest","@types/glob":"latest","@types/gulp":"latest","@types/node":"latest","gulp-concat":"latest","gulp-insert":"latest","into-stream":"latest","travis-fold":"latest","@types/mocha":"latest","run-sequence":"latest","@types/merge2":"latest","@types/mkdirp":"latest","@types/minimist":"latest","@types/through2":"latest","gulp-sourcemaps":"latest","gulp-typescript":"latest","@types/gulp-help":"latest","@types/minimatch":"latest","@types/browserify":"latest","@types/gulp-newer":"latest","@types/gulp-concat":"latest","convert-source-map":"latest","@types/run-sequence":"latest","@types/gulp-sourcemaps":"latest","@types/gulp-typescript":"latest","@types/convert-source-map":"latest","mocha-fivemat-progress-reporter":"latest"},"_npmOperationalInternal":{"tmp":"tmp/typescript-2.0.3.tgz_1474560003144_0.4724818258546293","host":"packages-12-west.internal.npmjs.com"}}`;
const REAL_UUID_0_0_1 = String.raw`"0.0.1":{"name":"uuid","version":"0.0.1","author":{"name":"Nikhil Marathe"},"_id":"uuid@0.0.1","dist":{"shasum":"5b43a6840d25914b5a76a0664d71a51601ddec79","tarball":"https://registry.npmjs.org/uuid/-/uuid-0.0.1.tgz","integrity":"sha512-x3aIUBw/J5WMm+mfHLh5b7OelhczIY5/wr/b6JapW/SYdU4Yy7mW8AQ6vxecnRjy/qqe14mLV5vdA3c+4QCO/w==","signatures":[{"sig":"MEUCIQCBH/OYMwdf/bhNLOnu7RN7FWR+xiRXSnjYCb9i79w44wIgPKNS2UlGKszZ04Kg4BfI1oLcscXAaz0j9MJNxflgWLw=","keyid":"SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA"}]},"main":"build/default/uuid","engine":["node >=0.1.103"],"engines":{"node":"*"},"scripts":{"preinstall":"node-waf configure && node-waf build"},"deprecated":"uuid@10 and below is no longer supported.  For ESM codebases, update to uuid@latest.  For CommonJS codebases, use uuid@11 (but be aware this version will likely be deprecated in 2028).","repository":{"url":"http://bitbucket.org/nikhilm/uuidjs","type":"hg"},"_npmVersion":"0.2.7-2","description":"Simple libuuid bindings to allow UUIDs to be generated from JS.","directories":{},"_nodeVersion":"v0.3.1-pre","_nodeSupported":true}`;
const REAL_TIME_ENTRIES = String.raw`"created":"2012-10-01T15:35:39.553Z","modified":"2026-11-21T08:11:51.232Z","0.8.0":"2012-10-01T15:35:41.062Z","0.8.1":"2012-11-15T20:53:44.894Z","0.8.1-1":"2012-12-04T23:35:48.083Z","2.0.3":"2016-09-22T16:00:05.876Z","0.0.1":"2011-03-31T08:12:51.801Z"`;

/** Deterministic PRNG (mulberry32): the oracle keeps a fixed seed, so the
 * check gate sees the same inputs on every run. */
function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const RANDOM_VERSIONS = [
	"1.0.0",
	"1.2.3-beta.1",
	"0.0.1",
	"10.20.30",
	"2.0.0-rc.2",
];
const RANDOM_FIELDS = [
	"description",
	"dist",
	"engines",
	"bin",
	"deprecated",
	"_id",
	"x-y",
];

/** Random JSON value, containers only above depth 4. Strings carry quotes,
 * backslashes, tabs, newlines and multibyte characters on purpose. */
function randValue(rand: () => number, depth: number): unknown {
	const pick = Math.floor(rand() * (depth >= 4 ? 8 : 10));
	if (pick === 0) return rand() < 0.5;
	if (pick === 1) return null;
	if (pick === 2) return Math.floor(rand() * 1e6);
	if (pick === 3) return rand() * 1e9 - 5e8;
	if (pick === 4) return "";
	if (pick === 5) return `plain-${Math.floor(rand() * 100)}`;
	if (pick === 6)
		return `quotes "here", a \\backslash, \ttab, \nnewline, unicode é 𝕏 🚀, ${Math.floor(rand() * 1e4)}`;
	if (pick === 8) {
		return Array.from({ length: Math.floor(rand() * 4) }, () =>
			randValue(rand, depth + 1),
		);
	}
	if (pick === 9) {
		const out: Record<string, unknown> = {};
		for (let i = 0; i < Math.floor(rand() * 4); i++)
			out[`k${Math.floor(rand() * 100)}`] = randValue(rand, depth + 1);
		return out;
	}
	return `scalar-${pick}`;
}

/** Random packument: every version carries all RANDOM_FIELDS, with the
 * deprecated marker a string, false, or null; the time map holds real ISO
 * strings and the occasional junk object (both sides must drop it). */
function randPackument(rand: () => number): unknown {
	const picked = RANDOM_VERSIONS.filter(() => rand() < 0.7);
	const versions: Record<string, unknown> = {};
	const time: Record<string, unknown> = {
		created: "2020-01-01T00:00:00.000Z",
	};
	for (const key of picked.length > 0 ? picked : RANDOM_VERSIONS.slice(0, 1)) {
		const fields: Record<string, unknown> = {};
		for (const field of RANDOM_FIELDS) {
			if (field === "deprecated") {
				const roll = rand();
				fields.deprecated =
					roll < 0.5
						? `upgrade "now" \\fast, ${Math.floor(rand() * 1e4)}`
						: roll < 0.75
							? false
							: null;
			} else {
				fields[field] = randValue(rand, 2);
			}
		}
		versions[key] = fields;
		time[key] =
			rand() < 0.9
				? new Date(
						Date.parse("2026-01-01T00:00:00.000Z") - Math.floor(rand() * 1e9),
					).toISOString()
				: { junk: 1 };
	}
	return {
		_id: "left-pad",
		name: "left-pad",
		"dist-tags": { latest: picked[0] ?? "1.0.0" },
		readme: randValue(rand, 1),
		versions,
		time,
		other: randValue(rand, 1),
	};
}

describe("streamPackument", () => {
	test("selects verbatim real registry entries", async () => {
		const bodyText = `{"_id":"typescript","name":"typescript","dist-tags":{"latest":"2.0.3"},"versions":{${REAL_TS_2_0_3},${REAL_UUID_0_0_1}},"time":{${REAL_TIME_ENTRIES}}}`;
		const got = await streamPackument(streamOf(bodyText, 9), 100);
		expect(releasesOf(got)).toEqual(releasesOf(JSON.parse(bodyText)));
		// The real deprecated marker landed on the right version.
		expect(
			got.versions["0.0.1"]?.deprecated?.startsWith("uuid@10 and below"),
		).toBe(true);
		expect(got.versions["2.0.3"]?.deprecated).toBeUndefined();
		expect(got.time["0.8.0"]).toBe("2012-10-01T15:35:41.062Z");
		expect(releasesOf(got).find((r) => r.version === "2.0.3")).toEqual({
			version: "2.0.3",
			publishedAt: Date.parse("2016-09-22T16:00:05.876Z"),
			deprecated: false,
		});
	});

	test("agrees with JSON.parse on seeded random packuments", async () => {
		// Fixed seed and 150 bodies: the check gate sees the same inputs every
		// run. 7-byte chunks put token and multibyte boundaries everywhere.
		const rand = mulberry32(0x071194);
		for (let run = 0; run < 150; run++) {
			const text = JSON.stringify(randPackument(rand));
			const got = await streamPackument(streamOf(text, 7), 500);
			expect(releasesOf(got)).toEqual(releasesOf(JSON.parse(text)));
		}
	});

	test("a truncated stream fails closed", async () => {
		await expect(
			streamPackument(streamOf('{"versions":{"1.0.0":{"na', 5), 100),
		).rejects.toThrow("packument stream truncated");
	});

	test("a body nested past the depth cap fails closed", async () => {
		// Top level is an object (a packument's shape); the deep array sits
		// under a skipped key, 80 levels deep against the 64 cap.
		await expect(
			streamPackument(
				streamOf(`{"a":[${"[".repeat(79)}1${"]".repeat(79)}]}`, 7),
				100,
			),
		).rejects.toThrow("nesting too deep");
	});

	test("a packument over a small version cap refuses with the cap named", async () => {
		const body = '{"versions":{"1.0.0":{},"1.0.1":{},"1.0.2":{},"1.0.3":{}}}';
		await expect(streamPackument(streamOf(body, 4), 3)).rejects.toThrow(
			"packument lists more than 3 versions",
		);
	});
});

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
			const releases = await fetchReleases("@scope/pkg");
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
			const releases = await fetchReleases("left-pad");
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
			await expect(fetchReleases("left-pad")).rejects.toThrow(
				"registry returned HTTP 500",
			);
		} finally {
			restore();
			reg.stop();
		}
	});

	test("a multi-MB packument still parses", async () => {
		// A ~3 MB body of real manifest shapes served in 97-byte chunks: real
		// packuments legitimately reach tens of MiB (typescript 15.2 MiB,
		// vite 37.2 MiB, measured 2026-11-22), so the stream must take them.
		const text = fatPackumentText(
			Date.parse("2026-11-01T12:00:00Z"),
			[
				["1.3.0", 8],
				["1.3.1", 2],
			],
			1200,
		);
		const reg = rawListener(text, 97);
		const restore = seedRegistry(reg.base);
		try {
			const releases = await fetchReleases("left-pad");
			expect(releases).toEqual(releasesOf(JSON.parse(text)));
			expect(releases.length).toBe(1202);
			const deprecated = releases.filter((r) => r.deprecated);
			// The filler's string-deprecated markers landed (1 in 25).
			expect(deprecated.length).toBe(48);
			expect(releases.find((r) => r.version === "1.3.1")).toEqual({
				version: "1.3.1",
				publishedAt: Date.parse("2026-11-01T12:00:00Z") - 2 * DAY_MS - HOUR_MS,
				deprecated: false,
			});
		} finally {
			restore();
			reg.stop();
		}
	});

	test("a packument listing over the version cap fails the fetch", async () => {
		const versions: Record<string, object> = {};
		for (let i = 0; i < 20_001; i++) versions[`1.0.${i}`] = {};
		const reg = rawListener(
			JSON.stringify({
				versions,
				time: { "1.0.0": "2026-01-01T00:00:00.000Z" },
			}),
			4096,
		);
		const restore = seedRegistry(reg.base);
		try {
			await expect(fetchReleases("left-pad")).rejects.toThrow(
				"packument lists more than 20000 versions",
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

	test("a multi-MB packument still arms the hold", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-bigbody-"));
		const t0 = Date.now();
		const reg = rawListener(
			fatPackumentText(
				t0,
				[
					["1.3.0", 8],
					["1.3.1", 2],
				],
				1200,
			),
			97,
		);
		const restore = seedRegistry(reg.base);
		try {
			// The ~3 MB body of real manifest shapes parses (the first cut's
			// 64 KiB body cap refused bodies like this one): the young 1.3.1
			// blocks and the hold arms with the exact clear time.
			repo(
				dir,
				jsoncLock([["commander", "commander@14.0.3"]]),
				pkgJson({ "left-pad": "^1.3.0" }),
				jsoncLock([
					["commander", "commander@14.0.3"],
					["left-pad", "left-pad@1.3.0"],
				]),
			);
			expect(await releaseLineBlocked(dir)).toEqual([
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

	test("a packument over the version cap keeps the park (null)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ottr-release-line-bigvers-"));
		const versions: Record<string, object> = {};
		for (let i = 0; i < 20_001; i++) versions[`1.0.${i}`] = {};
		const reg = rawListener(JSON.stringify({ versions, time: {} }), 4096);
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
