import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { gzipSync } from "node:zlib";
import { createServiceQuotaHttpReader } from "./serviceQuotaHttp.ts";
import {
	createServiceQuotaCoordinator,
	type ServiceQuotaCoordinator,
} from "./serviceQuotas.ts";
import fc from "./test/properties.ts";
import type {
	ServiceQuotaAdapterDefinition,
	ServiceQuotaMetric,
	ServiceQuotaReadError,
	ServiceQuotaReadResult,
	ServiceQuotaSourceConfig,
} from "./types.ts";

const endpoint = "https://quota.example.test/v2/balance";
const metrics: readonly [Extract<ServiceQuotaMetric, { kind: "balance" }>] = [
	{
		id: "credits",
		label: "Credits",
		kind: "balance",
		unit: { kind: "count", name: "credits" },
		remaining: 10.5,
		reportedTotal: null,
		resetsAt: null,
		providerStatus: null,
		plan: null,
	},
];
const json = JSON.stringify(metrics);
const decode = (body: unknown): unknown => body;
const signal = () => new AbortController().signal;
const error = (
	code: ServiceQuotaReadError["code"],
	httpStatus: number | null,
	retryAfterAt: number | null = null,
): Extract<ServiceQuotaReadResult, { ok: false }> => ({
	ok: false,
	error: { code, httpStatus, retryAfterAt },
});

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
		fetch: transport((_input, init) => globalThis.fetch(url, init)),
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
		adapterId: "fixture",
		label: id,
		credentialEnv: `fixture-${id}`,
	};
}

describe("service quota HTTP reader", () => {
	test("sends the fixed HTTPS GET, bound bearer and Accept header without a body", async () => {
		const credential = randomUUID();
		const received = Promise.withResolvers<{
			method: string | undefined;
			url: string | undefined;
			authorization: string | undefined;
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
					url: request.url,
					authorization: request.headers.authorization,
					accept: request.headers.accept,
					body,
				});
				response.end(json);
			});
		});
		try {
			const reader = createServiceQuotaHttpReader({
				endpoint,
				credential,
				decode,
				fetch: transport((input, init) => {
					expect(input).toBe(endpoint);
					expect(init?.method).toBe("GET");
					expect(init?.body).toBeUndefined();
					expect(init?.redirect).toBe("manual");
					return server.fetch(input, init);
				}),
			});
			expect(await reader.read({ signal: signal() })).toEqual({
				ok: true,
				metrics,
			});
			expect(await received.promise).toEqual({
				method: "GET",
				url: "/v2/balance",
				authorization: `Bearer ${credential}`,
				accept: "application/json",
				body: "",
			});
			expect(server.received).toBe(1);
		} finally {
			await server.close();
		}
	});

	test("rejects unsafe endpoints without a request or credential disclosure", () => {
		const credential = randomUUID();
		for (const invalid of [
			"not a URL",
			"http://quota.example.test/balance",
			"https://@quota.example.test/balance",
			`https://${credential}@quota.example.test/balance`,
			`https://user:${credential}@quota.example.test/balance`,
			`${endpoint}#fragment`,
			`${endpoint}#`,
		]) {
			expect(() =>
				createServiceQuotaHttpReader({ endpoint: invalid, credential, decode }),
			).toThrow("Invalid service quota endpoint");
		}
	});

	test("rejects malformed JSON and invalid whole normalized snapshots", async () => {
		for (const contents of [
			"{",
			"null",
			"{}",
			JSON.stringify([...metrics, ...metrics]),
		]) {
			const server = await listener((_request, response) =>
				response.end(contents),
			);
			try {
				const reader = createServiceQuotaHttpReader({
					endpoint,
					credential: randomUUID(),
					decode,
					fetch: server.fetch,
				});
				expect(await reader.read({ signal: signal() })).toEqual(
					error("invalid_response", 200),
				);
			} finally {
				await server.close();
			}
		}
	});

	test("accepts the exact 64 KiB streamed boundary and rejects one extra byte", async () => {
		for (const bytes of [65_536, 65_537]) {
			const contents = json + " ".repeat(bytes - Buffer.byteLength(json));
			const server = await listener((_request, response) => {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.write(contents.slice(0, 32_768));
				response.end(contents.slice(32_768));
			});
			try {
				const reader = createServiceQuotaHttpReader({
					endpoint,
					credential: randomUUID(),
					decode,
					fetch: server.fetch,
				});
				expect(await reader.read({ signal: signal() })).toEqual(
					bytes === 65_536
						? { ok: true, metrics }
						: error("invalid_response", 200),
				);
			} finally {
				await server.close();
			}
		}
	});

	test("counts decompressed UTF-8 bytes instead of compressed bytes or UTF-16 units", async () => {
		const contents = JSON.stringify({ metrics, padding: "é".repeat(33_000) });
		expect(contents.length).toBeLessThan(65_536);
		expect(Buffer.byteLength(contents)).toBeGreaterThan(65_536);
		for (const compressed of [false, true]) {
			const payload = compressed ? gzipSync(contents) : Buffer.from(contents);
			if (compressed) expect(payload.byteLength).toBeLessThan(65_536);
			const server = await listener((_request, response) => {
				response.writeHead(
					200,
					compressed ? { "Content-Encoding": "gzip" } : {},
				);
				response.end(payload);
			});
			let decoded = false;
			try {
				const reader = createServiceQuotaHttpReader({
					endpoint,
					credential: randomUUID(),
					fetch: server.fetch,
					decode: () => {
						decoded = true;
						return metrics;
					},
				});
				expect(await reader.read({ signal: signal() })).toEqual(
					error("invalid_response", 200),
				);
				expect(decoded).toBe(false);
			} finally {
				await server.close();
			}
		}
	});

	test("cancels an oversized stream without waiting for EOF", async () => {
		const cancelled = Promise.withResolvers<void>();
		let chunks = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (chunks < 2) {
					controller.enqueue(new Uint8Array(chunks === 0 ? 32_768 : 32_769));
					chunks++;
				}
			},
			cancel() {
				cancelled.resolve();
			},
		});
		const reader = createServiceQuotaHttpReader({
			endpoint,
			credential: randomUUID(),
			decode,
			fetch: transport(async () => new Response(stream)),
		});
		expect(await reader.read({ signal: signal() })).toEqual(
			error("invalid_response", 200),
		);
		await cancelled.promise;
		expect(chunks).toBe(2);
	});

	test("never follows 301, 302, 307 or 308 redirects", async () => {
		const target = await listener((_request, response) => response.end(json));
		try {
			for (const status of [301, 302, 307, 308]) {
				const server = await listener((_request, response) => {
					response.writeHead(status, { Location: target.url });
					response.end();
				});
				try {
					const reader = createServiceQuotaHttpReader({
						endpoint,
						credential: randomUUID(),
						decode,
						fetch: server.fetch,
					});
					expect(await reader.read({ signal: signal() })).toEqual(
						error("http", status),
					);
					expect(server.received).toBe(1);
					expect(target.received).toBe(0);
				} finally {
					await server.close();
				}
			}
		} finally {
			await target.close();
		}
	});

	test("classifies status errors without reading or publishing their bodies", async () => {
		const credential = randomUUID();
		for (const [status, code] of [
			[401, "authentication"],
			[403, "authentication"],
			[429, "rate_limit"],
			[500, "http"],
			[404, "http"],
		] as const) {
			const server = await listener((_request, response) => {
				response.writeHead(status, { "Retry-After": "600" });
				response.flushHeaders();
				response.write(credential);
				// No EOF: an error response must not wait for its body.
				response.on("close", () => response.end());
			});
			try {
				const reader = createServiceQuotaHttpReader({
					endpoint,
					credential,
					decode,
					fetch: server.fetch,
					now: () => 1_000,
				});
				expect(await reader.read({ signal: signal() })).toEqual(
					error(code, status, status === 429 ? 601_000 : null),
				);
			} finally {
				await server.close();
			}
		}
	});

	test("accepts integer and HTTP-date retries and ignores invalid headers", async () => {
		const now = Date.UTC(2026, 0, 1);
		for (const [header, expected] of [
			["900", now + 900_000],
			[new Date(now + 900_000).toUTCString(), now + 900_000],
			["Thursday, 01-Jan-26 00:15:00 GMT", now + 900_000],
			["Thu Jan  1 00:15:00 2026", now + 900_000],
			["0", now],
			["-1", null],
			["1.5", null],
			["1e3", null],
			["tomorrow", null],
			["2026-01-01", null],
			["Tue, 31 Feb 2026 00:00:00 GMT", null],
			["Thu, 01 Jan 2026 24:00:00 GMT", null],
			["99999999999999999999999999999", null],
		] as const) {
			const server = await listener((_request, response) => {
				response.writeHead(429, { "Retry-After": header });
				response.end();
			});
			try {
				const reader = createServiceQuotaHttpReader({
					endpoint,
					credential: randomUUID(),
					decode,
					fetch: server.fetch,
					now: () => now,
				});
				expect(await reader.read({ signal: signal() })).toEqual(
					error("rate_limit", 429, expected),
				);
			} finally {
				await server.close();
			}
		}
	});

	test("retry seconds obey exact integer arithmetic through the public reader", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 2_000_000_000 }),
				fc.integer({ min: 0, max: 2_000_000_000 }),
				async (seconds, now) => {
					const reader = createServiceQuotaHttpReader({
						endpoint,
						credential: randomUUID(),
						decode,
						now: () => now,
						fetch: transport(
							async () =>
								new Response(null, {
									status: 429,
									headers: { "Retry-After": String(seconds) },
								}),
						),
					});
					expect(await reader.read({ signal: signal() })).toEqual(
						error("rate_limit", 429, now + seconds * 1000),
					);
				},
			),
		);
	});

	test("a pre-aborted read makes no transport request", async () => {
		const server = await listener((_request, response) => response.end(json));
		const fixedEndpoint = server.url.replace("http:", "https:");
		let requests = 0;
		const reader = createServiceQuotaHttpReader({
			endpoint: fixedEndpoint,
			credential: randomUUID(),
			decode,
			fetch: transport((input, init) => {
				requests++;
				expect(input).toBe(fixedEndpoint);
				return server.fetch(input, init);
			}),
		});
		try {
			const controller = new AbortController();
			controller.abort();
			expect(await reader.read({ signal: controller.signal })).toEqual(
				error("network", null),
			);
			expect(requests).toBe(0);
			expect(server.received).toBe(0);
			expect(await reader.read({ signal: signal() })).toEqual({
				ok: true,
				metrics,
			});
			expect(requests).toBe(1);
			expect(server.received).toBe(1);
		} finally {
			await server.close();
		}
	});

	test("returns safe network, body and decoder errors without exception text or logs", async () => {
		const credential = randomUUID();
		const providerText = randomUUID();
		let status = 200;
		const server = await listener((_request, response) => {
			response.writeHead(status);
			response.end(status === 200 ? json : `${providerText}: ${credential}`);
		});
		const logged: unknown[][] = [];
		const spies = (["log", "warn", "error"] as const).map((method) =>
			spyOn(console, method).mockImplementation((...args: unknown[]) => {
				logged.push(args);
			}),
		);
		try {
			const network = createServiceQuotaHttpReader({
				endpoint,
				credential,
				decode,
				fetch: transport(async () => {
					throw new Error(`${providerText}: ${credential}`);
				}),
			});
			expect(await network.read({ signal: signal() })).toEqual(
				error("network", null),
			);
			const reader = createServiceQuotaHttpReader({
				endpoint,
				credential,
				fetch: server.fetch,
				decode: () => {
					throw new Error(`${providerText}: ${credential}`);
				},
			});
			expect(await reader.read({ signal: signal() })).toEqual(
				error("internal", 200),
			);
			status = 500;
			expect(await reader.read({ signal: signal() })).toEqual(
				error("http", 500),
			);
			expect(server.received).toBe(2);
			expect(logged).toEqual([]);
			expect(JSON.stringify(logged)).not.toContain(credential);
			expect(JSON.stringify(logged)).not.toContain(providerText);
		} finally {
			for (const spy of spies) spy.mockRestore();
			await server.close();
		}
	});

	test("caller abort interrupts both headers and body", async () => {
		for (const headers of [false, true]) {
			const requested = Promise.withResolvers<void>();
			const responseReceived = Promise.withResolvers<void>();
			const closed = Promise.withResolvers<void>();
			const server = await listener((_request, response) => {
				response.on("close", () => {
					response.end();
					closed.resolve();
				});
				if (headers) {
					response.writeHead(200);
					response.flushHeaders();
					response.write("[");
				}
				requested.resolve();
			});
			const controller = new AbortController();
			try {
				const reader = createServiceQuotaHttpReader({
					endpoint,
					credential: randomUUID(),
					decode,
					fetch: transport(async (input, init) => {
						const response = await server.fetch(input, init);
						responseReceived.resolve();
						return response;
					}),
				});
				const result = reader.read({ signal: controller.signal });
				await requested.promise;
				if (headers) await responseReceived.promise;
				controller.abort(new Error(randomUUID()));
				expect(await result).toMatchObject({
					ok: false,
					error: { code: "network", retryAfterAt: null },
				});
				await closed.promise;
			} finally {
				controller.abort();
				await server.close();
			}
		}
	});

	test("one real ten-second deadline covers delayed headers and delayed body", async () => {
		// Real socket phases must share the production deadline; fake timers do not drive the fetch platform clock.
		const requested = Promise.withResolvers<void>();
		const headersReceived = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const server = await listener((_request, response) => {
			requested.resolve();
			let bodyTimer: NodeJS.Timeout | undefined;
			const headerTimer = setTimeout(() => {
				response.writeHead(200);
				response.flushHeaders();
				response.write(json.slice(0, 1));
				bodyTimer = setTimeout(() => response.end(json.slice(1)), 6_000);
			}, 6_000);
			response.on("close", () => {
				clearTimeout(headerTimer);
				clearTimeout(bodyTimer);
				response.end();
				closed.resolve();
			});
		});
		try {
			const reader = createServiceQuotaHttpReader({
				endpoint,
				credential: randomUUID(),
				decode,
				fetch: transport(async (input, init) => {
					const response = await server.fetch(input, init);
					headersReceived.resolve();
					return response;
				}),
			});
			const start = performance.now();
			const result = reader.read({ signal: signal() });
			await requested.promise;
			await headersReceived.promise;
			expect(await result).toEqual(error("timeout", 200));
			expect(performance.now() - start).toBeGreaterThanOrEqual(9_900);
			await closed.promise;
		} finally {
			await server.close();
		}
	}, 25_000);

	test("a missing server secret sends no request through the trusted HTTP adapter", async () => {
		const server = await listener((_request, response) => response.end(json));
		// The seeded HTTPS URL has this listener's host and port; only the injected route changes its scheme.
		const fixedEndpoint = server.url.replace("http:", "https:");
		let credential: string | undefined;
		const completed = Promise.withResolvers<void>();
		const adapter: ServiceQuotaAdapterDefinition = {
			id: "fixture",
			createReader: ({ credential }) =>
				createServiceQuotaHttpReader({
					endpoint: fixedEndpoint,
					credential,
					decode,
					fetch: server.fetch,
				}),
		};
		let coordinator: ServiceQuotaCoordinator | undefined;
		coordinator = createServiceQuotaCoordinator({
			sources: [source("missing")],
			registry: new Map([[adapter.id, adapter]]),
			resolveCredential: () => credential,
			onChange: () => {
				if (coordinator?.getState()[0]?.status === "ok") completed.resolve();
			},
		});
		try {
			coordinator.checkDue();
			for (let i = 0; i < 20; i++)
				expect(coordinator.getState()[0]?.status).toBe("unconfigured");
			expect(server.received).toBe(0);
			credential = randomUUID();
			coordinator.rebind(source("missing"));
			coordinator.checkDue();
			await completed.promise;
			expect(coordinator.getState()[0]?.sample?.metrics).toEqual(metrics);
			expect(server.received).toBe(1);
		} finally {
			coordinator.dispose();
			await server.close();
		}
	});

	test("real coordinator reads bind separate accounts and state reads use only the cache", async () => {
		const credentials = [randomUUID(), randomUUID()];
		const accounts: Record<string, number> = {
			[`Bearer ${credentials[0]}`]: 11,
			[`Bearer ${credentials[1]}`]: 22,
		};
		const server = await listener((request, response) => {
			const remaining = accounts[request.headers.authorization ?? ""];
			if (remaining === undefined) {
				response.writeHead(401);
				response.end();
				return;
			}
			response.end(JSON.stringify([{ ...metrics[0], remaining }]));
		});
		const settled = Promise.withResolvers<void>();
		const adapter: ServiceQuotaAdapterDefinition = {
			id: "fixture",
			createReader: ({ credential }) =>
				createServiceQuotaHttpReader({
					endpoint,
					credential,
					decode,
					fetch: server.fetch,
				}),
		};
		const references: Record<string, string | undefined> = {
			"fixture-a": credentials[0],
			"fixture-b": credentials[1],
		};
		let coordinator: ServiceQuotaCoordinator | undefined;
		coordinator = createServiceQuotaCoordinator({
			sources: [source("a"), source("b")],
			registry: new Map([[adapter.id, adapter]]),
			resolveCredential: (reference) => references[reference],
			now: () => 1_000,
			onChange: () => {
				if (coordinator?.getState().every((entry) => entry.status === "ok"))
					settled.resolve();
			},
		});
		try {
			expect(server.received).toBe(0);
			references["fixture-a"] = randomUUID();
			references["fixture-b"] = randomUUID();
			coordinator.checkDue();
			await settled.promise;
			const state = coordinator.getState();
			expect(
				state.map((entry) => ({
					id: entry.id,
					status: entry.status,
					metrics: entry.sample?.metrics,
				})),
			).toEqual([
				{ id: "a", status: "ok", metrics: [{ ...metrics[0], remaining: 11 }] },
				{ id: "b", status: "ok", metrics: [{ ...metrics[0], remaining: 22 }] },
			]);
			for (let i = 0; i < 20; i++) {
				expect(coordinator.getState()).toEqual(state);
				coordinator.checkDue();
			}
			expect(server.received).toBe(2);
			for (const credential of credentials)
				expect(JSON.stringify(state)).not.toContain(credential);
			expect(JSON.stringify(state)).not.toContain("credentialEnv");
		} finally {
			coordinator.dispose();
			await server.close();
		}
	});
});
