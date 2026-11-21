/**
 * OTTR-1180: suite-wide env hygiene. The full suite runs ~185 files in one process, and a
 * test that loses its restore (a load-capped test never reaches its finally) leaves the
 * write in process.env for every later file — the full-suite-only failure class: a leftover
 * GIT_CONFIG_COUNT without its key makes every later git spawn die with a config fatal, a
 * leftover PATH or HOME reroutes later fixtures. bunfig lists this file after
 * boardRepoGuard.ts, so the snapshot keeps the guard's shim PATH and the restore below
 * never disarms the guard. A file that needs an env value across its tests re-asserts it
 * in beforeEach (the sandboxRun, worktree date-pin, release-gates and hindsight describes
 * do); per-call writers with try/finally keeps are unaffected.
 */
import { afterEach } from "bun:test";

const snapshot: Readonly<Record<string, string>> = Object.freeze({
	...process.env,
} as Record<string, string>);

afterEach(() => {
	for (const key of Object.keys(process.env))
		if (!Object.hasOwn(snapshot, key)) delete process.env[key];
	for (const [key, value] of Object.entries(snapshot))
		if (process.env[key] !== value) process.env[key] = value;
});
