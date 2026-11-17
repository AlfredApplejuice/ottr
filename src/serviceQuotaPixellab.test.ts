import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createPixellabQuotaAdapter } from "./serviceQuotaPixellab.ts";
import { builtInServiceQuotaAdapters } from "./serviceQuotaRegistry.ts";
import {
	createServiceQuotaCoordinator,
	type ServiceQuotaCoordinator,
} from "./serviceQuotas.ts";
import fc from "./test/properties.ts";
import type {
	ServiceQuotaAdapterDefinition,
	ServiceQuotaMetric,
	ServiceQuotaReadError,
	ServiceQuotaReader,
	ServiceQuotaSourceConfig,
} from "./types.ts";

const endpoint = "https://api.pixellab.ai/v2/balance";
const spec = readFileSync(
	new URL("../docs/specs/service-quotas.md", import.meta.url),
	"utf8",
);
const fixtureBlock = spec.match(
	/### Fixture and exact mapping[\s\S]*?```json\s*([\s\S]*?)```/,
)?.[1];
if (!fixtureBlock) throw new Error("Missing documented PixelLab JSON fixture");
const fixture: {
	credits: Record<string, unknown>;
	subscription: Record<string, unknown>;
} = JSON.parse(fixtureBlock);
const json = JSON.stringify(fixture);
const signal = () => new AbortController().signal;

function metrics(
	usd = 10.5,
	generations = 450,
	total = 2000,
	status = "active",
	plan: string | null = "Tier 2: Pixel Artisan",
): ServiceQuotaMetric[] {
	return [
		{
			id: "usd-credits",
			label: "USD credits",
			kind: "balance",
			unit: { kind: "currency", code: "USD" },
			remaining: usd,
			reportedTotal: null,
			resetsAt: null,
			providerStatus: null,
			plan: null,
		},
		{
			id: "subscription-generations",
			label: "Subscription generations",
			kind: "balance",
			unit: { kind: "count", name: "generations" },
			remaining: generations,
			reportedTotal: total,
			resetsAt: null,
			providerStatus: status,
			plan,
		},
	];
}

function changed(change: (body: typeof fixture) => void): string {
	const body = structuredClone(fixture);
	change(body);
	return JSON.stringify(body);
}

function transport(
	request: (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => Promise<Response>,
): typeof fetch {
	return Object.assign(request, { preconnect: globalThis.fetch.preconnect });
}

async function listener(
	handle: (request: IncomingMessage, response: ServerResponse) => void,
) {
	let received = 0;
	const server = createServer((request, response) => {
		received++;
		handle(request, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing test port");
	const url = `http://127.0.0.1:${address.port}/v2/balance`;
	return {
		url,
		get received() {
			return received;
		},
		fetch: transport((input, init) => {
			// Route only after the real reader supplies the exact production request.
			expect(input).toBe(endpoint);
			expect(init?.method).toBe("GET");
			expect(init?.body).toBeUndefined();
			expect(init?.redirect).toBe("manual");
			expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
			return globalThis.fetch(url, init);
		}),
		async close() {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			server.close((failure) => (failure ? reject(failure) : resolve()));
			await promise;
		},
	};
}

function source(id: string): ServiceQuotaSourceConfig {
	return {
		id,
		adapterId: "pixellab-v2",
		label: "PixelLab account",
		credentialEnv: `fixture-${id}`,
	};
}

function cache(adapter: ServiceQuotaAdapterDefinition, credential: string) {
	let now = 1_000;
	let completed = Promise.withResolvers<void>();
	const coordinator: ServiceQuotaCoordinator = createServiceQuotaCoordinator({
		sources: [source("account")],
		registry: new Map([[adapter.id, adapter]]),
		resolveCredential: () => credential,
		now: () => now,
		onChange: () => {
			const state = coordinator.getState()[0];
			if (state?.lastAttemptAt === now) completed.resolve();
		},
	});
	return {
		coordinator,
		async refresh(at: number) {
			now = at;
			completed = Promise.withResolvers<void>();
			coordinator.checkDue();
			await completed.promise;
			const state = coordinator.getState()[0];
			if (!state) throw new Error("Missing source state");
			return state;
		},
	};
}

const invalidBodies: { name: string; body: string }[] = [
	{ name: "malformed JSON", body: "{" },
	{ name: "v1 root balance", body: '{"usd":10.5}' },
	{ name: "null envelope", body: "null" },
	{ name: "array envelope", body: "[]" },
	{ name: "primitive envelope", body: "42" },
	{ name: "empty envelope", body: "{}" },
];
for (const component of ["credits", "subscription"] as const) {
	const { [component]: _omitted, ...rest } = fixture;
	invalidBodies.push({
		name: `missing ${component}`,
		body: JSON.stringify(rest),
	});
	for (const value of [null, [], "invalid", 0, true]) {
		invalidBodies.push({
			name: `${component} is ${JSON.stringify(value)}`,
			body: JSON.stringify({ ...fixture, [component]: value }),
		});
	}
}
for (const [component, field] of [
	["credits", "usd"],
	["subscription", "generations"],
	["subscription", "total"],
	["subscription", "status"],
] as const) {
	invalidBodies.push({
		name: `missing ${component}.${field}`,
		body: changed((body) => {
			delete body[component][field];
		}),
	});
	for (const value of field === "status"
		? [null, 0, false, [], {}]
		: [null, "10.5", false, [], {}]) {
		invalidBodies.push({
			name: `${component}.${field} has wrong type ${JSON.stringify(value)}`,
			body: changed((body) => {
				body[component][field] = value;
			}),
		});
	}
	if (field !== "status") {
		for (const literal of ["1e999", "-1e999"]) {
			invalidBodies.push({
				name: `${component}.${field} is non-finite ${literal}`,
				body: json.replace(new RegExp(`("${field}":)[^,}]+`), `$1${literal}`),
			});
		}
	}
}
for (const [component, mismatch] of [
	["credits", "generations"],
	["subscription", "usd"],
] as const) {
	for (const value of [mismatch, "", null, 0, false, [], {}]) {
		invalidBodies.push({
			name: `${component}.type rejects ${JSON.stringify(value)}`,
			body: changed((body) => {
				body[component].type = value;
			}),
		});
	}
}
for (const value of [0, false, [], {}]) {
	invalidBodies.push({
		name: `plan rejects ${JSON.stringify(value)}`,
		body: changed((body) => {
			body.subscription.plan = value;
		}),
	});
}
for (const field of ["status", "plan"] as const) {
	for (const value of ["a".repeat(257), `${"\u{1f680}".repeat(128)}a`]) {
		invalidBodies.push({
			name: `${field} exceeds 256 UTF-16 units with ${value.length} units and ${Array.from(value).length} characters`,
			body: changed((body) => {
				body.subscription[field] = value;
			}),
		});
	}
}
invalidBodies.push(
	{
		name: "valid fresh credits and invalid subscription reject the whole source",
		body: changed((body) => {
			body.credits.usd = 99;
			body.subscription.generations = "invalid";
		}),
	},
	{
		name: "invalid credits and valid fresh subscription reject the whole source",
		body: changed((body) => {
			body.credits.usd = "invalid";
			body.subscription.generations = 99;
		}),
	},
	{
		name: "body exceeds 64 KiB by one byte",
		body: json + " ".repeat(65_537 - Buffer.byteLength(json)),
	},
);

interface Failure {
	name: string;
	body?: string;
	status: number | null;
	code: ServiceQuotaReadError["code"];
	retryAfterAt?: number;
}
const failures: Failure[] = [
	...invalidBodies.map(({ name, body }) => ({
		name,
		body,
		status: 200,
		code: "invalid_response" as const,
	})),
	{ name: "401", status: 401, code: "authentication" },
	{ name: "403", status: 403, code: "authentication" },
	{ name: "429", status: 429, code: "rate_limit", retryAfterAt: 901_000 },
	{ name: "404 without v1 fallback", status: 404, code: "http" },
	{ name: "503", status: 503, code: "http" },
	{ name: "network exception", status: null, code: "network" },
];

describe("PixelLab v2 quota adapter", () => {
	test("reads the documented fixture with one fixed authenticated balance GET", async () => {
		const credential = randomUUID();
		const received = Promise.withResolvers<{
			method: string | undefined;
			path: string | undefined;
			authorized: boolean;
			accept: string | undefined;
			body: string;
		}>();
		const server = await listener((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => {
				body += chunk;
			});
			request.on("end", () => {
				received.resolve({
					method: request.method,
					path: request.url,
					authorized: request.headers.authorization === `Bearer ${credential}`,
					accept: request.headers.accept,
					body,
				});
				response.end(json);
			});
		});
		try {
			// Extra caller properties cannot override the provider's fixed endpoint.
			const options = { fetch: server.fetch, endpoint: server.url };
			const adapter = createPixellabQuotaAdapter(options);
			expect(adapter.id).toBe("pixellab-v2");
			const reader = adapter.createReader({ credential });
			expect(await reader.read({ signal: signal() })).toEqual({
				ok: true,
				metrics: metrics(),
			});
			expect(await received.promise).toEqual({
				method: "GET",
				path: "/v2/balance",
				authorized: true,
				accept: "application/json",
				body: "",
			});
			expect(server.received).toBe(1);
		} finally {
			await server.close();
		}
	});

	test("accepts each optional omission, nullable plan, every documented status and unknown text", async () => {
		let body = json;
		const server = await listener((_request, response) => response.end(body));
		try {
			const reader = createPixellabQuotaAdapter({
				fetch: server.fetch,
			}).createReader({
				credential: randomUUID(),
			});
			const cases: { body: string; expected: ServiceQuotaMetric[] }[] = [];
			for (const [component, field] of [
				["credits", "type"],
				["subscription", "type"],
				["subscription", "plan"],
			] as const) {
				cases.push({
					body: changed((value) => {
						value.subscription.type = "generations";
						delete value[component][field];
					}),
					expected:
						field === "plan"
							? metrics(10.5, 450, 2000, "active", null)
							: metrics(),
				});
			}
			cases.push({
				body: changed((value) => {
					delete value.credits.type;
					delete value.subscription.type;
					delete value.subscription.plan;
				}),
				expected: metrics(10.5, 450, 2000, "active", null),
			});
			for (const status of [
				"active",
				"trial",
				"expired",
				"none",
				"enterprise",
				"future-status",
				"",
			]) {
				cases.push({
					body: changed((value) => {
						value.subscription.status = status;
						value.subscription.plan = null;
					}),
					expected: metrics(10.5, 450, 2000, status, null),
				});
			}
			for (const entry of cases) {
				body = entry.body;
				expect(await reader.read({ signal: signal() })).toEqual({
					ok: true,
					metrics: entry.expected,
				});
			}
			expect(server.received).toBe(cases.length);
		} finally {
			await server.close();
		}
	});

	test("preserves signed, fractional, zero and over-total balances without inferred entitlements", async () => {
		let body = json;
		const server = await listener((_request, response) => response.end(body));
		try {
			const reader = createPixellabQuotaAdapter({
				fetch: server.fetch,
			}).createReader({ credential: randomUUID() });
			for (const [usd, generations, total] of [
				[-10.5, -450.25, -2000.75],
				[0, 0, 0],
				[0.125, 450.5, 2000.75],
				[10.5, 2500.5, 2000],
				[10.5, 1, 0],
				[Number.MAX_VALUE, Number.MIN_VALUE, -Number.MAX_VALUE],
			] as const) {
				body = changed((value) => {
					value.credits.usd = usd;
					value.subscription.generations = generations;
					value.subscription.total = total;
					value.subscription.status = "expired";
				});
				expect(await reader.read({ signal: signal() })).toEqual({
					ok: true,
					metrics: metrics(usd, generations, total, "expired"),
				});
			}
		} finally {
			await server.close();
		}
	});

	test("accepts 256 UTF-16-unit display strings and exactly 64 KiB", async () => {
		let body = json;
		const server = await listener((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.write(body.slice(0, 32_768));
			response.end(body.slice(32_768));
		});
		try {
			const reader = createPixellabQuotaAdapter({
				fetch: server.fetch,
			}).createReader({ credential: randomUUID() });
			for (const label of ["", "a".repeat(256), "\u{1f680}".repeat(128)]) {
				body = changed((value) => {
					value.subscription.status = label;
					value.subscription.plan = label;
				});
				body += " ".repeat(65_536 - Buffer.byteLength(body));
				expect(Buffer.byteLength(body)).toBe(65_536);
				expect(await reader.read({ signal: signal() })).toEqual({
					ok: true,
					metrics: metrics(10.5, 450, 2000, label, label),
				});
			}
		} finally {
			await server.close();
		}
	});

	test("discards extra fields at every level rather than deriving resets, totals or percentages", async () => {
		const extra = {
			used: 100,
			percentage: 95,
			resetsAt: 1234,
			startsAt: 0,
			plan: "not an entitlement",
			providerStatus: "ignore",
			total: 9999,
			unit: { kind: "count", name: "wrong" },
		};
		const body = JSON.stringify({
			...extra,
			credits: { ...extra, ...fixture.credits },
			subscription: { ...extra, ...fixture.subscription },
			["__proto__"]: { generations: 9 },
			constructor: { prototype: { polluted: true } },
		});
		const server = await listener((_request, response) => response.end(body));
		try {
			const reader = createPixellabQuotaAdapter({
				fetch: server.fetch,
			}).createReader({ credential: randomUUID() });
			expect(await reader.read({ signal: signal() })).toEqual({
				ok: true,
				metrics: metrics(),
			});
		} finally {
			await server.close();
		}
	});

	for (const failure of failures) {
		test(`${failure.name}: preserves the whole old sample and rejects a first sample`, async () => {
			const credential = randomUUID();
			const providerText = randomUUID();
			let failed = false;
			let attempts = 0;
			const server = await listener((_request, response) => {
				response.writeHead(
					failed ? (failure.status ?? 200) : 200,
					failure.code === "rate_limit" ? { "Retry-After": "600" } : {},
				);
				const body = failed
					? (failure.body ?? `${providerText}: ${credential}`)
					: json;
				response.write(body.slice(0, 32_768));
				response.end(body.slice(32_768));
			});
			const logged: unknown[][] = [];
			const spies = (["log", "info", "debug", "warn", "error"] as const).map(
				(method) =>
					spyOn(console, method).mockImplementation((...args: unknown[]) => {
						logged.push(args);
					}),
			);
			const adapter = createPixellabQuotaAdapter({
				now: () => 301_000,
				fetch: transport((input, init) => {
					attempts++;
					expect(input).toBe(endpoint);
					if (failed && failure.code === "network")
						return Promise.reject(new Error(`${providerText}: ${credential}`));
					return server.fetch(input, init);
				}),
			});
			const previous = cache(adapter, credential);
			const first = cache(adapter, credential);
			try {
				const success = await previous.refresh(1_000);
				expect(success).toMatchObject({
					status: "ok",
					sample: { observedAt: 1_000, metrics: metrics() },
				});
				failed = true;
				const expectedError = {
					code: failure.code,
					httpStatus: failure.status,
					retryAfterAt: failure.retryAfterAt ?? null,
				};
				const stale = await previous.refresh(301_000);
				expect(stale).toMatchObject({
					status: "stale",
					staleReason: "refresh_error",
					lastAttemptAt: 301_000,
					sample: success.sample,
					error: expectedError,
				});
				expect(stale.sample).toEqual({ observedAt: 1_000, metrics: metrics() });
				expect(stale.nextAttemptAt).toBe(
					failure.code === "authentication"
						? null
						: Math.max(601_000, failure.retryAfterAt ?? 0),
				);
				const initial = await first.refresh(301_000);
				expect(initial).toMatchObject({
					status: "error",
					sample: null,
					error: expectedError,
				});
				expect(attempts).toBe(3);
				expect(server.received).toBe(failure.code === "network" ? 1 : 3);
				const published = JSON.stringify([stale, initial, logged]);
				expect(published.includes(credential)).toBe(false);
				expect(published.includes(providerText)).toBe(false);
				expect(published.includes("fixture-account")).toBe(false);
				expect(logged.length).toBe(0);
			} finally {
				previous.coordinator.dispose();
				first.coordinator.dispose();
				for (const spy of spies) spy.mockRestore();
				await server.close();
			}
		});
	}

	test("refuses redirects to a second origin without forwarding any credential", async () => {
		let forwarded = false;
		const destination = await listener((request, response) => {
			forwarded ||= request.headers.authorization !== undefined;
			response.end(json);
		});
		let redirect = false;
		const server = await listener((_request, response) => {
			if (redirect) response.writeHead(302, { Location: destination.url });
			response.end(json);
		});
		const adapter = createPixellabQuotaAdapter({ fetch: server.fetch });
		const previous = cache(adapter, randomUUID());
		const first = cache(adapter, randomUUID());
		try {
			const success = await previous.refresh(1_000);
			redirect = true;
			const stale = await previous.refresh(301_000);
			expect(stale).toMatchObject({
				status: "stale",
				staleReason: "refresh_error",
				sample: success.sample,
				error: { code: "http", httpStatus: 302, retryAfterAt: null },
			});
			expect(await first.refresh(1_000)).toMatchObject({
				status: "error",
				sample: null,
				error: { code: "http", httpStatus: 302, retryAfterAt: null },
			});
			expect(server.received).toBe(3);
			expect(destination.received).toBe(0);
			expect(forwarded).toBe(false);
		} finally {
			previous.coordinator.dispose();
			first.coordinator.dispose();
			await server.close();
			await destination.close();
		}
	});

	test("the bounded reader times out without replacing old data or creating a first sample", async () => {
		let stall = false;
		const server = await listener((_request, response) => {
			if (!stall) response.end(json);
			else response.on("close", () => response.end());
		});
		const adapter = createPixellabQuotaAdapter({ fetch: server.fetch });
		const previous = cache(adapter, randomUUID());
		const first = cache(adapter, randomUUID());
		try {
			const success = await previous.refresh(1_000);
			stall = true;
			const [stale, initial] = await Promise.all([
				previous.refresh(301_000),
				first.refresh(301_000),
			]);
			expect(stale).toMatchObject({
				status: "stale",
				staleReason: "refresh_error",
				sample: success.sample,
				error: { code: "timeout", httpStatus: null, retryAfterAt: null },
			});
			expect(initial).toMatchObject({
				status: "error",
				sample: null,
				error: { code: "timeout", httpStatus: null, retryAfterAt: null },
			});
			expect(server.received).toBe(3);
		} finally {
			previous.coordinator.dispose();
			first.coordinator.dispose();
			await server.close();
		}
	}, 25_000);

	test("keeps two account factories, readers, credentials, samples and failures independent", async () => {
		const credentials = [randomUUID(), randomUUID()];
		const references: Record<string, string | undefined> = {
			"fixture-a": credentials[0],
			"fixture-b": credentials[1],
		};
		let failFirst = false;
		const calls = [0, 0];
		const server = await listener((request, response) => {
			const account = credentials.findIndex(
				(credential) =>
					request.headers.authorization === `Bearer ${credential}`,
			);
			if (account < 0) {
				response.writeHead(401);
				response.end();
				return;
			}
			calls[account] = (calls[account] ?? 0) + 1;
			if (account === 0 && failFirst) {
				response.writeHead(401);
				response.end();
				return;
			}
			response.end(
				changed((value) => {
					value.credits.usd = account === 0 ? 11 : 22;
				}),
			);
		});
		const real = createPixellabQuotaAdapter({ fetch: server.fetch });
		const readers: ServiceQuotaReader[] = [];
		const bound: string[] = [];
		const adapter: ServiceQuotaAdapterDefinition = {
			id: real.id,
			createReader(context) {
				bound.push(context.credential);
				const reader = real.createReader(context);
				readers.push(reader);
				context.credential = randomUUID();
				return reader;
			},
		};
		let now = 1_000;
		let settled = Promise.withResolvers<void>();
		let coordinator: ServiceQuotaCoordinator | undefined;
		coordinator = createServiceQuotaCoordinator({
			sources: [source("a"), source("b")],
			registry: new Map([[adapter.id, adapter]]),
			resolveCredential: (reference) => references[reference],
			now: () => now,
			onChange: () => {
				if (
					coordinator
						?.getState()
						.every(
							(entry) =>
								entry.lastAttemptAt === now || entry.nextAttemptAt === null,
						)
				)
					settled.resolve();
			},
		});
		try {
			expect(readers.length).toBe(2);
			expect(readers[0] === readers[1]).toBe(false);
			expect(bound[0] === credentials[0] && bound[1] === credentials[1]).toBe(
				true,
			);
			references["fixture-a"] = randomUUID();
			references["fixture-b"] = randomUUID();
			coordinator.checkDue();
			await settled.promise;
			const original = coordinator.getState();
			expect(
				original.map((entry) => ({
					id: entry.id,
					sample: entry.sample,
					status: entry.status,
				})),
			).toEqual([
				{
					id: "a",
					status: "ok",
					sample: { observedAt: 1_000, metrics: metrics(11) },
				},
				{
					id: "b",
					status: "ok",
					sample: { observedAt: 1_000, metrics: metrics(22) },
				},
			]);
			failFirst = true;
			now = 301_000;
			settled = Promise.withResolvers<void>();
			coordinator.checkDue();
			await settled.promise;
			const state = coordinator.getState();
			expect(state[0]).toMatchObject({
				id: "a",
				status: "stale",
				sample: original[0]?.sample,
				nextAttemptAt: null,
				error: { code: "authentication" },
			});
			expect(state[1]).toMatchObject({
				id: "b",
				status: "ok",
				sample: { observedAt: 301_000, metrics: metrics(22) },
				nextAttemptAt: 601_000,
				error: null,
			});
			expect(calls).toEqual([2, 2]);
			for (let i = 0; i < 10; i++) coordinator.checkDue();
			expect(server.received).toBe(4);
			expect(readers.length).toBe(2);
			now = 601_000;
			settled = Promise.withResolvers<void>();
			coordinator.checkDue();
			await settled.promise;
			expect(calls).toEqual([2, 3]);
			expect(coordinator.getState()[0]).toEqual(state[0]);
			expect(coordinator.getState()[1]).toMatchObject({
				status: "ok",
				lastAttemptAt: 601_000,
				nextAttemptAt: 901_000,
				sample: { observedAt: 601_000, metrics: metrics(22) },
			});
			const serialized = JSON.stringify(state);
			for (const credential of credentials)
				expect(serialized.includes(credential)).toBe(false);
			expect(serialized.includes("credentialEnv")).toBe(false);
			expect(serialized.includes("fixture-a")).toBe(false);
			expect(serialized.includes("fixture-b")).toBe(false);
		} finally {
			coordinator.dispose();
			await server.close();
		}
	});

	test("missing credentials create no reader and cause zero requests", async () => {
		const server = await listener((_request, response) => response.end(json));
		const adapter = createPixellabQuotaAdapter({ fetch: server.fetch });
		const factory = spyOn(adapter, "createReader");
		const coordinator = createServiceQuotaCoordinator({
			sources: [source("missing")],
			registry: new Map([[adapter.id, adapter]]),
			resolveCredential: () => undefined,
		});
		try {
			for (let i = 0; i < 10; i++) coordinator.checkDue();
			expect(coordinator.getState()).toMatchObject([
				{
					id: "missing",
					status: "unconfigured",
					sample: null,
					error: { code: "configuration" },
				},
			]);
			expect(factory).not.toHaveBeenCalled();
			expect(server.received).toBe(0);
		} finally {
			coordinator.dispose();
			factory.mockRestore();
			await server.close();
		}
	});

	test("the built-in registry contains a real reader without activating any source", async () => {
		const server = await listener((_request, response) => response.end(json));
		const nativeFetch = globalThis.fetch;
		const route = spyOn(globalThis, "fetch").mockImplementation(
			transport((input, init) => {
				expect(input).toBe(endpoint);
				expect(init?.method).toBe("GET");
				return nativeFetch(server.url, init);
			}),
		);
		try {
			const adapter = builtInServiceQuotaAdapters.get("pixellab-v2");
			expect(adapter?.id).toBe("pixellab-v2");
			if (!adapter) throw new Error("Missing built-in PixelLab adapter");
			const reader = adapter.createReader({ credential: randomUUID() });
			expect(server.received).toBe(0);
			expect(await reader.read({ signal: signal() })).toEqual({
				ok: true,
				metrics: metrics(),
			});
			expect(server.received).toBe(1);
		} finally {
			route.mockRestore();
			await server.close();
		}
	});

	test("finite provider values preserve exact numbers, unknowns and stable units", async () => {
		let body = json;
		const server = await listener((_request, response) => response.end(body));
		try {
			const reader = createPixellabQuotaAdapter({
				fetch: server.fetch,
			}).createReader({ credential: randomUUID() });
			const finite = fc.double({ noNaN: true, noDefaultInfinity: true });
			await fc.assert(
				fc.asyncProperty(
					finite,
					finite,
					finite,
					fc.string({ maxLength: 256 }),
					fc.option(fc.string({ maxLength: 256 }), { nil: null }),
					async (usd, generations, total, status, plan) => {
						body = JSON.stringify({
							credits: { usd },
							subscription: { generations, total, status, plan },
						});
						const result = await reader.read({ signal: signal() });
						// JSON normalizes negative zero; all other finite values round-trip exactly.
						expect(result).toEqual({
							ok: true,
							metrics: metrics(
								usd === 0 ? 0 : usd,
								generations === 0 ? 0 : generations,
								total === 0 ? 0 : total,
								status,
								plan,
							),
						});
					},
				),
			);
		} finally {
			await server.close();
		}
	});

	test("invalid boundary values always reject both metrics", async () => {
		let body = json;
		const server = await listener((_request, response) => response.end(body));
		try {
			const reader = createPixellabQuotaAdapter({
				fetch: server.fetch,
			}).createReader({ credential: randomUUID() });
			const invalidNumber = fc
				.tuple(
					fc.constantFrom("usd", "generations", "total"),
					fc.double({ noNaN: true, noDefaultInfinity: true }),
				)
				.map(([field, value]) =>
					changed((response) => {
						response[field === "usd" ? "credits" : "subscription"][field] =
							String(value);
					}),
				);
			const overflowString = fc
				.tuple(
					fc.constantFrom("status", "plan"),
					fc.integer({ min: 257, max: 512 }),
				)
				.map(([field, length]) =>
					changed((response) => {
						response.subscription[field] = "a".repeat(length);
					}),
				);
			const nonFinite = fc
				.tuple(
					fc.constantFrom("usd", "generations", "total"),
					fc.integer({ min: 309, max: 9999 }),
					fc.boolean(),
				)
				.map(([field, exponent, negative]) =>
					json.replace(
						new RegExp(`("${field}":)[^,}]+`),
						`$1${negative ? "-" : ""}1e${exponent}`,
					),
				);
			await fc.assert(
				fc.asyncProperty(
					fc.oneof(invalidNumber, overflowString, nonFinite),
					async (invalid) => {
						body = invalid;
						expect(await reader.read({ signal: signal() })).toEqual({
							ok: false,
							error: {
								code: "invalid_response",
								httpStatus: 200,
								retryAfterAt: null,
							},
						});
					},
				),
			);
		} finally {
			await server.close();
		}
	});
});
