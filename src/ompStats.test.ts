// ompStats contract tests: transcript scanning, record strictness, merge, report build.
// Fixtures are synthetic transcript files in the shape tracker turns write.
import { describe, expect, test } from "bun:test";
import {
	appendFileSync,
	closeSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildOmpStatsReport,
	mergeOmpStats,
	newSessionUsageCache,
	type OmpStats,
	type OmpStatsSource,
	type OmpUsageTotals,
	scanSessionUsage,
	scanSessionUsageIncremental,
} from "./ompStats.ts";
import { TRANSCRIPT_MAX_BYTES, TRANSCRIPT_MAX_SUB_FILES } from "./session.ts";

const dir = mkdtempSync(join(tmpdir(), "ottr-omp-stats-"));

/** The all-zero totals block every partial fixture starts from: parseable, no rates. */
const BASE: OmpUsageTotals = {
	totalRequests: 0,
	successfulRequests: 0,
	failedRequests: 0,
	errorRate: null,
	totalInputTokens: 0,
	totalOutputTokens: 0,
	totalCacheReadTokens: 0,
	totalCacheWriteTokens: 0,
	cacheRate: null,
	cacheSavings: null,
	totalCost: 0,
	unpricedRequests: 0,
	totalPremiumRequests: 0,
	avgDuration: null,
	avgTtft: null,
	avgTokensPerSecond: null,
	firstTimestamp: null,
	lastTimestamp: null,
};

/** One assistant usage record line in a tracker transcript. */
const usageLine = (o: {
	model?: string;
	timestamp?: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
}) =>
	JSON.stringify({
		type: "message",
		timestamp: o.timestamp ?? "2026-11-07T12:00:00.000Z",
		message: {
			role: "assistant",
			model: o.model ?? "zai/glm-5.3-flash",
			provider: "zai",
			usage: {
				input: o.input ?? 10,
				output: o.output ?? 5,
				cacheRead: o.cacheRead ?? 100,
				cacheWrite: o.cacheWrite ?? 20,
				cost: { total: o.cost ?? 0.01 },
			},
		},
	});

const stats = (
	overall: Partial<OmpUsageTotals>,
	byModel: OmpStats["byModel"] = [],
): OmpStats => ({
	overall: { ...BASE, ...overall },
	byModel,
});

/** A transcript whose apparent size is `bytes`: a valid line plus a sparse zero tail with
 *  no trailing newline, so only the valid line is a complete record line. Costs no real
 *  bytes on disk. */
const oversizeFile = (path: string, bytes: number): void => {
	writeFileSync(path, `${usageLine({ cost: 0.25 })}\n`);
	const fd = openSync(path, "r+");
	ftruncateSync(fd, bytes);
	closeSync(fd);
};

/** Nests `levels` dirs below `root` under a `name` first level and returns the deepest. */
const deepDir = (root: string, name: string, levels: number): string => {
	let at = join(root, name);
	mkdirSync(at, { recursive: true });
	for (let i = 0; i < levels - 1; i++) {
		at = join(at, `l${i}`);
		mkdirSync(at);
	}
	return at;
};

const noteLines = (answer: { notes?: string[] }): string[] =>
	answer.notes ?? [];

describe("scanSessionUsage", () => {
	test("sums main and subagent transcripts of one dir", () => {
		const root = join(dir, "scan-ok");
		const sessions = join(root, "sessions");
		const sub = join(sessions, "1_sess-1");
		mkdirSync(sub, { recursive: true });
		writeFileSync(
			join(sessions, "1_sess-1.jsonl"),
			[
				usageLine({ input: 10, output: 5, cost: 0.25 }),
				'{"type":"session"}',
				"",
			].join("\n"),
		);
		writeFileSync(
			join(sub, "sub-1.jsonl"),
			`${usageLine({ model: "claude-opus-5-5", input: 99, output: 9, cost: 0.75 })}\n`,
		);
		const answer = scanSessionUsage(sessions);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(2);
		expect(answer.stats?.overall.totalInputTokens).toBe(109);
		expect(answer.stats?.overall.totalOutputTokens).toBe(14);
		expect(answer.stats?.overall.totalCost).toBeCloseTo(1);
		expect(answer.stats?.overall.cacheRate).toBeCloseTo(200 / 309);
		expect(answer.stats?.overall.firstTimestamp).toBe(
			Date.parse("2026-11-07T12:00:00.000Z"),
		);
		expect(answer.stats?.byModel.map((m) => m.model)).toEqual([
			"claude-opus-5-5",
			"zai/glm-5.3-flash",
		]);
	});

	test("a missing dir answers the zero totals as a fresh project", () => {
		const answer = scanSessionUsage(join(dir, "no-such-dir", "sessions"));
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall).toEqual(BASE);
		expect(answer.stats?.byModel).toEqual([]);
	});

	test("a malformed record voids the store instead of under-reporting", () => {
		const root = join(dir, "scan-bad");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "1_sess-2.jsonl"),
			`${usageLine({ cost: 9 })}\n{broken\n`,
		);
		const answer = scanSessionUsage(sessions);
		expect(answer.stats).toBeNull();
		expect(answer.error).toContain("not a JSON object");
		expect(answer.error).toContain("1_sess-2.jsonl");
	});

	test("a non-jsonl file is not a transcript and is ignored", () => {
		const root = join(dir, "scan-mixed");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "notes.txt"), "not a transcript");
		writeFileSync(
			join(sessions, "1_sess-3.jsonl"),
			`${usageLine({ cost: 0.5 })}\n`,
		);
		const answer = scanSessionUsage(sessions);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(1);
	});

	test("records without a model or price count as unknown and unpriced", () => {
		const root = join(dir, "scan-unknown");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "1_sess-4.jsonl"),
			[
				JSON.stringify({
					type: "message",
					timestamp: "2026-11-07T13:00:00.000Z",
					message: { role: "assistant", usage: { input: 1, output: 1 } },
				}),
			].join("\n") + "\n",
		);
		const answer = scanSessionUsage(sessions);
		expect(answer.stats?.byModel[0]?.model).toBe("unknown");
		expect(answer.stats?.overall.unpricedRequests).toBe(1);
	});

	test("a file over the per-file cap is skipped with a note, never read", () => {
		const root = join(dir, "scan-oversize");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const small = join(sessions, "1_small.jsonl");
		writeFileSync(small, `${usageLine({ cost: 0.5 })}\n`);
		const big = join(sessions, "2_big.jsonl");
		oversizeFile(big, TRANSCRIPT_MAX_BYTES + 1);
		const answer = scanSessionUsage(sessions);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(1);
		expect(
			noteLines(answer).some(
				(n) => n.startsWith(big) && n.includes("skipped, too large"),
			),
		).toBe(true);
		expect(statSync(big).size).toBe(TRANSCRIPT_MAX_BYTES + 1);
	});

	test("a symlinked transcript is skipped with a note, not followed", () => {
		const root = join(dir, "scan-symlink");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "target.txt"),
			`${usageLine({ cost: 0.5 })}\n`,
		);
		symlinkSync(join(sessions, "target.txt"), join(sessions, "1_link.jsonl"));
		writeFileSync(
			join(sessions, "1_real.jsonl"),
			`${usageLine({ cost: 0.25 })}\n`,
		);
		const answer = scanSessionUsage(sessions);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(1);
		expect(
			noteLines(answer).some(
				(n) => n.includes("1_link.jsonl") && n.includes("a symlink"),
			),
		).toBe(true);
	});

	test("a symlinked dir is not descended", () => {
		const root = join(dir, "scan-symlink-dir");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(
			join(outside, "1_hidden.jsonl"),
			`${usageLine({ cost: 0.5 })}\n`,
		);
		symlinkSync(outside, join(sessions, "linked"));
		writeFileSync(
			join(sessions, "1_a.jsonl"),
			`${usageLine({ cost: 0.25 })}\n`,
		);
		const answer = scanSessionUsage(sessions);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(1);
		expect(
			noteLines(answer).some(
				(n) => n.includes("linked") && n.includes("a symlink"),
			),
		).toBe(true);
	});

	test("a walk deeper than the cap stays unread with a note", () => {
		const root = join(dir, "scan-deep");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "1_a.jsonl"),
			`${usageLine({ cost: 0.25 })}\n`,
		);
		writeFileSync(
			join(deepDir(sessions, "ok-chain", 8), "ok.jsonl"),
			`${usageLine({ cost: 0.5 })}\n`,
		);
		writeFileSync(
			join(deepDir(sessions, "deep-chain", 9), "deep.jsonl"),
			`${usageLine({ cost: 0.75 })}\n`,
		);
		const answer = scanSessionUsage(sessions);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(2);
		expect(
			noteLines(answer).some(
				(n) => n.includes("deep-chain") && n.includes("deeper than"),
			),
		).toBe(true);
	});

	test("a store over the file cap keeps the first 200 and notes the rest", () => {
		const root = join(dir, "scan-count-cap");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		for (let i = 0; i < TRANSCRIPT_MAX_SUB_FILES + 1; i++)
			writeFileSync(
				join(sessions, `${String(i).padStart(3, "0")}_c.jsonl`),
				`${usageLine({ cost: 0.25 })}\n`,
			);
		const answer = scanSessionUsage(sessions);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(TRANSCRIPT_MAX_SUB_FILES);
		expect(
			noteLines(answer).some((n) =>
				n.includes("1 file beyond the 200-file scan cap"),
			),
		).toBe(true);
	});

	test("a trailing partial line waits for its newline like the incremental scan", () => {
		const root = join(dir, "scan-partial");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const file = join(sessions, "1_a.jsonl");
		writeFileSync(file, `${usageLine({ input: 10, cost: 0.25 })}\n`);
		appendFileSync(file, usageLine({ input: 20, cost: 0.5 }));
		const answer = scanSessionUsage(sessions);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(1);
	});

	test("a store over the byte budget skips the files that bust it", () => {
		const root = join(dir, "scan-budget");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		for (const name of ["1_a", "2_b", "3_c", "4_d", "9_big"])
			oversizeFile(join(sessions, `${name}.jsonl`), TRANSCRIPT_MAX_BYTES);
		const answer = scanSessionUsage(sessions);
		expect(answer.error).toBeNull();
		// Four 64 MiB files fill the 256 MiB budget exactly; the fifth stays unread —
		// in any walk order, since a skipped file never advances the budget.
		expect(answer.stats?.overall.totalRequests).toBe(4);
		expect(
			noteLines(answer).filter((n) => n.includes("scan budget is exhausted")),
		).toHaveLength(1);
	});
});

describe("scanSessionUsageIncremental", () => {
	test("parses only the appended tail when a transcript grows", async () => {
		const root = join(dir, "inc-append");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const file = join(sessions, "1_sess.jsonl");
		writeFileSync(
			file,
			[
				usageLine({ input: 10, output: 5, cost: 0.25 }),
				usageLine({ input: 20, output: 6, cost: 0.5 }),
				"",
			].join("\n"),
		);
		const cache = newSessionUsageCache();
		const first = await scanSessionUsageIncremental(sessions, cache);
		expect(first.error).toBeNull();
		expect(first.stats?.overall.totalRequests).toBe(2);
		const appended = `${usageLine({ input: 30, output: 7, cost: 0.25 })}\n`;
		appendFileSync(file, appended);
		const before = cache.parsedBytes;
		const second = await scanSessionUsageIncremental(sessions, cache);
		expect(second.error).toBeNull();
		expect(cache.parsedBytes - before).toBe(Buffer.byteLength(appended));
		expect(second.stats?.overall.totalRequests).toBe(3);
		expect(second.stats?.overall.totalInputTokens).toBe(60);
		expect(second.stats?.overall.totalCost).toBe(1);
		expect(cache.files.get(file)?.size).toBe(statSync(file).size);
	});

	test("a warm rescan of an unchanged dir reads zero bytes", async () => {
		const root = join(dir, "inc-unchanged");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "1_a.jsonl"),
			`${usageLine({ input: 10, cost: 0.25 })}\n`,
		);
		const cache = newSessionUsageCache();
		const first = await scanSessionUsageIncremental(sessions, cache);
		expect(first.error).toBeNull();
		const before = cache.parsedBytes;
		const second = await scanSessionUsageIncremental(sessions, cache);
		expect(second.error).toBeNull();
		expect(cache.parsedBytes - before).toBe(0);
		expect(second.stats).toEqual(first.stats);
	});

	test("a truncated file is re-read in full", async () => {
		const root = join(dir, "inc-truncated");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const file = join(sessions, "1_a.jsonl");
		writeFileSync(
			file,
			[
				usageLine({ input: 10, cost: 0.25 }),
				usageLine({ input: 20, cost: 0.5 }),
				"",
			].join("\n"),
		);
		const cache = newSessionUsageCache();
		const first = await scanSessionUsageIncremental(sessions, cache);
		expect(first.stats?.overall.totalRequests).toBe(2);
		writeFileSync(file, `${usageLine({ input: 10, cost: 0.5 })}\n`);
		const before = cache.parsedBytes;
		const second = await scanSessionUsageIncremental(sessions, cache);
		expect(second.error).toBeNull();
		expect(cache.parsedBytes - before).toBe(statSync(file).size);
		expect(second.stats?.overall.totalRequests).toBe(1);
		expect(second.stats?.overall.totalCost).toBe(0.5);
	});

	test("an mtime moved back forces a full re-read", async () => {
		const root = join(dir, "inc-mtime");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const file = join(sessions, "1_a.jsonl");
		writeFileSync(file, `${usageLine({ cost: 0.25 })}\n`);
		const cache = newSessionUsageCache();
		const first = await scanSessionUsageIncremental(sessions, cache);
		expect(first.stats?.overall.totalRequests).toBe(1);
		const older = new Date(Date.now() - 60_000);
		utimesSync(file, older, older);
		const before = cache.parsedBytes;
		const second = await scanSessionUsageIncremental(sessions, cache);
		expect(second.error).toBeNull();
		expect(cache.parsedBytes - before).toBe(statSync(file).size);
		expect(second.stats?.overall.totalRequests).toBe(1);
	});

	test("a removed file leaves the totals and the cache", async () => {
		const root = join(dir, "inc-removed");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const a = join(sessions, "1_a.jsonl");
		const b = join(sessions, "1_b.jsonl");
		writeFileSync(a, `${usageLine({ model: "model-a", cost: 0.25 })}\n`);
		writeFileSync(b, `${usageLine({ model: "model-b", cost: 0.75 })}\n`);
		const cache = newSessionUsageCache();
		const first = await scanSessionUsageIncremental(sessions, cache);
		expect(first.stats?.overall.totalRequests).toBe(2);
		rmSync(b);
		const second = await scanSessionUsageIncremental(sessions, cache);
		expect(second.error).toBeNull();
		expect(second.stats?.overall.totalRequests).toBe(1);
		expect(second.stats?.byModel.map((m) => m.model)).toEqual(["model-a"]);
		expect(cache.files.has(b)).toBe(false);
		expect(cache.files.has(a)).toBe(true);
	});

	test("matches the sync scan on a main plus subagent layout", async () => {
		const root = join(dir, "inc-parity");
		const sessions = join(root, "sessions");
		const sub = join(sessions, "1_sess-1");
		mkdirSync(sub, { recursive: true });
		// Binary-exact costs so float summation order cannot differ.
		writeFileSync(
			join(sessions, "1_sess-1.jsonl"),
			[
				usageLine({ input: 10, output: 5, cost: 0.25 }),
				'{"type":"session"}',
				"",
			].join("\n"),
		);
		writeFileSync(
			join(sub, "sub-1.jsonl"),
			`${usageLine({ model: "claude-opus-5-5", input: 99, output: 9, cost: 0.75 })}\n`,
		);
		const answer = await scanSessionUsageIncremental(
			sessions,
			newSessionUsageCache(),
		);
		expect(answer.error).toBeNull();
		expect(answer.stats).toEqual(scanSessionUsage(sessions).stats);
	});

	test("a malformed complete line voids the store with the sync wording", async () => {
		const root = join(dir, "inc-bad");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const file = join(sessions, "1_bad.jsonl");
		writeFileSync(file, `${usageLine({ cost: 9 })}\n{broken\n`);
		const answer = await scanSessionUsageIncremental(
			sessions,
			newSessionUsageCache(),
		);
		expect(answer.stats).toBeNull();
		expect(answer.error).toBe(`${file}: a record is not a JSON object`);
	});

	test("a trailing partial line waits for its newline", async () => {
		const root = join(dir, "inc-partial");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const file = join(sessions, "1_a.jsonl");
		writeFileSync(file, usageLine({ input: 10, cost: 0.25 }));
		const cache = newSessionUsageCache();
		const first = await scanSessionUsageIncremental(sessions, cache);
		expect(first.error).toBeNull();
		expect(first.stats?.overall.totalRequests).toBe(0);
		expect(cache.files.get(file)?.size).toBe(0);
		appendFileSync(file, "\n");
		const second = await scanSessionUsageIncremental(sessions, cache);
		expect(second.error).toBeNull();
		expect(second.stats).toEqual(scanSessionUsage(sessions).stats);
	});

	test("a large scan yields to the event loop instead of blocking it", async () => {
		const root = join(dir, "inc-yield");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		for (let i = 0; i < 200; i++)
			writeFileSync(
				join(sessions, `${String(i).padStart(3, "0")}_s.jsonl`),
				`${usageLine({ cost: 0.25 })}\n`,
			);
		const cache = newSessionUsageCache();
		const pending = scanSessionUsageIncremental(sessions, cache);
		let maxGap = 0;
		let last = Date.now();
		// Real wall-clock sampling: fake timers cannot measure true event-loop gaps.
		const sampler = setInterval(() => {
			const now = Date.now();
			if (now - last > maxGap) maxGap = now - last;
			last = now;
		}, 1);
		const answer = await pending.finally(() => clearInterval(sampler));
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(200);
		expect(maxGap).toBeLessThan(100);
	});

	test("a missing dir answers the zero totals as a fresh project", async () => {
		const answer = await scanSessionUsageIncremental(
			join(dir, "no-such-inc", "sessions"),
			newSessionUsageCache(),
		);
		expect(answer.error).toBeNull();
		expect(answer.stats).toEqual({ overall: BASE, byModel: [] });
	});

	test("an over-cap file is skipped with a note and no whole-file read", async () => {
		const root = join(dir, "inc-oversize");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const small = join(sessions, "1_small.jsonl");
		writeFileSync(small, `${usageLine({ cost: 0.5 })}\n`);
		const big = join(sessions, "2_big.jsonl");
		oversizeFile(big, TRANSCRIPT_MAX_BYTES + 1);
		const cache = newSessionUsageCache();
		const answer = await scanSessionUsageIncremental(sessions, cache);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(1);
		expect(
			noteLines(answer).some(
				(n) => n.startsWith(big) && n.includes("skipped, too large"),
			),
		).toBe(true);
		// The proof of no whole-file read: the cache counted only the small file's bytes.
		expect(cache.parsedBytes).toBe(statSync(small).size);
		expect(cache.files.has(big)).toBe(false);
	});

	test("a symlinked transcript is skipped with a note, not followed", async () => {
		const root = join(dir, "inc-symlink");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "target.txt"),
			`${usageLine({ cost: 0.5 })}\n`,
		);
		symlinkSync(join(sessions, "target.txt"), join(sessions, "1_link.jsonl"));
		writeFileSync(
			join(sessions, "1_real.jsonl"),
			`${usageLine({ cost: 0.25 })}\n`,
		);
		const answer = await scanSessionUsageIncremental(
			sessions,
			newSessionUsageCache(),
		);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(1);
		expect(
			noteLines(answer).some(
				(n) => n.includes("1_link.jsonl") && n.includes("a symlink"),
			),
		).toBe(true);
	});

	test("a symlinked dir is not descended", async () => {
		const root = join(dir, "inc-symlink-dir");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(
			join(outside, "1_hidden.jsonl"),
			`${usageLine({ cost: 0.5 })}\n`,
		);
		symlinkSync(outside, join(sessions, "linked"));
		writeFileSync(
			join(sessions, "1_a.jsonl"),
			`${usageLine({ cost: 0.25 })}\n`,
		);
		const answer = await scanSessionUsageIncremental(
			sessions,
			newSessionUsageCache(),
		);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(1);
		expect(
			noteLines(answer).some(
				(n) => n.includes("linked") && n.includes("a symlink"),
			),
		).toBe(true);
	});

	test("a walk deeper than the cap stays unread with a note", async () => {
		const root = join(dir, "inc-deep");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "1_a.jsonl"),
			`${usageLine({ cost: 0.25 })}\n`,
		);
		writeFileSync(
			join(deepDir(sessions, "deep-chain", 9), "deep.jsonl"),
			`${usageLine({ cost: 0.75 })}\n`,
		);
		const answer = await scanSessionUsageIncremental(
			sessions,
			newSessionUsageCache(),
		);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(1);
		expect(
			noteLines(answer).some(
				(n) => n.includes("deep-chain") && n.includes("deeper than"),
			),
		).toBe(true);
	});

	test("a store over the file cap keeps the first 200 and notes the rest", async () => {
		const root = join(dir, "inc-count-cap");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		for (let i = 0; i < TRANSCRIPT_MAX_SUB_FILES + 1; i++)
			writeFileSync(
				join(sessions, `${String(i).padStart(3, "0")}_c.jsonl`),
				`${usageLine({ cost: 0.25 })}\n`,
			);
		const answer = await scanSessionUsageIncremental(
			sessions,
			newSessionUsageCache(),
		);
		expect(answer.error).toBeNull();
		expect(answer.stats?.overall.totalRequests).toBe(TRANSCRIPT_MAX_SUB_FILES);
		expect(
			noteLines(answer).some((n) =>
				n.includes("1 file beyond the 200-file scan cap"),
			),
		).toBe(true);
	});

	test("a store over the byte budget skips the files that bust it", async () => {
		const root = join(dir, "inc-budget");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		for (const name of ["1_a", "2_b", "3_c", "4_d", "9_big"])
			oversizeFile(join(sessions, `${name}.jsonl`), TRANSCRIPT_MAX_BYTES);
		const cache = newSessionUsageCache();
		const answer = await scanSessionUsageIncremental(sessions, cache);
		expect(answer.error).toBeNull();
		// Four 64 MiB files fill the 256 MiB budget exactly; the fifth stays unread —
		// in any walk order, since a skipped file never advances the budget.
		expect(answer.stats?.overall.totalRequests).toBe(4);
		expect(
			noteLines(answer).filter((n) => n.includes("scan budget is exhausted")),
		).toHaveLength(1);
		// The skipped file cost no read: the parsed bytes are the four folded files.
		expect(cache.parsedBytes).toBe(4 * TRANSCRIPT_MAX_BYTES);
		expect(cache.files.size).toBe(4);
	});

	test("an append past the per-file cap keeps the prefix and notes the tail", async () => {
		const root = join(dir, "inc-tail-cap");
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const file = join(sessions, "1_s.jsonl");
		writeFileSync(file, `${usageLine({ input: 10, cost: 0.25 })}\n`);
		const originalSize = statSync(file).size;
		const cache = newSessionUsageCache();
		const first = await scanSessionUsageIncremental(sessions, cache);
		expect(first.stats?.overall.totalRequests).toBe(1);
		appendFileSync(file, `${usageLine({ input: 30, cost: 0.5 })}\n`);
		const fd = openSync(file, "r+");
		ftruncateSync(fd, statSync(file).size + TRANSCRIPT_MAX_BYTES);
		closeSync(fd);
		const before = cache.parsedBytes;
		const second = await scanSessionUsageIncremental(sessions, cache);
		expect(second.error).toBeNull();
		expect(second.stats?.overall.totalRequests).toBe(1);
		expect(
			noteLines(second).some(
				(n) => n.startsWith(file) && n.includes("skipped, too large"),
			),
		).toBe(true);
		// The tail stayed unread and the folded prefix keeps its cache entry.
		expect(cache.parsedBytes - before).toBe(0);
		expect(cache.files.get(file)?.size).toBe(originalSize);
	});
});

describe("mergeOmpStats", () => {
	const row = (
		model: string,
		cost: number,
		requests = 1,
	): OmpStats["byModel"][number] => ({
		...BASE,
		model,
		totalRequests: requests,
		totalCost: cost,
	});

	test("sums counts and cost, recomputes the rates, weights the averages", () => {
		const a = stats({
			totalRequests: 100,
			failedRequests: 4,
			totalInputTokens: 1000,
			totalCacheReadTokens: 9000,
			cacheSavings: 0.5,
			avgDuration: 1000,
			totalCost: 1,
			firstTimestamp: 100,
			lastTimestamp: 200,
		});
		const b = stats({
			totalRequests: 10,
			failedRequests: 1,
			totalInputTokens: 1000,
			totalCacheReadTokens: 0,
			cacheSavings: 0.9,
			avgDuration: 2000,
			totalCost: 2,
			firstTimestamp: 50,
			lastTimestamp: 300,
		});
		const m = mergeOmpStats([a, b]);
		expect(m.overall.totalRequests).toBe(110);
		expect(m.overall.failedRequests).toBe(5);
		expect(m.overall.errorRate).toBeCloseTo(5 / 110);
		expect(m.overall.totalInputTokens).toBe(2000);
		expect(m.overall.cacheRate).toBeCloseTo(9000 / 11000);
		// Request-weighted: (0.5*100 + 0.9*10) / 110, not the plain mean.
		expect(m.overall.cacheSavings).toBeCloseTo((0.5 * 100 + 0.9 * 10) / 110);
		expect(m.overall.avgDuration).toBeCloseTo((1000 * 100 + 2000 * 10) / 110);
		expect(m.overall.totalCost).toBe(3);
		expect(m.overall.firstTimestamp).toBe(50);
		expect(m.overall.lastTimestamp).toBe(300);
	});

	test("folds byModel by model, sorted by cost first", () => {
		const m = mergeOmpStats([
			stats({}, [row("m", 1), row("other", 4)]),
			stats({}, [row("m", 2)]),
		]);
		expect(m.byModel[0]).toMatchObject({ model: "other", totalCost: 4 });
		expect(m.byModel[1]).toMatchObject({ model: "m", totalCost: 3 });
	});

	test("an empty merge answers the zero totals with no rows", () => {
		const m = mergeOmpStats([]);
		expect(m.overall).toEqual(BASE);
		expect(m.byModel).toEqual([]);
	});
});

describe("buildOmpStatsReport", () => {
	test("merges across stores; every source keeps its own answer", () => {
		const board = stats({ totalRequests: 3, totalCost: 3 });
		const project = stats({ totalRequests: 7, totalCost: 7 });
		const sources: OmpStatsSource[] = [
			{ name: "board store", answer: { stats: board, error: null } },
			{ name: "lumen", answer: { stats: project, error: null } },
			{ name: "worker-gone", answer: { stats: null, error: "down" } },
		];
		const report = buildOmpStatsReport(sources, 1234);
		expect(report.at).toBe(1234);
		expect(report.sources).toHaveLength(3);
		expect(report.overall.totalRequests).toBe(10);
		expect(report.overall.totalCost).toBe(10);
	});
});
