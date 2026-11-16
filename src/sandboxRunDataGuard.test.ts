import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test file that reaches runSandboxJob: src/sandboxRun.test.ts stages real
// job dirs, extension/tracker.test.ts drives the sandbox_run tool, and
// scripts/vm-validate-smoke.test.ts drives the smoke CLI. This guard runs them
// the way the board's merge and review turns run the suite — in a process whose
// OTTR_DATA_DIR points at a live data root — and checks two leak channels the
// child files cannot see themselves:
// 1. The child's ambient root (this temp dir) must stay empty: the belt files
//    use OTTR_TEST_DATA_ROOT as their root, so a staging call with neither its
//    own env nor its own data root lands here — on the server the ambient root
//    would be the board's own /data. The child file's afterAll fails with it.
// 2. The live validate-jobs dir must gain nothing test-made: a call whose
//    explicit env lacks OTTR_DATA_DIR bypasses the child's ambient root and
//    writes /data directly. A real job's dir gains result.json when the runner
//    answers, so a target.tar-only dir names the leak. A job that is still
//    running while the child executes could false-red here; a rerun clears it.
// On a machine without /data the second channel skips; the first still runs.
const sandboxTestFiles = [
	"src/sandboxRun.test.ts",
	"extension/tracker.test.ts",
	"scripts/vm-validate-smoke.test.ts",
];

const liveJobsDir = "/data/ottr/validate-jobs";

// The sandbox staging signature: <project>/validate-jobs/<id>. The watched dir
// may legally carry other OTTR_DATA_DIR consumers — ProjectStore adopts
// <dataRoot>/<store name> per board entry — so only this signature names a leak.
function sandboxStageDirs(root: string): string[] {
	const out: string[] = [];
	for (const project of readdirSync(root, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		for (const leaf of readdirSync(join(root, project.name), {
			withFileTypes: true,
		}))
			if (leaf.isDirectory() && leaf.name === "validate-jobs")
				out.push(join(project.name, leaf.name));
	}
	return out;
}

test("the suite's sandbox paths never stage a job in the ambient OTTR_DATA_DIR", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "ottr-sbx-guard-"));
	const before = existsSync(liveJobsDir) ? readdirSync(liveJobsDir) : null;
	try {
		const run = Bun.spawnSync(["bun", "test", ...sandboxTestFiles], {
			cwd: join(import.meta.dir, ".."),
			env: {
				...process.env,
				OTTR_DATA_DIR: dataDir,
				OTTR_TEST_DATA_ROOT: dataDir,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		if (run.exitCode !== 0) {
			// Show the child's failure next to this one, so a red guard names the
			// sandbox test that staged in the ambient root.
			console.error(run.stdout.toString().slice(-2000));
			console.error(run.stderr.toString().slice(-2000));
		}
		// Channel 1 first, so it reports even when the child is already red: the
		// belt files use OTTR_TEST_DATA_ROOT as their root, so a staging call that
		// consults the ambient env lands right here.
		expect(sandboxStageDirs(dataDir)).toEqual([]);
		expect(run.exitCode).toBe(0);
		// Channel 2: the live dir gains only real jobs (they carry result.json).
		if (before !== null) {
			const added = readdirSync(liveJobsDir).filter((n) => !before.includes(n));
			const testMade = added.filter(
				(n) => !existsSync(join(liveJobsDir, n, "result.json")),
			);
			expect(testMade).toEqual([]);
		}
	} finally {
		rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
	}
}, 120_000);
