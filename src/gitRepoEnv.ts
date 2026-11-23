/**
 * Ambient env vars that relocate a git spawn to another repository (OTTR-1162). A drill run with
 * `GIT_DIR` aimed at an enclosing repository made a fixture helper's `git config` and
 * `git commit --allow-empty` write that repository while the fixture test stayed green — the
 * same signature as the stray commit and config write the board repo picked up during the
 * 2026-11-20 OTTR-1097 merge turn. How that session's environment got poisoned was not found,
 * and the loss of the board's `refs/remotes/origin/main` around the same time was not
 * reproduced (it may have another cause). git honors these variables over its cwd, so every
 * git spawn the board or the suite makes strips them from the child env; a caller that
 * genuinely needs them passes them via an explicit env value, which merges after the strip
 * (sealedGit's per-call env).
 */
export const GIT_REPO_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	// Relocates the common dir: refs, objects and the repo config (OTTR-1162 send-back).
	"GIT_COMMON_DIR",
] as const;

/**
 * A copy of the ambient env without the repo-relocating vars, for git spawns with a fixed repo:
 * test fixtures always act on their explicit cwd, never on a poisoned session env.
 */
export function fixtureGitEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !(GIT_REPO_ENV as readonly string[]).includes(k))
			env[k] = v;
	}
	return env;
}

/** Deletes the repo-relocating vars in place; callers build their env from process.env. */
export function stripRepoRelocatingEnv(
	env: Record<string, string | undefined>,
): void {
	for (const k of GIT_REPO_ENV) delete env[k];
}
