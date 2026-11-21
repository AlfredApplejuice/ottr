import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fixtureGitEnv } from "../gitRepoEnv.ts";
import { type BoardGuard, buildShim } from "./boardRepoGuard.ts";

// The preload stashes its handle on globalThis (a bun preload cannot pass values to test
// files). The property is present after the preload ran; null names the inert context.
const holder = globalThis as { __ottrBoardGuard?: BoardGuard | null };

test("the board-repo guard preload is wired (OTTR-1162)", () => {
	if (!("__ottrBoardGuard" in holder))
		throw new Error(
			"board-repo guard preload did not run: bunfig.toml [test] preload is missing or its install throws",
		);
});

test("the installed guard watches the enclosing repository, without writing it", () => {
	const guard = holder.__ottrBoardGuard;
	if (guard == null) return; // inert context only: no enclosing repo (a Stryker sandbox)
	expect(process.env.PATH?.split(delimiter)[0]).toBe(dirname(guard.shim));
	expect(basename(guard.shim)).toBe("git");
	// The watched repo is the enclosing checkout's git common dir. Read-only probe: this test
	// never points GIT_DIR, GIT_WORK_TREE or a cwd at the enclosing repository.
	const probe = spawnSync(guard.git, ["rev-parse", "--git-common-dir"], {
		cwd: process.cwd(),
		env: fixtureGitEnv(),
		encoding: "utf8",
	});
	expect(probe.status).toBe(0);
	const raw = probe.stdout.trim();
	const common = realpathSync(
		raw.startsWith("/") ? raw : join(process.cwd(), raw),
	);
	expect(guard.repo).toBe(common);
});

test("the shim refuses redirected writes aimed at a fixture repository (OTTR-1162 drill)", () => {
	// The drill builds its own shim instance with a fixture repository baked in as the watched
	// repo. Every redirected env value and cwd below names that temp repo — never the
	// enclosing one — so a shim bug during a drill cannot write the real repository.
	const guard = holder.__ottrBoardGuard;
	const realgit = guard?.git ?? Bun.which("git") ?? "git";
	const watched = mkdtempSync(join(tmpdir(), "ottr-guard-watch-"));
	spawnSync("git", ["init", "-q", "-b", "main", watched], {
		env: fixtureGitEnv(),
		encoding: "utf8",
	});
	const dir = mkdtempSync(join(tmpdir(), "ottr-guard-shim-"));
	const log = join(dir, "blocks.log");
	const shim = join(dir, "git");
	buildShim({ realgit, repo: watched, log, shimPath: shim });
	const envOf = (extra: Record<string, string>): Record<string, string> => ({
		...fixtureGitEnv(),
		PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
		...extra,
	});
	const outside = mkdtempSync(join(tmpdir(), "ottr-guard-outside-"));
	const inside = mkdtempSync(join(tmpdir(), "ottr-guard-inside-"));
	spawnSync("git", ["init", "-q", "-b", "main", inside], {
		env: fixtureGitEnv(),
		encoding: "utf8",
	});

	// A GIT_DIR-redirected commit from a cwd outside every repository: refused.
	const commit = spawnSync(
		"git",
		[
			"-c",
			"user.name=ott",
			"-c",
			"user.email=ott@example.invalid",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"guard-drill",
		],
		{
			cwd: outside,
			env: envOf({ GIT_DIR: join(watched, ".git") }),
			encoding: "utf8",
		},
	);
	expect(commit.status).toBe(126);
	expect(commit.stderr).toContain("board-repo guard");

	// A GIT_COMMON_DIR-redirected ref update from a fixture repo's own cwd: refused.
	const update = spawnSync(
		"git",
		["update-ref", "refs/heads/guard-drill", "HEAD"],
		{
			cwd: inside,
			env: envOf({ GIT_COMMON_DIR: join(watched, ".git") }),
			encoding: "utf8",
		},
	);
	expect(update.status).toBe(126);
	expect(update.stderr).toContain("board-repo guard");

	// A read through the same redirect still passes: the guard blocks writes only.
	const read = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
		cwd: outside,
		env: envOf({ GIT_DIR: join(watched, ".git") }),
		encoding: "utf8",
	});
	expect(read.status).toBe(0);
	expect(read.stdout.trim()).toBe(realpathSync(join(watched, ".git")));

	// The watched fixture repo holds nothing the drills could have written.
	const refs = spawnSync("git", ["for-each-ref", "refs/heads"], {
		cwd: watched,
		env: fixtureGitEnv(),
		encoding: "utf8",
	});
	expect(refs.status).toBe(0);
	expect(refs.stdout.trim()).toBe("");
	expect(existsSync(join(watched, "refs", "heads", "guard-drill"))).toBe(false);
});
