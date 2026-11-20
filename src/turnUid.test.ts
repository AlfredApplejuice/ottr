import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	type Stats,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
	applyTurnHomeEnv,
	assertProjectSegment,
	bootTurnIsolation,
	closeProjectDir,
	ensureLayerCopy,
	isolationEnabled,
	prepareRunWorkspace,
	prepareTurnHome,
	projectTurnUid,
	resolvePinnedLayer,
	retargetCacheLinks,
	type TurnHome,
	uidCollisionNote,
} from "./turnUid.ts";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
// chown and uid-drop need root; the pure property and env tests run everywhere.
const rootTest = isRoot ? test : test.skip;

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function freshDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), `ottr-turnuid-${prefix}-`));
	dirs.push(d);
	return d;
}

/** A real turn home under a fresh homes root. */
function freshTurnHome(project: string): TurnHome {
	return prepareTurnHome(freshDir("homes"), project, projectTurnUid(project));
}

describe("projectTurnUid", () => {
	test("is deterministic, in range, and gid-equals-uid", () => {
		for (const name of ["ottr", "agent-data", "a", "project with spaces"]) {
			const a = projectTurnUid(name);
			const b = projectTurnUid(name);
			expect(b).toEqual(a);
			expect(a.uid).toBeGreaterThanOrEqual(65536);
			expect(a.uid).toBeLessThan(65536 + (1 << 24));
			expect(a.gid).toBe(a.uid);
		}
	});

	test("fixed distinct names get distinct uids", () => {
		const names = ["ottr", "agent-data", "alate", "clipshelf", "hindsight"];
		const uids = names.map((n) => projectTurnUid(n).uid);
		expect(new Set(uids).size).toBe(names.length);
	});

	test("property: in range and deterministic for arbitrary names", () => {
		const nameArb = fc
			.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-._"), {
				minLength: 1,
				maxLength: 64,
			})
			.map((chars) => chars.join(""));
		fc.assert(
			fc.property(nameArb, (name) => {
				const a = projectTurnUid(name);
				const b = projectTurnUid(name);
				return (
					a.uid === b.uid &&
					a.gid === a.uid &&
					a.uid >= 65536 &&
					a.uid < 65536 + (1 << 24)
				);
			}),
			{ numRuns: 200 },
		);
	});
});

describe("uidCollisionNote", () => {
	test("first claim is silent, a second name on the uid gets a note", () => {
		const ids = projectTurnUid("collision-proj-a");
		const other: typeof ids = { uid: ids.uid, gid: ids.uid };
		expect(uidCollisionNote("collision-proj-a", ids)).toBeNull();
		expect(uidCollisionNote("collision-proj-a", ids)).toBeNull();
		const note = uidCollisionNote("collision-proj-b", other);
		expect(note).toContain("collision-proj-a");
		expect(note).toContain("collision-proj-b");
	});
});

describe("assertProjectSegment", () => {
	test("rejects traversal, separators and empties", () => {
		for (const bad of ["", ".", "..", "a/b", "../x", "/abs", "a\\b", "a\0b"])
			expect(() => assertProjectSegment(bad)).toThrow();
		assertProjectSegment("ottr");
		assertProjectSegment("my-project.v2");
	});
});

describe("resolvePinnedLayer", () => {
	const workerHome = "/fake-home";
	test("null for a non-layer HOME", () => {
		expect(resolvePinnedLayer(workerHome, undefined)).toBeNull();
		expect(resolvePinnedLayer(workerHome, "/root")).toBeNull();
		expect(resolvePinnedLayer(workerHome, "/root/.alate/layers")).toBeNull();
	});
	test("escapes and missing layers refuse or throw", () => {
		expect(
			resolvePinnedLayer(workerHome, "/fake-home/.alate/layers/../escape"),
		).toBeNull();
		expect(() =>
			resolvePinnedLayer(workerHome, "/fake-home/.alate/layers/gone"),
		).toThrow(/vanished/);
	});
});

describe("applyTurnHomeEnv", () => {
	const workerHome = "/fake-home";
	const layerDir = `${workerHome}/.alate/layers/l1`;
	const ids = projectTurnUid("env-proj");
	const turnHome: TurnHome = {
		root: "/turn-homes/env-proj",
		home: "/turn-homes/env-proj/home",
		layers: "/turn-homes/env-proj/layers",
		provision: "/turn-homes/env-proj/ottr",
	};
	const copyLayer = (dir: string) =>
		`${turnHome.layers}/${dir.split("/").pop()}`;
	// Pure stand-in for resolvePinnedLayer: same prefix and single-segment rules,
	// no fs (the fake workerHome does not exist), so these tests run as any user.
	const resolveLayer = (home: unknown): string | null => {
		if (typeof home !== "string") return null;
		const prefix = `${workerHome}/.alate/layers/`;
		if (!home.startsWith(prefix)) return null;
		const rest = home.slice(prefix.length);
		if (rest === "" || rest.includes("/") || rest === "." || rest === "..")
			return null;
		return home;
	};

	test("pinned HOME moves to the layer copy with the agent dir following", () => {
		const env: Record<string, string | undefined> = {
			HOME: layerDir,
			PI_CODING_AGENT_DIR: `${layerDir}/.omp/agent`,
		};
		const out = applyTurnHomeEnv(env, {
			workerHome,
			turnHome,
			ids,
			copyLayer,
			resolveLayer,
		});
		expect(out).toEqual({ pinned: true, home: copyLayer(layerDir) });
		expect(env.HOME).toBe(copyLayer(layerDir));
		expect(env.PI_CODING_AGENT_DIR).toBe(`${copyLayer(layerDir)}/.omp/agent`);
	});

	test("a foreign PI_CODING_AGENT_DIR falls to the copy's agent dir", () => {
		const env: Record<string, string | undefined> = {
			HOME: layerDir,
			PI_CODING_AGENT_DIR: "/etc/ottr/home/.omp/agent",
		};
		applyTurnHomeEnv(env, {
			workerHome,
			turnHome,
			ids,
			copyLayer,
			resolveLayer,
		});
		expect(env.PI_CODING_AGENT_DIR).toBe(`${copyLayer(layerDir)}/.omp/agent`);
	});

	test("unpinned and escaped HOMEs land on the turn home's writable home", () => {
		for (const home of [
			"/root",
			undefined,
			`${workerHome}/.alate/layers/../x`,
		]) {
			const env: Record<string, string | undefined> = { HOME: home };
			const out = applyTurnHomeEnv(env, {
				workerHome,
				turnHome,
				ids,
				copyLayer,
				resolveLayer,
			});
			expect(out).toEqual({ pinned: false, home: turnHome.home });
			expect(env.HOME).toBe(turnHome.home);
		}
	});

	test("property: no pinned HOME means no copyLayer call", () => {
		let calls = 0;
		fc.assert(
			fc.property(
				fc.option(fc.constantFrom("/root", "/home/x", "/tmp"), {
					nil: undefined,
				}),
				(home) => {
					calls = 0;
					const env: Record<string, string | undefined> = { HOME: home };
					applyTurnHomeEnv(env, {
						workerHome,
						turnHome,
						ids,
						copyLayer: () => {
							calls += 1;
							return "/copied";
						},
						resolveLayer,
					});
					return calls === 0 && env.HOME === turnHome.home;
				},
			),
			{ numRuns: 100 },
		);
	});
});

rootTest("prepareTurnHome builds the root-owned shell and the uid home", () => {
	const homesRoot = freshDir("home-root");
	const ids = projectTurnUid("home-proj");
	const turnHome = prepareTurnHome(homesRoot, "home-proj", ids);
	// The project level and the daemon dirs stay root-owned: the uid can never
	// rename or swap anything the daemon chowns or copies beneath them.
	const shell = statSync(turnHome.root);
	expect(shell.uid).toBe(0);
	expect(shell.mode & 0o777).toBe(0o755);
	expect(statSync(turnHome.layers).uid).toBe(0);
	expect(statSync(turnHome.provision).uid).toBe(0);
	const homeStat = statSync(turnHome.home);
	expect(homeStat.uid).toBe(ids.uid);
	expect(homeStat.mode & 0o777).toBe(0o700);
	expect(() => prepareTurnHome(homesRoot, "../escape", ids)).toThrow();
});

rootTest(
	"layer copy keeps state links and retargets cache links lazily",
	() => {
		const workerHome = freshDir("worker-home");
		const turnHome = freshTurnHome("copy-proj");
		const ids = projectTurnUid("copy-proj");
		const layerDir = join(workerHome, ".alate", "layers", "l1");
		mkdirSync(join(layerDir, ".omp", "agent"), { recursive: true });
		mkdirSync(join(workerHome, ".omp", "agent"), { recursive: true });
		mkdirSync(join(workerHome, ".cache"), { recursive: true });
		writeFileSync(join(workerHome, ".omp", "agent", "agent.db"), "store");
		const dbTarget = join(workerHome, ".omp", "agent", "agent.db");
		symlinkSync(dbTarget, join(layerDir, ".omp", "agent", "agent.db"));
		symlinkSync(join(workerHome, ".cache"), join(layerDir, ".cache"));

		const copy = ensureLayerCopy(layerDir, turnHome, workerHome, ids);
		expect(copy).toBe(join(turnHome.layers, "l1"));
		// State link survives the copy with its flat target and still resolves.
		expect(readlinkSync(join(copy, ".omp", "agent", "agent.db"))).toBe(
			dbTarget,
		);
		expect(existsSync(join(copy, ".omp", "agent", "agent.db"))).toBe(true);
		// Cache link retargeted into the uid-owned home; the cache DIR itself is
		// created by the turn through the link (root never writes below home).
		expect(readlinkSync(join(copy, ".cache"))).toBe(
			join(turnHome.home, ".cache"),
		);
		expect(statOf(join(turnHome.home, ".cache"))).toBeNull();
		// The copy is owned by the project uid; its top dir is closed.
		expect(statSync(copy).uid).toBe(ids.uid);
		expect(statSync(copy).mode & 0o777).toBe(0o700);
		// The store itself was never touched by the retarget.
		expect(readFileSync(dbTarget, "utf8")).toBe("store");

		// A second call reuses the copy; a pre-existing final dir wins over a new copy.
		expect(ensureLayerCopy(layerDir, turnHome, workerHome, ids)).toBe(copy);
	},
);

rootTest("a stale copy whose source layer is gone is pruned", () => {
	const workerHome = freshDir("worker-home3");
	const turnHome = freshTurnHome("prune-proj");
	const ids = projectTurnUid("prune-proj");
	const layersShared = join(workerHome, ".alate", "layers");
	mkdirSync(layersShared, { recursive: true });
	const layerDir = join(layersShared, "keep");
	mkdirSync(layerDir, { recursive: true });
	writeFileSync(join(layerDir, "config.yml"), "model: x\n");
	// A copy of a layer alate already deleted, and one fresh temp dir.
	const goneCopy = join(turnHome.layers, "gone");
	mkdirSync(goneCopy, { recursive: true });
	const staleTmp = join(turnHome.layers, ".tmp-old");
	mkdirSync(staleTmp, { recursive: true });
	// Slide both mtimes back past the stale cutoff.
	const past = Date.now() - 25 * 60 * 60 * 1000;
	for (const p of [goneCopy, staleTmp]) touchMtime(p, past);

	const copy = ensureLayerCopy(layerDir, turnHome, workerHome, ids);
	expect(copy).toBe(join(turnHome.layers, "keep"));
	expect(existsSync(goneCopy)).toBe(false);
	expect(existsSync(staleTmp)).toBe(false);
	expect(existsSync(copy)).toBe(true);
});

function statOf(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

function touchMtime(path: string, pastMs: number): void {
	const st = statOf(path);
	if (st === null) return;
	const seconds = pastMs / 1000;
	utimesSync(path, seconds, seconds);
}

rootTest("retargetCacheLinks skips foreign and relative links", () => {
	const workerHome = freshDir("worker-home2");
	const turnHome = freshTurnHome("ret-proj");
	const copyDir = freshDir("copy-dir");
	mkdirSync(join(workerHome, ".cache"), { recursive: true });
	symlinkSync(join(workerHome, ".cache"), join(copyDir, ".cache"));
	symlinkSync("../../elsewhere", join(copyDir, ".npm"));
	writeFileSync(join(copyDir, ".bun"), "a plain file");

	retargetCacheLinks(copyDir, turnHome.home, workerHome);
	expect(readlinkSync(join(copyDir, ".cache"))).toBe(
		join(turnHome.home, ".cache"),
	);
	// Relative link: untouched (stays layer content as shipped).
	expect(readlinkSync(join(copyDir, ".npm"))).toBe("../../elsewhere");
	// A plain file is never replaced.
	expect(lstatSync(join(copyDir, ".bun")).isSymbolicLink()).toBe(false);
});

rootTest("prepareRunWorkspace chowns cwd and the project git dir", () => {
	const ws = freshDir("ws");
	const ids = projectTurnUid("ws-proj");
	const main = join(ws, "main");
	mkdirSync(main, { recursive: true });
	const git = (...argv: string[]) => {
		const r = Bun.spawnSync(["git", "-C", main, ...argv], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
		});
		if (r.exitCode !== 0)
			throw new Error(`git ${argv.join(" ")} failed: ${r.stderr.toString()}`);
	};
	git("init", "-b", "main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	writeFileSync(join(main, "f.txt"), "x\n");
	git("add", ".");
	git("commit", "-m", "init", "--no-gpg-sign");
	git("worktree", "add", join(main, ".worktrees", "card-1"));

	const cwd = join(main, ".worktrees", "card-1");
	prepareRunWorkspace(cwd, ids, ws);
	expect(statSync(cwd).uid).toBe(ids.uid);
	expect(statSync(cwd).mode & 0o777).toBe(0o700);
	// The project dir (the git dir's parent) is closed for other projects.
	expect(statSync(main).mode & 0o777).toBe(0o700);
	expect(statSync(main).uid).toBe(ids.uid);
	// The uid owns the git dir it must write into, worktree gitdir included.
	expect(statSync(join(main, ".git")).uid).toBe(ids.uid);
	const wtGitDir = readFileSync(join(cwd, ".git"), "utf8")
		.replace("gitdir: ", "")
		.trim();
	expect(statSync(wtGitDir).uid).toBe(ids.uid);
	// A planted `.git` pointer is never followed: the common dir comes from the
	// board layout (<workspace>/<project>/.git), so this stays uid-owned only.
	expect(existsSync(join(main, ".git", "planted-marker"))).toBe(false);

	// A cwd outside the workspace root fails the run (fail closed).
	expect(() =>
		prepareRunWorkspace(join(freshDir("elsewhere"), "main"), ids, ws),
	).toThrow(/not under/);
	// A project dir without a git dir fails too.
	const noGit = join(ws, "no-git-proj");
	mkdirSync(join(noGit, "wt"), { recursive: true });
	expect(() => prepareRunWorkspace(join(noGit, "wt"), ids, ws)).toThrow(
		/no git dir/,
	);
});

rootTest("chownTree leaves symlink targets untouched", () => {
	const tree = freshDir("chown-tree");
	const target = freshDir("chown-outside");
	const ids = projectTurnUid("chown-proj");
	mkdirSync(join(tree, "sub"), { recursive: true });
	writeFileSync(join(tree, "sub", "f.txt"), "x\n");
	const outside = join(target, "victim.txt");
	writeFileSync(outside, "v\n");
	symlinkSync(outside, join(tree, "sub", "link"));

	chownTreePublic(tree, ids);
	// Every real entry is the uid's; the link target is not.
	expect(statSync(join(tree, "sub", "f.txt")).uid).toBe(ids.uid);
	expect(statSync(outside).uid).not.toBe(ids.uid);
	expect(lstatSync(join(tree, "sub", "link")).uid).toBe(ids.uid);
});

// Import indirection kept local: the test exercises the exported walk.
import { chownTree as chownTreePublic } from "./turnUid.ts";

rootTest("closeProjectDir chowns the whole project data tree", () => {
	const root = freshDir("close-root");
	const ids = projectTurnUid("close-proj");
	const dir = join(root, "close-proj");
	mkdirSync(join(dir, "sessions"), { recursive: true });
	writeFileSync(join(dir, "sessions", "s1.jsonl"), "x\n");
	chmodSync(join(dir, "sessions", "s1.jsonl"), 0o644);
	// The server (root) wrote the files; the close hands the tree to the uid.
	closeProjectDir(dir, ids);
	expect(statSync(dir).uid).toBe(ids.uid);
	expect(statSync(join(dir, "sessions")).uid).toBe(ids.uid);
	expect(statSync(join(dir, "sessions", "s1.jsonl")).uid).toBe(ids.uid);
	expect(statSync(dir).mode & 0o777).toBe(0o700);
	// Missing and non-dir entries are no-ops.
	closeProjectDir(join(root, "missing"), ids);
	writeFileSync(join(root, "afile"), "x");
	closeProjectDir(join(root, "afile"), ids);
	expect(lstatSync(join(root, "afile")).isDirectory()).toBe(false);
});

rootTest("bootTurnIsolation hardens the shared home and closes roots", () => {
	const workerHome = freshDir("boot-home");
	const rootA = freshDir("boot-root-a");
	const rootB = freshDir("boot-root-b");
	mkdirSync(join(workerHome, ".omp", "agent"), { recursive: true });
	writeFileSync(join(workerHome, ".omp", "agent", "agent.db"), "store");
	chmodSync(join(workerHome, ".omp", "agent", "agent.db"), 0o600);
	for (const [name, mode] of [
		["proj-a", 0o755],
		["proj-b", 0o755],
	] as const) {
		mkdirSync(join(rootA, name), { recursive: true });
		chmodSync(join(rootA, name), mode);
	}
	mkdirSync(join(rootB, "proj-a"), { recursive: true });

	const notes = bootTurnIsolation(workerHome, [rootA, rootB]);
	expect(notes).toEqual([]);
	const idsA = projectTurnUid("proj-a");
	const idsB = projectTurnUid("proj-b");
	// Shared home: traversable, not listable, for turn uids (0711).
	const homeMode = statSync(workerHome).mode & 0o777;
	expect(homeMode & 0o004).toBe(0);
	expect(homeMode & 0o001).toBe(0o001);
	expect(
		statSync(join(workerHome, ".omp", "agent", "agent.db")).mode & 0o777,
	).toBe(0o666);
	// The store's dir is sticky-writable (sqlite journals); sessions and logs
	// are sticky write-only-for-others (each uid keeps its entries private).
	expect(statSync(join(workerHome, ".omp", "agent")).mode & 0o777).toBe(0o777);
	expect(statSync(join(workerHome, ".omp", "agent")).mode & 0o1000).toBe(
		0o1000,
	);
	const sessions = statSync(join(workerHome, ".omp", "agent", "sessions"));
	expect(sessions.mode & 0o777).toBe(0o733);
	expect(sessions.mode & 0o1000).toBe(0o1000);
	// Project dirs under each root carry their project uid and are closed.
	expect(statSync(join(rootA, "proj-a")).uid).toBe(idsA.uid);
	expect(statSync(join(rootA, "proj-a")).mode & 0o777).toBe(0o700);
	expect(statSync(join(rootA, "proj-b")).uid).toBe(idsB.uid);
	expect(statSync(join(rootB, "proj-a")).uid).toBe(idsA.uid);
});

rootTest("bootTurnIsolation skips the chmod on a mounted store", () => {
	const workerHome = freshDir("boot-home-mounted");
	mkdirSync(join(workerHome, ".omp", "agent"), { recursive: true });
	const db = join(workerHome, ".omp", "agent", "agent.db");
	writeFileSync(db, "store");
	chmodSync(db, 0o600);
	const notes = bootTurnIsolation(workerHome, [], {
		isMounted: (p) => p === db,
	});
	expect(statSync(db).mode & 0o777).toBe(0o600);
	expect(notes.some((n) => n.includes("mount"))).toBe(true);
});

test("isolationEnabled matches the process uid", () => {
	expect(isolationEnabled()).toBe(
		typeof process.getuid === "function" && process.getuid() === 0,
	);
});
