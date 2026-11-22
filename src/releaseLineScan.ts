/**
 * The bun.lock release line scan's data side (OTTR-972), shared by the check
 * script (scripts/check-release-lines.ts) and the board (src/turn.ts): the
 * board never spawns a worktree script for the release line hold — it reads
 * the worktree's bun.lock and package.json as untrusted data and queries the
 * npm registry itself (releaseLineBlocked). The rule lives in
 * src/releaseLine.ts (docs/specs/release-line-gate.md).
 */
import { join } from "node:path";
import { childDatabaseEnv } from "./childEnv.ts";
import { readBoundedFile } from "./confine.ts";
import {
	lineCapReached,
	type RegistryRelease,
	releaseLineWaitUntil,
	unsettledBlocker,
} from "./releaseLine.ts";

const DAY_MS = 86_400_000;
export const AGE_MS = 7 * DAY_MS;
export const CAP_MS = 14 * DAY_MS;
const TIMEOUT_MS = 20_000;
/** Byte cap for every worktree file the hold reads (bun.lock, package.json)
 * and for the base blob out of git, through the bounded readers (d6f0a9dd):
 * a bigger file fails closed to null and keeps the park. */
export const LOCK_MAX_BYTES = 4 * 1024 * 1024;
/** Packument body budget on the board path: a bigger answer fails the fetch,
 * the scan fails closed, and the park stays. The check script passes a larger
 * cap, because its legitimate packuments can be big and its failure blocks
 * the work turn instead of arming a timer. */
export const REGISTRY_BODY_MAX_BYTES = 64 * 1024;
/** The board scan stops when the changed set exceeds this count or when
 * SCAN_MS passed since its start; both fail the scan closed (park stays). */
export const MAX_CHANGED_PACKAGES = 500;
export const SCAN_MS = 60_000;
/** "name@1.2.3" or "@scope/name@1.2.3-beta.1"; the last @ separates the version. */
const REGISTRY_ENTRY = /^(@?[^@]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
/** Stable only: a prerelease pin never blocks and never gets checked. */
const STABLE = /^\d+\.\d+\.\d+$/;

/** Parses bun.lock's JSONC by walking strings first, then skipping comments
 * and dropping trailing commas before JSON.parse. Never a blind "//" strip —
 * integrity hashes contain "//" (e.g. rw@1.3.3 in the real lock). */
export function parseJsonc(text: string): unknown {
	let out = "";
	let i = 0;
	let inString = false;
	while (i < text.length) {
		const c = text[i];
		if (inString) {
			if (c === "\\") {
				out += text.slice(i, i + 2);
				i += 2;
				continue;
			}
			if (c === '"') inString = false;
			out += c;
			i++;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
			continue;
		}
		if (c === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j] ?? "")) j++;
			if (text[j] === "}" || text[j] === "]") {
				i++;
				continue;
			}
		}
		out += c;
		i++;
	}
	return JSON.parse(out);
}

export type LockEntry = { key: string; name: string; version: string };

/** The registry entries of one lock text, keyed by their packages map key,
 * never by the resolved name: a nested key like d3-dsv/commander resolves a
 * package named commander beside the top-level commander, and the two must
 * not collapse into one slot. Non-registry entries (workspace:, link:,
 * git:, file:, tarballs) never match. */
export function registryEntries(lockText: string): LockEntry[] {
	const entries: LockEntry[] = [];
	const parsed = parseJsonc(lockText) as { packages?: unknown } | null;
	const packages = parsed?.packages;
	if (packages === null || typeof packages !== "object") return entries;
	for (const [key, tuple] of Object.entries(
		packages as Record<string, unknown>,
	)) {
		if (!Array.isArray(tuple)) continue;
		const entry: unknown = tuple[0];
		if (typeof entry !== "string") continue;
		const match = REGISTRY_ENTRY.exec(entry);
		if (match === null) continue;
		const name = match[1];
		const version = match[2];
		if (name === undefined || version === undefined) continue;
		entries.push({ key, name, version });
	}
	return entries;
}

/** The names the given package.json text declares directly. Throws on
 * unparseable text: the script lets that crash uncaught, the board treats it
 * as no hold. */
export function directNamesOf(pkgJsonText: string): Set<string> {
	const parsed = JSON.parse(pkgJsonText) as {
		dependencies?: Record<string, unknown>;
		devDependencies?: Record<string, unknown>;
		optionalDependencies?: Record<string, unknown>;
	};
	return new Set(
		Object.keys(parsed.dependencies ?? {})
			.concat(Object.keys(parsed.devDependencies ?? {}))
			.concat(Object.keys(parsed.optionalDependencies ?? {})),
	);
}

export type Changed = { name: string; version: string; direct: boolean };

/** Ascending by name, then version, so identical pairs sit adjacent. */
function ascending(a: Changed, b: Changed): number {
	if (a.name !== b.name) return a.name < b.name ? -1 : 1;
	if (a.version !== b.version) return a.version < b.version ? -1 : 1;
	return 0;
}

/** Changed registry packages, ascending by name: a lock key that is added,
 * or whose resolved name or version differs, against the base entries.
 * Installed prereleases are skipped; identical changed (name, version) pairs
 * scan once. */
export function changedPackages(
	current: LockEntry[],
	base: LockEntry[],
	direct: Set<string>,
): Changed[] {
	const before = new Map(base.map((entry) => [entry.key, entry]));
	const changed: Changed[] = [];
	for (const entry of current) {
		const prior = before.get(entry.key);
		if (
			prior !== undefined &&
			prior.name === entry.name &&
			prior.version === entry.version
		)
			continue;
		if (!STABLE.test(entry.version)) continue;
		changed.push({
			name: entry.name,
			version: entry.version,
			direct: direct.has(entry.name),
		});
	}
	changed.sort(ascending);
	const scanned = new Set<string>();
	return changed.filter((pkg) => {
		const pair = `${pkg.name}@${pkg.version}`;
		if (scanned.has(pair)) return false;
		scanned.add(pair);
		return true;
	});
}

type Packument = {
	versions?: Record<string, { deprecated?: unknown } | undefined>;
	time?: Record<string, unknown>;
};

/** Packument -> releases: the time entries of versions it still lists,
 * deprecated when the metadata marks it with a string (the ompWatch rule). */
export function releasesOf(body: unknown): RegistryRelease[] {
	if (body === null || typeof body !== "object")
		throw new Error("packument is not an object");
	const packument = body as Packument;
	const versions = packument.versions;
	if (versions === null || typeof versions !== "object")
		throw new Error("packument has no versions map");
	const time = packument.time;
	if (time === null || typeof time !== "object")
		throw new Error("packument has no time map");
	const releases: RegistryRelease[] = [];
	for (const version of Object.keys(versions)) {
		const published = Date.parse(String(time[version] ?? ""));
		if (!Number.isFinite(published)) continue;
		releases.push({
			version,
			publishedAt: published,
			deprecated: typeof versions[version]?.deprecated === "string",
		});
	}
	return releases;
}

/** Bounded packument body read (the readBoundedBody pattern in
 * src/serviceQuotaHttp.ts): accumulates chunks up to `maxBytes`, refuses a
 * bigger body before any JSON.parse, and cancels the stream on refusal. */
async function readPackumentBody(
	body: ReadableStreamDefaultReader<Uint8Array>,
	maxBytes: number,
): Promise<unknown> {
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for (;;) {
		const chunk = await body.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > maxBytes) {
			await body.cancel().catch(() => {});
			throw new Error(`packument larger than ${maxBytes} bytes`);
		}
		chunks.push(chunk.value);
	}
	const contents = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		contents.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(contents));
}

/** GET {registry}/{name} with "/" encoded as %2F and "@" kept (the
 * OMP_PACKAGE_URL style). `maxBodyBytes` bounds the response body: the board
 * passes REGISTRY_BODY_MAX_BYTES, the check script its larger budget. */
export async function fetchReleases(
	name: string,
	maxBodyBytes: number,
): Promise<RegistryRelease[]> {
	const registry = (
		process.env.OTTR_NPM_REGISTRY ?? "https://registry.npmjs.org"
	).replace(/\/+$/, "");
	const response = await fetch(`${registry}/${name.replaceAll("/", "%2F")}`, {
		headers: { "user-agent": "ottr" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok)
		throw new Error(`registry returned HTTP ${response.status}`);
	if (response.body === null) throw new Error("registry response has no body");
	return releasesOf(
		await readPackumentBody(response.body.getReader(), maxBodyBytes),
	);
}

/** One unsettled direct or transitive package: the rule's blocker names the
 * report line, waitUntilMs (OTTR-960) is the machine-readable clear time. */
export type Unsettled = {
	name: string;
	version: string;
	blocker: RegistryRelease;
	waitUntilMs: number;
};

export type ReleaseLineScan =
	| { ok: true; direct: Unsettled[]; transitive: Unsettled[] }
	| { ok: false; failed: { name: string; message: string } };

/** The scan: one fetch call per changed package, ascending by name. Never
 * throws: an unparseable lock reports name "bun.lock"; a failed fetch reports
 * the package and stops the scan (the script's exit-1 semantics). The board
 * bounds (`maxChangedPackages`, `deadlineMs`) stop the scan the same way:
 * both fail closed with name "bun.lock" before or between fetches. */
export async function scanReleaseLines(input: {
	lockText: string;
	baseLockText: string; // "" = empty base map
	directNames: Set<string>;
	fetch: (name: string) => Promise<RegistryRelease[]>;
	now: number;
	ageMs: number;
	capMs: number;
	/** Stop when the changed set holds more than this many packages. */
	maxChangedPackages?: number;
	/** Stop before a fetch when Date.now() passed this epoch ms. */
	deadlineMs?: number;
}): Promise<ReleaseLineScan> {
	const { directNames, now, ageMs, capMs } = input;
	let current: LockEntry[];
	let base: LockEntry[];
	try {
		current = registryEntries(input.lockText);
		// "" is the absent base file: an empty base map (every entry counts as
		// changed), not a broken lock. A non-empty unparseable base still fails.
		base = input.baseLockText === "" ? [] : registryEntries(input.baseLockText);
	} catch (error) {
		return {
			ok: false,
			failed: {
				name: "bun.lock",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
	const changed = changedPackages(current, base, directNames);
	if (
		input.maxChangedPackages !== undefined &&
		changed.length > input.maxChangedPackages
	)
		return {
			ok: false,
			failed: {
				name: "bun.lock",
				message: `lock diff changes ${changed.length} packages, over the ${input.maxChangedPackages} cap`,
			},
		};
	const direct: Unsettled[] = [];
	const transitive: Unsettled[] = [];
	for (const pkg of changed) {
		if (input.deadlineMs !== undefined && Date.now() > input.deadlineMs)
			return {
				ok: false,
				failed: {
					name: "bun.lock",
					message: "release line scan deadline passed",
				},
			};
		let releases: RegistryRelease[];
		try {
			releases = await input.fetch(pkg.name);
		} catch (error) {
			return {
				ok: false,
				failed: {
					name: pkg.name,
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
		const blocker = unsettledBlocker(releases, pkg.version, now, ageMs);
		if (blocker === null) continue;
		if (lineCapReached(releases, pkg.version, now, ageMs, capMs)) continue;
		const waitUntilMs = releaseLineWaitUntil(
			releases,
			pkg.version,
			now,
			ageMs,
			capMs,
		);
		if (waitUntilMs === null) continue;
		const unsettled: Unsettled = {
			name: pkg.name,
			version: pkg.version,
			blocker,
			waitUntilMs,
		};
		if (pkg.direct) direct.push(unsettled);
		else transitive.push(unsettled);
	}
	return { ok: true, direct, transitive };
}

/** The board's default release line hold probe (OTTR-972). Reads worktree
 * data only and spawns no worktree script; `git cat-file blob` (the base
 * lock read) runs no textconv, filter, or hook. Returns the direct blocked
 * entries, or null when anything is missing, unparseable, or the scan fails:
 * the board holds only on a positive result. */
export async function releaseLineBlocked(
	wt: string,
): Promise<{ name: string; version: string; waitUntilMs: number }[] | null> {
	let lockText: string;
	let pkgText: string;
	try {
		// The bounded readers (d6f0a9dd): a symlink, a non-regular file, or a
		// file over LOCK_MAX_BYTES fails closed below — never an unbounded
		// read of a worker-writable path.
		lockText = (
			await readBoundedFile(join(wt, "bun.lock"), LOCK_MAX_BYTES)
		).toString("utf8");
		pkgText = (
			await readBoundedFile(join(wt, "package.json"), LOCK_MAX_BYTES)
		).toString("utf8");
	} catch {
		return null;
	}
	let directNames: Set<string>;
	try {
		directNames = directNamesOf(pkgText);
	} catch {
		return null;
	}
	// No base ref: fail closed — nothing to compare against.
	const rev = Bun.spawnSync(["git", "rev-parse", "--verify", "origin/main"], {
		cwd: wt,
		env: childDatabaseEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (rev.exitCode !== 0) return null;
	// Three states, never a guess: the file's presence comes from ls-tree, so
	// git trouble fails closed and only a truly absent bun.lock means the
	// empty base map (every entry counts as changed).
	const listed = Bun.spawnSync(
		["git", "ls-tree", "--name-only", "origin/main", "--", "bun.lock"],
		{
			cwd: wt,
			env: childDatabaseEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (listed.exitCode !== 0) return null;
	let baseLockText = "";
	if (listed.stdout.toString().trim() !== "") {
		const shown = Bun.spawnSync(
			["git", "cat-file", "blob", "origin/main:bun.lock"],
			{
				cwd: wt,
				env: childDatabaseEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (shown.exitCode !== 0) return null;
		// The base blob sits in git's object store, but past commits wrote it:
		// the same byte cap applies before the whole blob lands in memory.
		if (shown.stdout.byteLength > LOCK_MAX_BYTES) return null;
		baseLockText = shown.stdout.toString();
	}
	let scan: ReleaseLineScan;
	try {
		scan = await scanReleaseLines({
			lockText,
			baseLockText,
			directNames,
			fetch: (name) => fetchReleases(name, REGISTRY_BODY_MAX_BYTES),
			now: Date.now(),
			ageMs: AGE_MS,
			capMs: CAP_MS,
			maxChangedPackages: MAX_CHANGED_PACKAGES,
			deadlineMs: Date.now() + SCAN_MS,
		});
	} catch {
		return null;
	}
	if (!scan.ok) return null;
	return scan.direct.map(({ name, version, waitUntilMs }) => ({
		name,
		version,
		waitUntilMs,
	}));
}
