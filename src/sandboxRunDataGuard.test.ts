import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test file that reaches runSandboxJob: src/sandboxRun.test.ts stages real
// job dirs, extension/tracker.test.ts drives the sandbox_run tool, and
// scripts/vm-validate-smoke.test.ts drives the smoke CLI. This guard runs them
// the way the board's merge and review turns run the suite — in a process whose
// OTTR_DATA_DIR points at a live data root — but points that root here: on the
// server OTTR_DATA_DIR is /data, and one staging call without its own data root
// would drop a val-* job dir into the board's own validate-jobs.
const sandboxTestFiles = [
	"src/sandboxRun.test.ts",
	"extension/tracker.test.ts",
	"scripts/vm-validate-smoke.test.ts",
];

test("the suite's sandbox paths never stage a job in the ambient OTTR_DATA_DIR", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "ottr-sbx-guard-"));
	try {
		const run = Bun.spawnSync(["bun", "test", ...sandboxTestFiles], {
			cwd: join(import.meta.dir, ".."),
			env: { ...process.env, OTTR_DATA_DIR: dataDir },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (run.exitCode !== 0) {
			// Show the child's failure next to this one, so a red guard names the
			// sandbox test that staged in the ambient root.
			console.error(run.stdout.toString().slice(-2000));
			console.error(run.stderr.toString().slice(-2000));
		}
		expect(run.exitCode).toBe(0);
		// Empty afterward: a job dir here proves a sandbox path staged through
		// the ambient OTTR_DATA_DIR instead of its own data root.
		expect(readdirSync(dataDir)).toEqual([]);
	} finally {
		rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
	}
}, 120_000);
