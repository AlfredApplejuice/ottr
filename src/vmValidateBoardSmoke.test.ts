import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskPatch } from "./store.ts";
import {
	type BoardSmokeDeps,
	type BoardSmokeStore,
	main,
} from "./vmValidateBoardSmoke.ts";
import { type ValidateResponse, VM_VALIDATE } from "./vmValidateShared.ts";

const JOB_ID = "val-1763000000-cafebabe";
const REFUSAL = "sandbox_run runs only in review or trending scout runs";

const guestResponse: ValidateResponse = {
	id: JOB_ID,
	selfCheck: {
		ok: true,
		checks: [{ name: "interfaces", ok: true, detail: "lo only" }],
	},
	missingControl: null,
	job: {
		argv: ["bun", "test", "src/parse.ts"],
		cwd: "/target",
		exitCode: 0,
		signal: null,
		timedOut: false,
		stdoutTail: "1 pass",
		stderrTail: "",
	},
	artifacts: [],
	limits: { ...VM_VALIDATE },
	bootMs: 812,
	totalMs: 9400,
	logTail: "",
	resultSource: "guest",
};

interface FetchCapture {
	url: string;
	init: RequestInit;
}

// One fake fetch: records every call, answers with the given status and body.
function fakeFetch(
	status: number,
	body: string,
): { fetchImpl: typeof fetch; seen: FetchCapture[] } {
	const seen: FetchCapture[] = [];
	const fetchImpl = (async (url: string | URL, init: RequestInit) => {
		seen.push({ url: String(url), init });
		return new Response(body, { status });
	}) as unknown as typeof fetch;
	return { fetchImpl, seen };
}

interface StoreSpy {
	updates: { id: string; patch: TaskPatch }[];
	closed: number;
}

// A fake store: createTask hands out a fixed card id, updateTask and close are recorded.
function fakeStore(): { store: BoardSmokeStore; spy: StoreSpy } {
	const spy: StoreSpy = { updates: [], closed: 0 };
	const store: BoardSmokeStore = {
		createTask: async () => ({ id: "P1-smoke" }),
		updateTask: async (id, patch) => {
			spy.updates.push({ id, patch });
			return { id };
		},
		close: async () => {
			spy.closed += 1;
		},
	};
	return { store, spy };
}

// Tmp data roots, each removed after its test even when an assertion fails.
const tmpRoots: string[] = [];
afterEach(() => {
	for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
	tmpRoots.length = 0;
});
function tmpRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "ottr-boardsmoke-"));
	tmpRoots.push(root);
	return root;
}

// Pre-writes the run dir's result.json exactly as the server leaves it.
function writeResultJson(root: string, result: ValidateResponse): string {
	const dir = join(root, "ottr", "validate-jobs", result.id);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "result.json");
	writeFileSync(path, JSON.stringify(result));
	return path;
}

function boardDeps(
	store: BoardSmokeStore,
	fetchImpl: typeof fetch,
	dataRoot: string,
	out: string[],
): BoardSmokeDeps {
	return {
		openStore: async () => store,
		fetchImpl,
		dataRoot,
		print: (line) => out.push(line),
	};
}

describe("main", () => {
	test("the happy path exits 0, POSTs the cancelled card to loopback, and closes the store", async () => {
		const root = tmpRoot();
		writeResultJson(root, guestResponse);
		const { store, spy } = fakeStore();
		const { fetchImpl, seen } = fakeFetch(
			200,
			JSON.stringify({ ok: true, result: guestResponse }),
		);
		const out: string[] = [];
		const code = await main(
			["--port", "8123"],
			boardDeps(store, fetchImpl, root, out),
		);
		expect(code).toBe(0);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe(
			"http://127.0.0.1:8123/api/projects/ottr/sandbox",
		);
		const body = JSON.parse(String(seen[0]?.init.body)) as {
			taskId?: unknown;
		};
		expect(body.taskId).toBe("P1-smoke");
		const headers = seen[0]?.init.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json");
		// One update: the back-to-back cancel. The card never stays open.
		expect(spy.updates).toHaveLength(1);
		expect(typeof spy.updates[0]?.patch.cancelledAt).toBe("number");
		expect(spy.updates[0]?.id).toBe("P1-smoke");
		expect(spy.closed).toBe(1);
		expect(out.join("\n")).toContain("PASS");
		expect(out.join("\n")).toContain(
			join(root, "ottr", "validate-jobs", JOB_ID, "result.json"),
		);
	});

	test("a 403 refusal exits 2 and prints the endpoint's error text", async () => {
		const root = tmpRoot();
		const { store, spy } = fakeStore();
		const { fetchImpl } = fakeFetch(403, JSON.stringify({ error: REFUSAL }));
		const out: string[] = [];
		const code = await main(
			["--port", "8123"],
			boardDeps(store, fetchImpl, root, out),
		);
		expect(code).toBe(2);
		expect(out.join("\n")).toContain(REFUSAL);
		// The card was cancelled before the POST, so nothing stays open.
		expect(typeof spy.updates[0]?.patch.cancelledAt).toBe("number");
	});

	test("an absent guest result exits 2 before the disk check", async () => {
		const root = tmpRoot();
		const { store } = fakeStore();
		const { fetchImpl } = fakeFetch(
			200,
			JSON.stringify({
				ok: true,
				result: {
					...guestResponse,
					resultSource: "absent",
					selfCheck: null,
					job: null,
					error: "no result drive",
				},
			}),
		);
		const out: string[] = [];
		const code = await main(
			["--port", "8123"],
			boardDeps(store, fetchImpl, root, out),
		);
		expect(code).toBe(2);
		expect(out.join("\n")).toContain("resultSource absent");
	});

	test("a failed guest self-check exits 2", async () => {
		const root = tmpRoot();
		const { store } = fakeStore();
		const { fetchImpl } = fakeFetch(
			200,
			JSON.stringify({
				ok: true,
				result: {
					...guestResponse,
					selfCheck: {
						ok: false,
						checks: [{ name: "interfaces", ok: false, detail: "eth0 up" }],
					},
				},
			}),
		);
		const out: string[] = [];
		const code = await main(
			["--port", "8123"],
			boardDeps(store, fetchImpl, root, out),
		);
		expect(code).toBe(2);
		expect(out.join("\n")).toContain("self-check did not pass");
	});

	test("a missing result.json exits 3", async () => {
		const root = tmpRoot();
		const { store } = fakeStore();
		const { fetchImpl } = fakeFetch(
			200,
			JSON.stringify({ ok: true, result: guestResponse }),
		);
		const out: string[] = [];
		const code = await main(
			["--port", "8123"],
			boardDeps(store, fetchImpl, root, out),
		);
		expect(code).toBe(3);
		expect(out.join("\n")).toContain(
			join(root, "ottr", "validate-jobs", JOB_ID, "result.json"),
		);
	});

	test("a result.json with a failed self-check exits 3", async () => {
		const root = tmpRoot();
		writeResultJson(root, {
			...guestResponse,
			selfCheck: {
				ok: false,
				checks: [{ name: "interfaces", ok: false, detail: "eth0 up" }],
			},
		});
		const { store } = fakeStore();
		const { fetchImpl } = fakeFetch(
			200,
			JSON.stringify({ ok: true, result: guestResponse }),
		);
		const out: string[] = [];
		const code = await main(
			["--port", "8123"],
			boardDeps(store, fetchImpl, root, out),
		);
		expect(code).toBe(3);
		expect(out.join("\n")).toContain("result.json holds a failed self-check");
	});
});
