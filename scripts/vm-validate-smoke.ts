/**
 * The KVM-host acceptance run for the microVM validation mode
 * (docs/specs/microvm-validation-mode.md, "Acceptance checks", item 3): one validation
 * job whose probe tries to reach the network, write to the target, and read the
 * environment. Every attempt is printed with its verdict, and the exit is non-zero when
 * one attempt is not blocked, so a host script can gate on the exit code alone.
 *
 * Run it where bun, the checkout and the vm-runner's compose network meet, for example
 * in a one-off container from the branch's vm-runner image (see docs/WORKERS.md,
 * "Validation mode"):
 *
 *   bun /workspace/ottr/scripts/vm-validate-smoke.ts
 *
 * No secret enters the VM: the runner request carries the shared worker token on the
 * wire only, exactly as the sandbox_run tool does.
 */
import { join } from "node:path";
import { runSandboxJob } from "../src/sandboxRun.ts";
import { type ValidateResponse, VM_VALIDATE } from "../src/vmValidateShared.ts";

/** The job that attempts the three harness controls and reports each one. */
export function probeArgv(): string[] {
	return [
		"sh",
		"-c",
		[
			"if bun -e 'Bun.connect({hostname:\"1.1.1.1\",port:53,socket:{}}).then(()=>process.exit(0),()=>process.exit(1))' >/dev/null 2>&1; then v=allowed; else v=blocked; fi",
			'echo "ATTEMPT network $v tcp/1.1.1.1:53 routes=$(ip route show | head -1)"',
			"if touch /target/.ottr-smoke 2>/dev/null; then v=allowed; else v=blocked; fi",
			'echo "ATTEMPT target-write $v /target/.ottr-smoke"',
			"echo \"ATTEMPT env $(env | sort | sed 's/=.*//' | tr '\\n' ' ' | sed 's/ $//')\"",
		].join("; "),
	];
}

export interface Attempt {
	name: string;
	/** The probe's own verdict: blocked or allowed — for env, the variable list. */
	verdict: string;
	detail: string;
}

/** The ATTEMPT lines the probe wrote to the job's stdout. */
export function parseAttempts(stdoutTail: string): Attempt[] {
	const out: Attempt[] = [];
	for (const line of stdoutTail.split("\n")) {
		const m = /^ATTEMPT ([a-z-]+) (.*)$/.exec(line.trim());
		if (!m) continue;
		const name = m[1] ?? "";
		const rest = (m[2] ?? "").trim();
		// env's value is the whole variable list, not a verdict-plus-detail split.
		if (name === "env") out.push({ name, verdict: rest, detail: "" });
		else {
			const space = rest.indexOf(" ");
			out.push(
				space === -1
					? { name, verdict: rest, detail: "" }
					: {
							name,
							verdict: rest.slice(0, space),
							detail: rest.slice(space + 1),
						},
			);
		}
	}
	return out;
}

/** The env names the allowlist produces, in sorted order. */
export const expectedEnvNames = Object.keys(VM_VALIDATE.envAllowlist)
	.sort()
	.join(" ");

/** Every way the result fails the acceptance: empty means the sandbox held. */
export function acceptanceViolations(result: ValidateResponse): string[] {
	const bad: string[] = [];
	if (result.resultSource !== "guest")
		bad.push(
			`no guest result (${result.resultSource}): ${result.error ?? "no error line"}`,
		);
	if (result.selfCheck?.ok !== true)
		bad.push("the guest self-check did not pass");
	if (result.missingControl !== null && result.missingControl !== undefined)
		bad.push(`missing control: ${result.missingControl}`);
	const job = result.job;
	if (!job) {
		bad.push("the job did not run");
		return bad;
	}
	const attempts = parseAttempts(job.stdoutTail);
	const byName = new Map(attempts.map((a) => [a.name, a]));
	for (const name of ["network", "target-write"] as const) {
		const a = byName.get(name);
		if (!a) bad.push(`the ${name} attempt never ran`);
		else if (a.verdict !== "blocked")
			bad.push(
				`the ${name} attempt was ${a.verdict}, not blocked (${a.detail})`,
			);
	}
	const env = byName.get("env");
	if (!env) bad.push("the env attempt never ran");
	else if (env.verdict !== expectedEnvNames)
		bad.push(
			`the job env was "${env.verdict}", not the allowlist "${expectedEnvNames}"`,
		);
	return bad;
}

export interface SmokeDeps {
	/** Defaults to the real runSandboxJob. */
	runner?: typeof runSandboxJob;
	/** Defaults to process stdout. */
	print?: (line: string) => void;
}

/** Runs the acceptance job and returns the process exit code: 0 only when it held. */
export async function main(
	argv: string[],
	deps: SmokeDeps = {},
): Promise<number> {
	const print = deps.print ?? ((line: string) => console.log(line));
	const runner = deps.runner ?? runSandboxJob;
	const flag = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const project = flag("project") ?? "ottr";
	const url =
		flag("url") ?? process.env.OTTR_VM_RUNNER_URL ?? "http://vm-runner:8787";
	const token = flag("token") ?? process.env.OTTR_WORKER_TOKEN ?? "";
	const checkout = flag("checkout") ?? join("/workspace", project);
	const ref = flag("ref");
	print(
		`vm-validate-smoke: project ${project}, ref ${ref ?? "HEAD"}, runner ${url}`,
	);
	const result = await runner({
		project,
		checkout,
		argv: probeArgv(),
		cwd: "/target",
		...(ref !== undefined && ref !== "" ? { ref } : {}),
		env: {
			OTTR_VM_RUNNER_URL: url,
			...(token !== "" ? { OTTR_WORKER_TOKEN: token } : {}),
		},
	});
	if (!result.ok) {
		print(`FAIL: ${result.error}`);
		return 1;
	}
	const response = result.result;
	for (const check of response.selfCheck?.checks ?? []) {
		print(
			`self-check ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`,
		);
	}
	if (!response.job) {
		print(`FAIL: the job did not run (${response.error ?? "no error line"})`);
		return 1;
	}
	for (const a of parseAttempts(response.job.stdoutTail)) {
		print(
			a.name === "env"
				? `ATTEMPT env: ${a.verdict === expectedEnvNames ? "exactly the allowlist" : `read back "${a.verdict}" instead of the allowlist "${expectedEnvNames}"`}`
				: `ATTEMPT ${a.name}: ${a.verdict}${a.detail ? ` (${a.detail})` : ""} — ${a.verdict === "blocked" ? "blocked as required" : "NOT BLOCKED"}`,
		);
	}
	const violations = acceptanceViolations(response);
	if (violations.length > 0) {
		for (const v of violations) print(`FAIL: ${v}`);
		print(
			`totalMs ${response.totalMs}, logTail: ${response.logTail.slice(-400)}`,
		);
		return 1;
	}
	print(
		`PASS: every control held (boot+run ${response.totalMs} ms, limits ${JSON.stringify(response.limits)})`,
	);
	return 0;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
