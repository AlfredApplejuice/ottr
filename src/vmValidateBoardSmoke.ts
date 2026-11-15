/**
 * Host smoke for the board path of sandbox_run (docs/specs/microvm-validation-mode.md,
 * acceptance check 6): files a cancelled review card in the project's store, calls the
 * board's sandbox endpoint over loopback the way the tool does, and checks that the
 * job's result landed at <OTTR_DATA_DIR>/<project>/validate-jobs/<id>/result.json with
 * selfCheck.ok true. Run inside the server container, which holds the board, the
 * checkouts and the data volume (docs/WORKERS.md, "Validation mode"):
 *
 *   docker compose exec server bun /app/src/vmValidateBoardSmoke.ts
 *
 * Flags: --project (default ottr), --checkout (default /workspace/<project>), --port
 * (default OTTR_PORT or 8080), --ref (default HEAD), --cwd, --collect (comma list),
 * --argv (comma-split job command; default the probe below). Exit 0 only when the
 * endpoint answered, the guest's self-check passed, and result.json holds the same
 * verdict. The review card is created cancelled: the dispatch loop never starts it,
 * and the smoke leaves no open card on the board.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, type TaskPatch } from "./store.ts";
import type { Task, TaskKind } from "./types.ts";
import type { ValidateResponse } from "./vmValidateShared.ts";

// The default probe: reads the env back, shows the routes, and tries the two
// writes the controls forbid (the target, the result medium). Every attempt
// must come back blocked in the job's stdoutTail.
const PROBE_ARGV = [
	"sh",
	"-c",
	"echo '== env =='; env; echo '== routes =='; ip route; echo '== target write =='; touch /target/.ottr-probe && echo WRITE-OK || echo WRITE-BLOCKED; echo '== vdd write =='; : > /dev/vdd && echo VDD-WRITE-OK || echo VDD-WRITE-BLOCKED",
];

/** The store surface the smoke needs; ProjectStore satisfies it, tests fake it. */
export interface BoardSmokeStore {
	createTask(
		prompt: string,
		model: string | null,
		kind: TaskKind,
	): Promise<Pick<Task, "id">>;
	updateTask(id: string, patch: TaskPatch): Promise<unknown>;
	close?(): Promise<void>;
}

export interface BoardSmokeDeps {
	/** Defaults to ProjectStore.open. */
	openStore?: (checkout: string) => Promise<BoardSmokeStore>;
	/** Defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Defaults to OTTR_DATA_DIR, then /data. */
	dataRoot?: string;
	/** Defaults to process stdout. */
	print?: (line: string) => void;
}

/** Runs the board-path acceptance and returns the exit code: 0 only when it held. */
export async function main(
	argv: string[],
	deps: BoardSmokeDeps = {},
): Promise<number> {
	const print = deps.print ?? ((line: string) => console.log(line));
	const fetchImpl = deps.fetchImpl ?? fetch;
	const flag = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const project = flag("project") ?? "ottr";
	const checkout = flag("checkout") ?? join("/workspace", project);
	const port = flag("port") ?? process.env.OTTR_PORT ?? "8080";
	const ref = flag("ref");
	const cwd = flag("cwd");
	const collectFlag = flag("collect");
	const collect =
		collectFlag === undefined
			? []
			: collectFlag
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s !== "");
	// Comma-split, never trimmed: a job command's parts are byte-exact.
	const argvFlag = flag("argv");
	const jobArgv =
		argvFlag === undefined
			? PROBE_ARGV
			: argvFlag.split(",").filter((s) => s !== "");
	const dataRoot = deps.dataRoot ?? process.env.OTTR_DATA_DIR ?? "/data";

	const store = await (deps.openStore ?? ((c: string) => ProjectStore.open(c)))(
		checkout,
	);
	let card: Pick<Task, "id"> | null = null;
	let cancelled = false;
	try {
		// Create and cancel back to back on the store queue: the dispatch loop
		// ticks on seconds, so it never sees an open card to start.
		card = await store.createTask(
			`sandbox_run board-path smoke (${new Date().toISOString()})`,
			null,
			"review",
		);
		await store.updateTask(card.id, { cancelledAt: Date.now() });
		cancelled = true;

		const body = {
			taskId: card.id,
			project,
			argv: jobArgv,
			...(ref ? { ref } : {}),
			...(cwd ? { cwd } : {}),
			...(collect.length > 0 ? { collect } : {}),
		};
		// Loopback inside the server container: the agent-host wall needs no token.
		let res: Response;
		try {
			res = await fetchImpl(
				`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project)}/sandbox`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			);
		} catch (err) {
			const why = err instanceof Error ? err.message : String(err);
			print(`FAIL: the board endpoint is unreachable (${why})`);
			return 2;
		}
		const text = await res.text();
		if (res.status !== 200) {
			print(`FAIL: ${res.status}: ${text}`);
			return 2;
		}
		let answer: { ok?: unknown; result?: unknown };
		try {
			answer = JSON.parse(text) as { ok?: unknown; result?: unknown };
		} catch (err) {
			const why = err instanceof Error ? err.message : String(err);
			print(`FAIL: the endpoint answered 200 with invalid JSON (${why})`);
			return 2;
		}
		if (
			answer.ok !== true ||
			typeof answer.result !== "object" ||
			answer.result === null
		) {
			print(`FAIL: the endpoint answered 200 without a result: ${text}`);
			return 2;
		}
		const result = answer.result as ValidateResponse;
		print(JSON.stringify(result, null, 2));
		if (result.resultSource === "absent")
			print("FAIL: the endpoint saw no guest result (resultSource absent)");
		if (result.selfCheck?.ok !== true)
			print("FAIL: the guest self-check did not pass");
		if (result.missingControl)
			print(`FAIL: missing control: ${result.missingControl}`);
		if (
			result.resultSource === "absent" ||
			result.selfCheck?.ok !== true ||
			result.missingControl
		)
			return 2;

		const resultPath = join(
			dataRoot,
			project,
			"validate-jobs",
			result.id,
			"result.json",
		);
		print(`result.json must sit at ${resultPath}`);
		let raw: string;
		try {
			raw = readFileSync(resultPath, "utf8");
		} catch {
			print(`FAIL: result.json missing or unreadable at ${resultPath}`);
			return 3;
		}
		let disk: ValidateResponse;
		try {
			disk = JSON.parse(raw) as ValidateResponse;
		} catch (err) {
			const why = err instanceof Error ? err.message : String(err);
			print(`FAIL: result.json at ${resultPath} is not valid JSON (${why})`);
			return 3;
		}
		if (disk.id !== result.id)
			print(`FAIL: result.json holds id "${disk.id}", not "${result.id}"`);
		if (disk.selfCheck?.ok !== true)
			print("FAIL: result.json holds a failed self-check");
		if (disk.id !== result.id || disk.selfCheck?.ok !== true) return 3;

		print(
			`PASS: the board path reached the guest, result.json agrees (${result.id})`,
		);
		return 0;
	} finally {
		// Belt and braces: never leave an open card, even when an early step threw.
		if (card !== null && !cancelled)
			await store.updateTask(card.id, { cancelledAt: Date.now() });
		await store.close?.();
	}
}

// The body runs only as the CLI (docker compose exec server bun /app/src/vmValidateBoardSmoke.ts).
// The Stryker bun-runner's coverage preload imports every mutated module, so an unguarded
// top-level run here killed the mutation dry run (OTTR-973).
if (import.meta.main) process.exit(await main(process.argv.slice(2)));
