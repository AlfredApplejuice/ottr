// Tracker-global key/value store. SQLite keeps .tasks/tracker.db.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { closeLocked, openLocked, vacuumInto } from "./dblock.ts";
import { databaseConfig } from "./postgresConfig.ts";
import {
	getPostgresDatabase,
	PostgresDatabase,
	type StoreDatabase,
} from "./postgresDriver.ts";
import { initializeGlobalSchema } from "./postgresSchema.ts";
import { StoreQueue } from "./storeQueue.ts";

export class GlobalStore {
	private readonly queue: StoreQueue;

	private constructor(private db: StoreDatabase) {
		this.queue =
			db instanceof PostgresDatabase
				? db.createQueue()
				: new StoreQueue({
						begin: () => db.exec("BEGIN IMMEDIATE"),
						commit: () => db.exec("COMMIT"),
						rollback: () => db.rollback(),
					});
	}

	static async open(root: string): Promise<GlobalStore> {
		if (databaseConfig().backend === "postgres") {
			const db = await getPostgresDatabase("ottr_global");
			try {
				await initializeGlobalSchema(db);
				return new GlobalStore(db);
			} catch (error) {
				await db.close();
				throw error;
			}
		}
		const dir = resolve(root);
		mkdirSync(join(dir, ".tasks"), { recursive: true });
		// Keep a fresh checkout's boot from leaving an untracked .tasks dir (mirrors ProjectStore.init).
		const taskIgnore = join(dir, ".tasks", ".gitignore");
		if (!existsSync(taskIgnore)) writeFileSync(taskIgnore, "*\n");
		const dbPath = join(dir, ".tasks", "tracker.db");
		// Shared durability/perf and single-instance sequence with ProjectStore.open
		// (R2-9): WAL + busy_timeout + synchronous NORMAL, then the lock, which
		// throws StoreLockedError naming the live holder.
		const db = await openLocked(dbPath);
		try {
			await db.exec(
				"CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
			);
			return new GlobalStore(db);
		} catch (error) {
			await closeLocked(db);
			throw error;
		}
	}

	async transaction<T>(work: () => T | Promise<T>): Promise<T> {
		// Public callbacks can have external effects. Never repeat them after connection loss.
		return this.queue.transaction(work, { replay: false });
	}

	async get<T>(key: string): Promise<T | null> {
		return this.queue.run(async () => {
			const row = await this.db
				.query<{ value: string }, [string]>(
					"SELECT value FROM kv WHERE key = ?",
				)
				.get(key);
			if (row === null) return null;
			try {
				return JSON.parse(row.value) as T;
			} catch {
				return null; // Only corrupt JSON degrades to null; database errors propagate.
			}
		});
	}

	async set(key: string, value: unknown): Promise<void> {
		return this.queue.run(async () => {
			await this.db
				.query(
					"INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				)
				.run(key, JSON.stringify(value));
		});
	}

	async update<T>(key: string, modify: (current: T | null) => T): Promise<T> {
		return this.transaction(async () => {
			const next = modify(await this.get<T>(key));
			await this.set(key, next);
			return next;
		});
	}

	/** Snapshot copy of tracker.db for the backup (docs/specs/db-backup.md); `dest` must not exist. */
	async backupTo(dest: string): Promise<void> {
		const db = this.db;
		if (db instanceof PostgresDatabase)
			throw new Error(
				"PostgreSQL backup is operator-owned; SQLite snapshots are unavailable",
			);
		return this.queue.run(async () => {
			await vacuumInto(db, dest, ["kv"]);
		});
	}

	async close(): Promise<void> {
		return this.queue.close(async () => {
			if (this.db instanceof PostgresDatabase) await this.db.close();
			else await closeLocked(this.db);
		});
	}
}
