/**
 * sandbox_run's client (docs/specs/microvm-validation-mode.md, "Board tool:
 * sandbox_run"): packs the target checkout with git archive, writes the tar
 * under the run dir, and POSTs the runner's /validate. The endpoint caps the
 * job and the VM at VM_VALIDATE.timeoutSec + lifetimeSlackSec and answers
 * after both, so this client sets no timeout of its own. Callers:
 * extension/tracker.ts (the sandbox_run tool) and src/vmValidateSmoke.ts (the
 * host smoke). Everything effectful is injected, so tests run without git,
 * network or /data.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { projectTrustedLists } from "./trustedLists.ts";
import {
	cwdUnderTarget,
	type ValidateRequest,
	type ValidateResponse,
	VM_VALIDATE,
} from "./vmValidateShared.ts";

/** The runner's project-name rule, copied from src/vmRunner.ts PROJECT_NAME. */
export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The job cwd's root in the guest; the runner takes only paths at or under it. */
const TARGET_ROOT = "/target";

/** One git spawn: the archive bytes, or the failure with its stderr. */
export type GitSpawn = (
	argv: string[],
) => Promise<{ code: number; stdout: Uint8Array; stderr: string }>;

const defaultSpawn: GitSpawn = async (argv) => {
	const proc = Bun.spawn(argv, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
	]);
	return { code: await proc.exited, stdout: new Uint8Array(stdout), stderr };
};

/** val-<epoch seconds>-<4 random hex bytes>; fits the ValidateRequest id rule. */
export const newJobId = (): string =>
	`val-${Math.floor(Date.now() / 1000)}-${randomBytes(4).toString("hex")}`;

export interface SandboxJobOptions {
	/** Must pass PROJECT_NAME; names the run dir and the /data record. */
	project: string;
	/** Git ref to archive; default HEAD. */
	ref?: string;
	/** The job's command; a non-empty list of strings. */
	argv: string[];
	/** Job cwd; absolute, normalized, at or under /target. Default "/target". */
	cwd?: string;
	/** Scratch-relative paths to promote; at most VM_VALIDATE.collectMaxNames. */
	collect?: string[];
	/** The checkout git packs; default /workspace/<project>. */
	checkout?: string;
	/** Defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Defaults to a Bun.spawn git runner. */
	spawnImpl?: GitSpawn;
	/** Read per call; defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/** The run dir sits at <dataRoot>/<project>/validate-jobs/<id>; default /data. */
	dataRoot?: string;
	/** Defaults to newJobId. */
	idFactory?: () => string;
}

export type SandboxJobResult =
	| { ok: true; result: ValidateResponse }
	| { ok: false; error: string };

function argvError(argv: string[]): string | null {
	if (argv.length === 0 || !argv.every((x) => typeof x === "string"))
		return "job.argv must be a non-empty list of strings";
	return null;
}

// Absolute, a posix.normalize identity, and at or under /target: the same shape
// the runner's inside() check takes (src/vmRunner.ts), plus the root itself
// because the default cwd is /target.
function cwdError(cwd: string): string | null {
	if (!cwdUnderTarget(cwd))
		return `job.cwd must be an absolute, normalized path at or under ${TARGET_ROOT} (got "${cwd}")`;
	return null;
}

// The runner's promotion rules reject absolute, empty, "." and ".." names
// before the job runs, so the caller sees the rule and not a 400.
function collectError(collect: string[]): string | null {
	if (collect.length > VM_VALIDATE.collectMaxNames)
		return `job.collect takes at most ${VM_VALIDATE.collectMaxNames} names (got ${collect.length})`;
	for (const name of collect) {
		const bad =
			isAbsolute(name) ||
			name === "" ||
			name.split("/").some((c) => c === "" || c === "." || c === "..");
		if (bad)
			return `job.collect names must be relative paths without empty, "." or ".." parts (got "${name}")`;
	}
	return null;
}

/**
 * Packs the target and runs one validation job. All input checks run before
 * any effect, so a bad call spends no git run and no tar write; the env checks
 * come first, because a misconfigured host must not pack at all.
 */
export async function runSandboxJob(
	o: SandboxJobOptions,
): Promise<SandboxJobResult> {
	const project = o.project;
	if (!PROJECT_NAME.test(project))
		return {
			ok: false,
			error: `project "${project}" is not a project name (src/vmRunner.ts PROJECT_NAME)`,
		};
	const argvErrorText = argvError(o.argv);
	if (argvErrorText !== null) return { ok: false, error: argvErrorText };
	const argv = o.argv;

	const cwd = o.cwd ?? TARGET_ROOT;
	const cwdErrorText = cwdError(cwd);
	if (cwdErrorText !== null) return { ok: false, error: cwdErrorText };

	const collect = o.collect ?? [];
	const collectErrorText = collectError(collect);
	if (collectErrorText !== null) return { ok: false, error: collectErrorText };

	const env = o.env ?? process.env;
	const base = (env.OTTR_VM_RUNNER_URL ?? "").trim().replace(/\/+$/, "");
	if (base === "")
		return {
			ok: false,
			error:
				"OTTR_VM_RUNNER_URL is not set; set it and bring up the vm-runner compose service (--profile vm) to run sandbox jobs.",
		};
	const token = (env.OTTR_WORKER_TOKEN ?? "").trim();
	if (token === "")
		return {
			ok: false,
			error:
				"OTTR_WORKER_TOKEN is not set; the runner rejects an unauthorized /validate call.",
		};

	const id = (o.idFactory ?? newJobId)();
	const runDir = join(
		// OTTR_DATA_DIR is the board’s data dir (the compose stack sets it to /data);
		// honoring it here keeps the tar on the volume the runner reads, on any layout.
		o.dataRoot ?? env.OTTR_DATA_DIR ?? "/data",
		project,
		"validate-jobs",
		id,
	);
	const targetTar = join(runDir, "target.tar");

	const spawn = o.spawnImpl ?? defaultSpawn;
	// `--` ends git's option parsing: a caller-supplied ref is a tree-ish, never a
	// flag. Without it, a value like --output=/path would truncate a host file or
	// --remote=<host> would dial out from this process before git failed on the
	// missing tree-ish.
	const archive = await spawn([
		"git",
		"-C",
		o.checkout ?? join("/workspace", project),
		"archive",
		"--",
		o.ref ?? "HEAD",
	]);
	if (archive.code !== 0 || archive.stdout.length === 0) {
		const why = archive.stderr.trim().slice(-500);
		const empty = archive.code === 0 ? ", empty archive" : "";
		return {
			ok: false,
			error: `git archive failed (exit ${archive.code}${empty}): ${why}`,
		};
	}

	try {
		await mkdir(runDir, { recursive: true });
		await writeFile(targetTar, archive.stdout);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `cannot write ${targetTar} (${why})` };
	}

	const request: ValidateRequest = {
		id,
		project,
		targetTar,
		// The validate bake reads the dispatch's trusted texts, never the shared
		// home (docs/specs/vm-list-isolation.md).
		lists: projectTrustedLists(project),
		job: {
			argv,
			cwd,
			...(collect.length > 0 ? { collect } : {}),
		},
	};

	// No client-side timeout: the runner kills the job at VM_VALIDATE.timeoutSec
	// and the VM at timeoutSec + lifetimeSlackSec, then answers.
	const fetchImpl = o.fetchImpl ?? fetch;
	let res: Response;
	try {
		res = await fetchImpl(`${base}/validate`, {
			method: "POST",
			headers: {
				// The token rides the wire only, like /run; it never enters the
				// request body or any text this function returns.
				"x-otwr-token": token,
				"content-type": "application/json",
			},
			body: JSON.stringify(request),
		});
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `the runner at ${base} is unreachable (${why})`,
		};
	}
	const bodyText = await res.text();
	// Defense in depth: a misbehaving runner must not echo the wire token into
	// the error text the audit stores as its exact blocker.
	const safe =
		token === "" ? bodyText : bodyText.replaceAll(token, "[REDACTED]");
	if (res.status !== 200)
		return { ok: false, error: `${res.status}: ${safe.slice(0, 500)}` };
	let result: ValidateResponse;
	try {
		result = JSON.parse(bodyText) as ValidateResponse;
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `the runner answered 200 with invalid JSON (${why}): ${safe.slice(0, 500)}`,
		};
	}
	return { ok: true, result };
}
