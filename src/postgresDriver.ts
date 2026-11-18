import { AsyncLocalStorage } from "node:async_hooks";
import { type ReservedSQL, SQL } from "bun";
import { databaseConfig, safeDatabaseError } from "./postgresConfig.ts";
import type { SQLiteChanges, SQLiteDatabase } from "./sqliteDriver.ts";
import { StoreQueue, type StoreQueueScope } from "./storeQueue.ts";

export type StoreDatabase = SQLiteDatabase | PostgresDatabase;

// Two fixed int32 keys identify one database-wide, session-owned Ottr lock.
const LOCK_CLASS = 0x4f545452;
const LOCK_OBJECT = 0x50474244;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const GENERATED_IDS: Record<string, true> = {
	turns: true,
	events: true,
	pr_review_runs: true,
	review_findings: true,
};
const CONNECTION_ERRORS: Record<string, true> = {
	ECONNREFUSED: true,
	ECONNRESET: true,
	ECONNABORTED: true,
	EPIPE: true,
	ETIMEDOUT: true,
	ENETUNREACH: true,
	EHOSTUNREACH: true,
	ERR_POSTGRES_CONNECTION_CLOSED: true,
	ERR_POSTGRES_CONNECTION_TIMEOUT: true,
	ERR_POSTGRES_CONNECTION_LOST: true,
	ERR_POSTGRES_SOCKET_CLOSED: true,
	ERR_POSTGRES_CONNECTION_REFUSED: true,
};

type Token = {
	text: string;
	kind: "word" | "identifier" | "literal" | "trivia" | "symbol";
};

/** Keep literals, quoted identifiers, dollar strings, and comments opaque. */
function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let offset = 0;
	while (offset < text.length) {
		const start = offset;
		const char = text.charAt(offset);
		let kind: Token["kind"] = "symbol";
		if (/\s/.test(char)) {
			kind = "trivia";
			while (offset < text.length && /\s/.test(text.charAt(offset))) offset++;
		} else if (text.startsWith("--", offset)) {
			kind = "trivia";
			const end = text.indexOf("\n", offset);
			offset = end < 0 ? text.length : end;
		} else if (text.startsWith("/*", offset)) {
			kind = "trivia";
			offset += 2;
			let depth = 1;
			while (offset < text.length && depth > 0) {
				if (text.startsWith("/*", offset)) {
					depth++;
					offset += 2;
				} else if (text.startsWith("*/", offset)) {
					depth--;
					offset += 2;
				} else offset++;
			}
			if (depth !== 0) throw new Error("Invalid PostgreSQL statement.");
		} else if (char === "'" || char === '"') {
			kind = char === "'" ? "literal" : "identifier";
			// E strings alone use backslash escaping with standard_conforming_strings.
			const escaped =
				char === "'" && /(?:^|[^a-z0-9_])e$/i.test(text.slice(0, start));
			offset++;
			let closed = false;
			while (offset < text.length) {
				if (escaped && text[offset] === "\\") {
					offset += 2;
					continue;
				}
				if (text[offset++] !== char) continue;
				if (text[offset] === char) {
					offset++;
					continue;
				}
				closed = true;
				break;
			}
			if (!closed) throw new Error("Invalid PostgreSQL statement.");
		} else if (
			char === "$" &&
			/^\$(?:[a-z_][a-z0-9_]*)?\$/i.test(text.slice(offset))
		) {
			kind = "literal";
			const tag = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(text.slice(offset))?.[0];
			if (!tag) throw new Error("Invalid PostgreSQL statement.");
			const end = text.indexOf(tag, offset + tag.length);
			if (end < 0) throw new Error("Invalid PostgreSQL statement.");
			offset = end + tag.length;
		} else if (/[a-z_]/i.test(char)) {
			kind = "word";
			offset++;
			while (offset < text.length && /[a-z0-9_$]/i.test(text.charAt(offset)))
				offset++;
		} else offset++;
		tokens.push({ text: text.slice(start, offset), kind });
	}
	return tokens;
}

function identifier(token: Token | undefined): string | null {
	if (token?.kind === "word") return token.text.toLowerCase();
	if (token?.kind === "identifier")
		return token.text.slice(1, -1).replaceAll('""', '"');
	return null;
}

/** Replay only the single-statement read forms used by the shared stores. */
function replayableRead(tokens: Token[], command: string): boolean {
	if (command !== "SELECT" && command !== "SHOW") return false;
	for (const [index, token] of tokens.entries()) {
		if (token.text === ";" && index !== tokens.length - 1) return false;
		// SELECT INTO writes, and locking reads are not side-effect-free.
		if (token.kind === "word" && /^(?:into|for)$/i.test(token.text))
			return false;
		// The tokenizer deliberately recognizes only ASCII unquoted identifiers.
		// Do not mistake an unrecognized identifier for harmless punctuation.
		if (token.kind === "symbol" && /[^\p{ASCII}]/u.test(token.text))
			return false;
		if (tokens[index + 1]?.text !== "(") continue;
		const name = identifier(token);
		if (name === null) continue;
		const qualified = tokens[index - 1]?.text === ".";
		if (
			!qualified &&
			token.kind === "word" &&
			/^(?:select|from|where|join|on|having|and|or|not|in|exists|as|distinct|when|then|else)$/i.test(
				token.text,
			)
		)
			continue;
		if (
			!/^(?:count|max|pg_backend_pid|current_database|current_schema|current_setting)$/.test(
				name,
			) ||
			(qualified &&
				(identifier(tokens[index - 2]) !== "pg_catalog" ||
					tokens[index - 3]?.text === "."))
		)
			return false;
	}
	return true;
}

/** Translate application SQL, never values or the contents of opaque SQL tokens. */
function statement(
	text: string,
	schema: string,
): { text: string; read: boolean; generated: boolean; command: string } {
	const tokens = tokenize(text);
	const significant = tokens.filter((token) => token.kind !== "trivia");
	const command = significant[0]?.text.toUpperCase() ?? "";
	const read = replayableRead(significant, command);
	let parameter = 0;
	let generated = false;
	let expectTable = false;
	let createIndex = false;
	for (const [index, token] of significant.entries()) {
		const word = token.kind === "word" ? token.text.toUpperCase() : "";
		if (token.kind === "symbol" && token.text === "?")
			token.text = `$${++parameter}`;
		if (expectTable) {
			if (["IF", "NOT", "EXISTS", "ONLY"].includes(word)) continue;
			expectTable = false;
			const name = identifier(token);
			const qualified = significant[index + 1]?.text === ".";
			const callable = significant[index + 1]?.text === "(";
			if (
				name &&
				!qualified &&
				!(
					callable &&
					word !== "" &&
					significant[index - 1]?.text.toUpperCase() === "FROM"
				)
			) {
				token.text = `"${schema}"."${name.replaceAll('"', '""')}"`;
			}
			if (command === "INSERT" && name) {
				const tableName = qualified ? identifier(significant[index + 2]) : name;
				generated =
					tableName !== null && Object.hasOwn(GENERATED_IDS, tableName);
			}
		}
		if (word === "INDEX" && command === "CREATE") createIndex = true;
		if (
			["FROM", "JOIN", "UPDATE", "INTO", "TABLE"].includes(word) ||
			(word === "ON" && createIndex)
		) {
			// Conflict actions and trigger events do not introduce a relation.
			if (
				word !== "UPDATE" ||
				(command !== "CREATE" &&
					significant[index + 1]?.text.toUpperCase() !== "SET")
			)
				expectTable = true;
			if (word === "ON") createIndex = false;
		}
	}
	if (
		generated &&
		!significant.some(
			(token) =>
				token.kind === "word" && token.text.toUpperCase() === "RETURNING",
		)
	) {
		let end = tokens.length;
		while (end > 0) {
			const token = tokens[end - 1];
			if (!token || (token.kind !== "trivia" && token.text !== ";")) break;
			end--;
		}
		tokens.splice(end, 0, { text: " RETURNING id", kind: "word" });
	}
	return {
		text: tokens.map((token) => token.text).join(""),
		read,
		generated,
		command,
	};
}

function connectionFailure(error: unknown): boolean {
	if (
		typeof error !== "object" ||
		error === null ||
		!("code" in error) ||
		typeof error.code !== "string"
	)
		return false;
	const sqlstate = error instanceof SQL.PostgresError ? error.errno : undefined;
	return (
		(typeof sqlstate === "string" &&
			/^(?:08[A-Z0-9]{3}|57P0[123]|40003)$/.test(sqlstate)) ||
		/^(?:08[A-Z0-9]{3}|57P0[123]|40003)$/.test(error.code) ||
		Object.hasOwn(CONNECTION_ERRORS, error.code)
	);
}

/** Only an actual server ErrorResponse with SQLSTATE proves command refusal. */
function definiteServerRejection(error: unknown): boolean {
	return (
		error instanceof SQL.PostgresError &&
		error.code === "ERR_POSTGRES_SERVER_ERROR" &&
		typeof error.errno === "string" &&
		/^[0-9A-Z]{5}$/.test(error.errno) &&
		error.severity !== "FATAL" &&
		error.severity !== "PANIC" &&
		!connectionFailure(error)
	);
}

class InterruptedTransaction extends Error {
	constructor() {
		super("PostgreSQL transaction connection failed.");
	}
}

interface Session {
	pool: SQL;
	connection: ReservedSQL;
	pid: number;
	closed: boolean;
}
interface OperationScope {
	active: boolean;
}
interface Transaction {
	lost: boolean;
	commitSent: boolean;
}
interface DriverOptions {
	retryMilliseconds?: number;
}

class PostgresBackend {
	private readonly url: string;
	private readonly retryMilliseconds: number;
	private readonly context = new AsyncLocalStorage<OperationScope>();
	readonly queueContext = new AsyncLocalStorage<StoreQueueScope>();
	private tail: Promise<void> = Promise.resolve();
	private session: Session | null = null;
	private transaction: Transaction | null = null;
	private poisoned: Error | null = null;
	private closing = false;
	private closePromise: Promise<void> | null = null;
	refs = 0;

	constructor(url: string, options: DriverOptions) {
		this.url = url;
		this.retryMilliseconds = options.retryMilliseconds ?? 30_000;
		if (
			!Number.isFinite(this.retryMilliseconds) ||
			this.retryMilliseconds <= 0 ||
			this.retryMilliseconds > 30_000
		)
			throw new Error("Invalid PostgreSQL retry duration.");
	}

	async open(milliseconds = 2_000): Promise<void> {
		const target = new URL(this.url);
		let session: Session | null = null;
		const pool = new SQL(this.url, {
			adapter: "postgres",
			hostname: target.hostname.replace(/^\[|\]$/g, ""),
			port: Number(target.port || 5432),
			database: decodeURIComponent(target.pathname.slice(1)),
			username: decodeURIComponent(target.username) || "postgres",
			password: decodeURIComponent(target.password),
			max: 1,
			bigint: true,
			idleTimeout: 0,
			maxLifetime: 0,
			// Schema-exists notices can contain raw identifiers. Errors still propagate.
			connection: { client_min_messages: "warning" },
			connectionTimeout: Math.max(0.001, Math.min(milliseconds, 2_000) / 1_000),
			onclose: () => {
				if (session) session.closed = true;
			},
		});
		try {
			const connection = await pool.reserve({
				signal: AbortSignal.timeout(Math.max(1, Math.ceil(milliseconds))),
			});
			session = { pool, connection, pid: 0, closed: false };
			const rows = await connection.unsafe<
				{ pid: number; owned: boolean; version: string }[]
			>(
				"SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.pg_try_advisory_lock($1::integer, $2::integer) AS owned, pg_catalog.current_setting('server_version_num') AS version",
				[LOCK_CLASS, LOCK_OBJECT],
			);
			if (!rows[0]?.owned)
				throw new Error("PostgreSQL database already has an owner.");
			if (Number(rows[0].version) < 180000)
				throw new Error("PostgreSQL 18 or later is required.");
			session.pid = rows[0].pid;
			this.session = session;
			await this.proveOwnership();
		} catch (error) {
			try {
				await pool.close({ timeout: 0 });
			} catch (closeError) {
				throw safeDatabaseError(closeError, "close");
			}
			throw safeDatabaseError(error, "connect");
		}
	}

	serialize<T>(work: () => Promise<T>): Promise<T> {
		const inherited = this.context.getStore();
		if (inherited?.active) {
			if (this.poisoned) return Promise.reject(this.poisoned);
			return work();
		}
		if (this.closing)
			return Promise.reject(new Error("PostgreSQL backend is closed."));
		const result = this.tail.then(async () => {
			if (this.poisoned) throw this.poisoned;
			const scope: OperationScope = { active: true };
			try {
				return await this.context.run(scope, work);
			} finally {
				scope.active = false;
			}
		});
		this.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private fatal(
		phase:
			| "unknown result"
			| "ownership"
			| "retry exhausted"
			| "rollback"
			| "transaction interrupted",
	): never {
		this.poisoned = safeDatabaseError(undefined, phase);
		console.error(`PostgreSQL backend stopped: ${phase}.`);
		// The process must not admit work after an unknown write or lost ownership.
		process.exit(1);
	}

	private async proveOwnership(): Promise<void> {
		const session = this.session;
		if (!session || session.closed) throw new InterruptedTransaction();
		const rows = await session.connection.unsafe<
			{ pid: number; owned: boolean }[]
		>(
			"SELECT pg_catalog.pg_backend_pid() AS pid, EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND pid = pg_catalog.pg_backend_pid() AND classid = $1::oid AND objid = $2::oid AND objsubid = 2 AND granted) AS owned",
			[LOCK_CLASS, LOCK_OBJECT],
		);
		if (rows[0]?.pid !== session.pid || !rows[0]?.owned)
			this.fatal("ownership");
	}

	private async discard(): Promise<void> {
		const previous = this.session;
		this.session = null;
		if (previous) {
			try {
				await previous.pool.close({ timeout: 0 });
			} catch {
				this.fatal("ownership");
			}
		}
	}

	private async recover(deadline: number): Promise<void> {
		// reserve() may finish before the handshake/query does. Bound the whole
		// recovery, including socket close and ownership proof, not just reservation.
		const timeout = setTimeout(
			() => this.fatal("retry exhausted"),
			Math.max(0, deadline - Date.now()),
		);
		try {
			await this.discard();
			while (Date.now() < deadline) {
				try {
					await this.open(deadline - Date.now());
					return;
				} catch {
					/* Only a new reserved session with proven ownership can resume. */
				}
				await Bun.sleep(Math.min(50, Math.max(0, deadline - Date.now())));
			}
			this.fatal("retry exhausted");
		} finally {
			clearTimeout(timeout);
		}
	}

	async retry<T>(
		attempt: () => Promise<T>,
		canReplay?: () => boolean,
	): Promise<T> {
		const deadline = Date.now() + this.retryMilliseconds;
		for (;;) {
			try {
				return await attempt();
			} catch (error) {
				if (!(error instanceof InterruptedTransaction)) throw error;
				if (canReplay && !canReplay()) this.fatal("transaction interrupted");
				await this.recover(deadline);
			}
		}
	}

	async execute(
		text: string,
		params: unknown[],
		schema: string,
	): Promise<
		Record<string, unknown>[] & { affectedRows: number; generated?: boolean }
	> {
		return this.serialize(async () => {
			const translated = statement(text, schema);
			const control = translated.command;
			if (control === "BEGIN") {
				if (this.transaction)
					throw new Error("PostgreSQL transaction is already active.");
				// BEGIN itself has no state effect. Its retry remains part of the whole attempt.
			}
			const attempt = async () => {
				if (this.poisoned) throw this.poisoned;
				if (this.transaction?.lost) throw new InterruptedTransaction();
				try {
					await this.proveOwnership();
				} catch (error) {
					if (!definiteServerRejection(error)) {
						if (this.transaction) this.transaction.lost = true;
						throw new InterruptedTransaction();
					}
					throw safeDatabaseError(error, "ownership");
				}
				if (control === "COMMIT" && this.transaction)
					this.transaction.commitSent = true;
				try {
					const session = this.session;
					if (!session) throw new InterruptedTransaction();
					const rows: Record<string, unknown>[] & {
						affectedRows: number;
						generated?: boolean;
					} = await session.connection.unsafe<Record<string, unknown>[]>(
						translated.text,
						params,
					);
					if (control === "BEGIN")
						this.transaction = { lost: false, commitSent: false };
					if (control === "COMMIT" || control === "ROLLBACK")
						this.transaction = null;
					for (const row of rows)
						for (const key of Object.keys(row)) {
							const value = row[key];
							if (
								typeof value === "bigint" &&
								value >= -MAX_SAFE_INTEGER &&
								value <= MAX_SAFE_INTEGER
							)
								row[key] = Number(value);
						}
					rows.generated = translated.generated;
					return rows;
				} catch (error) {
					if (!definiteServerRejection(error) || this.session?.closed) {
						if (this.transaction?.commitSent || control === "COMMIT")
							this.fatal("unknown result");
						if (this.transaction) {
							this.transaction.lost = true;
							throw new InterruptedTransaction();
						}
						if (
							!translated.read &&
							control !== "BEGIN" &&
							control !== "ROLLBACK"
						)
							this.fatal("unknown result");
						throw new InterruptedTransaction();
					}
					throw safeDatabaseError(error, "query");
				}
			};
			// Never retry a statement from the middle of an explicit transaction.
			return this.transaction || control === "BEGIN"
				? attempt()
				: this.retry(attempt);
		});
	}

	async rollback(): Promise<void> {
		if (this.poisoned) throw this.poisoned;
		if (!this.transaction) return;
		if (this.transaction.lost) {
			this.transaction = null;
			await this.discard();
			return;
		}
		try {
			const session = this.session;
			if (!session || session.closed) this.fatal("rollback");
			// An application/constraint error can leave the transaction aborted.
			// Only ROLLBACK is legal there: an ownership SELECT would fail with
			// 25P02 before recovery ever reached the server.
			await session.connection.unsafe("ROLLBACK");
			this.transaction = null;
		} catch {
			this.fatal("rollback");
		}
	}

	close(): Promise<void> {
		if (this.closePromise !== null) return this.closePromise;
		this.closing = true;
		this.closePromise = this.tail.then(async () => {
			const session = this.session;
			this.session = null;
			if (session) {
				const errors: Error[] = [];
				try {
					if (!session.closed)
						await session.connection.unsafe(
							"SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer)",
							[LOCK_CLASS, LOCK_OBJECT],
						);
				} catch (error) {
					errors.push(safeDatabaseError(error, "close"));
				}
				try {
					await session.pool.close({ timeout: 0 });
				} catch (error) {
					errors.push(safeDatabaseError(error, "close"));
				}
				if (errors.length > 0)
					throw new AggregateError(errors, "PostgreSQL close failed.");
			}
		});
		return this.closePromise;
	}
}

let backend: Promise<PostgresBackend> | null = null;

/** Reserve ownership only. Schema migrations belong to the schema helpers. */
export async function getPostgresDatabase(
	schema: string,
	options: DriverOptions = {},
): Promise<PostgresDatabase> {
	if (
		schema.length > 63 ||
		/[^a-z0-9_]/.test(schema) ||
		!/^(?:ottr_global|p_[a-z0-9_]{0,48}_[a-f0-9]{12})$/.test(schema)
	)
		throw new Error("Invalid PostgreSQL schema identifier.");
	const config = databaseConfig();
	if (config.backend !== "postgres")
		throw new Error("PostgreSQL backend is not selected.");
	if (!backend)
		backend = (async () => {
			try {
				const owner = new PostgresBackend(config.url, options);
				await owner.open();
				return owner;
			} catch (error) {
				throw safeDatabaseError(error, "connect");
			}
		})();
	const owner = await backend;
	owner.refs++;
	return new PostgresDatabase(schema, owner);
}

export async function closePostgresBackend(): Promise<void> {
	if (!backend) return;
	const current = backend;
	try {
		await (await current).close();
	} finally {
		if (backend === current) backend = null;
	}
}

/** A schema reference on the tenant's single reserved, serialized connection. */
export class PostgresDatabase {
	readonly schema: string;
	private readonly owner: PostgresBackend;
	private closed = false;

	constructor(schema: string, owner: PostgresBackend) {
		this.schema = schema;
		this.owner = owner;
	}

	serialize<T>(work: () => Promise<T>): Promise<T> {
		if (this.closed)
			return Promise.reject(new Error("PostgreSQL store is closed."));
		return this.owner.serialize(work);
	}

	createQueue(): StoreQueue {
		return new StoreQueue({
			begin: () => this.exec("BEGIN"),
			commit: () => this.exec("COMMIT"),
			rollback: () => this.rollback(),
			serialize: (work) => this.serialize(work),
			retry: (attempt, canReplay) => this.owner.retry(attempt, canReplay),
			context: this.owner.queueContext,
		});
	}

	query<Row = Record<string, unknown>, Params extends unknown[] = unknown[]>(
		text: string,
	) {
		return {
			get: async (...params: Params): Promise<Row | null> =>
				(await this.rows<Row>(text, params))[0] ?? null,
			all: (...params: Params): Promise<Row[]> => this.rows<Row>(text, params),
			run: (...params: Params): Promise<SQLiteChanges> =>
				this.run(text, params),
		};
	}

	private rows<Row>(text: string, params: unknown[]): Promise<Row[]> {
		return this.serialize(
			async () =>
				(await this.owner.execute(text, params, this.schema)) as Row[],
		);
	}

	async run(text: string, params: unknown[] = []): Promise<SQLiteChanges> {
		return this.serialize(async () => {
			const rows = await this.owner.execute(text, params, this.schema);
			const id = rows.generated ? (rows[0]?.id ?? 0) : 0;
			if (typeof id !== "number" && typeof id !== "bigint")
				throw new Error("PostgreSQL returned an invalid inserted ID.");
			return { changes: rows.affectedRows, lastInsertRowid: id };
		});
	}

	async exec(text: string): Promise<void> {
		await this.rows(text, []);
	}
	async rollback(): Promise<void> {
		await this.serialize(() => this.owner.rollback());
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.owner.refs--;
		if (this.owner.refs === 0) await closePostgresBackend();
	}
}
