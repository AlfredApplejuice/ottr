import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGitEnv } from "../gitRepoEnv.ts";
import type { BoardGuard } from "./boardRepoGuard.ts";

// The preload stashes its handle on globalThis (a bun preload cannot pass values to test files).
const holder = globalThis as { __ottrBoardGuard?: BoardGuard };
const guard = holder.__ottrBoardGuard;

test.skipIf(!guard)(
	"the guard refuses a fixture-shaped git write aimed at the enclosing repo (OTTR-1162 drill)",
	() => {
		if (!guard) return; // inert context (no enclosing repo, a Stryker sandbox)
		// The bad fixture: a session env whose GIT_DIR names the board repo drives a
		// fixture-style write from a cwd outside every repository. The shim must refuse it
		// without writing anything.
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
		// A read through the same redirect still passes: the guard blocks writes only.
		const rd = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
			cwd,
			env,
			encoding: "utf8",
		});
		expect(rd.status).toBe(0);
		expect(rd.stdout.trim()).toBe(guard.repo);
	},
);
