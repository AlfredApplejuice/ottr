/**
 * Ambient env vars that relocate a git spawn to another repository (OTTR-1162). A session that
 * carries `GIT_DIR` (a merge-turn shell, a process launched from a git hook) once redirected the
 * suite's fixture writes into the board's own repository: a fixture `git commit --allow-empty`
 * landed on the board main, `git config` wrote the board config, and `git update-ref -d` deleted
 * the board's `refs/remotes/origin/main`. git honors these over its cwd, so every git spawn the
 * board or the suite makes strips them from the child env; a caller that genuinely needs them
 * passes them via an explicit env value, which merges after the strip (sealedGit's per-call env).
 */
export const GIT_REPO_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
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
