/**
 * Fails when bun.lock took a dependency version while its release line is
 * unsettled (OTTR-909): a newer stable release of the same major.minor line
 * is still younger than the 7-day release age gate, so the pin would be
 * replaced within days. Runs inside `bun run check` only when bun.lock
 * differs from origin/main; without a lock change it makes no network call.
 * The rule lives in src/releaseLine.ts and the scan's shared core in
 * src/releaseLineScan.ts (docs/specs/release-line-gate.md).
 */
import { readRegular } from "../src/confine.ts";
import { RELEASE_LINE_MARKER } from "../src/releaseLine.ts";
import {
	AGE_MS,
	CAP_MS,
	directNamesOf,
	fetchReleases,
	LOCK_MAX_BYTES,
	type ReleaseLineScan,
	scanReleaseLines,
} from "../src/releaseLineScan.ts";

const DAY_MS = 86_400_000;
/** Packument body budget for the script's own fetches: larger than the
 * board's 64 KiB so a legitimately big packument still passes, bounded so a
 * registry answer can never fill the worker's memory. */
const SCRIPT_BODY_MAX_BYTES = 8 * 1024 * 1024;

/** git inside the repo root; stdin ignored so nothing can hang on a prompt. */
function git(...args: string[]): {
	code: number;
	stdout: string;
	stderr: string;
} {
	const r = Bun.spawnSync(["git", ...args], {
		cwd: process.cwd(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: r.exitCode ?? 1,
		stdout: r.stdout.toString(),
		stderr: r.stderr.toString(),
	};
}

/** origin/main's bun.lock text; a base without the file is an empty base map. */
function baseLockText(): string {
	const shown = git("show", "origin/main:bun.lock");
	return shown.code === 0 ? shown.stdout : "";
}

/** The scan: the shared core in src/releaseLineScan.ts does the fetches; this
 * prints. A lock or registry failure exits 1 immediately; direct failures
 * collect to the end, transitive ones warn inline and keep the exit 0. */
async function scan(): Promise<number> {
	const now = Date.now();
	const scan: ReleaseLineScan = await scanReleaseLines({
		// The worktree is worker-writable: bounded reads, never readFileSync.
		lockText: readRegular("bun.lock", LOCK_MAX_BYTES).toString("utf8"),
		baseLockText: baseLockText(),
		directNames: directNamesOf(
			readRegular("package.json", LOCK_MAX_BYTES).toString("utf8"),
		),
		fetch: (name) => fetchReleases(name, SCRIPT_BODY_MAX_BYTES),
		now,
		ageMs: AGE_MS,
		capMs: CAP_MS,
	});
	if (!scan.ok) {
		console.error(
			`release line check failed: ${scan.failed.name}: ${scan.failed.message}`,
		);
		return 1;
	}
	for (const t of scan.transitive) {
		const days = Math.floor((now - t.blocker.publishedAt) / DAY_MS);
		console.error(
			`warning: release line not settled: ${t.name} ${t.version}, ${t.blocker.version} is ${days} days old (transitive)`,
		);
	}
	const failures = scan.direct.map((t) => {
		const days = Math.floor((now - t.blocker.publishedAt) / DAY_MS);
		return `release line not settled: ${t.name} ${t.version}, ${t.blocker.version} is ${days} days old`;
	});
	for (const line of failures) console.error(line);
	// OTTR-960: the machine-readable clear times the board's hold reads.
	const blocked = scan.direct.map(({ name, version, waitUntilMs }) => ({
		name,
		version,
		waitUntilMs,
	}));
	if (blocked.length > 0)
		console.log(`${RELEASE_LINE_MARKER}${JSON.stringify({ blocked })}`);
	return failures.length > 0 ? 1 : 0;
}

async function main(): Promise<number> {
	if (git("rev-parse", "--verify", "origin/main").code !== 0) {
		console.error(
			"release line check: cannot resolve origin/main; run git fetch origin",
		);
		return 1;
	}
	const diff = git("diff", "--quiet", "origin/main", "--", "bun.lock");
	if (diff.code === 0) return 0; // unchanged: silent exit, no network call
	if (diff.code !== 1) return 1; // any other git failure
	return scan();
}

if (import.meta.main) process.exit(await main());
