import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitSpawn, newJobId, runSandboxJob } from "./sandboxRun.ts";
import { type ValidateResponse, VM_VALIDATE } from "./vmValidateShared.ts";

const TAR = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4]);
const TOKEN = "worker-token";

const jobEnv = (url = "http://vm-runner:8080///"): NodeJS.ProcessEnv => ({
	OTTR_VM_RUNNER_URL: url,
	OTTR_WORKER_TOKEN: TOKEN,
});

const spawnOk: GitSpawn = async () => ({ code: 0, stdout: TAR, stderr: "" });

const guestResponse: ValidateResponse = {
	id: "val-1763000000-cafebabe",
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

// Tmp data roots, each removed after its test even when an assertion fails.
const tmpRoots: string[] = [];
afterEach(() => {
	for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
	tmpRoots.length = 0;
});
function tmpRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "ottr-sandboxrun-"));
	tmpRoots.push(root);
	return root;
}

describe("runSandboxJob", () => {
	test("packs the checkout, posts the job, and returns the runner's answer", async () => {
		const root = tmpRoot();
		const { fetchImpl, seen } = fakeFetch(200, JSON.stringify(guestResponse));
		const spawned: string[][] = [];
		const spawnImpl: GitSpawn = async (argv) => {
			spawned.push(argv);
			return { code: 0, stdout: TAR, stderr: "" };
		};
		const res = await runSandboxJob({
			project: "ottr",
			ref: "main",
			argv: ["bun", "test", "src/parse.ts"],
			cwd: "/target/src",
			collect: ["tmp/poc.txt"],
			checkout: "/workspace/ottr",
			fetchImpl,
			spawnImpl,
			env: jobEnv(),
			dataRoot: root,
			idFactory: () => "val-1763000000-cafebabe",
		});
		expect(res.ok).toBe(true);
		expect(spawned).toEqual([
			["git", "-C", "/workspace/ottr", "archive", "--", "main"],
		]);
		expect(seen.length).toBe(1);
		const call = seen[0]!;
		// Trailing slashes come off the runner URL.
		expect(call.url).toBe("http://vm-runner:8080/validate");
		expect(call.init.method).toBe("POST");
		// The token rides the wire only.
		expect(call.init.headers).toEqual({
			"x-otwr-token": TOKEN,
			"content-type": "application/json",
		});
		const body = JSON.parse(String(call.init.body)) as {
			id: string;
			project: string;
			targetTar: string;
			job: { argv: string[]; cwd: string; collect: string[] };
		};
		expect(body.id).toBe("val-1763000000-cafebabe");
		expect(body.project).toBe("ottr");
		expect(body.targetTar).toBe(
			join(
				root,
				"ottr",
				"validate-jobs",
				"val-1763000000-cafebabe",
				"target.tar",
			),
		);
		expect(body.job).toEqual({
			argv: ["bun", "test", "src/parse.ts"],
			cwd: "/target/src",
			collect: ["tmp/poc.txt"],
		});
		// The packed tar reached the run dir byte for byte.
		expect(new Uint8Array(readFileSync(body.targetTar))).toEqual(TAR);
		if (!res.ok) throw new Error("expected the runner's answer");
		expect(res.result.resultSource).toBe("guest");
	});

	test("defaults cwd to /target and omits an empty collect", async () => {
		const { fetchImpl, seen } = fakeFetch(200, JSON.stringify(guestResponse));
		const res = await runSandboxJob({
			project: "ottr",
			argv: ["true"],
			fetchImpl,
			spawnImpl: spawnOk,
			env: jobEnv(),
			dataRoot: tmpRoot(),
		});
		expect(res.ok).toBe(true);
		const body = JSON.parse(String(seen[0]!.init.body)) as {
			job: Record<string, unknown>;
		};
		expect(body.job).toEqual({ argv: ["true"], cwd: "/target" });
	});

	test("the default job id fits the ValidateRequest id shape", () => {
		for (let i = 0; i < 100; i++) {
			const id = newJobId();
			expect(id).toMatch(/^val-[0-9]+-[0-9a-f]{8}$/);
			expect(id.length).toBeLessThanOrEqual(64);
		}
	});

	test("a failed git archive refuses with the stderr tail and posts nothing", async () => {
		const { fetchImpl, seen } = fakeFetch(200, JSON.stringify(guestResponse));
		const res = await runSandboxJob({
			project: "ottr",
			argv: ["true"],
			fetchImpl,
			spawnImpl: async () => ({
				code: 128,
				stdout: new Uint8Array(),
				stderr:
					"fatal: not a git repository (or any of the parent directories): .git\n",
			}),
			env: jobEnv(),
			dataRoot: tmpRoot(),
		});
		if (res.ok) throw new Error("expected a refusal");
		expect(res.error).toContain("exit 128");
		expect(res.error).toContain("not a git repository");
		expect(seen.length).toBe(0);
	});

	test("an empty archive refuses even at exit 0", async () => {
		const { fetchImpl, seen } = fakeFetch(200, JSON.stringify(guestResponse));
		const res = await runSandboxJob({
			project: "ottr",
			argv: ["true"],
			fetchImpl,
			spawnImpl: async () => ({
				code: 0,
				stdout: new Uint8Array(),
				stderr: "",
			}),
			env: jobEnv(),
			dataRoot: tmpRoot(),
		});
		if (res.ok) throw new Error("expected a refusal");
		expect(res.error).toContain("empty archive");
		expect(seen.length).toBe(0);
	});

	test("a missing OTTR_VM_RUNNER_URL names the setting and the vm profile", async () => {
		let spawned = 0;
		const res = await runSandboxJob({
			project: "ottr",
			argv: ["true"],
			spawnImpl: async () => {
				spawned += 1;
				return { code: 0, stdout: TAR, stderr: "" };
			},
			env: { OTTR_WORKER_TOKEN: TOKEN },
		});
		if (res.ok) throw new Error("expected a refusal");
		expect(res.error).toContain("OTTR_VM_RUNNER_URL");
		expect(res.error).toContain("--profile vm");
		// A misconfigured host packs nothing.
		expect(spawned).toBe(0);
	});

	test("a missing OTTR_WORKER_TOKEN names the token setting", async () => {
		const res = await runSandboxJob({
			project: "ottr",
			argv: ["true"],
			spawnImpl: spawnOk,
			env: { OTTR_VM_RUNNER_URL: "http://vm-runner:8080" },
		});
		if (res.ok) throw new Error("expected a refusal");
		expect(res.error).toContain("OTTR_WORKER_TOKEN");
	});

	test("a non-200 answer becomes the blocker text, with an echoed token redacted", async () => {
		const { fetchImpl } = fakeFetch(
			503,
			`runner unhealthy: no /dev/kvm (${TOKEN})`,
		);
		const res = await runSandboxJob({
			project: "ottr",
			argv: ["true"],
			fetchImpl,
			spawnImpl: spawnOk,
			env: jobEnv(),
			dataRoot: tmpRoot(),
		});
		if (res.ok) throw new Error("expected a refusal");
		expect(res.error).toBe("503: runner unhealthy: no /dev/kvm ([REDACTED])");
	});

	test("a long non-200 body is cut at 500 characters", async () => {
		const { fetchImpl } = fakeFetch(500, "x".repeat(600));
		const res = await runSandboxJob({
			project: "ottr",
			argv: ["true"],
			fetchImpl,
			spawnImpl: spawnOk,
			env: jobEnv(),
			dataRoot: tmpRoot(),
		});
		if (res.ok) throw new Error("expected a refusal");
		expect(res.error).toBe(`500: ${"x".repeat(500)}`);
	});

	test("a 200 with invalid JSON refuses", async () => {
		const { fetchImpl } = fakeFetch(200, "<html>booting</html>");
		const res = await runSandboxJob({
			project: "ottr",
			argv: ["true"],
			fetchImpl,
			spawnImpl: spawnOk,
			env: jobEnv(),
			dataRoot: tmpRoot(),
		});
		if (res.ok) throw new Error("expected a refusal");
		expect(res.error).toContain("invalid JSON");
	});

	test("cwd must be absolute, normalized and under /target", async () => {
		const { fetchImpl, seen } = fakeFetch(200, JSON.stringify(guestResponse));
		for (const cwd of [
			"src",
			"",
			"/target/../etc",
			"/target//x",
			"/target/x/",
			"/other/x",
			"/target/../..",
		]) {
			const res = await runSandboxJob({
				project: "ottr",
				argv: ["true"],
				cwd,
				fetchImpl,
				spawnImpl: spawnOk,
				env: jobEnv(),
			});
			if (res.ok) throw new Error(`expected a refusal for cwd "${cwd}"`);
			expect(res.error).toContain("job.cwd");
		}
		// Every refusal ran before any effect.
		expect(seen.length).toBe(0);
	});

	test("collect names are capped, relative and free of dot parts", async () => {
		const { fetchImpl } = fakeFetch(200, JSON.stringify(guestResponse));
		const cases: string[][] = [
			Array.from({ length: 17 }, (_, i) => `tmp/f${i}.txt`),
			["/etc/passwd"],
			["tmp/../poc.txt"],
			["tmp/./poc.txt"],
			[""],
			["tmp/a//b"],
		];
		for (const collect of cases) {
			const res = await runSandboxJob({
				project: "ottr",
				argv: ["true"],
				collect,
				fetchImpl,
				spawnImpl: spawnOk,
				env: jobEnv(),
			});
			if (res.ok)
				throw new Error(
					`expected a refusal for collect ${JSON.stringify(collect)}`,
				);
			expect(res.error).toContain("job.collect");
		}
	});

	test("argv must be a non-empty string list", async () => {
		const { fetchImpl } = fakeFetch(200, JSON.stringify(guestResponse));
		const cases: unknown[] = [[], ["sh", 3]];
		for (const argv of cases) {
			const res = await runSandboxJob({
				project: "ottr",
				argv: argv as string[],
				fetchImpl,
				spawnImpl: spawnOk,
				env: jobEnv(),
			});
			if (res.ok) throw new Error("expected a refusal");
			expect(res.error).toContain("job.argv");
		}
	});

	test("a bad project name refuses before any spawn", async () => {
		let spawned = 0;
		const res = await runSandboxJob({
			project: "../evil",
			argv: ["true"],
			spawnImpl: async () => {
				spawned += 1;
				return { code: 0, stdout: TAR, stderr: "" };
			},
			env: jobEnv(),
		});
		if (res.ok) throw new Error("expected a refusal");
		expect(res.error).toContain("PROJECT_NAME");
		expect(spawned).toBe(0);
	});
});

test("a dashed ref cannot reach git as an option: the spawn puts -- before it", async () => {
	const root = mkdtempSync(join(tmpdir(), "ottr-sbx-dashref-"));
	try {
		const { fetchImpl } = fakeFetch(200, JSON.stringify(guestResponse));
		const spawned: string[][] = [];
		const res = await runSandboxJob({
			project: "ottr",
			ref: "--output=/data/stats.db",
			argv: ["true"],
			checkout: "/workspace/ottr",
			fetchImpl,
			spawnImpl: async (argv) => {
				spawned.push(argv);
				return { code: 0, stdout: TAR, stderr: "" };
			},
			env: jobEnv(),
			dataRoot: root,
			idFactory: () => "val-1763000000-dashref",
		});
		// The separator keeps git from reading the caller's value as a flag: even a
		// value crafted for --output or --remote travels only as a tree-ish name.
		expect(res.ok).toBe(true);
		expect(spawned[0]).toEqual([
			"git",
			"-C",
			"/workspace/ottr",
			"archive",
			"--",
			"--output=/data/stats.db",
		]);
		expect(existsSync(join(root, "ottr", "validate-jobs"))).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	}
});
