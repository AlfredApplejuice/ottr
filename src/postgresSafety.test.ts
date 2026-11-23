import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_BACKUP_NOTICE } from "./backup.ts";
import {
	createPostgresFixture,
	type PostgresFixture,
	readPostgresTestConfig,
} from "./test/postgres.ts";

const config = readPostgresTestConfig();
const liveTest = config ? test : test.skip;
const root = mkdtempSync(join(tmpdir(), "ottr-postgres-safety-"));
const serverModule = import.meta.resolve("./server.ts");
const restoreModule = import.meta.resolve("./restore.ts");
let fixture: PostgresFixture | undefined;
let sequence = 0;

beforeAll(async () => {
	if (config) fixture = await createPostgresFixture(config);
}, 15_000);

afterAll(async () => {
	await fixture?.close();
	rmSync(root, { recursive: true, force: true });
}, 15_000);

function environment(label: string): Record<string, string | undefined> {
	const base = join(root, `${sequence++}-${label}`);
	const roots = join(base, "checkouts");
	const home = join(base, "home");
	mkdirSync(roots, { recursive: true });
	mkdirSync(home);
	return {
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: tmpdir(),
		// Runtime compilation is not application state; keep its cache outside base.
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "bun-runtime-cache"),
		NODE_ENV: "test",
		PORT: "0",
		OMP_TRACKER_HOST: "127.0.0.1",
		OMP_TRACKER_ROOTS: roots,
		OTTR_STATE_DIR: join(base, "state"),
		OTTR_DATA_DIR: join(base, "shared-data"),
		OTTR_SERVER_DATA_DIR: join(base, "server-data"),
		OTTR_BACKUP_DIR: join(base, "backups"),
		OTTR_BACKUP_KEEP: "7",
		OTTR_OMP_STATS_PORT: "off",
		OTTR_TEST_PG_URL: process.env.OTTR_TEST_PG_URL,
		OTTR_REQUIRE_PG_TESTS: process.env.OTTR_REQUIRE_PG_TESTS,
	};
}

function sqliteFile(path: string): Buffer {
	mkdirSync(dirname(path), { recursive: true });
	const database = new Database(path);
	try {
		database.exec(
			"CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('source stays unchanged')",
		);
	} finally {
		database.close();
	}
	return readFileSync(path);
}

function tree(path: string): string[] {
	if (!existsSync(path)) return [];
	return readdirSync(path, { recursive: true, withFileTypes: true })
		.map((entry) => {
			const file = join(entry.parentPath, entry.name);
			const name = relative(path, file);
			return entry.isDirectory()
				? `${name}/`
				: `${name}:${readFileSync(file).toString("hex")}`;
		})
		.sort();
}

async function subprocess(
	program: string | string[],
	env: Record<string, string | undefined>,
) {
	const child = Bun.spawn(
		[
			process.execPath,
			...(typeof program === "string" ? ["--eval", program] : program),
		],
		{
			cwd: root,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr, output: stdout + stderr };
}

// The server closes through its real lifecycle. No parent signal or process kill ends a test child.
// Dynamic import catches startup refusal before module initialization completes.
const bootAndClose = `
	import { getPostgresDatabase } from ${JSON.stringify(import.meta.resolve("./postgresDriver.ts"))};
	import { spawnPiped } from ${JSON.stringify(import.meta.resolve("./worktree.ts"))};
	const launchEnvironment = { ...process.env };
	const postgresSelected = Boolean(process.env.OTTR_DATABASE_URL);
	let server;
	try {
		server = await import(${JSON.stringify(serverModule)});
		// Exercise the product wrapper with an explicit record from before startup scrub.
		const inherited = await spawnPiped([
			process.execPath, "--eval",
			'if (Object.hasOwn(process.env, "OTTR_DATABASE_URL")) process.exitCode = 1;',
		], process.cwd(), 10_000, launchEnvironment);
		if (inherited.code !== 0)
			throw new Error("Database URL reached the product child environment.");
		console.log("filtered database URL: absent");
		if (postgresSelected) {
			const database = await getPostgresDatabase("ottr_global");
			try {
				const row = await database.serialize(() => database.query("SELECT 1 AS ready").get());
				if (row?.ready !== 1) throw new Error("Pinned PostgreSQL read failed.");
				console.log("pinned PostgreSQL database: ready");
			} finally {
				await database.close();
			}
		}
		await server.shutdown(0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		if (server) await server.shutdown(1);
		process.exit(1);
	}
`;

liveTest(
	"empty PostgreSQL guard precedes all SQLite paths, override preserves bytes, and an existing global schema wins",
	async () => {
		if (!fixture) throw new Error("Expected the live PostgreSQL fixture.");
		await fixture.sql.unsafe("CREATE SCHEMA unrelated_state");
		await fixture.sql.unsafe("CREATE TABLE unrelated_state.probe (value text)");
		const sources = [
			(env: Record<string, string | undefined>) =>
				join(env.OTTR_STATE_DIR!, ".tasks", "tracker.db"),
			(env: Record<string, string | undefined>) =>
				join(env.OMP_TRACKER_ROOTS!, "demo", ".tasks", "tasks.db"),
			(env: Record<string, string | undefined>) =>
				join(env.OTTR_DATA_DIR!, "demo", "tasks.db"),
			(env: Record<string, string | undefined>) =>
				join(env.OTTR_SERVER_DATA_DIR!, "demo", "tasks.db"),
		];
		for (const source of sources) {
			const env = environment("guard");
			sqliteFile(source(env));
			const before = tree(dirname(env.OTTR_STATE_DIR!));
			const result = await subprocess(
				[fileURLToPath(serverModule)],
				fixture.subprocessEnv(env),
			);
			expect(result.code).not.toBe(0);
			expect(result.output).toContain("bun src/import-sqlite-to-postgres.ts");
			expect(result.output).not.toContain(fixture.url);
			expect(tree(dirname(env.OTTR_STATE_DIR!))).toEqual(before);
		}
		expect(
			await fixture.sql.unsafe(
				"SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = 'ottr_global'",
			),
		).toEqual([]);

		const env = environment("override");
		mkdirSync(join(env.OMP_TRACKER_ROOTS!, "demo"));
		const originals = sources.map((source) => {
			const path = source(env);
			return { path, bytes: sqliteFile(path) };
		});
		const overridden = await subprocess(
			bootAndClose,
			fixture.subprocessEnv({ ...env, OTTR_PG_ALLOW_EMPTY: "1" }),
		);
		expect(overridden.code).toBe(0);
		expect(overridden.output).not.toContain(fixture.url);
		expect(overridden.stdout.split(POSTGRES_BACKUP_NOTICE).length - 1).toBe(1);
		expect(overridden.stdout).toContain("filtered database URL: absent");
		expect(overridden.stdout).toContain("pinned PostgreSQL database: ready");
		expect(existsSync(env.OTTR_BACKUP_DIR!)).toBe(false);
		expect(existsSync(join(env.OTTR_SERVER_DATA_DIR!, ".adopted"))).toBe(false);
		for (const { path, bytes } of originals) {
			expect(readFileSync(path).equals(bytes)).toBe(true);
			expect(existsSync(`${path}.moved-to-server`)).toBe(false);
			expect(existsSync(`${path}.adopting`)).toBe(false);
			expect(existsSync(`${path}-wal`)).toBe(false);
			expect(existsSync(`${path}-shm`)).toBe(false);
			expect(existsSync(`${path}-journal`)).toBe(false);
		}
		expect(
			await fixture.sql.unsafe(
				"SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = 'ottr_global'",
			),
		).toEqual([{ nspname: "ottr_global" }]);
		expect(
			await fixture.sql.unsafe(
				"SELECT project_name FROM ottr_global.project_registry",
			),
		).toEqual([]);

		// No override on a later boot: existing PostgreSQL state, not the live SQLite files, owns the board.
		await fixture.sql.unsafe(
			"INSERT INTO ottr_global.kv (key, value) VALUES ($1, $2)",
			["safety_sentinel", JSON.stringify("keep PostgreSQL state")],
		);
		const existing = await subprocess(bootAndClose, fixture.subprocessEnv(env));
		expect(existing.code).toBe(0);
		expect(existing.output).not.toContain(
			"bun src/import-sqlite-to-postgres.ts",
		);
		expect(existing.stdout.split(POSTGRES_BACKUP_NOTICE).length - 1).toBe(1);
		expect(existing.stdout).toContain("filtered database URL: absent");
		expect(existing.stdout).toContain("pinned PostgreSQL database: ready");
		for (const { path, bytes } of originals)
			expect(readFileSync(path).equals(bytes)).toBe(true);
		expect(
			await fixture.sql.unsafe(
				"SELECT value FROM ottr_global.kv WHERE key = $1",
				["safety_sentinel"],
			),
		).toEqual([{ value: JSON.stringify("keep PostgreSQL state") }]);
	},
	90_000,
);

liveTest(
	"invalid and unreachable PostgreSQL startup fail before files change and never expose the URL",
	async () => {
		if (!fixture) throw new Error("Expected the live PostgreSQL fixture.");
		const invalid = fixture.url.replace(/^[^:]+:/, "https:");
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket) {
					socket.end();
				},
			},
		});
		const unreachable = new URL(fixture.url);
		unreachable.hostname = "127.0.0.1";
		unreachable.port = String(listener.port);
		listener.stop(true);
		for (const url of [invalid, unreachable.href]) {
			const env = environment("startup-failure");
			sqliteFile(join(env.OTTR_STATE_DIR!, ".tasks", "tracker.db"));
			const before = tree(dirname(env.OTTR_STATE_DIR!));
			const started = performance.now();
			const result = await subprocess([fileURLToPath(serverModule)], {
				...env,
				OTTR_DATABASE_URL: url,
			});
			expect(result.code).not.toBe(0);
			expect(result.output).not.toContain(url);
			expect(result.output).not.toContain(fixture.url);
			expect(result.output).not.toContain(
				"bun src/import-sqlite-to-postgres.ts",
			);
			expect(performance.now() - started).toBeLessThan(15_000);
			expect(tree(dirname(env.OTTR_STATE_DIR!))).toEqual(before);
		}
	},
	40_000,
);

liveTest(
	"PostgreSQL restore refuses before target, snapshot, sidecar, or marker changes",
	async () => {
		if (!fixture) throw new Error("Expected the live PostgreSQL fixture.");
		const env = environment("restore");
		const stamp = "20261110T031500Z";
		const source = join(env.OTTR_BACKUP_DIR!, stamp, "tracker.db");
		sqliteFile(source);
		sqliteFile(join(env.OTTR_STATE_DIR!, ".tasks", "tracker.db"));
		sqliteFile(join(env.OTTR_SERVER_DATA_DIR!, "demo", "tasks.db"));
		writeFileSync(
			join(env.OTTR_STATE_DIR!, ".tasks", "tracker.db-wal"),
			"synthetic WAL bytes",
		);
		writeFileSync(
			join(env.OTTR_STATE_DIR!, ".tasks", "tracker.db-shm"),
			"synthetic SHM bytes",
		);
		writeFileSync(
			join(env.OTTR_SERVER_DATA_DIR!, "demo", "tasks.db-journal"),
			"synthetic journal bytes",
		);
		writeFileSync(
			join(env.OTTR_BACKUP_DIR!, stamp, "snapshot.json"),
			JSON.stringify({ copied: ["tracker.db"], failed: [] }),
		);
		const before = tree(dirname(env.OTTR_STATE_DIR!));
		for (const args of [[], ["latest"], [stamp]]) {
			const result = await subprocess(
				[fileURLToPath(restoreModule), ...args],
				fixture.subprocessEnv(env),
			);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain(
				"SQLite restore is not available for PostgreSQL",
			);
			expect(result.output).not.toContain(fixture.url);
			expect(tree(dirname(env.OTTR_STATE_DIR!))).toEqual(before);
		}
	},
	30_000,
);

// This real boot also protects the unchanged default path while the PostgreSQL scheduler stays off.
test("SQLite default startup retains its snapshot scheduler and clean shutdown", async () => {
	const env = environment("sqlite-default");
	const result = await subprocess(bootAndClose, env);
	expect(result.code).toBe(0);
	expect(result.stdout).toContain("database: sqlite");
	expect(result.output).not.toContain(POSTGRES_BACKUP_NOTICE);
	const stamps = readdirSync(env.OTTR_BACKUP_DIR!);
	expect(stamps).toHaveLength(1);
	expect(existsSync(join(env.OTTR_BACKUP_DIR!, stamps[0]!, "tracker.db"))).toBe(
		true,
	);
}, 30_000);
