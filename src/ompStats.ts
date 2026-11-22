// omp usage: the board sums the usage records of omp session transcripts itself. omp's
// `stats` command only syncs the default session store under ~/.omp/agent/sessions, while
// tracker turns write their transcripts to each project's sessions dir (--session-dir), so
// the CLI sees almost none of the fleet's usage. The board scans every project dir it
// mounts plus the default stores and aggregates the same per-message records omp's rollups
// use: assistant messages carrying usage (input/output/cacheRead/cacheWrite/cost/model).
import { type Dirent, lstatSync, readdirSync, type Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	isSizeRefusal,
	readBoundedFile,
	readRegular,
	readTailBounded,
} from "./confine.ts";
import {
	TRANSCRIPT_MAX_BYTES,
	TRANSCRIPT_MAX_SUB_FILES,
	TRANSCRIPT_MAX_TOTAL_BYTES,
} from "./session.ts";

/** One omp usage total block: the rollup fields the Settings card shows. Rates and
 *  averages that transcripts cannot prove (request failures, durations, omp's cost-model
 *  savings) stay null — a null is "no basis", never a fabricated zero. Durations would be
 *  milliseconds; timestamps are epoch ms. */
export interface OmpUsageTotals {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	errorRate: number | null;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	/** cacheRead / (input + cacheRead), omp's own formula; null without a denominator. */
	cacheRate: number | null;
	/** Not derivable from transcripts: null. */
	cacheSavings: number | null;
	totalCost: number;
	/** Requests whose model priced nothing while tokens moved. */
	unpricedRequests: number;
	totalPremiumRequests: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	firstTimestamp: number | null;
	lastTimestamp: number | null;
}

/** One model's totals in the report's byModel list. */
export interface OmpModelUsage extends OmpUsageTotals {
	model: string;
}

/** The aggregated usage of one store: overall totals plus one row per model. */
export interface OmpStats {
	overall: OmpUsageTotals;
	byModel: OmpModelUsage[];
}

/** What one store's scan answers: parsed numbers, or the reason there are none. Always a
 *  200-shaped answer — a failed read is data, not a failed request. */
export interface OmpStatsAnswer {
	stats: OmpStats | null;
	error: string | null;
	/** One line per file this scan left unread: over the per-file budget, over the scan's
	 *  count or byte caps, or a symlink it refused to follow. The totals fold only the
	 *  files that were read, so each note names usage the totals leave out. Absent when
	 *  nothing was skipped. */
	notes?: string[];
}

/** One scanned store for the report: the board's or the workers' default omp store, or a
 *  project's turn-session dir (name = the project). */
export interface OmpStatsSource {
	name: string;
	answer: OmpStatsAnswer;
}

/** The Settings card payload: every source's answer plus totals + per-model rows merged
 *  across the stores. */
export interface OmpStatsReport {
	at: number;
	sources: OmpStatsSource[];
	overall: OmpUsageTotals;
	byModel: OmpModelUsage[];
}

const isCount = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0;

const isRate = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);

/** Epoch ms of an ISO timestamp; null when the record carries none omp would window by. */
function ts(v: unknown): number | null {
	if (typeof v !== "string") return null;
	const at = Date.parse(v);
	return Number.isNaN(at) ? null : at;
}

const ZEROS: OmpUsageTotals = {
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

/** Merges totals blocks: counts and cost sum; errorRate and cacheRate recompute from the
 *  summed counts (cacheRate = cacheRead / (input + cacheRead), omp's formula on 18.14.0);
 *  the request-weighted averages carry over; timestamps span. */
function mergeTotals(rows: OmpUsageTotals[]): OmpUsageTotals {
	if (rows.length === 0) return { ...ZEROS };
	const sum = (pick: (r: OmpUsageTotals) => number): number =>
		rows.reduce((n, r) => n + pick(r), 0);
	const total = sum((r) => r.totalRequests);
	const input = sum((r) => r.totalInputTokens);
	const cacheRead = sum((r) => r.totalCacheReadTokens);
	// Request-weighted: an average over merged stores must weight each store by its
	// request count, not by store count. Stores without a value contribute nothing.
	const weighted = (
		pick: (r: OmpUsageTotals) => number | null,
	): number | null => {
		let acc = 0;
		let weight = 0;
		for (const r of rows) {
			const v = pick(r);
			if (v !== null) {
				acc += v * r.totalRequests;
				weight += r.totalRequests;
			}
		}
		return weight > 0 ? acc / weight : null;
	};
	const first = rows.flatMap((r) =>
		r.firstTimestamp === null ? [] : [r.firstTimestamp],
	);
	const last = rows.flatMap((r) =>
		r.lastTimestamp === null ? [] : [r.lastTimestamp],
	);
	return {
		totalRequests: total,
		successfulRequests: sum((r) => r.successfulRequests),
		failedRequests: sum((r) => r.failedRequests),
		errorRate: total > 0 ? sum((r) => r.failedRequests) / total : null,
		totalInputTokens: input,
		totalOutputTokens: sum((r) => r.totalOutputTokens),
		totalCacheReadTokens: cacheRead,
		totalCacheWriteTokens: sum((r) => r.totalCacheWriteTokens),
		cacheRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
		cacheSavings: weighted((r) => r.cacheSavings),
		totalCost: sum((r) => r.totalCost),
		unpricedRequests: sum((r) => r.unpricedRequests),
		totalPremiumRequests: sum((r) => r.totalPremiumRequests),
		avgDuration: weighted((r) => r.avgDuration),
		avgTtft: weighted((r) => r.avgTtft),
		avgTokensPerSecond: weighted((r) => r.avgTokensPerSecond),
		firstTimestamp: first.length > 0 ? Math.min(...first) : null,
		lastTimestamp: last.length > 0 ? Math.max(...last) : null,
	};
}

/** Folds parsed stats blocks into one: totals sum, byModel rows fold by model with the
 *  same merge rules. Empty input answers the zero totals with no rows. */
export function mergeOmpStats(stats: OmpStats[]): OmpStats {
	const rows = new Map<string, OmpUsageTotals[]>();
	for (const s of stats) {
		for (const m of s.byModel) {
			const list = rows.get(m.model) ?? [];
			list.push(m);
			rows.set(m.model, list);
		}
	}
	return {
		overall: mergeTotals(stats.map((s) => s.overall)),
		byModel: [...rows.entries()]
			.map(([model, list]) => ({ ...mergeTotals(list), model }))
			.sort((a, b) =>
				b.totalCost !== a.totalCost
					? b.totalCost - a.totalCost
					: a.model.localeCompare(b.model),
			),
	};
}

/** Builds the report: totals and per-model rows merged across the stores; every source
 *  keeps its own answer either way, so the breakdown shows what each store reported. */
export function buildOmpStatsReport(
	sources: OmpStatsSource[],
	at: number,
): OmpStatsReport {
	const merged = mergeOmpStats(
		sources.flatMap((s) => (s.answer.stats === null ? [] : [s.answer.stats])),
	);
	return { at, sources, overall: merged.overall, byModel: merged.byModel };
}

/** One usage record: an assistant message's usage (retro.ts reads the same shape). */
interface UsageRecord {
	model: string;
	timestamp: number | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** The cost.total of one usage object when it is a rate; 0 otherwise. */
function parseCost(u: object): number {
	if ("cost" in u && typeof u.cost === "object" && u.cost !== null) {
		const c: object = u.cost;
		if ("total" in c && isRate(c.total)) return c.total;
	}
	return 0;
}

/** One usage record from a parsed message line; fields without values read as 0. */
function usageFields(d: object, m: object, u: object): UsageRecord {
	const count = (v: unknown): number => (isCount(v) ? v : 0);
	const model =
		"model" in m && typeof m.model === "string" && m.model.length > 0
			? m.model
			: "unknown";
	return {
		model,
		timestamp: ts("timestamp" in d ? d.timestamp : undefined),
		input: count("input" in u ? u.input : undefined),
		output: count("output" in u ? u.output : undefined),
		cacheRead: count("cacheRead" in u ? u.cacheRead : undefined),
		cacheWrite: count("cacheWrite" in u ? u.cacheWrite : undefined),
		cost: parseCost(u),
	};
}

/** One record from one parsed line. Null = malformed (voids the file); undefined = a line
 *  without usage, skipped. */
function parseUsageRecord(d: unknown): UsageRecord | null | undefined {
	if (typeof d !== "object" || d === null) return null;
	if (!("type" in d) || d.type !== "message") return undefined;
	if (!("message" in d) || typeof d.message !== "object" || d.message === null)
		return undefined;
	const m: object = d.message;
	if (!("role" in m) || m.role !== "assistant") return undefined;
	if (!("usage" in m) || typeof m.usage !== "object" || m.usage === null)
		return undefined;
	return usageFields(d, m, m.usage as object);
}

/** Collects the usage records of one transcript text. Null when a non-blank line is not a
 *  JSON object: a skipped record could hide usage, so one malformed line voids the file
 *  (the same strictness the turn-cost backfill applies). */
function readUsageRecords(text: string): UsageRecord[] | null {
	const out: UsageRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let d: unknown;
		try {
			d = JSON.parse(line);
		} catch {
			return null;
		}
		const rec = parseUsageRecord(d);
		if (rec === undefined) continue;
		if (rec === null) return null;
		out.push(rec);
	}
	return out;
}

/** Aggregates usage records into one store's stats. Each record is one request; failures
 *  leave no assistant message, so they are invisible here and the rates that need them
 *  stay null. */
function aggregate(records: UsageRecord[]): OmpStats {
	const totals = (rows: UsageRecord[]): OmpUsageTotals => {
		if (rows.length === 0) return { ...ZEROS };
		const sum = (pick: (r: UsageRecord) => number): number =>
			rows.reduce((n, r) => n + pick(r), 0);
		const input = sum((r) => r.input);
		const cacheRead = sum((r) => r.cacheRead);
		const first = rows.flatMap((r) =>
			r.timestamp === null ? [] : [r.timestamp],
		);
		const last = rows.flatMap((r) =>
			r.timestamp === null ? [] : [r.timestamp],
		);
		return {
			totalRequests: rows.length,
			successfulRequests: rows.length,
			failedRequests: 0,
			errorRate: null,
			totalInputTokens: input,
			totalOutputTokens: sum((r) => r.output),
			totalCacheReadTokens: cacheRead,
			totalCacheWriteTokens: sum((r) => r.cacheWrite),
			cacheRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
			cacheSavings: null,
			totalCost: sum((r) => r.cost),
			unpricedRequests: rows.filter(
				(r) =>
					r.cost === 0 && r.input + r.output + r.cacheRead + r.cacheWrite > 0,
			).length,
			totalPremiumRequests: 0,
			avgDuration: null,
			avgTtft: null,
			avgTokensPerSecond: null,
			firstTimestamp: first.length > 0 ? Math.min(...first) : null,
			lastTimestamp: last.length > 0 ? Math.max(...last) : null,
		};
	};
	const byModelRows = new Map<string, UsageRecord[]>();
	for (const r of records) {
		const list = byModelRows.get(r.model) ?? [];
		list.push(r);
		byModelRows.set(r.model, list);
	}
	return {
		overall: totals(records),
		byModel: [...byModelRows.entries()]
			.map(([model, rows]) => ({ ...totals(rows), model }))
			.sort((a, b) =>
				b.totalCost !== a.totalCost
					? b.totalCost - a.totalCost
					: a.model.localeCompare(b.model),
			),
	};
}

/** The deepest dir levels a walk descends below the sessions dir: legit trees are
 *  `<ts>_<id>.jsonl` mains plus sibling `<ts>_<id>/` subagent dirs, two levels deep. */
const MAX_WALK_DEPTH = 8;

/** One entry a walk either descends into, lists as a transcript, refuses with a note, or
 *  ignores the way every walk did. */
type WalkEntry =
	| { kind: "descend" }
	| { kind: "transcript" }
	| { kind: "note"; note: string }
	| { kind: "ignore" };

/** Classifies one dirent without ever stat-ing through it, so no entry is followed: omp
 *  itself skips symlinks in its sessions tree, and a walk that followed one could leave
 *  the worker-writable volume the store lives on. */
function classifyWalkEntry(entry: Dirent, path: string): WalkEntry {
	if (entry.isSymbolicLink())
		return { kind: "note", note: `${path}: skipped, a symlink` };
	if (entry.isDirectory()) return { kind: "descend" };
	if (entry.name.endsWith(".jsonl"))
		return entry.isFile()
			? { kind: "transcript" }
			: { kind: "note", note: `${path}: skipped, not a regular file` };
	return { kind: "ignore" };
}

/** A walk's file list plus the notes it collected: symlinks, non-regular entries named
 *  like transcripts, and dirs beyond the depth cap stay unread with a note, so a partial
 *  listing is never silent. */
interface WalkResult {
	files: string[];
	notes: string[];
}

/** Caps a walk's file list at the scan's file-count cap, noting what stays unread. */
function capFiles(files: string[], notes: string[]): string[] {
	if (files.length <= TRANSCRIPT_MAX_SUB_FILES) return files;
	const over = files.length - TRANSCRIPT_MAX_SUB_FILES;
	notes.push(
		`${over} ${over === 1 ? "file" : "files"} beyond the ${TRANSCRIPT_MAX_SUB_FILES}-file scan cap stayed unread`,
	);
	return files.slice(0, TRANSCRIPT_MAX_SUB_FILES);
}

/** Every transcript file under a sessions dir: `<ts>_<id>.jsonl` mains plus the sibling
 *  `<ts>_<id>/` dirs of subagent transcripts, recursively to MAX_WALK_DEPTH. */
function walkJsonl(dir: string): WalkResult {
	const files: string[] = [];
	const notes: string[] = [];
	const visit = (at: string, depth: number): void => {
		let names: Dirent[];
		try {
			names = readdirSync(at, { withFileTypes: true });
		} catch (err) {
			// Only a dir that does not exist means "no sessions yet" (a fresh project).
			const absent =
				err instanceof Error && "code" in err && err.code === "ENOENT";
			if (absent) return;
			throw err;
		}
		for (const entry of names) {
			const path = join(at, entry.name);
			const kind = classifyWalkEntry(entry, path);
			if (kind.kind === "ignore") continue;
			if (kind.kind === "note") {
				notes.push(kind.note);
				continue;
			}
			if (kind.kind === "transcript") {
				files.push(path);
				continue;
			}
			if (depth + 1 > MAX_WALK_DEPTH) {
				notes.push(
					`${path}: skipped, deeper than ${MAX_WALK_DEPTH} walk levels`,
				);
				continue;
			}
			visit(path, depth + 1);
		}
	};
	visit(dir, 0);
	return { files, notes };
}

/** Scans one store's sessions dir and sums its usage records. A missing dir answers the
 *  zero totals (a fresh project); an unreadable dir or file, or a malformed record in one,
 *  answers { stats: null, error } naming the cause — a partial sum would under-report.
 *  The store sits on a worker-writable volume, so nothing is read whole without bound:
 *  each file goes through the confinement reader with the session.ts per-file budget, and
 *  the scan adds a walk-depth cap, a file-count cap, and a total byte budget. What a cap
 *  or a symlink leaves unread comes back in `notes`, one line each — the totals fold only
 *  the files that were read, so every note names usage the totals leave out. Only complete
 *  lines are ever parsed: a trailing line without a newline is skipped this scan and
 *  parsed once its newline lands, the same rule the incremental scan applies. */
export function scanSessionUsage(sessionsDir: string): OmpStatsAnswer {
	let walked: WalkResult;
	try {
		walked = walkJsonl(sessionsDir);
	} catch (err) {
		return {
			stats: null,
			error: `${sessionsDir}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const notes = walked.notes;
	const files = capFiles(walked.files, notes);
	const records: UsageRecord[] = [];
	let budgetBytes = 0;
	for (const file of files) {
		let st: Stats;
		try {
			st = lstatSync(file);
		} catch (err) {
			return { stats: null, error: `${file}: ${ioReason(err)}` };
		}
		if (st.isSymbolicLink()) {
			notes.push(`${file}: skipped, a symlink`);
			continue;
		}
		if (budgetBytes + st.size > TRANSCRIPT_MAX_TOTAL_BYTES) {
			notes.push(
				`${file}: skipped, the ${TRANSCRIPT_MAX_TOTAL_BYTES}-byte scan budget is exhausted`,
			);
			continue;
		}
		let text: string;
		try {
			text = readRegular(file, TRANSCRIPT_MAX_BYTES).toString("utf8");
		} catch (err) {
			if (isSizeRefusal(err)) {
				notes.push(`${file}: skipped, too large`);
				continue;
			}
			return { stats: null, error: `${file}: ${ioReason(err)}` };
		}
		// Only complete lines are ever parsed, the incremental scan's rule: a trailing
		// line without a newline is skipped this scan and parsed once its newline lands,
		// so both scans agree on a transcript caught mid-write.
		const cut = text.lastIndexOf("\n");
		const read = readUsageRecords(cut === -1 ? "" : text.slice(0, cut + 1));
		if (read === null)
			return {
				stats: null,
				error: `${file}: a record is not a JSON object`,
			};
		budgetBytes += st.size;
		records.push(...read);
	}
	return {
		stats: aggregate(records),
		error: null,
		...(notes.length > 0 ? { notes } : {}),
	};
}

/** Per-file scan state; `stats` holds the usage totals of the file's complete lines. */
export interface SessionUsageCache {
	files: Map<string, { size: number; mtimeMs: number; stats: OmpStats }>;
	/** Cumulative bytes actually read from disk for parsing — the tests' parsed-bytes count. */
	parsedBytes: number;
}

export function newSessionUsageCache(): SessionUsageCache {
	return { files: new Map(), parsedBytes: 0 };
}

/** The message a failed walk, stat, or read answers with. */
const ioReason = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

/** Folds per-file stats blocks with mergeOmpStats. The merge recomputes errorRate as
 *  failed/total, but these blocks come from aggregate, which keeps errorRate null
 *  because transcripts cannot prove failures — so the fold restores that null instead
 *  of a fabricated 0. */
function foldStats(stats: OmpStats[]): OmpStats {
	const calm = <T extends OmpUsageTotals>(r: T): T =>
		r.failedRequests === 0 && r.errorRate !== null
			? { ...r, errorRate: null }
			: r;
	const merged = mergeOmpStats(stats);
	return {
		overall: calm(merged.overall),
		byModel: merged.byModel.map((m) => calm(m)),
	};
}

/** Every transcript file under a sessions dir, listed without blocking the event loop:
 *  the async twin of walkJsonl. */
async function walkJsonlAsync(dir: string): Promise<WalkResult> {
	const files: string[] = [];
	const notes: string[] = [];
	const visit = async (at: string, depth: number): Promise<void> => {
		let names: Dirent[];
		try {
			names = await readdir(at, { withFileTypes: true });
		} catch (err) {
			// Only a dir that does not exist means "no sessions yet" (a fresh project).
			const absent =
				err instanceof Error && "code" in err && err.code === "ENOENT";
			if (absent) return;
			throw err;
		}
		for (const entry of names) {
			const path = join(at, entry.name);
			const kind = classifyWalkEntry(entry, path);
			if (kind.kind === "ignore") continue;
			if (kind.kind === "note") {
				notes.push(kind.note);
				continue;
			}
			if (kind.kind === "transcript") {
				files.push(path);
				continue;
			}
			if (depth + 1 > MAX_WALK_DEPTH) {
				notes.push(
					`${path}: skipped, deeper than ${MAX_WALK_DEPTH} walk levels`,
				);
				continue;
			}
			await visit(path, depth + 1);
		}
	};
	await visit(dir, 0);
	return { files, notes };
}

/** Scans one store's sessions dir without blocking the event loop, resuming from the
 *  cache: a file whose size and mtime are unchanged reuses its stored totals and reads
 *  0 bytes, an append parses only the new tail, and anything else (first sight, a
 *  shrink, an mtime moved back) is re-read in full. Only complete lines are ever
 *  parsed: a trailing line without a newline is skipped this scan and parsed once its
 *  newline lands — the sync scan now applies the same rule, so a transcript caught
 *  mid-write parses identically in both. Per file the cache keeps one aggregate, so an
 *  append folds the tail's
 *  records into the stored stats instead of keeping raw records around. A missing dir
 *  answers the zero totals (a fresh project); an unreadable dir or file, or a malformed
 *  record in one, answers { stats: null, error } naming the cause — a partial sum would
 *  under-report. Files the walk no longer lists leave the totals and the cache. The
 *  store sits on a worker-writable volume, so nothing is read whole without bound:
 *  every read goes through the confinement readers with the session.ts per-file budget,
 *  and the scan adds a walk-depth cap, a file-count cap, and a total byte budget. What
 *  a cap or a symlink leaves unread comes back in `notes`, one line each — the totals
 *  fold only what was read (a capped append keeps its scanned prefix), so every note
 *  names usage the totals leave out. */
export async function scanSessionUsageIncremental(
	sessionsDir: string,
	cache: SessionUsageCache,
): Promise<OmpStatsAnswer> {
	let walked: WalkResult;
	try {
		walked = await walkJsonlAsync(sessionsDir);
	} catch (err) {
		return { stats: null, error: `${sessionsDir}: ${ioReason(err)}` };
	}
	const notes = walked.notes;
	const files = capFiles(walked.files, notes);
	const seen = new Set<string>();
	const perFile: OmpStats[] = [];
	let budgetBytes = 0;
	for (const file of files) {
		// One yield per file: the sync scan starves the event loop for the whole store.
		await new Promise<void>((resolve) => setImmediate(resolve));
		let st: Stats;
		try {
			st = await lstat(file);
		} catch (err) {
			return { stats: null, error: `${file}: ${ioReason(err)}` };
		}
		// A symlink swapped in after the walk stays unread: the lstat never follows one.
		if (st.isSymbolicLink()) {
			notes.push(`${file}: skipped, a symlink`);
			continue;
		}
		const prev = cache.files.get(file);
		if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
			seen.add(file);
			perFile.push(prev.stats);
			continue;
		}
		if (prev && st.size >= prev.size && st.mtimeMs >= prev.mtimeMs) {
			// Append: everything new lives past the consumed prefix.
			const newBytes = st.size - prev.size;
			if (newBytes > TRANSCRIPT_MAX_BYTES) {
				notes.push(`${file}: skipped, too large`);
				seen.add(file);
				perFile.push(prev.stats);
				continue;
			}
			if (budgetBytes + newBytes > TRANSCRIPT_MAX_TOTAL_BYTES) {
				notes.push(
					`${file}: skipped, the ${TRANSCRIPT_MAX_TOTAL_BYTES}-byte scan budget is exhausted`,
				);
				seen.add(file);
				perFile.push(prev.stats);
				continue;
			}
			let tail: string;
			try {
				tail = (
					await readTailBounded(file, prev.size, TRANSCRIPT_MAX_BYTES)
				).toString("utf8");
			} catch (err) {
				if (isSizeRefusal(err)) {
					notes.push(`${file}: skipped, too large`);
					seen.add(file);
					perFile.push(prev.stats);
					continue;
				}
				return { stats: null, error: `${file}: ${ioReason(err)}` };
			}
			cache.parsedBytes += Buffer.byteLength(tail, "utf8");
			const cut = tail.lastIndexOf("\n");
			if (cut === -1) {
				// No newline landed yet: the tail is a partial line, keep waiting for it.
				seen.add(file);
				perFile.push(prev.stats);
				continue;
			}
			const consumed = tail.slice(0, cut + 1);
			const records = readUsageRecords(consumed);
			if (records === null)
				return { stats: null, error: `${file}: a record is not a JSON object` };
			const stats = foldStats([prev.stats, aggregate(records)]);
			cache.files.set(file, {
				size: prev.size + Buffer.byteLength(consumed, "utf8"),
				mtimeMs: st.mtimeMs,
				stats,
			});
			seen.add(file);
			perFile.push(stats);
			budgetBytes += newBytes;
			continue;
		}
		// First sight, a shrink, or an mtime moved back: only a full read tells the truth.
		if (budgetBytes + st.size > TRANSCRIPT_MAX_TOTAL_BYTES) {
			notes.push(
				`${file}: skipped, the ${TRANSCRIPT_MAX_TOTAL_BYTES}-byte scan budget is exhausted`,
			);
			continue;
		}
		let text: string;
		try {
			text = (await readBoundedFile(file, TRANSCRIPT_MAX_BYTES)).toString(
				"utf8",
			);
		} catch (err) {
			if (isSizeRefusal(err)) {
				notes.push(`${file}: skipped, too large`);
				continue;
			}
			return { stats: null, error: `${file}: ${ioReason(err)}` };
		}
		cache.parsedBytes += Buffer.byteLength(text, "utf8");
		const cut = text.lastIndexOf("\n");
		const complete = cut === -1 ? "" : text.slice(0, cut + 1);
		const records = readUsageRecords(complete);
		if (records === null)
			return { stats: null, error: `${file}: a record is not a JSON object` };
		const stats = aggregate(records);
		cache.files.set(file, {
			size: Buffer.byteLength(complete, "utf8"),
			mtimeMs: st.mtimeMs,
			stats,
		});
		seen.add(file);
		perFile.push(stats);
		budgetBytes += st.size;
	}
	// A file the walk no longer lists is gone; drop it so its totals leave too.
	for (const path of cache.files.keys())
		if (!seen.has(path)) cache.files.delete(path);
	return {
		stats: foldStats(perFile),
		error: null,
		...(notes.length > 0 ? { notes } : {}),
	};
}
