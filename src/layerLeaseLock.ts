import { constants, Database } from "bun:sqlite";
import { lstatSync } from "node:fs";

// OS-backed locks for the agent layer leases (docs/specs/agent-layer-switch.md, "Record").
// Each lock is an exclusive SQLite transaction on a zero-byte file: SQLite takes POSIX
// record locks, which work across independent processes and containers on the shared
// volume, the kernel drops them when the holder dies, and SQLite tracks them per inode, so
// a second connection in the same process sees the lock too. The transaction never writes,
// so the file stays empty: journal_mode=MEMORY and locking_mode=EXCLUSIVE leave no sidecar.
// SQLITE_OPEN_NOFOLLOW refuses a symlink in any component of the path, so callers pass a
// path below a realpath'd home.

const OPEN = constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW;
const CREATE = constants.SQLITE_OPEN_CREATE;

/** An exclusive lock this process holds until `release()`; release is idempotent. */
export type HeldLock = { release(): void };

/** "free": no one holds the lock (its holder ended). "held" and "uncertain" both mean keep. */
export type LockProbe = "held" | "free" | "uncertain";

/** True when `path` is a regular file, false when it is missing; throws on anything else. */
function regularFile(path: string): boolean {
	try {
		if (!lstatSync(path).isFile())
			throw new Error(`refusing ${path}: a symlink or not a regular file`);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

const isBusy = (err: unknown): boolean =>
	(err as { code?: string }).code === "SQLITE_BUSY";

// busy_timeout stays 0: with locking_mode=EXCLUSIVE a connection keeps the SHARED lock of
// a failed upgrade, so two waiters can block each other until both time out. Only a close
// drops that lock, so holdLock retries the full open-and-lock sequence instead.
function lockOn(db: Database): void {
	db.run("PRAGMA busy_timeout = 0");
	db.run("PRAGMA locking_mode = EXCLUSIVE");
	db.run("PRAGMA journal_mode = MEMORY");
	db.run("BEGIN EXCLUSIVE");
}

/**
 * Takes the exclusive lock on `path`, creating the file when it is missing, and retries for
 * up to `waitMs` while another holder has it. Throws when the lock stays busy, or when the
 * path is a symlink or not a regular file.
 */
export function holdLock(path: string, waitMs: number): HeldLock {
	const deadline = Date.now() + waitMs;
	for (;;) {
		regularFile(path);
		const db = new Database(path, OPEN | CREATE);
		try {
			lockOn(db);
			return heldBy(db);
		} catch (err) {
			db.close();
			if (!isBusy(err) || Date.now() >= deadline) throw err;
		}
		Bun.sleepSync(1 + Math.floor(Math.random() * 4)); // jitter breaks lockstep retries
	}
}

function heldBy(db: Database): HeldLock {
	let open = true;
	return {
		release() {
			if (!open) return;
			open = false;
			try {
				db.run("ROLLBACK");
			} finally {
				db.close();
			}
		},
	};
}

/**
 * Tests the lock on an existing `path` without waiting. Only a lock this call could take
 * proves that its holder ended; a missing file, a symlink, or any other error is uncertain.
 */
export function probeLock(path: string): LockProbe {
	let db: Database;
	try {
		if (!regularFile(path)) return "uncertain";
		db = new Database(path, OPEN);
	} catch {
		return "uncertain";
	}
	try {
		lockOn(db);
		db.run("ROLLBACK");
		return "free";
	} catch (err) {
		return isBusy(err) ? "held" : "uncertain";
	} finally {
		db.close();
	}
}
