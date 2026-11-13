/**
 * Host smoke for the validation mode (docs/specs/microvm-validation-mode.md,
 * acceptance check 3): packs a checkout with git archive and runs the probe
 * job in the Firecracker sandbox, then prints the result JSON. Run inside the
 * server container, which holds OTTR_VM_RUNNER_URL, OTTR_WORKER_TOKEN,
 * /workspace and the compose network (docs/WORKERS.md):
 *
 *   docker compose exec server bun /app/src/vmValidateSmoke.ts
 *
 * Flags: --project (default ottr), --checkout (default /workspace/<project>),
 * --ref (default HEAD), --cwd, --collect (comma list), --argv (comma-split
 * job command; default the probe below). Exit 0 only when the guest answered,
 * its self-check passed and no control is missing.
 */
import { runSandboxJob } from "./sandboxRun.ts";

// The default probe: reads the env back, shows the routes, and tries the two
// writes the controls forbid (the target, the result medium). Every attempt
// must come back blocked in the job's stdoutTail.
const PROBE_ARGV = [
	"sh",
	"-c",
	"echo '== env =='; env; echo '== routes =='; ip route; echo '== target write =='; touch /target/.ottr-probe && echo WRITE-OK || echo WRITE-BLOCKED; echo '== vdd write =='; : > /dev/vdd && echo VDD-WRITE-OK || echo VDD-WRITE-BLOCKED",
];

function flagValue(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	if (i < 0) return undefined;
	return process.argv[i + 1];
}

const project = flagValue("project") ?? "ottr";
const checkout = flagValue("checkout") ?? `/workspace/${project}`;
const ref = flagValue("ref");
const cwd = flagValue("cwd");
const collectFlag = flagValue("collect");
const collect =
	collectFlag === undefined
		? undefined
		: collectFlag
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s !== "");
// Comma-split, never trimmed: a job command's parts are byte-exact.
const argvFlag = flagValue("argv");
const argv =
	argvFlag === undefined
		? PROBE_ARGV
		: argvFlag.split(",").filter((s) => s !== "");

const job = await runSandboxJob({
	project,
	checkout,
	argv,
	...(ref ? { ref } : {}),
	...(cwd ? { cwd } : {}),
	...(collect !== undefined && collect.length > 0 ? { collect } : {}),
});

if (!job.ok) {
	console.error(job.error);
	process.exit(1);
}
console.log(JSON.stringify(job.result, null, 2));

const result = job.result;
const failedChecks = result.selfCheck?.checks.filter((c) => !c.ok) ?? [];
const passed =
	result.resultSource === "guest" &&
	result.selfCheck !== null &&
	result.selfCheck.ok &&
	result.missingControl === null;
if (!passed) {
	if (result.missingControl !== null)
		console.error(`missing control: ${result.missingControl}`);
	if (result.error !== undefined) console.error(result.error);
	for (const c of failedChecks) console.error(`${c.name}: ${c.detail}`);
	process.exit(1);
}
