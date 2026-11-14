/**
 * The release line gate (docs/specs/release-line-gate.md): wait for a release line to settle
 * before taking a version. One pure module holds the rule; the omp watch's bumpTarget and
 * the bun.lock release line check both use it, so nothing here imports the watcher.
 */

export type RegistryRelease = {
	version: string; // registry version string; stable is exactly x.y.z
	publishedAt: number; // publish time, ms epoch
	deprecated?: boolean;
};

/** The machine-readable report the bun.lock check prints when a direct package is
 * blocked (OTTR-960): one stdout line `RELEASE_LINE_MARKER + {json}`, after the human
 * failure lines. The board's gate probe triggers the test gate on it, and the hold
 * parses the blocked packages and their clear times from it. */
export const RELEASE_LINE_MARKER = "release line blocked: ";

const STABLE_RE = /^\d+\.\d+\.\d+$/;

/** Numeric x.y.z order; both sides must be stable x.y.z. Moved here from src/ompWatch.ts. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** A release counts when it is stable and not deprecated. */
const counts = (r: RegistryRelease): boolean =>
	STABLE_RE.test(r.version) && r.deprecated !== true;

const isAged = (r: RegistryRelease, now: number, ageMs: number): boolean =>
	now - r.publishedAt >= ageMs;

const lineKey = (version: string): string =>
	version.split(".").slice(0, 2).join(".");

/** The oldest counted release of a line's aged ones, by version order. */
const oldestAged = (
	line: RegistryRelease[],
	now: number,
	ageMs: number,
): RegistryRelease =>
	line
		.filter((r) => isAged(r, now, ageMs))
		.reduce((a, b) => (compareVersions(a.version, b.version) < 0 ? a : b));

/**
 * The wait of `version`'s line, floored at `floor` when given: `now - publishedAt` of the
 * oldest aged counted release at or above the floor, or null when the line holds no aged
 * counted release (the wait has not started) or no young one (nothing waits).
 */
function lineWait(
	releases: RegistryRelease[],
	version: string,
	now: number,
	ageMs: number,
	floor?: string,
): number | null {
	const line = releases
		.filter(counts)
		.filter(
			(r) =>
				lineKey(r.version) === lineKey(version) &&
				(floor === undefined || compareVersions(r.version, floor) >= 0),
		);
	const aged = line.filter((r) => isAged(r, now, ageMs));
	if (aged.length === 0 || aged.length === line.length) return null;
	return now - oldestAged(line, now, ageMs).publishedAt;
}

/** The rule above; result is the pick's version string or null (keep the current). */
export function settledLineTarget(
	releases: RegistryRelease[],
	now: number,
	ageMs: number,
	capMs: number,
): string | null {
	const candidates = releases
		.filter(counts)
		.filter((r) => isAged(r, now, ageMs));
	let pick: RegistryRelease | undefined;
	for (const r of candidates) {
		if (!releaseLineAccepts(releases, r.version, now, ageMs, capMs)) continue;
		if (pick === undefined || compareVersions(r.version, pick.version) > 0)
			pick = r;
	}
	if (pick !== undefined) return pick.version;
	// The cap: with no accepted release, today's pick only when some line waited too long.
	const waited = candidates.some(
		(r) => (lineWait(releases, r.version, now, ageMs) ?? 0) > capMs,
	);
	if (!waited) return null;
	const newest = candidates.reduce((a, b) =>
		compareVersions(a.version, b.version) > 0 ? a : b,
	);
	return newest.version;
}

/** True when `version` is accepted: counted, aged, its line is settled above it, or the
 * wait for its line (line-wide over `releases`, the candidate list) exceeds capMs. */
export function releaseLineAccepts(
	releases: RegistryRelease[],
	version: string,
	now: number,
	ageMs: number,
	capMs: number,
): boolean {
	if (unsettledBlocker(releases, version, now, ageMs) !== null) {
		// The cap lifts the wait of the candidate's own line only, counted line-wide.
		const wait = lineWait(releases, version, now, ageMs);
		return wait !== null && wait > capMs;
	}
	return true;
}

/** The newest counted release above `version` in its line that is younger than ageMs,
 * or null when the line is settled above `version`. The script's report names it. */
export function unsettledBlocker(
	releases: RegistryRelease[],
	version: string,
	now: number,
	ageMs: number,
): RegistryRelease | null {
	let blocker: RegistryRelease | null = null;
	for (const r of releases) {
		if (!counts(r)) continue;
		if (lineKey(r.version) !== lineKey(version)) continue;
		if (compareVersions(r.version, version) <= 0) continue;
		if (isAged(r, now, ageMs)) continue;
		if (blocker === null || compareVersions(r.version, blocker.version) > 0)
			blocker = r;
	}
	return blocker;
}

/** True when `version`'s line's wait exceeds capMs, measured from the oldest aged counted
 * release at or above `version` in that line (the cap definition above; `version` is the
 * candidate floor, for the script the installed version). */
export function lineCapReached(
	releases: RegistryRelease[],
	version: string,
	now: number,
	ageMs: number,
	capMs: number,
): boolean {
	const wait = lineWait(releases, version, now, ageMs, version);
	return wait !== null && wait > capMs;
}

/**
 * The earliest epoch ms at which the gate passes for `version` (OTTR-960): the earlier of
 * its line's settle time (the newest young counted release above it turns `ageMs` old)
 * and its line's cap time (the oldest aged counted release at or above it plus `capMs`).
 * Null when `version` is not blocked now: the board holds a card only for a future time.
 */
export function releaseLineWaitUntil(
	releases: RegistryRelease[],
	version: string,
	now: number,
	ageMs: number,
	capMs: number,
): number | null {
	if (unsettledBlocker(releases, version, now, ageMs) === null) return null;
	if (lineCapReached(releases, version, now, ageMs, capMs)) return null;
	const line = lineKey(version);
	const youngAbove = releases.filter(
		(r) =>
			counts(r) &&
			lineKey(r.version) === line &&
			compareVersions(r.version, version) > 0 &&
			!isAged(r, now, ageMs),
	);
	// unsettledBlocker is non-null, so at least one young release sits above.
	const settleAt = Math.max(...youngAbove.map((r) => r.publishedAt + ageMs));
	const floor = releases.filter(
		(r) =>
			counts(r) &&
			lineKey(r.version) === line &&
			compareVersions(r.version, version) >= 0 &&
			isAged(r, now, ageMs),
	);
	const capAt =
		floor.length === 0
			? Number.POSITIVE_INFINITY
			: Math.min(...floor.map((r) => r.publishedAt)) + capMs;
	return Math.min(settleAt, capAt);
}
