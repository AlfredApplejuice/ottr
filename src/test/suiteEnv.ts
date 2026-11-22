/**
 * OTTR-1180: suite-wide env hygiene. The full suite runs ~185 files in one process, and a
 * load-capped test never reaches its finally, so its env writes ride into every later file
 * (observed as git exit-128 fatals from a leftover GIT_CONFIG_COUNT in the board-repo guard
 * probe). The hooks below snapshot the env before each test and restore the drift after it:
 * the leak heals at its source, and every file's own module and beforeAll pins stand.
 * bunfig lists this file after boardRepoGuard.ts, so the captures keep the guard's shim
 * PATH and the restore never disarms the guard.
 *
 * The scrub below runs once at preload: the worker session exports its own runtime names
 * (OTTR_*, OMP_*, ALATE_*, HINDSIGHT_*, GH_*, PI_CODING_AGENT_DIR and the git ident pair),
 * and a CI run — the suite's reference environment — carries none of them. Tests read the
 * scrubbed base the same way here and on CI; a test that needs one of the names sets it
 * itself.
 */
import { afterEach, beforeEach } from "bun:test";

for (const key of Object.keys(process.env)) {
	if (
		/^(OTTR_|OMP_|ALATE_|HINDSIGHT_|GH_|PI_CODING_|GIT_AUTHOR_|GIT_COMMITTER_)/.test(
			key,
		) &&
		// Test controls survive the scrub: CI sets these on its test step, and the
		// sandbox data guard passes its watched roots to its child through them.
		!/^(OTTR_TEST_|OTTR_REQUIRE_PG_TESTS|OTTR_DATA_DIR|OTTR_DATABASE_URL|OTTR_PG_ALLOW_EMPTY)/.test(
			key,
		)
	)
		delete process.env[key];
}

let start: Record<string, string> = {};

beforeEach(() => {
	start = { ...process.env } as Record<string, string>;
});

afterEach(() => {
	for (const key of Object.keys(process.env))
		if (!Object.hasOwn(start, key)) delete process.env[key];
	for (const [key, value] of Object.entries(start))
		if (process.env[key] !== value) process.env[key] = value;
});
