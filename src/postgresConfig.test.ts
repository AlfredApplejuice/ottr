import { afterAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import { childDatabaseEnv } from "./childEnv.ts";
import {
	type DatabaseConfig,
	parseDatabaseConfig,
	safeDatabaseError,
} from "./postgresConfig.ts";
import { childEnv, createRunSink, startRun, vmEnv } from "./runner.ts";
import fc from "./test/properties.ts";
import { serveVmRunner } from "./vmRunner.ts";
import { VmTokens } from "./vmTokens.ts";
import {
	runWorker,
	serveWorker,
	WORKER_DONE,
	type WorkerRequest,
} from "./workers.ts";

const root = mkdtempSync(join(tmpdir(), "ottr-pg-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fresh = () => mkdtempSync(join(root, "case-"));
let nextSentinel = 0;
const sentinel = () => `synthetic-${++nextSentinel}`;
type TestDatabaseEnv = {
	OTTR_DATABASE_URL: string;
	OTTR_TEST_PG_URL: string;
	OTTR_REQUIRE_PG_TESTS: string;
};
const testEnv = (): TestDatabaseEnv => ({
	OTTR_DATABASE_URL: sentinel(),
	OTTR_TEST_PG_URL: `postgresql://localhost/test-${sentinel()}`,
	OTTR_REQUIRE_PG_TESTS: "1",
});

async function withEnv<T>(
	env: Record<string, string>,
	work: () => Promise<T>,
): Promise<T> {
	const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
	Object.assign(process.env, env);
	try {
		return await work();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function refused(raw: string): Error {
	try {
		parseDatabaseConfig(raw);
	} catch (error) {
		expect(error instanceof Error).toBe(true);
		return error as Error;
	}
	throw new Error("Invalid database input was accepted.");
}

function assertSafe(error: Error, secret: string): void {
	expect(Object.hasOwn(error, "cause")).toBe(false);
	expect(Object.keys(error)).toEqual([]);
	for (const text of [String(error), JSON.stringify(error), Bun.inspect(error)])
		expect(text.includes(secret)).toBe(false);
}

describe("PostgreSQL server configuration", () => {
	test("absent and empty values retain SQLite", () => {
		expect(parseDatabaseConfig(undefined)).toEqual({ backend: "sqlite" });
		expect(parseDatabaseConfig("")).toEqual({ backend: "sqlite" });
	});

	test.each(["postgres", "postgresql", "POSTGRESQL"])(
		"accepts %s and preserves TLS options without serializing the URL",
		(scheme) => {
			const marker = sentinel();
			const url = `${scheme}://user-${marker}:pass-${marker}@db.example:5433/${encodeURIComponent('Ottr λ "quoted"')}?sslmode=verify-full&sslrootcert=%2Fcerts%2Froot.pem&application_name=ottr`;
			const config = parseDatabaseConfig(url);
			expect(config.backend).toBe("postgres");
			if (config.backend !== "postgres") throw new Error("Wrong backend.");
			expect(config.url === url).toBe(true);
			expect(config.host).toBe("db.example");
			expect(config.database).toBe('Ottr λ "quoted"');
			expect(Object.isFrozen(config)).toBe(true);
			expect(JSON.stringify(config)).toBe(
				JSON.stringify({
					backend: "postgres",
					host: config.host,
					database: config.database,
				}),
			);
			expect(Bun.inspect(config).includes(marker)).toBe(false);
			for (const text of [
				Bun.inspect({ config }),
				inspect(config),
				inspect({ config }),
			])
				expect(text.includes(marker)).toBe(false);
			expect(Object.hasOwn({ ...config }, "url")).toBe(false);
		},
	);

	test.each([
		" ",
		"sqlite:///tmp/db",
		"https://db.example/ottr",
		"postgres:ottr",
		"postgresql:///ottr",
		"postgresql://db.example",
		"postgresql://db.example/",
		"postgresql://db.example/ottr#fragment",
		"postgresql://db.example/a/b",
		"postgresql://db.example:70000/ottr",
		"postgresql://db.example/\ud800",
		"postgresql://db.example:0/ottr",
		"postgresql://db.example/raw space",
	])("rejects malformed selection case %# without a raw cause", (raw) => {
		const error = refused(raw);
		expect(error.message).toBe(
			"Invalid OTTR_DATABASE_URL. Use a PostgreSQL URL with a host and database.",
		);
		expect(Object.hasOwn(error, "cause")).toBe(false);
	});

	test("pins the first valid selection despite later environment changes", async () => {
		for (const backend of ["sqlite", "postgres"]) {
			const script = `
				import { databaseConfig } from ${JSON.stringify(new URL("./postgresConfig.ts", import.meta.url).href)};
				const first = databaseConfig();
				process.env.OTTR_DATABASE_URL = "invalid later value";
				const second = databaseConfig();
				console.log(JSON.stringify({ same: first === second, backend: second.backend }));
			`;
			const child = Bun.spawn([process.execPath, "--eval", script], {
				cwd: root,
				env: {
					...process.env,
					OTTR_DATABASE_URL:
						backend === "sqlite"
							? ""
							: `postgresql://localhost/test-${sentinel()}`,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(0);
			expect(stderr).toBe("");
			expect(JSON.parse(stdout)).toEqual({ same: true, backend });
		}
	});

	test.each(["postgres", "sqlite", "invalid"])(
		"boot initialization and public launchers protect %s selection from child and startup environments",
		async (mode) => {
			const marker = sentinel();
			const runDir = fresh();
			const raw =
				mode === "postgres"
					? `postgresql://user-${marker}:password-${marker}@localhost/test?sslmode=verify-full`
					: mode === "sqlite"
						? ""
						: `invalid-${marker}`;
			const childScript = `
				import { readFileSync, writeFileSync } from "node:fs";
				const result = {
					inherited: Object.hasOwn(process.env, "OTTR_DATABASE_URL"),
					parentStartupEntry: process.platform === "linux"
						? readFileSync("/proc/" + process.ppid + "/environ").includes("OTTR_DATABASE_URL=")
						: null,
					testUrlPreserved: process.env.OTTR_TEST_PG_URL === "synthetic-isolated-test",
					requireTestsPreserved: process.env.OTTR_REQUIRE_PG_TESTS === "1",
				};
				const configAt = process.argv.indexOf("--config-file");
				if (configAt >= 0)
					writeFileSync(process.argv[configAt + 1] + ".probe", JSON.stringify(result));
				else console.log(JSON.stringify(result));
			`;
			const script = `
				import { readFileSync, writeFileSync } from "node:fs";
				import { join } from "node:path";
				import { databaseConfig, initializeDatabaseConfig } from ${JSON.stringify(new URL("./postgresConfig.ts", import.meta.url).href)};
				import { spawnPiped } from ${JSON.stringify(new URL("./worktree.ts", import.meta.url).href)};
				import { firecrackerLauncher } from ${JSON.stringify(new URL("./vmRunner.ts", import.meta.url).href)};
				import { slotFor } from ${JSON.stringify(new URL("./vmNet.ts", import.meta.url).href)};
				const original = process.env.OTTR_DATABASE_URL;
				const startupEntryBefore = process.platform === "linux"
					? readFileSync("/proc/self/environ").includes("OTTR_DATABASE_URL=")
					: null;
				let config;
				let safeRefusal = false;
				try {
					config = initializeDatabaseConfig();
				} catch (error) {
					safeRefusal = error instanceof Error
						&& error.message === "Invalid OTTR_DATABASE_URL. Use a PostgreSQL URL with a host and database."
						&& !Object.hasOwn(error, "cause");
				}
				const { code, stdout, stderr } = await spawnPiped(
					[process.execPath, "--eval", ${JSON.stringify(childScript)}],
					undefined,
					10_000,
				);
				if (code !== 0 || stderr !== "") throw new Error("Environment probe failed.");
				let firecracker = null;
				if (process.platform === "linux") {
					const runDir = ${JSON.stringify(runDir)};
					const binary = join(runDir, "fake-firecracker");
					writeFileSync(binary, "#!" + process.execPath + "\\n" + ${JSON.stringify(childScript)}, { mode: 0o700 });
					const vm = await firecrackerLauncher(binary)({
						runDir, mode: "run", slot: slotFor(0), vcpus: 1, memMiB: 128,
						kernel: "/synthetic/kernel", drives: [], bootArgs: "",
					});
					await vm.exited;
					firecracker = JSON.parse(readFileSync(join(runDir, "firecracker-run.json.probe"), "utf8"));
				}
				console.log(JSON.stringify({
					startupEntryBefore,
					safeRefusal,
					backend: config?.backend ?? null,
					directUrlPreserved: config?.backend === "postgres" ? config.url === original : null,
					jsonSafe: config === undefined || !Object.hasOwn(JSON.parse(JSON.stringify(config)), "url"),
					pinned: config === undefined || databaseConfig() === config,
					inEnv: Object.hasOwn(process.env, "OTTR_DATABASE_URL"),
					child: JSON.parse(stdout),
					firecracker,
				}));
			`;
			const child = Bun.spawn([process.execPath, "--eval", script], {
				cwd: root,
				env: {
					...process.env,
					OTTR_DATABASE_URL: raw,
					OTTR_TEST_PG_URL: "synthetic-isolated-test",
					OTTR_REQUIRE_PG_TESTS: "1",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(0);
			expect(stderr).toBe("");
			expect(stdout.includes(marker)).toBe(false);
			const expectedChild = {
				inherited: false,
				parentStartupEntry: process.platform === "linux" ? false : null,
				testUrlPreserved: true,
				requireTestsPreserved: true,
			};
			expect(JSON.parse(stdout)).toEqual({
				startupEntryBefore: process.platform === "linux" ? true : null,
				safeRefusal: mode === "invalid",
				backend: mode === "invalid" ? null : mode,
				directUrlPreserved: mode === "postgres" ? true : null,
				jsonSafe: true,
				pinned: true,
				inEnv: false,
				child: expectedChild,
				firecracker: process.platform === "linux" ? expectedChild : null,
			});
		},
	);

	test("malformed percent escapes fail safely in every URL component", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("%", "%Q0", "%0", "%FF", "%C0%AF", "%ED%A0%80"),
				fc.integer({ min: 0, max: 4 }),
				(malformedEscape, component) => {
					const marker = sentinel();
					const pieces = [
						`u-${marker}`,
						`p-${marker}`,
						"db.example",
						`db-${marker}`,
						"sslmode=verify-full",
					];
					pieces[component] = pieces[component]! + malformedEscape;
					const raw = `postgresql://${pieces[0]}:${pieces[1]}@${pieces[2]}/${pieces[3]}?${pieces[4]}`;
					assertSafe(refused(raw), marker);
				},
			),
		);
	});

	test("encoded credentials stay private while Unicode database names round trip", () => {
		const unicode = fc.string({
			unit: fc.constantFrom("λ", "界", "é", "🦦", "a", " ", '"', "/", "%", "?"),
			minLength: 1,
			maxLength: 30,
		});
		fc.assert(
			fc.property(unicode, unicode, (database, credentials) => {
				const marker = `private-${encodeURIComponent(credentials)}`;
				const raw = `postgresql://${marker}:${marker}@db.example/${encodeURIComponent(database)}?sslmode=verify-full`;
				const config = parseDatabaseConfig(raw);
				expect(config.backend).toBe("postgres");
				if (config.backend !== "postgres") throw new Error("Wrong backend.");
				expect(config.database === database).toBe(true);
				expect(config.url === raw).toBe(true);
				expect(JSON.stringify(config).includes(marker)).toBe(false);
				for (const text of [
					Bun.inspect(config),
					Bun.inspect({ config }),
					inspect(config),
					inspect({ config }),
				])
					expect(text.includes(marker)).toBe(false);
				expect(JSON.parse(JSON.stringify(config.database)) === database).toBe(
					true,
				);
			}),
		);
	});

	test("raw and percent-encoded controls never enter log fields", () => {
		const controls = fc.constantFrom(
			0,
			9,
			10,
			13,
			27,
			127,
			128,
			159,
			0x2028,
			0x2029,
			0x202e,
		);
		fc.assert(
			fc.property(
				controls,
				fc.boolean(),
				fc.integer({ min: 0, max: 4 }),
				(code, encoded, component) => {
					const marker = sentinel();
					const char = String.fromCodePoint(code);
					const value = encoded ? encodeURIComponent(char) : char;
					const pieces = [
						`u-${marker}`,
						`p-${marker}`,
						"db.example",
						`db-${marker}`,
						"sslmode=verify-full",
					];
					pieces[component] = pieces[component]! + value;
					assertSafe(
						refused(
							`postgresql://${pieces[0]}:${pieces[1]}@${pieces[2]}/${pieces[3]}?${pieces[4]}`,
						),
						marker,
					);
				},
			),
		);
	});

	test("arbitrary URL text either refuses safely or returns the supported invariant", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), (raw) => {
				let config: DatabaseConfig;
				try {
					config = parseDatabaseConfig(raw);
				} catch (error) {
					expect(error instanceof Error).toBe(true);
					expect((error as Error).message).toBe(
						"Invalid OTTR_DATABASE_URL. Use a PostgreSQL URL with a host and database.",
					);
					expect(Object.hasOwn(error as Error, "cause")).toBe(false);
					return;
				}
				if (raw === "") expect(config.backend).toBe("sqlite");
				else {
					expect(config.backend).toBe("postgres");
					if (config.backend === "postgres") {
						expect(config.host.length > 0 && config.database.length > 0).toBe(
							true,
						);
						expect(
							Object.hasOwn(JSON.parse(JSON.stringify(config)), "url"),
						).toBe(false);
					}
				}
			}),
		);
	});
});

describe("safe PostgreSQL errors", () => {
	test.each([
		["startup", "PostgreSQL startup failed."],
		["ownership", "PostgreSQL ownership failed."],
		["unknown", "PostgreSQL write result is unknown."],
		["close", "PostgreSQL close failed."],
		[undefined, "PostgreSQL operation failed."],
	] as const)("uses constant messages for phase %#", (phase, message) => {
		expect(safeDatabaseError(new Error(sentinel()), phase).message).toBe(
			message,
		);
	});

	test("nested errors, driver fields and arbitrary phases cannot expose secrets", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string(), { maxLength: 8 }),
				fc.string(),
				(messages, phase) => {
					const marker = sentinel();
					let cause: unknown = { url: marker, query: marker, password: marker };
					for (const message of messages)
						cause = Object.assign(
							new Error(`${message} ${marker}`, { cause }),
							{ code: marker, detail: marker },
						);
					const error = new AggregateError([cause], marker, { cause });
					const safe = safeDatabaseError(error, `${phase}${marker}`);
					expect(safe.message).toBe("PostgreSQL operation failed.");
					assertSafe(safe, marker);
				},
			),
		);
	});

	test("does not inspect hostile error fields or nested getters", () => {
		const error = new Proxy(
			{},
			{
				get: () => {
					throw new Error("error field access");
				},
			},
		);
		expect(safeDatabaseError(error).message).toBe(
			"PostgreSQL operation failed.",
		);
	});
});

function assertChildEnv(
	env: Record<string, unknown>,
	expected: TestDatabaseEnv,
): void {
	expect(Object.hasOwn(env, "OTTR_DATABASE_URL")).toBe(false);
	expect(env.OTTR_TEST_PG_URL === expected.OTTR_TEST_PG_URL).toBe(true);
	expect(env.OTTR_REQUIRE_PG_TESTS).toBe(expected.OTTR_REQUIRE_PG_TESTS);
}

function startOptions(dir: string) {
	return {
		cwd: dir,
		prompt: "synthetic environment probe",
		sessionDir: join(dir, "sessions"),
		resumeId: null,
		extensionPath: null,
		logPath: join(dir, "run.log"),
		dataRoot: dir,
		memoryConfigPath: null,
		pluginSkillsHome: dir,
	};
}

class Child extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
}

function captureServer() {
	const bodies: WorkerRequest[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			bodies.push((await req.json()) as WorkerRequest);
			return new Response(
				`${JSON.stringify({ [WORKER_DONE]: { exitCode: 0, stderrTail: "" } })}\n`,
			);
		},
	});
	return { server, bodies, urls: [`http://127.0.0.1:${server.port}`] };
}

function request(dir: string, env: Record<string, string>): WorkerRequest {
	return {
		id: sentinel(),
		argv: [
			"--eval",
			`console.log(JSON.stringify(Object.fromEntries(
			["OTTR_DATABASE_URL", "OTTR_TEST_PG_URL", "OTTR_REQUIRE_PG_TESTS"]
				.filter((key) => process.env[key] !== undefined)
				.map((key) => [key, process.env[key]])
		)))`,
		],
		cwd: dir,
		stdin: "",
		env,
	};
}

function vmRunner() {
	const dir = fresh();
	const dataRoot = join(dir, "data");
	const homeRoot = join(dir, "home");
	mkdirSync(join(dataRoot, "project"), { recursive: true });
	mkdirSync(homeRoot);
	const bodies: { env: Record<string, string> }[] = [];
	let launches = 0;
	let end: (() => void) | undefined;
	const server = serveVmRunner({
		port: 0,
		max: 1,
		vcpus: 1,
		memMiB: 128,
		diskBytes: 1024,
		stateDir: join(dir, "state"),
		kernel: "/synthetic/kernel",
		firecracker: "/synthetic/firecracker",
		boardHost: "board",
		netError: null,
		dataRoot,
		homeRoot,
		exists: () => true,
		resolveHost: async () => "127.0.0.1",
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		rootfs: {
			base: async () => ({ key: "synthetic", path: join(dir, "base") }),
			layer: async () => ({ ok: true, path: join(dir, "layer") }),
		},
		launcher: async () => {
			launches++;
			const { promise, resolve } = Promise.withResolvers<void>();
			end = resolve;
			return {
				pid: 4242,
				guestUrl: "http://guest.invalid",
				exited: promise,
				kill: resolve,
				logTail: () => "",
			};
		},
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input)).pathname;
			if (path === "/run") {
				bodies.push(JSON.parse(String(init?.body)));
				return new Response(
					`${JSON.stringify({ [WORKER_DONE]: { exitCode: 0, stderrTail: "" } })}\n`,
				);
			}
			if (path === "/shutdown") end?.();
			return new Response("ok");
		}) as typeof fetch,
	});
	const spec = {
		project: "project",
		taskId: "P-1",
		branch: "ott/p-1",
		base: "main",
		boardUrl: "http://board:8080",
		token: sentinel(),
		providers: [],
		hindsight: false,
		layerDir: null,
		copyIn: [],
		copyOut: [],
	};
	return {
		server,
		bodies,
		spec,
		dir,
		launches: () => launches,
		url: `http://127.0.0.1:${server.port}/run`,
	};
}

describe("production database environment boundary", () => {
	test("record helpers omit production selection and retain isolated test settings", () => {
		fc.assert(
			fc.property(
				fc.string(),
				fc.string(),
				fc.string(),
				(production, testUrl, required) => {
					const env = {
						OTTR_DATABASE_URL: production,
						OTTR_TEST_PG_URL: testUrl,
						OTTR_REQUIRE_PG_TESTS: required,
					};
					const layerEnv = {
						HOME: "/synthetic/home",
						PI_CODING_AGENT_DIR: "/synthetic/agent",
						...env,
					};
					for (const child of [
						childDatabaseEnv(env),
						childEnv({ base: env }),
						vmEnv({
							env,
							boardUrl: "http://board",
							token: sentinel(),
							layerEnv: null,
						}),
						vmEnv({
							env,
							boardUrl: "http://board",
							token: sentinel(),
							layerEnv,
						}),
					])
						assertChildEnv(child, env);
					expect(env.OTTR_DATABASE_URL === production).toBe(true);
				},
			),
		);
	});

	test("local omp and its identity probe omit production selection after overrides", async () => {
		const env = testEnv();
		await withEnv(testEnv(), async () => {
			let probeEnv: Record<string, string | undefined> | undefined;
			let child: Record<string, string | undefined> | undefined;
			const handle = await startRun({
				...startOptions(fresh()),
				env,
				gitProbe: async (o) => {
					probeEnv = { ...o.baseEnv };
					return { name: false, email: false };
				},
				launcher: (_command, _args, options) => {
					child = { ...options.env };
					const fake = new Child();
					queueMicrotask(() => fake.emit("close", 0));
					return fake as unknown as ChildProcess;
				},
			});
			await handle.done;
			expect(probeEnv !== undefined && child !== undefined).toBe(true);
			assertChildEnv(probeEnv!, env);
			assertChildEnv(child!, env);
		});
	});

	test("direct runWorker serializes both environment records without production selection", async () => {
		const capture = captureServer();
		try {
			const dir = fresh();
			const primary = testEnv();
			const secondary = testEnv();
			const req = { ...request(dir, primary), githubReadEnv: secondary };
			const sink = createRunSink({
				logPath: join(dir, "run.log"),
				dataRoot: dir,
			});
			await runWorker(req, { urls: capture.urls }, sink).done;
			expect(capture.bodies.length).toBe(1);
			assertChildEnv(capture.bodies[0]!.env, primary);
			assertChildEnv(capture.bodies[0]!.githubReadEnv!, secondary);
			expect(Object.hasOwn(primary, "OTTR_DATABASE_URL")).toBe(true);
			expect(Object.hasOwn(secondary, "OTTR_DATABASE_URL")).toBe(true);
		} finally {
			capture.server.stop(true);
		}
	});

	test.each(["worker", "vm"])(
		"startRun %s request omits production selection from both records",
		async (mode) => {
			const capture = captureServer();
			try {
				const secondary = testEnv();
				const dir = fresh();
				for (const supplied of [false, true]) {
					const inherited = testEnv();
					const explicit = testEnv();
					await withEnv(inherited, async () => {
						const handle = await startRun({
							...startOptions(dir),
							env: supplied ? explicit : {},
							githubReadEnv: secondary,
							gitProbe: async () => ({ name: false, email: false }),
							...(mode === "worker"
								? { worker: { urls: capture.urls } }
								: {
										vm: {
											target: { urls: capture.urls },
											tokens: new VmTokens({ file: null }),
											grant: {
												project: "project",
												taskId: "P-1",
												branch: "ott/p-1",
												repoPath: dir,
												worktree: dir,
											},
											base: "main",
											boardUrl: "http://board:8080",
											providers: [],
											hindsight: false,
										},
									}),
						});
						await handle.done;
					});
					assertChildEnv(
						capture.bodies.at(-1)!.env,
						supplied ? explicit : inherited,
					);
					assertChildEnv(capture.bodies.at(-1)!.githubReadEnv!, secondary);
				}
				expect(capture.bodies.length).toBe(2);
			} finally {
				capture.server.stop(true);
			}
		},
	);

	test("worker daemon strips all merged sources before the real child spawn", async () => {
		const server = serveWorker({ port: 0, ompPath: process.execPath });
		try {
			await withEnv(testEnv(), async () => {
				const secondary = testEnv();
				const res = await fetch(`http://127.0.0.1:${server.port}/run`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						...request(fresh(), testEnv()),
						githubReadEnv: secondary,
					}),
				});
				expect(res.status).toBe(200);
				const text = await res.text();
				const env = JSON.parse(text.split("\n")[0]!);
				assertChildEnv(env, secondary);
			});
		} finally {
			server.stop(true);
		}
	}, 30_000);

	test("VM runner filters the final guest payload after its secondary merge", async () => {
		const r = vmRunner();
		try {
			const secondary = testEnv();
			const res = await fetch(r.url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...request(r.dir, testEnv()),
					githubReadEnv: secondary,
					vm: r.spec,
				}),
			});
			expect(res.status).toBe(200);
			await res.text();
			expect(r.bodies.length).toBe(1);
			assertChildEnv(r.bodies[0]!.env, secondary);
		} finally {
			r.server.stop(true);
		}
	});

	test("worker and VM endpoints refuse serialized or nested environment forms before launch", async () => {
		const worker = serveWorker({ port: 0, ompPath: process.execPath });
		const vm = vmRunner();
		try {
			const marker = sentinel();
			const invalid = [
				JSON.stringify({ OTTR_DATABASE_URL: marker }),
				[`OTTR_DATABASE_URL=${marker}`],
				[["OTTR_DATABASE_URL", marker]],
				{ nested: { OTTR_DATABASE_URL: marker } },
				null,
			];
			for (const url of [`http://127.0.0.1:${worker.port}/run`, vm.url]) {
				for (const field of ["env", "githubReadEnv"]) {
					for (const value of invalid) {
						const body = {
							...request(vm.dir, testEnv()),
							vm: vm.spec,
							[field]: value,
						};
						const res = await fetch(url, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(body),
						});
						expect(res.status).toBe(400);
						expect((await res.text()).includes(marker)).toBe(false);
					}
				}
				for (const value of [null, [], "invalid"]) {
					const res = await fetch(url, {
						method: "POST",
						body: JSON.stringify(value),
					});
					expect(res.status).toBe(400);
					await res.text();
				}
			}
			expect(vm.launches()).toBe(0);
		} finally {
			worker.stop(true);
			vm.server.stop(true);
		}
	});

	test("direct worker dispatch refuses serialized environment forms without a remote request", async () => {
		const capture = captureServer();
		try {
			const dir = fresh();
			const sink = createRunSink({
				logPath: join(dir, "run.log"),
				dataRoot: dir,
			});
			for (const field of ["env", "githubReadEnv"]) {
				const req = {
					...request(dir, testEnv()),
					[field]: [sentinel()],
				} as unknown as WorkerRequest;
				await expect(
					runWorker(req, { urls: capture.urls }, sink).done,
				).rejects.toThrow("bad request environment");
			}
			expect(capture.bodies.length).toBe(0);
		} finally {
			capture.server.stop(true);
		}
	});
});
