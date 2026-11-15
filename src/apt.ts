// System packages a project's turns need (e.g. the shared libraries Chrome needs for omp's
// browser tool). The list lives in the data repo as workers/<project>/apt.txt; alate provisions
// it into the shared home volume, and the board seed copies it into the board home. The board
// sends the trusted list text on every worker turn request and a worker installs from that
// request only (docs/specs/worker-list-isolation.md); the container that runs a turn installs
// what it still lacks.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveAgentLayer } from "./layers.ts";

// Debian package names (policy 5.6.1): a list entry can never turn into an apt-get option.
const PACKAGE = /^[a-z0-9][a-z0-9+.-]+$/;
// One path segment that cannot climb out of the workers dir; mirrors the New tab, which
// rejects only separators and the dot names, so any other folder name is legal here.
export const PROJECT = /^(?!\.\.?$)[^/\\]+$/;

/** The projects alate provisioned under ~/.ottr/workers, sorted; unsafe names are skipped. */
export function workerProjects(home = homedir()): string[] {
	const dir = join(home, ".ottr", "workers");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.sort()
		.filter((p) => PROJECT.test(p));
}

/** Where alate provisions a project's package list, resolved for a read: under the home's
 *  current agent layer when one exists, else the flat home (docs/specs/agent-layer-switch.md). */
export function aptListPath(project: string, home = homedir()): string {
	if (!PROJECT.test(project))
		throw new Error(`apt: unsafe project name ${JSON.stringify(project)}`);
	const layer = resolveAgentLayer(home)?.dir ?? home;
	return join(layer, ".ottr", "workers", project, "apt.txt");
}

/** apt.txt: one Debian package per line; `#` comments and blank lines are ignored. */
export function parseAptTxt(text: string): string[] {
	const names = text
		.split("\n")
		.map((l) => l.replace(/#.*/, "").trim())
		.filter((l) => l !== "");
	const bad = names.filter((n) => !PACKAGE.test(n));
	if (bad.length > 0)
		throw new Error(`apt: not a Debian package name: ${bad.join(", ")}`);
	return [...new Set(names)];
}

/** The names `dpkg-query --status` output does not show as installed. */
export function missingFrom(names: string[], status: string): string[] {
	const installed = new Set<string>();
	for (const block of status.split(/\n\s*\n/)) {
		const name = /^Package: (\S+)/m.exec(block)?.[1];
		if (name && /^Status: .* installed$/m.test(block)) installed.add(name);
	}
	return names.filter((n) => !installed.has(n));
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Installs the listed packages this machine lacks, before a turn runs here; `source` names the
 * list the names came from in the guard line and the install note (the file path for the
 * server wrapper, the run request on a worker). Throws apt's own error, so the turn stops.
 */
export async function ensurePackages(
	names: string[],
	source: string,
	run: Exec = exec,
): Promise<string[]> {
	if (names.length === 0) return [];
	if (
		process.platform !== "linux" ||
		process.getuid?.() !== 0 ||
		!Bun.which("apt-get")
	)
		return [
			`apt: ${source} lists ${names.length} package(s), but only root on Debian or Ubuntu installs them here: install them yourself`,
		];
	// ponytail: one install at a time per process (each container runs one ottr process);
	// apt's lock timeout covers other callers, e.g. an agent running apt-get itself.
	const runQ = queue.then(() => install(names, source, run));
	queue = runQ.catch(() => {});
	return runQ;
}

/** The server-local wrapper: read the project's apt.txt (aptListPath resolves the layer), install. */
export async function ensureProjectPackages(
	project: string,
	home = homedir(),
): Promise<string[]> {
	const file = aptListPath(project, home);
	if (!existsSync(file)) return [];
	return ensurePackages(parseAptTxt(readFileSync(file, "utf8")), file);
}

/** The packages `dpkg --audit` names: each sits on a line `" <name>[:arch]  <summary>"`. */
export function auditedPackages(audit: string): string[] {
	const names = audit
		.split("\n")
		.map((line) => /^ (\S+)/.exec(line)?.[1]?.split(":")[0] ?? "")
		.filter((name) => PACKAGE.test(name));
	return [...new Set(names)];
}

type Exec = (argv: string[], check?: boolean) => Promise<string>;

/** Exported for tests, which inject `run` in place of the real commands. */
export async function install(
	names: string[],
	file: string,
	run: Exec = exec,
): Promise<string[]> {
	const status = await run(["dpkg-query", "--status", ...names], false);
	const missing = missingFrom(names, status);
	if (missing.length === 0) return [];
	// A container stopped during apt-get leaves dpkg interrupted, and every later apt-get
	// install then fails (OTTR-221). dpkg has no lock timeout: when another apt run holds the
	// lock, this fails, and apt-get install below waits for the lock and reports instead.
	await run(["dpkg", "--configure", "-a"], false);
	const broken = auditedPackages(await run(["dpkg", "--audit"], false));
	await run(["apt-get", "update", "-qq"]);
	if (broken.length > 0) {
		await run([
			"apt-get",
			"install",
			"-y",
			"-qq",
			"--reinstall",
			"-o",
			"DPkg::Lock::Timeout=120",
			...broken,
		]);
		const audit = (await run(["dpkg", "--audit"], false)).trim();
		if (audit) throw new Error(`apt: dpkg --audit after repair: ${audit}`);
	}
	await run([
		"apt-get",
		"install",
		"-y",
		"-qq",
		"--no-install-recommends",
		"-o",
		"DPkg::Lock::Timeout=120",
		...missing,
	]);
	return [`apt: installed ${missing.join(" ")} (${file})`];
}

/** stdout; throws with the stderr tail on a non-zero exit when `check` is set. */
async function exec(argv: string[], check = true): Promise<string> {
	const p = Bun.spawn(argv, {
		env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	if (check && code !== 0)
		throw new Error(
			`apt: ${argv.slice(0, 2).join(" ")} failed (exit ${code}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`,
		);
	return stdout;
}
