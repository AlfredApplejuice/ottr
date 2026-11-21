import { createHash, randomBytes } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
	chmodSync,
	chownSync,
	closeSync,
	constants,
	cpSync,
	existsSync,
	fstatSync,
	lchownSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

/**
 * Per-project turn identity for classic workers (OTTR-994,
 * docs/specs/worker-turn-uid-isolation.md): every turn drops to its project's
 * uid/gid, writes only its per-project turn home, and reads the flat shared
 * home only through the pin's links. A turn of project A can no longer read
 * /proc/<pid>/environ of a running turn of project B, and its plant surface
 * stops at its own project's home.
 *
 * Soundness rule for everything root touches here: root never creates, chowns
 * or follows a path whose parent a turn uid can mutate. The project level of
 * the turn home stays root-owned; recursive chowns pin every entry with an
 * O_PATH|O_NOFOLLOW fd and fchown the inode, so a same-uid rename or symlink
 * swap during the walk cannot redirect the chown outside the tree.
 */

/** Turn uids start above nobody (65534); the space is 2^24 names wide. */
export const TURN_UID_BASE = 65536;
export const TURN_UID_SPACE = 1 << 24;

/** Layer links retargeted into the per-project turn home: caches, not state. */
export const RETARGET_LINKS = [".cache", ".npm", ".bun", ".local"] as const;

/** Flat-home links an unpinned turn's HOME carries (the legacy identity). */
const FLAT_LINK_ALWAYS = [".omp"] as const;
const FLAT_LINK_IF_EXISTS = [
	".gitconfig",
	".config",
	".ssh",
	".claude",
] as const;

export interface TurnIdentity {
	uid: number;
	gid: number;
}

/** Deterministic uid/gid for one project name; gid equals uid. */
export function projectTurnUid(name: string): TurnIdentity {
	const digest = createHash("sha256").update(name, "utf8").digest();
	const offset = Number(digest.readBigUInt64BE(0) % BigInt(TURN_UID_SPACE));
	const uid = TURN_UID_BASE + offset;
	return { uid, gid: uid };
}

// One uid per name for this container's lifetime; a second name on a taken uid
// shares that trust boundary until one project is renamed. The note rides the
// run's install notes so the card log shows it.
const uidOwners = new Map<number, string>();

export function uidCollisionNote(
	name: string,
	ids: TurnIdentity,
): string | null {
	const owner = uidOwners.get(ids.uid);
	if (owner === undefined) {
		uidOwners.set(ids.uid, name);
		return null;
	}
	if (owner === name) return null;
	return `turn-uid: projects ${owner} and ${name} share uid ${ids.uid}; rename one project to restore the boundary`;
}

/** True only when the daemon can drop privileges (root on Linux). */
export function isolationEnabled(): boolean {
	return typeof process.getuid === "function" && process.getuid() === 0;
}

/** Turn-home root: OTTR_TURN_HOMES or /turn-homes (the compose volume mount). */
export function turnHomesRoot(): string {
	return process.env.OTTR_TURN_HOMES || "/turn-homes";
}

/** Project names are single path segments; anything else is refused (fail closed). */
export function assertProjectSegment(name: string): void {
	if (
		name === "" ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0")
	)
		throw new Error(`turn-uid: refusing project name ${JSON.stringify(name)}`);
}

/** The per-project turn home: a root-owned shell with one uid-owned HOME. */
export interface TurnHome {
	/** `<root>/<project>`: root-owned 0755; the uid never mutates this level. */
	root: string;
	/** The uid's writable HOME: `<root>/home`, owned by the project uid, 0700. */
	home: string;
	/** Root-owned per-project layer copies: `<root>/layers`. */
	layers: string;
	/** Root-owned provisioning target (tools, venv, PATH dirs): `<root>/ottr`. */
	provision: string;
}

/**
 * `<root>/<project>` and its fixed layout, created once. The project level and
 * the `layers` and `ottr` dirs stay root-owned, so a turn uid can never
 * create, rename or symlink-swap anything the daemon chowns or copies there;
 * only `home` is handed to the uid.
 */
export function prepareTurnHome(
	root: string,
	project: string,
	ids: TurnIdentity,
): TurnHome {
	assertProjectSegment(project);
	mkdirSync(root, { recursive: true });
	const dir = join(root, project);
	mkdirSync(dir, { recursive: true });
	chmodSync(dir, 0o755);
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	chownSync(home, ids.uid, ids.gid);
	chmodSync(home, 0o700);
	const layers = join(dir, "layers");
	mkdirSync(layers, { recursive: true });
	chmodSync(layers, 0o755);
	const provision = join(dir, "ottr");
	mkdirSync(provision, { recursive: true });
	chmodSync(provision, 0o755);
	return { root: dir, home, layers, provision };
}

/**
 * The pinned layer dir a request env names, or null when the path is not
 * `<workerHome>/.alate/layers/<id>` after realpath (planted-pointer refuse,
 * same shape check as pinTarget in src/layers.ts). Throws when the layer
 * vanished between dispatch and /run.
 */
export function resolvePinnedLayer(
	workerHome: string,
	home: unknown,
): string | null {
	const layersRoot = join(workerHome, ".alate", "layers");
	if (typeof home !== "string" || !home.startsWith(`${layersRoot}/`))
		return null;
	// Lexical shape first, without touching the fs: `..` or a nested path is a
	// plant (the callers fall back to the unpinned home), not a vanished layer.
	if (dirname(resolve(home)) !== layersRoot) return null;
	let dir: string;
	try {
		dir = realpathSync(home);
	} catch {
		throw new Error(
			`turn-uid: agent layer ${basename(home)} vanished before the run`,
		);
	}
	// A symlink inside the layers tree may still point out of it: refuse too.
	if (dirname(dir) !== layersRoot) return null;
	return dir;
}

/**
 * One per-project copy of the pinned layer under `<turnHome>/layers/<id>`:
 * cp into a temp dir beside the final name, retarget the cache links, chown,
 * then one atomic rename. The parent stays root-owned, so the uid cannot
 * touch the temp or the final dir; symlinks are copied as links, so the
 * shared-state links keep pointing at the flat shared home. An existing
 * final dir is reused (a layer id is never rewritten), including the
 * concurrent-winner case where our own rename loses the race.
 */
export function ensureLayerCopy(
	layerDir: string,
	turnHome: TurnHome,
	workerHome: string,
	ids: TurnIdentity,
): string {
	pruneLayerCopies(layerDir, turnHome);
	const final = join(turnHome.layers, basename(layerDir));
	if (existsSync(final)) return final;
	const tmp = join(
		turnHome.layers,
		`.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
	);
	try {
		cpSync(layerDir, tmp, { recursive: true });
		retargetCacheLinks(tmp, turnHome.home, workerHome);
		chownTree(tmp, ids);
		chmodSync(tmp, 0o700);
		renameSync(tmp, final);
	} catch (err) {
		// A concurrent run of the same project won the rename: both copied the
		// same immutable source, so its final dir is this run's copy too.
		if (existsSync(final)) return final;
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			// The stale sweep removes it on a later run.
		}
		throw err;
	}
	return final;
}

/**
 * Stale layer copies: temp dirs older than a day, and final copies whose
 * source layer alate deleted (the current pin is never pruned). Best effort.
 */
function pruneLayerCopies(layerDir: string, turnHome: TurnHome): void {
	const sharedLayers = dirname(layerDir);
	const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
	let entries: Dirent[];
	try {
		entries = readdirSync(turnHome.layers, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(turnHome.layers, entry.name);
		if (entry.name.startsWith(".tmp-")) {
			try {
				const st = statOf(path);
				if (st !== null && st.mtimeMs < staleCutoff)
					rmSync(path, { recursive: true, force: true });
			} catch {
				// The rename below either happened or a later run prunes it.
			}
			continue;
		}
		if (entry.name === basename(layerDir)) continue;
		if (existsSync(join(sharedLayers, entry.name))) continue;
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			// Best effort; disk pressure stays bounded by alate's own clean-up.
		}
	}
}

function statOf(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

/**
 * Inside a fresh layer copy, links into the flat shared home for the
 * per-project cache entries (`.cache`, `.npm`, `.bun`, `.local`) are pointed
 * at the turn home's writable home instead. The cache dirs themselves the
 * turn creates through those links, as its own uid: root never writes below
 * the uid-owned home. State links (agent.db, sessions, oauth, logs) keep
 * their flat targets, and a missing or non-link entry stays layer content.
 */
export function retargetCacheLinks(
	copyDir: string,
	homeDir: string,
	workerHome: string,
): void {
	for (const rel of RETARGET_LINKS) {
		const linkPath = join(copyDir, rel);
		const st = statOf(linkPath);
		if (st === null || !st.isSymbolicLink()) continue;
		let target: string;
		try {
			target = readlinkSync(linkPath);
		} catch {
			continue;
		}
		// Only absolute links into the shared home are retargeted; a relative or
		// foreign link stays as the layer shipped it.
		if (resolve(copyDir, target) !== target) continue;
		if (!target.startsWith(`${workerHome}/`)) continue;
		unlinkSync(linkPath);
		symlinkSync(join(homeDir, rel), linkPath);
	}
}

/** bun-types (and Bun's runtime constants) omit Linux's O_PATH; the value is a
 * stable Linux ABI constant (asm-generic/fcntl.h: O_PATH 010000000). A kernel
 * without it fails the opens below and the run fails closed. */
const fsConstants = constants;
const fsConstantsEx = fsConstants as typeof fsConstants & { O_PATH?: number };
const oPath =
	typeof fsConstantsEx.O_PATH === "number" ? fsConstantsEx.O_PATH : 0o10000000;
const oNoFollow = fsConstants.O_NOFOLLOW;

/** Pin a path with O_PATH|O_NOFOLLOW (the walk's root open). Exposed for the
 * rename-race test seam; the returned fd must be closed by the caller. */
export function openPinned(path: string): number {
	return openSync(path, oPath | oNoFollow);
}

/**
 * chown every entry of a tree, race-free against the tree's owning uid.
 * The root is opened once (atomic path resolution, O_NOFOLLOW on the final
 * part); every listing, open and chown below it then goes through the
 * `/proc/self/fd/N` magic link of a pinned descriptor, which the kernel
 * resolves to the exact inode the fd holds. A same-uid rename or symlink
 * swap during the walk therefore cannot redirect a chown or a descent to a
 * file outside the tree: renames cannot change what a pinned fd points at,
 * and O_NOFOLLOW refuses a symlink as the final part of each anchored child
 * path. A symlink entry is lchowned through its pinned parent (the link
 * itself, never the target) and never descended through.
 */
export function chownTree(root: string, ids: TurnIdentity): void {
	const rootFd = openPinned(root);
	try {
		// O_PATH|O_NOFOLLOW on a trailing symlink can return the link's fd: refuse
		// a symlink root before any chown (its magic link would resolve to the
		// target), and chown a plain file root without a walk.
		const rootSt = fstatSync(rootFd);
		if (rootSt.isSymbolicLink())
			throw new Error(`turn-uid: ${root} is a symlink; refusing to chown it`);
		// The pinned root inode is chowned through its magic link; chownTreeFd
		// handles everything below it.
		chownSync(`/proc/self/fd/${rootFd}`, ids.uid, ids.gid);
		if (rootSt.isDirectory()) chownTreeFd(rootFd, ids);
	} finally {
		closeSync(rootFd);
	}
}

/** chown every entry below an already-pinned directory fd, race-free by the
 * same /proc/self/fd anchoring; the pinned inode itself is the caller's (the
 * test seam for the rename race: the caller can rename the root mid-flight
 * and prove the walk follows the inode, not the path). */
export function chownTreeFd(rootFd: number, ids: TurnIdentity): void {
	// A dir fd stays open until its listing pass is done: each child path is
	// `/proc/self/fd/<parentFd>/<entry>`, so the parent must live until every
	// child is opened. Child dir fds are closed after their own pass.
	const dirs: number[] = [rootFd];
	while (dirs.length > 0) {
		const dirFd = dirs.pop();
		if (dirFd === undefined) break;
		const viaDir = `/proc/self/fd/${dirFd}`;
		for (const entry of readdirSync(viaDir)) {
			const child = `${viaDir}/${entry}`;
			let fd: number;
			try {
				fd = openSync(child, oPath | oNoFollow);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ELOOP") {
					// A symlink entry (kernel refused the no-follow open): own the
					// link itself — lchown does not follow the final part, and the
					// parent is the pinned magic link — and never descend.
					lchownSync(child, ids.uid, ids.gid);
					continue;
				}
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // unlinked mid-walk: nothing left to chown
				throw err;
			}
			try {
				const st = fstatSync(fd);
				if (st.isSymbolicLink()) {
					// O_PATH|O_NOFOLLOW can return the link's fd instead of failing:
					// lchown it through the pinned parent (never the target) and do
					// not descend.
					closeSync(fd);
					lchownSync(child, ids.uid, ids.gid);
					continue;
				}
				// The magic link of a non-symlink fd resolves to the pinned inode:
				// chown through it instead of any path a rename could move.
				chownSync(`/proc/self/fd/${fd}`, ids.uid, ids.gid);
				if (st.isDirectory()) dirs.push(fd);
				else closeSync(fd);
			} catch (err) {
				closeSync(fd);
				throw err;
			}
		}
		// The root fd belongs to the caller (chownTree closes it in its finally);
		// only the fds this walk opened itself are closed here.
		if (dirFd !== rootFd) closeSync(dirFd);
	}
}

/**
 * Per-run workspace handoff: the run's cwd tree and the project's git dir
 * become the project uid's, and their top dirs go to mode 0700, so a turn of
 * another project cannot traverse into this project's checkout. Every path
 * below the workspace root is resolved per component from a pinned root fd
 * with O_NOFOLLOW|O_DIRECTORY: after a project's first run its project dir is
 * uid-owned, so the uid could rename an intermediate dir (`.worktrees`) and
 * plant a symlink whose middle part a plain-path open would follow — handing
 * the root-privileged chown another project's tree. A symlink or non-dir
 * component below the workspace root fails the run instead. The git dir is
 * derived structurally (`<workspaceRoot>/<project>/.git`, the board's own
 * layout), never from the worktree's planted `.git` pointer. Any step that
 * cannot be proven fails the run.
 */
export function prepareRunWorkspace(
	cwd: string,
	ids: TurnIdentity,
	workspaceRoot: string,
): void {
	const rel = relative(workspaceRoot, cwd);
	if (rel === "" || isAbsolute(rel) || rel.startsWith(".."))
		throw new Error(
			`turn-uid: run cwd ${cwd} is not under the workspace root ${workspaceRoot}`,
		);
	const segments = rel.split(sep);
	const firstSegment = segments[0];
	if (
		firstSegment === undefined ||
		firstSegment === "" ||
		firstSegment === "." ||
		firstSegment === ".."
	)
		throw new Error(
			`turn-uid: run cwd ${cwd} does not name a project under ${workspaceRoot}`,
		);
	const rootFd = openPinned(workspaceRoot);
	try {
		// The cwd tree, resolved component by component below the pinned root:
		// a planted symlink or a non-dir at any level fails the run before any
		// chown happens.
		const cwdFd = pinUnder(rootFd, segments);
		try {
			chownSync(`/proc/self/fd/${cwdFd}`, ids.uid, ids.gid);
			chownTreeFd(cwdFd, ids);
			chmodSync(`/proc/self/fd/${cwdFd}`, 0o700);
		} finally {
			closeSync(cwdFd);
		}
		// The project dir and its git dir, anchored the same way (the git dir
		// must be a real directory; a planted `.git` symlink is refused).
		const projectFd = pinUnder(rootFd, [firstSegment]);
		try {
			const gitFd = pinUnder(projectFd, [".git"]);
			try {
				chownSync(`/proc/self/fd/${gitFd}`, ids.uid, ids.gid);
				chownTreeFd(gitFd, ids);
				chmodSync(`/proc/self/fd/${gitFd}`, 0o700);
			} finally {
				closeSync(gitFd);
			}
			chownSync(`/proc/self/fd/${projectFd}`, ids.uid, ids.gid);
			chmodSync(`/proc/self/fd/${projectFd}`, 0o700);
		} finally {
			closeSync(projectFd);
		}
	} finally {
		closeSync(rootFd);
	}
}

/** Open `name` below a pinned directory fd as a real directory, refusing
 * symlinks and non-dirs (the anchored per-component resolve). */
function pinChild(parentFd: number, name: string): number {
	try {
		return openSync(
			`/proc/self/fd/${parentFd}/${name}`,
			oPath | oNoFollow | fsConstants.O_DIRECTORY,
		);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ELOOP" || code === "ENOTDIR")
			throw new Error(
				`turn-uid: refusing planted entry "${name}" below the pinned workspace path (${code})`,
			);
		if (code === "ENOENT")
			throw new Error(`turn-uid: missing workspace entry "${name}"`);
		throw err;
	}
}

/** Pin the directory at `segments` below a pinned root fd, per component. */
function pinUnder(rootFd: number, segments: readonly string[]): number {
	let fd = rootFd;
	for (const name of segments) {
		const child = pinChild(fd, name);
		if (fd !== rootFd) closeSync(fd);
		fd = child;
	}
	return fd;
}

/** chownTree anchored to the exact dir entry the caller stat'ed: a swap of the
 * entry between the walk's open and its end changes the inode on the path, and
 * the run fails instead of chowning an impostor. */
function chownSameDir(dir: string, ids: TurnIdentity): void {
	const before = statOf(dir);
	if (before === null || !before.isDirectory() || before.isSymbolicLink())
		throw new Error(`turn-uid: ${dir} is not a directory`);
	chownTree(dir, ids);
	const after = statOf(dir);
	if (after === null || after.ino !== before.ino || after.dev !== before.dev)
		throw new Error(`turn-uid: ${dir} was swapped during the chown; refusing`);
}

/**
 * Per-run close of one project's dir under a shared root (/data/<project>):
 * the whole tree becomes the project uid's, so the turn's session writes
 * beside the server's files succeed, and other projects cannot read it.
 * The dir entry itself sits in a root-owned parent, so the uid cannot swap
 * it during the walk.
 */
export function closeProjectDir(dir: string, ids: TurnIdentity): void {
	const st = statOf(dir);
	if (st === null) return; // Nothing here yet (a fresh project): nothing to close.
	if (!st.isDirectory() || st.isSymbolicLink()) return;
	chownSameDir(dir, ids);
	chownSync(dir, ids.uid, ids.gid);
	chmodSync(dir, 0o700);
}

/**
 * The env a turn runs with: HOME moves to the per-project layer copy when the
 * request pins a layer, else to the turn home's writable home with the flat
 * identity links. PI_CODING_AGENT_DIR follows the copy. Mutates `env` in
 * place; returns the resolved home for tests.
 */
export function applyTurnHomeEnv(
	env: Record<string, string | undefined>,
	ctx: {
		workerHome: string;
		turnHome: TurnHome;
		ids: TurnIdentity;
		copyLayer?: (layerDir: string) => string;
		resolveLayer?: (home: unknown) => string | null;
	},
): { pinned: boolean; home: string } {
	const copyLayer =
		ctx.copyLayer ??
		((layerDir) =>
			ensureLayerCopy(layerDir, ctx.turnHome, ctx.workerHome, ctx.ids));
	const resolveLayer =
		ctx.resolveLayer ??
		((home: unknown) => resolvePinnedLayer(ctx.workerHome, home));
	const layerDir = resolveLayer(env.HOME);
	if (layerDir === null) {
		linkFlatHome(ctx.turnHome.home, ctx.workerHome);
		env.HOME = ctx.turnHome.home;
		return { pinned: false, home: ctx.turnHome.home };
	}
	const copy = copyLayer(layerDir);
	env.HOME = copy;
	const agentDir = env.PI_CODING_AGENT_DIR;
	env.PI_CODING_AGENT_DIR =
		typeof agentDir === "string" && agentDir.startsWith(layerDir)
			? copy + agentDir.slice(layerDir.length)
			: join(copy, ".omp", "agent");
	return { pinned: true, home: copy };
}

/**
 * An unpinned turn keeps the legacy flat identity through links in its
 * writable home: `.omp` (config, agent dir, store, plugins, logs) always,
 * the flat git, gh and ssh state when the flat home has it. Root creates a
 * link only when the entry is missing; an entry a turn planted stays, and a
 * planted link only redirects the turn's own reads.
 */
function linkFlatHome(homeDir: string, workerHome: string): void {
	for (const rel of FLAT_LINK_ALWAYS)
		linkIfMissing(homeDir, rel, workerHome, rel);
	for (const rel of FLAT_LINK_IF_EXISTS) {
		if (existsSync(join(workerHome, rel)))
			linkIfMissing(homeDir, rel, workerHome, rel);
	}
}

function linkIfMissing(
	homeDir: string,
	rel: string,
	workerHome: string,
	sourceRel: string,
): void {
	const linkPath = join(homeDir, rel);
	const st = statOf(linkPath);
	if (st !== null) return;
	try {
		symlinkSync(join(workerHome, sourceRel), linkPath);
	} catch {
		// Best effort, like the pin's prepare: a failed link degrades to the
		// turn-home-local path, never fails the run.
	}
}

/**
 * Boot preparation, root-only: the shared home becomes traversable-but-not-
 * listable for turn uids, the flat state dirs omp writes through the pin's
 * links become sticky write-only-for-others (each uid keeps its entries
 * private), the store's dir turns sticky-writable so sqlite can create its
 * journal beside a mounted store, and every project dir under the shared
 * roots gets its project uid and mode 0700. Returns log lines; a non-root
 * daemon gets exactly the off note and changes nothing.
 */
export function bootTurnIsolation(
	workerHome: string,
	roots: string[],
	deps: { isMounted?: (path: string) => boolean } = {},
): string[] {
	if (!isolationEnabled())
		return [
			"off: the worker daemon is not root, turns keep the legacy identity",
		];
	const notes: string[] = [];
	try {
		chmodSync(workerHome, 0o711);
	} catch (err) {
		notes.push(`home chmod failed: ${String(err)}`);
	}
	// 1733: write-and-traverse for every uid, no listing of others' entries,
	// sticky so a uid cannot remove another uid's files.
	for (const [rel, mode] of [
		[".omp/agent", 0o1777],
		[".omp/agent/sessions", 0o1733],
		[".omp/logs", 0o1733],
	] as const) {
		try {
			mkdirSync(join(workerHome, rel), { recursive: true });
			chmodSync(join(workerHome, rel), mode);
		} catch (err) {
			notes.push(`${rel} prepare failed: ${String(err)}`);
		}
	}
	const db = join(workerHome, ".omp", "agent", "agent.db");
	const mounted = deps.isMounted ?? pathIsMounted;
	if (existsSync(db)) {
		try {
			if (mounted(db)) {
				// The compose store is a host bind mount: a chmod here would change
				// the host file's mode. Skip it; the turn-side store write degrades
				// to the cause omp reports (docs/specs/worker-turn-uid-isolation.md).
				notes.push("agent.db is a mount; store mode left to the host");
			} else {
				chmodSync(db, 0o666);
			}
		} catch (err) {
			notes.push(`agent.db chmod failed: ${String(err)}`);
		}
	}
	// BuildKit client material is root-0400 in the image ("workers run as
	// root"); turn uids need a read to build when the build profile is on.
	for (const cert of [
		"/certs/buildkit/client/key.pem",
		"/certs/buildkit/client/cert.pem",
		"/certs/buildkit/ca/ca.pem",
	]) {
		try {
			if (existsSync(cert)) chmodSync(cert, 0o644);
		} catch (err) {
			notes.push(`${cert} chmod failed: ${String(err)}`);
		}
	}
	for (const root of roots) notes.push(...closeRootProjectDirs(root));
	return notes;
}

/** True when the path is a mount point of this container (bind mounts included). */
function pathIsMounted(path: string): boolean {
	let mounts: string;
	try {
		mounts = readFileSync("/proc/self/mountinfo", "utf8");
	} catch {
		return false;
	}
	// mountinfo escapes space, tab and newline in the mount point field.
	const escaped = path
		.replaceAll(" ", "\\040")
		.replaceAll("\t", "\\011")
		.replaceAll("\n", "\\012");
	for (const line of mounts.split("\n")) {
		const fields = line.split(" ");
		if (fields[4] === escaped) return true;
	}
	return false;
}

/** chown+close every project dir directly under one shared root; per-entry failures note. */
function closeRootProjectDirs(root: string): string[] {
	const notes: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return notes; // A root this worker does not mount (compose contract).
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		try {
			const dir = join(root, entry.name);
			const ids = projectTurnUid(entry.name);
			chownSync(dir, ids.uid, ids.gid);
			chmodSync(dir, 0o700);
		} catch (err) {
			notes.push(`${join(root, entry.name)} close failed: ${String(err)}`);
		}
	}
	return notes;
}
