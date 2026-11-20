import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fixtureGitEnv } from "../gitRepoEnv.ts";
import type { BoardGuard } from "./boardRepoGuard.ts";

// The preload stashes its handle on globalThis (a bun preload cannot pass values to test
// files). The property is present after the preload ran; null names the inert context.
const holder = globalThis as { __ottrBoardGuard?: BoardGuard | null };

test("the board-repo guard preload is wired (OTTR-1162)", () => {
	if (!("__ottrBoardGuard" in holder))
		throw new Error(
			"board-repo guard preload did not run: bunfig.toml [test] preload is missing or its install throws",
		);
});

test("the guard refuses a fixture-shaped git write aimed at the enclosing repo (OTTR-1162 drill)", () => {
	const guard = holder.__ottrBoardGuard;
	// Inert context only: no enclosing repo (a Stryker sandbox, a bare checkout). The guard
	// protects nothing there, so the drill has nothing to refuse. A missing property (the
	// preload never ran) is the test above's failure, not this one's.
	if (guard == null) return;
	// The bad fixture: a session env whose GIT_DIR names the board repo drives a fixture-style
	// write from a cwd outside every repository. The shim must refuse it without writing
	// anything.
	expect(process.env.PATH?.split(delimiter)[0]).toBe(dirname(guard.shim));
	expect(basename(guard.shim)).toBe("git");
	const cwd = mkdtempSync(join(tmpdir(), "ottr-guard-drill-"));
	const env = { ...fixtureGitEnv(), GIT_DIR: guard.repo };
	const r = spawnSync(
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
		{ cwd, env, encoding: "utf8" },
	);
	expect(r.status).toBe(126);
	expect(r.stderr).toContain("board-repo guard");
	// The common-dir redirect relocates refs and the repo config wholesale: a fixture repo
	// whose GIT_COMMON_DIR names the board repo would write board refs from its own cwd.
	// The shim must refuse that too, without writing anything.
	const fixture = mkdtempSync(join(tmpdir(), "ottr-guard-drill-repo-"));
	spawnSync("git", ["init", "-q", "-b", "main", fixture], {
		env: fixtureGitEnv(),
		encoding: "utf8",
	});
	const rc = spawnSync(
		"git",
		["update-ref", "refs/heads/guard-drill", "HEAD"],
		{
			cwd: fixture,
			env: { ...fixtureGitEnv(), GIT_COMMON_DIR: guard.repo },
			encoding: "utf8",
		},
	);
	expect(rc.status).toBe(126);
	expect(rc.stderr).toContain("board-repo guard");
	// A read through the same redirect still passes: the guard blocks writes only.
	const rd = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
		cwd,
		env,
		encoding: "utf8",
	});
	expect(rd.status).toBe(0);
	expect(rd.stdout.trim()).toBe(guard.repo);
});
