import { inspect } from "node:util";
import { scrubProcEnviron } from "./hosted.ts";

export type DatabaseConfig =
	| { backend: "sqlite" }
	| { backend: "postgres"; url: string; host: string; database: string };

// Reject controls before URL parsing can discard them, and after percent decoding.
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const INVALID_CONFIG =
	"Invalid OTTR_DATABASE_URL. Use a PostgreSQL URL with a host and database.";

/** Parse server configuration without a connection or an environment change. */
export function parseDatabaseConfig(raw: string | undefined): DatabaseConfig {
	if (raw === undefined || raw === "")
		return Object.freeze({ backend: "sqlite" });
	try {
		if (
			raw.trim() !== raw ||
			raw.includes(" ") ||
			!/^postgres(?:ql)?:\/\//i.test(raw) ||
			CONTROLS.test(raw) ||
			CONTROLS.test(decodeURIComponent(raw))
		)
			throw new Error(INVALID_CONFIG);
		// encodeURI also rejects unpaired Unicode surrogates.
		encodeURI(raw);
		const parsed = new URL(raw);
		const host = decodeURIComponent(parsed.hostname);
		const database = decodeURIComponent(parsed.pathname.slice(1));
		if (
			(parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
			!host ||
			!database ||
			parsed.hash !== "" ||
			parsed.pathname.slice(1).includes("/") ||
			(parsed.port !== "" && Number(parsed.port) < 1) ||
			/[\s/@?#\\]/u.test(host)
		)
			throw new Error(INVALID_CONFIG);
		const config: DatabaseConfig = {
			backend: "postgres",
			url: raw,
			host,
			database,
		};
		// JSON omits the connection value; inspectors receive safe metadata only.
		Object.defineProperty(config, "url", { enumerable: false });
		Object.defineProperty(config, inspect.custom, {
			value: () => ({ backend: "postgres", host, database }),
		});
		return Object.freeze(config);
	} catch {
		// URL and URI errors can contain credentials. Never retain their causes.
		throw new Error(INVALID_CONFIG);
	}
}

let selected: DatabaseConfig | undefined;

/** The first successful server selection remains fixed for this process. */
export function databaseConfig(): DatabaseConfig {
	selected ??= parseDatabaseConfig(process.env.OTTR_DATABASE_URL);
	return selected;
}

/** Pin configuration and scrub the startup block. Bun children still need explicit environments. */
export function initializeDatabaseConfig(): DatabaseConfig {
	try {
		return databaseConfig();
	} finally {
		delete process.env.OTTR_DATABASE_URL;
		scrubProcEnviron("OTTR_DATABASE_URL");
	}
}

/** Driver errors can contain queries, credentials and nested causes. Keep none. */
export function safeDatabaseError(_error: unknown, phase?: string): Error {
	switch (phase) {
		case "startup":
			return new Error("PostgreSQL startup failed.");
		case "ownership":
			return new Error("PostgreSQL ownership failed.");
		case "unknown":
			return new Error("PostgreSQL write result is unknown.");
		case "close":
			return new Error("PostgreSQL close failed.");
		default:
			return new Error("PostgreSQL operation failed.");
	}
}
