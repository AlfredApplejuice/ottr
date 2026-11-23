import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ottr-service-env-"));
const productionUrl = `postgresql://127.0.0.1/production-${crypto.randomUUID()}`;
const testUrl = `postgresql://127.0.0.1/test-${crypto.randomUUID()}`;
const moduleUrl = (name: string) =>
	JSON.stringify(new URL(name, import.meta.url).href);
const observation = `({
	hasProductionDatabaseUrl: Object.hasOwn(process.env, "OTTR_DATABASE_URL"),
	preservesTestPgUrl: process.env.OTTR_TEST_PG_URL === ${JSON.stringify(testUrl)},
	preservesRequirePgTests: process.env.OTTR_REQUIRE_PG_TESTS === "1",
})`;
const expected = {
	hasProductionDatabaseUrl: false,
	preservesTestPgUrl: true,
	preservesRequirePgTests: true,
};

async function run(
	source: string,
	env: Record<string, string | undefined> = {},
): Promise<unknown> {
	const path = join(root, `${crypto.randomUUID()}.ts`);
	writeFileSync(path, source);
	const child = Bun.spawn([process.execPath, path], {
		env: {
			...process.env,
			OTTR_DATABASE_URL: productionUrl,
			OTTR_TEST_PG_URL: testUrl,
			OTTR_REQUIRE_PG_TESTS: "1",
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code).toBe(0);
	expect(child.signalCode).toBeNull();
	expect(stderr).toBe("");
	return JSON.parse(stdout);
}

function fakeOmp(report: string): string {
	const dir = mkdtempSync(join(root, "bin-"));
	writeFileSync(
		join(dir, "omp"),
		`#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(report)}, JSON.stringify({
	...${observation},
	hasTernPane: Object.hasOwn(process.env, "TERN_PANE"),
	hasTernSocket: Object.hasOwn(process.env, "TERN_PANE_SOCKET"),
}));
if (process.argv[2] === "usage") console.log(JSON.stringify({ reports: [] }));
else if (process.argv[2] === "stats") console.log("Dashboard available at: http://127.0.0.1:41234");
else throw new Error("unexpected fake omp command");
`,
		{ mode: 0o700 },
	);
	return dir;
}

for (const scrubParent of [false, true]) {
	test(`worker sign-out child excludes the boot URL with parent scrub=${scrubParent}`, async () => {
		const dbPath = join(root, `${crypto.randomUUID()}.db`);
		const db = new Database(dbPath);
		try {
			db.exec(`CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			)`);
			db.query(
				"INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, 'oauth', '{}')",
			).run("test-provider");
		} finally {
			db.close();
		}
		const report = join(root, `${crypto.randomUUID()}.json`);
		const preload = join(root, `${crypto.randomUUID()}.ts`);
		writeFileSync(
			preload,
			`import { writeFileSync } from "node:fs";
if (process.argv[1] === ${JSON.stringify(new URL("./login.ts", import.meta.url).pathname)}) {
	writeFileSync(${JSON.stringify(report)}, JSON.stringify(${observation}));
}
`,
		);
		const result = await run(
			`import { readFileSync } from "node:fs";
import { signOutWorkerStore } from ${moduleUrl("./login.ts")};
${scrubParent ? "delete process.env.OTTR_DATABASE_URL;" : ""}
const count = await signOutWorkerStore("test-provider", ${JSON.stringify(dbPath)}, "test sign-out", 60_000);
console.log(JSON.stringify({ ...JSON.parse(readFileSync(${JSON.stringify(report)}, "utf8")), count }));
`,
			{ BUN_OPTIONS: `--preload=${preload}` },
		);
		expect(result).toEqual({ ...expected, count: 1 });
		const check = new Database(dbPath, { readonly: true });
		try {
			expect(
				check.query("SELECT disabled_cause FROM auth_credentials").get(),
			).toEqual({ disabled_cause: "test sign-out" });
		} finally {
			check.close();
		}
	}, 90_000);
}

test("dashboard filters the final environment from deps.env before its real child", async () => {
	const report = join(root, `${crypto.randomUUID()}.json`);
	const bin = fakeOmp(report);
	const result = await run(`import { readFileSync } from "node:fs";
import { createOmpStatsDashboard } from ${moduleUrl("./ompStatsDashboard.ts")};
delete process.env.OTTR_DATABASE_URL;
const exited = Promise.withResolvers<void>();
const dashboard = createOmpStatsDashboard({
	baseDir: ${JSON.stringify(join(root, crypto.randomUUID()))},
	sources: () => [],
	env: () => ({
		...process.env,
		PATH: ${JSON.stringify(bin)},
		OTTR_DATABASE_URL: ${JSON.stringify(productionUrl)},
		TERN_PANE: "test-pane",
		TERN_PANE_SOCKET: "test-socket",
	}),
	mirror: async () => ({ written: 0, errors: [] }),
	startTimeoutMs: 60_000,
	log: (line) => {
		if (line === "omp stats exited with 0") exited.resolve();
	},
});
dashboard.ensure();
await exited.promise;
console.log(readFileSync(${JSON.stringify(report)}, "utf8"));
`);
	expect(result).toEqual({
		...expected,
		hasTernPane: false,
		hasTernSocket: false,
	});
}, 90_000);

test("quota filters an explicit production URL before its real child", async () => {
	const report = join(root, `${crypto.randomUUID()}.json`);
	const bin = fakeOmp(report);
	const result = await run(`import { readFileSync } from "node:fs";
import { fetchQuota } from ${moduleUrl("./quota.ts")};
delete process.env.OTTR_DATABASE_URL;
const result = await fetchQuota({
	...process.env,
	PATH: ${JSON.stringify(bin)},
	OTTR_DATABASE_URL: ${JSON.stringify(productionUrl)},
});
console.log(JSON.stringify({
	...JSON.parse(readFileSync(${JSON.stringify(report)}, "utf8")),
	error: result.error,
	limits: result.limits,
}));
`);
	expect(result).toMatchObject({ ...expected, error: null, limits: [] });
}, 90_000);

test("fork analysis filters explicit overrides and preserves child input", async () => {
	const childSource = `const input = await Bun.stdin.text();
console.log(JSON.stringify({ ...${observation}, preservesInput: input === "test input" }));`;
	const result =
		await run(`import { defaultSpawn } from ${moduleUrl("./forkAnalysis.ts")};
delete process.env.OTTR_DATABASE_URL;
const result = await defaultSpawn([process.execPath, "-e", ${JSON.stringify(childSource)}], {
	stdin: "test input",
	env: { ...process.env, OTTR_DATABASE_URL: ${JSON.stringify(productionUrl)} },
	timeoutMs: 60_000,
});
console.log(JSON.stringify({ code: result.code, stderr: result.stderr, ...JSON.parse(result.stdout) }));
`);
	expect(result).toEqual({
		...expected,
		code: 0,
		stderr: "",
		preservesInput: true,
	});
}, 90_000);
