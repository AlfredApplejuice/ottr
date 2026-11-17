import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	createServiceQuotaCoordinator,
	type ServiceQuotaCoordinator,
	validateServiceQuotaMetrics,
} from "./serviceQuotas.ts";
import fc from "./test/properties.ts";
import type {
	ServiceQuotaMetric,
	ServiceQuotaReadError,
	ServiceQuotaReadResult,
	ServiceQuotaSourceConfig,
	ServiceQuotaSourceState,
} from "./types.ts";

const INTERVAL = 300_000;
const START = 1_800_000_000_000;
const source = (id = "account-a"): ServiceQuotaSourceConfig => ({
	id,
	adapterId: "synthetic",
	label: "anthropic",
	credentialEnv: `SERVER_${id}`,
});
const balance = (
	id = "credits",
	remaining = 10.5,
): Extract<ServiceQuotaMetric, { kind: "balance" }> => ({
	id,
	label: "anthropic",
	unit: { kind: "currency", code: "USD" },
	kind: "balance",
	remaining,
	reportedTotal: null,
	resetsAt: null,
	providerStatus: null,
	plan: null,
});
const windowMetric = (): Extract<ServiceQuotaMetric, { kind: "window" }> => ({
	id: "requests",
	label: "Requests",
	unit: { kind: "count", name: "requests" },
	kind: "window",
	used: 12.5,
	limit: 0,
	startsAt: null,
	resetsAt: null,
});
const success = (
	metrics: readonly ServiceQuotaMetric[] = [balance(), windowMetric()],
): ServiceQuotaReadResult => ({ ok: true, metrics });
const failure = (
	code: ServiceQuotaReadError["code"],
	httpStatus: number | null = null,
	retryAfterAt: number | null = null,
): ServiceQuotaReadResult => ({
	ok: false,
	error: { code, httpStatus, retryAfterAt },
});

function fixture<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Required fixture is absent");
	return value;
}

function harness(sources = [source()]) {
	let clock = START;
	let changes = 0;
	const credentials = new Map(
		sources.map((s) => [s.credentialEnv, randomUUID()]),
	);
	const resolutions: string[] = [];
	const readers: { credential: string }[] = [];
	const attempts: {
		reader: number;
		signal: AbortSignal;
		resolve: (value: unknown) => void;
		reject: (reason: unknown) => void;
	}[] = [];
	const coordinator = createServiceQuotaCoordinator({
		sources,
		registry: new Map([
			[
				"synthetic",
				{
					id: "synthetic",
					createReader({ credential }) {
						const index = readers.push({ credential }) - 1;
						return {
							read({ signal }) {
								const deferred = Promise.withResolvers<unknown>();
								attempts.push({
									reader: index,
									signal,
									resolve: deferred.resolve,
									reject: deferred.reject,
								});
								// The synthetic reader tests validation of untrusted adapter results.
								return deferred.promise as Promise<ServiceQuotaReadResult>;
							},
						};
					},
				},
			],
		]),
		resolveCredential(reference) {
			resolutions.push(reference);
			return credentials.get(reference);
		},
		now: () => clock,
		onChange: () => {
			changes++;
		},
	});
	return {
		coordinator,
		credentials,
		resolutions,
		readers,
		attempts,
		at(value: number) {
			clock = value;
		},
		changes: () => changes,
		async finish(index: number, result: unknown = success()) {
			fixture(attempts[index]).resolve(result);
			await Promise.resolve();
		},
	};
}

describe("service quota validation", () => {
	test("copies known fields and preserves signed, fractional balances and raw windows", () => {
		const input = [
			{
				...balance("money", -2.25),
				reportedTotal: -10.75,
				providerStatus: "unrecognized",
				plan: "Tier",
				raw: randomUUID(),
			},
			windowMetric(),
		];
		const result = validateServiceQuotaMetrics(input);
		expect(result).toEqual([
			{
				...balance("money", -2.25),
				reportedTotal: -10.75,
				providerStatus: "unrecognized",
				plan: "Tier",
			},
			windowMetric(),
		]);
		fixture(input[0]).unit = { kind: "currency", code: "EUR" };
		expect(fixture(result?.[0]).unit).toEqual({
			kind: "currency",
			code: "USD",
		});
		expect(
			validateServiceQuotaMetrics([{ ...windowMetric(), limit: 10 }]),
		).not.toBeNull();
		expect(validateServiceQuotaMetrics([])).toEqual([]);
	});

	test("rejects whole snapshots, duplicate IDs, unknown kinds and missing nulls", () => {
		for (const input of [
			null,
			{},
			"metrics",
			[balance(), balance()],
			[{ ...balance(), kind: "other" }],
		])
			expect(validateServiceQuotaMetrics(input)).toBeNull();
		for (const key of ["reportedTotal", "resetsAt", "providerStatus", "plan"]) {
			const invalid = { ...balance() } as Record<string, unknown>;
			delete invalid[key];
			expect(validateServiceQuotaMetrics([invalid])).toBeNull();
		}
		for (const key of ["used", "limit", "startsAt", "resetsAt"]) {
			const invalid = { ...windowMetric() } as Record<string, unknown>;
			delete invalid[key];
			expect(validateServiceQuotaMetrics([invalid])).toBeNull();
		}
		const invalid = { ...balance("second"), remaining: "12" };
		expect(validateServiceQuotaMetrics([balance(), invalid])).toBeNull();
		expect(validateServiceQuotaMetrics([invalid, balance()])).toBeNull();
		expect(
			validateServiceQuotaMetrics(
				[{ ...balance(), unit: { kind: "currency", code: "EUR" } }],
				[balance()],
			),
		).toBeNull();
		expect(
			validateServiceQuotaMetrics(
				[{ ...balance(), unit: { kind: "count", name: "USD" } }],
				[balance()],
			),
		).toBeNull();
	});

	test("enforces 32 metrics and UTF-16 display limits without truncation", () => {
		const metrics = Array.from({ length: 32 }, (_, i) => balance(String(i)));
		expect(validateServiceQuotaMetrics(metrics)).toHaveLength(32);
		expect(validateServiceQuotaMetrics([...metrics, balance("33")])).toBeNull();
		for (const field of ["id", "label", "providerStatus", "plan"]) {
			expect(
				validateServiceQuotaMetrics([
					{ ...balance(), [field]: "x".repeat(256) },
				]),
			).not.toBeNull();
			expect(
				validateServiceQuotaMetrics([
					{ ...balance(), [field]: "😀".repeat(129) },
				]),
			).toBeNull();
		}
		for (const unit of [
			{ kind: "currency", code: "x".repeat(257) },
			{ kind: "count", name: "x".repeat(257) },
		])
			expect(validateServiceQuotaMetrics([{ ...balance(), unit }])).toBeNull();
	});

	test("properties preserve every finite balance and explicit unknowns", () => {
		fc.assert(
			fc.property(
				fc.double({ noNaN: true, noDefaultInfinity: true }),
				fc.option(fc.double({ noNaN: true, noDefaultInfinity: true }), {
					nil: null,
				}),
				(remaining, reportedTotal) => {
					const metric = { ...balance("money", remaining), reportedTotal };
					expect(validateServiceQuotaMetrics([metric])).toEqual([metric]);
				},
			),
		);
		for (const bad of [NaN, Infinity, -Infinity, "1", null, undefined]) {
			expect(
				validateServiceQuotaMetrics([{ ...balance(), remaining: bad }]),
			).toBeNull();
			if (bad !== null)
				expect(
					validateServiceQuotaMetrics([{ ...balance(), reportedTotal: bad }]),
				).toBeNull();
			expect(
				validateServiceQuotaMetrics([{ ...windowMetric(), used: bad }]),
			).toBeNull();
			expect(
				validateServiceQuotaMetrics([{ ...windowMetric(), limit: bad }]),
			).toBeNull();
		}
	});

	test("properties enforce window nonnegativity and timestamp order", () => {
		fc.assert(
			fc.property(
				fc.integer(),
				fc.integer(),
				fc.integer(),
				fc.integer(),
				(used, limit, startsAt, resetsAt) => {
					const value = { ...windowMetric(), used, limit, startsAt, resetsAt };
					expect(validateServiceQuotaMetrics([value]) !== null).toBe(
						used >= 0 && limit >= 0 && startsAt < resetsAt,
					);
				},
			),
		);
		for (const timestamp of [
			0.5,
			NaN,
			Infinity,
			undefined,
			"123",
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expect(
				validateServiceQuotaMetrics([
					{ ...windowMetric(), startsAt: timestamp },
				]),
			).toBeNull();
			expect(
				validateServiceQuotaMetrics([{ ...balance(), resetsAt: timestamp }]),
			).toBeNull();
		}
	});

	test("properties enforce display caps and stable units", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 280 }),
				fc.string({ maxLength: 280 }),
				(label, code) => {
					const metric = {
						...balance(),
						label,
						unit: { kind: "currency" as const, code },
					};
					expect(validateServiceQuotaMetrics([metric]) !== null).toBe(
						label.length <= 256 && code.length <= 256,
					);
					expect(
						validateServiceQuotaMetrics([metric], [balance()]) !== null,
					).toBe(label.length <= 256 && code === "USD");
				},
			),
		);
	});
});

describe("service quota coordinator", () => {
	test("constructs bindings without reads and returns detached pending snapshots", async () => {
		const h = harness();
		expect(h.resolutions).toEqual([source().credentialEnv]);
		expect(h.attempts).toHaveLength(0);
		expect(h.coordinator.getState()).toEqual([
			{
				id: "account-a",
				adapterId: "synthetic",
				label: "anthropic",
				status: "pending",
				lastAttemptAt: null,
				nextAttemptAt: START,
				sample: null,
				error: null,
			},
		]);
		for (let i = 0; i < 10; i++) h.coordinator.getState();
		expect(h.attempts).toHaveLength(0);
		h.coordinator.checkDue();
		h.coordinator.checkDue();
		expect(h.attempts).toHaveLength(1);
		h.at(START + 123);
		await h.finish(0);
		const state = fixture(h.coordinator.getState()[0]);
		expect(state).toMatchObject({
			status: "ok",
			lastAttemptAt: START + 123,
			nextAttemptAt: START + 123 + INTERVAL,
			sample: { observedAt: START + 123 },
		});
		state.label = "changed";
		if (state.sample) {
			state.sample.observedAt = 0;
			fixture(state.sample.metrics[0]).label = "changed metric";
			fixture(state.sample.metrics[0]).unit.kind = "count";
		}
		expect(h.coordinator.getState()[0]).toMatchObject({
			label: "anthropic",
			sample: { observedAt: START + 123, metrics: [balance(), windowMetric()] },
		});
	});

	test("uses completion times and publishes freshness once while a request stays active", async () => {
		const h = harness();
		h.coordinator.checkDue();
		h.at(START + 70);
		await h.finish(0);
		h.at(START + 70 + INTERVAL - 1);
		h.coordinator.checkDue();
		expect(h.attempts).toHaveLength(1);
		expect(fixture(h.coordinator.getState()[0]).status).toBe("ok");
		h.at(START + 70 + INTERVAL);
		expect(h.coordinator.getState()[0]).toMatchObject({
			status: "stale",
			staleReason: "expired",
			error: null,
		});
		const before = h.changes();
		h.coordinator.checkDue();
		expect(h.changes()).toBe(before + 1);
		expect(h.attempts).toHaveLength(2);
		h.at(START + 2 * INTERVAL);
		h.coordinator.checkDue();
		expect(h.changes()).toBe(before + 1);
		expect(h.attempts).toHaveLength(2);
		await h.finish(1);
		expect(h.coordinator.getState()[0]).toMatchObject({
			status: "ok",
			lastAttemptAt: START + 2 * INTERVAL,
			nextAttemptAt: START + 3 * INTERVAL,
			sample: { observedAt: START + 2 * INTERVAL },
		});
	});

	for (const code of [
		"authentication",
		"rate_limit",
		"timeout",
		"network",
		"http",
		"invalid_response",
		"internal",
	] as const) {
		for (const priorSuccess of [false, true]) {
			test(`${code} ${priorSuccess ? "preserves the whole old sample" : "has no sample on first failure"}`, async () => {
				const h = harness();
				h.coordinator.checkDue();
				if (priorSuccess) {
					await h.finish(0);
					h.at(START + INTERVAL);
					h.coordinator.checkDue();
				}
				const completed = START + (priorSuccess ? INTERVAL : 0) + 99;
				h.at(completed);
				await h.finish(priorSuccess ? 1 : 0, failure(code));
				expect(h.coordinator.getState()[0]).toMatchObject({
					status: priorSuccess ? "stale" : "error",
					lastAttemptAt: completed,
					nextAttemptAt:
						code === "authentication" ? null : completed + INTERVAL,
					sample: priorSuccess
						? { observedAt: START, metrics: [balance(), windowMetric()] }
						: null,
					error: { code, httpStatus: null, retryAfterAt: null },
				});
				h.at(completed + INTERVAL - 1);
				h.coordinator.checkDue();
				expect(h.attempts).toHaveLength(priorSuccess ? 2 : 1);
			});
		}
	}

	test("rejects either invalid metric without partial updates, then recovers", async () => {
		for (const invalidFirst of [true, false]) {
			const h = harness();
			h.coordinator.checkDue();
			await h.finish(0);
			h.at(START + INTERVAL);
			h.coordinator.checkDue();
			const valid = balance("fresh", 88);
			const invalid = { ...balance("bad"), remaining: NaN };
			await h.finish(
				1,
				success(invalidFirst ? [invalid, valid] : [valid, invalid]),
			);
			expect(h.coordinator.getState()[0]).toMatchObject({
				status: "stale",
				staleReason: "refresh_error",
				sample: { observedAt: START, metrics: [balance(), windowMetric()] },
				error: { code: "invalid_response" },
			});
			h.at(START + 2 * INTERVAL);
			h.coordinator.checkDue();
			await h.finish(2, success([balance("credits", 22)]));
			expect(h.coordinator.getState()[0]).toMatchObject({
				status: "ok",
				error: null,
				sample: {
					observedAt: START + 2 * INTERVAL,
					metrics: [balance("credits", 22)],
				},
			});
		}
	});

	test("limits board concurrency and starts queued sources on completion", async () => {
		const h = harness(Array.from({ length: 6 }, (_, i) => source(String(i))));
		h.coordinator.checkDue();
		expect(h.attempts.map((a) => a.reader)).toEqual([0, 1, 2, 3]);
		expect(h.coordinator.getState()).toHaveLength(6);
		h.coordinator.checkDue();
		expect(h.attempts).toHaveLength(4);
		await h.finish(2);
		expect(h.attempts.map((a) => a.reader)).toEqual([0, 1, 2, 3, 4]);
		await h.finish(1, failure("network"));
		expect(h.attempts.map((a) => a.reader)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(h.coordinator.getState().map((s) => s.status)).toEqual([
			"pending",
			"error",
			"ok",
			"pending",
			"pending",
			"pending",
		]);
		h.coordinator.dispose();
		for (let i = 0; i < h.attempts.length; i++) await h.finish(i);
	});

	test("honors longer rate delays but not shorter hints or hints on other failures", async () => {
		for (const [code, hint, expected] of [
			["rate_limit", START + INTERVAL * 3, START + INTERVAL * 3],
			["rate_limit", START + 10, START + INTERVAL],
			["network", START + INTERVAL * 3, START + INTERVAL],
		] as const) {
			const h = harness();
			h.coordinator.checkDue();
			await h.finish(
				0,
				failure(code, code === "rate_limit" ? 429 : null, hint),
			);
			expect(fixture(h.coordinator.getState()[0]).nextAttemptAt).toBe(expected);
			h.at(expected - 1);
			h.coordinator.checkDue();
			expect(h.attempts).toHaveLength(1);
			h.at(expected);
			h.coordinator.checkDue();
			expect(h.attempts).toHaveLength(2);
		}
	});

	for (const httpStatus of [401, 403]) {
		test(`${httpStatus} pauses until explicit rebind and never rereads environment automatically`, async () => {
			const h = harness();
			const oldCredential = fixture(h.readers[0]).credential;
			h.coordinator.checkDue();
			await h.finish(0, failure("http", httpStatus));
			h.credentials.set(source().credentialEnv, randomUUID());
			h.at(START + 20 * INTERVAL);
			h.coordinator.checkDue();
			h.coordinator.setSources([source()]);
			expect(h.resolutions).toHaveLength(1);
			expect(fixture(h.readers[0]).credential).toBe(oldCredential);
			expect(h.coordinator.getState()[0]).toMatchObject({
				status: "error",
				nextAttemptAt: null,
				error: { code: "authentication", httpStatus },
			});
			h.coordinator.rebind(source());
			expect(h.coordinator.getState()[0]).toMatchObject({
				status: "pending",
				lastAttemptAt: null,
				sample: null,
				error: null,
			});
			expect(fixture(h.readers[1]).credential).toBe(
				fixture(h.credentials.get(source().credentialEnv)),
			);
			h.coordinator.checkDue();
			expect(h.attempts).toHaveLength(2);
		});
	}

	test("two accounts retain separate bindings and whole samples despite equal labels", async () => {
		const h = harness([source("a"), source("b")]);
		expect(fixture(h.readers[0]).credential).not.toBe(
			fixture(h.readers[1]).credential,
		);
		h.coordinator.checkDue();
		await h.finish(0, success([balance("same", 1)]));
		h.at(START + 90);
		await h.finish(1, success([balance("same", 2)]));
		h.at(START + INTERVAL);
		h.coordinator.checkDue();
		await h.finish(2, failure("network"));
		expect(h.coordinator.getState()).toMatchObject([
			{
				id: "a",
				status: "stale",
				sample: { observedAt: START, metrics: [balance("same", 1)] },
			},
			{
				id: "b",
				status: "ok",
				sample: { observedAt: START + 90, metrics: [balance("same", 2)] },
			},
		]);
	});

	test("preflights duplicate IDs before resolution and preserves first-position order", async () => {
		const h = harness([
			source("a"),
			source("b"),
			{ ...source("a"), credentialEnv: "OTHER_REFERENCE" },
		]);
		expect(h.resolutions).toEqual([source("b").credentialEnv]);
		expect(h.coordinator.getState().map((s) => [s.id, s.status])).toEqual([
			["a", "unconfigured"],
			["b", "pending"],
		]);
		h.coordinator.checkDue();
		await h.finish(0);
		h.coordinator.setSources([source("b"), source("a")]);
		expect(h.coordinator.getState().map((s) => [s.id, s.status])).toEqual([
			["b", "ok"],
			["a", "pending"],
		]);
		expect(h.resolutions).toEqual([
			source("b").credentialEnv,
			source("a").credentialEnv,
		]);
		h.coordinator.setSources([source("b"), source("b"), source("a")]);
		expect(h.resolutions).toHaveLength(2);
		expect(h.coordinator.getState()[0]).toMatchObject({
			id: "b",
			status: "unconfigured",
			sample: null,
		});
	});

	test("clears state and publishes before resolver and factory inspect a replacement", async () => {
		let coordinator: ServiceQuotaCoordinator | undefined;
		const observed: { phase: string; state: ServiceQuotaSourceState }[] = [];
		const credential = randomUUID();
		const inspect = (phase: string) => {
			if (!coordinator) return;
			observed.push({ phase, state: fixture(coordinator.getState()[0]) });
		};
		coordinator = createServiceQuotaCoordinator({
			sources: [source()],
			registry: new Map([
				[
					"synthetic",
					{
						id: "synthetic",
						createReader() {
							inspect("factory");
							return { read: async () => success() };
						},
					},
				],
			]),
			resolveCredential() {
				inspect("resolve");
				return credential;
			},
			now: () => START,
			onChange() {
				if (
					coordinator &&
					fixture(coordinator.getState()[0]).status === "unconfigured"
				)
					inspect("publish");
			},
		});
		coordinator.checkDue();
		await Promise.resolve();
		coordinator.rebind(source());
		expect(observed.map((entry) => entry.phase)).toEqual([
			"publish",
			"resolve",
			"factory",
		]);
		for (const entry of observed)
			expect(entry.state).toMatchObject({
				status: "unconfigured",
				lastAttemptAt: null,
				nextAttemptAt: null,
				sample: null,
				error: { code: "configuration" },
			});
		coordinator.checkDue();
		await Promise.resolve();
		observed.length = 0;
		coordinator.setSources([{ ...source(), label: "replacement" }]);
		expect(observed.map((entry) => entry.phase)).toEqual([
			"publish",
			"resolve",
			"factory",
		]);
		for (const entry of observed)
			expect(entry.state).toMatchObject({
				status: "unconfigured",
				lastAttemptAt: null,
				nextAttemptAt: null,
				sample: null,
				error: { code: "configuration" },
			});
	});

	for (const lifecycle of ["rebind", "remove/add", "setSources"] as const) {
		for (const outcome of ["success", "failure", "throw"] as const) {
			test(`${lifecycle} ignores late ${outcome} even when the reader ignores abort`, async () => {
				const h = harness();
				h.coordinator.checkDue();
				if (lifecycle === "rebind") h.coordinator.rebind(source());
				else if (lifecycle === "remove/add") {
					h.coordinator.remove(source().id);
					h.coordinator.setSources([source()]);
				} else
					h.coordinator.setSources([{ ...source(), label: "new binding" }]);
				expect(fixture(h.attempts[0]).signal.aborted).toBe(true);
				h.coordinator.checkDue();
				expect(h.attempts).toHaveLength(1);
				const changes = h.changes();
				if (outcome === "throw") {
					fixture(h.attempts[0]).reject(new Error(randomUUID()));
					await Promise.resolve();
				} else
					await h.finish(
						0,
						outcome === "success"
							? success([balance("old account", 99)])
							: failure("authentication", 401),
					);
				expect(h.coordinator.getState()[0]).toMatchObject({
					status: "pending",
					sample: null,
					error: null,
				});
				expect(h.changes()).toBe(changes);
				expect(h.attempts).toHaveLength(2);
				await h.finish(1, success([balance("new account", 5)]));
				expect(h.coordinator.getState()[0]).toMatchObject({
					status: "ok",
					sample: { metrics: [balance("new account", 5)] },
				});
			});
		}
	}

	test("obsolete attempts retain global slots as well as same-source slots", async () => {
		const h = harness([
			source("a"),
			source("b"),
			source("c"),
			source("d"),
			source("e"),
		]);
		h.coordinator.checkDue();
		h.coordinator.remove("a");
		h.coordinator.rebind(source("b"));
		h.coordinator.checkDue();
		expect(h.attempts).toHaveLength(4);
		await h.finish(0);
		expect(h.attempts).toHaveLength(5);
		expect(fixture(h.attempts[4]).reader).toBe(4);
		await h.finish(1);
		expect(h.attempts).toHaveLength(6);
		expect(fixture(h.attempts[5]).reader).toBe(5);
		h.coordinator.dispose();
		for (let i = 2; i < h.attempts.length; i++) await h.finish(i);
	});

	test("disposal is terminal and rejects every late completion and lifecycle call", async () => {
		const h = harness([
			source("a"),
			source("b"),
			source("c"),
			source("d"),
			source("e"),
		]);
		h.coordinator.checkDue();
		const changes = h.changes();
		h.coordinator.dispose();
		expect(h.coordinator.getState()).toEqual([]);
		expect(h.attempts.every((a) => a.signal.aborted)).toBe(true);
		h.coordinator.setSources([source("a")]);
		h.coordinator.rebind(source("a"));
		h.coordinator.remove("a");
		h.coordinator.checkDue();
		await h.finish(0);
		await h.finish(1, failure("network"));
		fixture(h.attempts[2]).reject(new Error(randomUUID()));
		await Promise.resolve();
		await h.finish(3);
		expect(h.attempts).toHaveLength(4);
		expect(h.changes()).toBe(changes);
		expect(h.coordinator.getState()).toEqual([]);
	});

	test("credential acceptance rejects only ASCII control code units", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 0xffff }), (code) => {
				const credential = `${randomUUID()}${String.fromCharCode(code)}`;
				let calls = 0;
				const coordinator = createServiceQuotaCoordinator({
					sources: [source()],
					registry: new Map([
						[
							"synthetic",
							{
								id: "synthetic",
								createReader() {
									calls++;
									return { read: async () => success() };
								},
							},
						],
					]),
					resolveCredential: () => credential,
				});
				const accepted = code > 31 && code !== 127;
				expect(calls).toBe(accepted ? 1 : 0);
				expect(fixture(coordinator.getState()[0]).status).toBe(
					accepted ? "pending" : "unconfigured",
				);
				coordinator.dispose();
			}),
			{ examples: [[0], [31], [32], [126], [127], [128], [0xffff]] },
		);
	});

	test("missing or invalid credentials, unknown adapters and factory errors are unconfigured", () => {
		for (const credential of [undefined, "", "   ", `${randomUUID()}\n`]) {
			let calls = 0;
			const coordinator = createServiceQuotaCoordinator({
				sources: [source()],
				registry: new Map([
					[
						"synthetic",
						{
							id: "synthetic",
							createReader() {
								calls++;
								return { read: async () => success() };
							},
						},
					],
				]),
				resolveCredential: () => credential,
			});
			coordinator.checkDue();
			expect(calls).toBe(0);
			expect(coordinator.getState()[0]).toMatchObject({
				status: "unconfigured",
				sample: null,
				error: { code: "configuration" },
			});
		}
		for (const phase of ["resolve", "factory", "unknown", "label"] as const) {
			const secret = randomUUID();
			const coordinator = createServiceQuotaCoordinator({
				sources: [
					{
						...source(),
						label: phase === "label" ? "x".repeat(257) : "anthropic",
					},
				],
				registry: new Map(
					phase === "unknown"
						? []
						: [
								[
									"synthetic",
									{
										id: "synthetic",
										createReader() {
											throw new Error(secret);
										},
									},
								],
							],
				),
				resolveCredential() {
					if (phase === "resolve") throw new Error(secret);
					return secret;
				},
			});
			coordinator.checkDue();
			expect(coordinator.getState()[0]).toMatchObject({
				id: "account-a",
				adapterId: "synthetic",
				status: "unconfigured",
				sample: null,
				error: { code: "configuration" },
			});
			expect(JSON.stringify(coordinator.getState())).not.toContain(secret);
		}
	});

	test("exceptions and raw adapter fields never enter public state or captured logs", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			const h = harness();
			const secret = fixture(h.readers[0]).credential;
			h.coordinator.checkDue();
			await h.finish(0, {
				ok: true,
				metrics: [
					{
						...balance(),
						raw: secret,
						credentialEnv: source().credentialEnv,
					},
				],
				raw: secret,
			});
			h.at(START + INTERVAL);
			h.coordinator.checkDue();
			await h.finish(1, {
				ok: false,
				error: {
					code: "network",
					httpStatus: null,
					retryAfterAt: null,
					raw: secret,
				},
			});
			h.at(START + INTERVAL * 2);
			h.coordinator.checkDue();
			fixture(h.attempts[2]).reject(new Error(secret));
			await Promise.resolve();
			const state = h.coordinator.getState();
			expect(state[0]).toMatchObject({
				status: "stale",
				error: { code: "internal", httpStatus: null, retryAfterAt: null },
				sample: { observedAt: START, metrics: [balance()] },
			});
			const serialized = JSON.stringify([
				state,
				log.mock.calls,
				warn.mock.calls,
				error.mock.calls,
			]);
			for (const privateValue of [
				secret,
				source().credentialEnv,
				"credentialEnv",
				"revision",
				"raw",
			])
				expect(serialized).not.toContain(privateValue);
		} finally {
			log.mockRestore();
			warn.mockRestore();
			error.mockRestore();
		}
	});

	test("reader and publication exceptions produce safe errors without lost slots", async () => {
		const diagnostic = spyOn(console, "error").mockImplementation(() => {});
		const secret = randomUUID();
		try {
			for (const asynchronous of [false, true]) {
				let reads = 0;
				const coordinator = createServiceQuotaCoordinator({
					sources: Array.from({ length: 6 }, (_, i) => source(String(i))),
					registry: new Map([
						[
							"synthetic",
							{
								id: "synthetic",
								createReader() {
									return {
										read() {
											reads++;
											throw new Error(secret);
										},
									};
								},
							},
						],
					]),
					resolveCredential: () => randomUUID(),
					now: () => START,
					onChange() {
						if (asynchronous) return Promise.reject(new Error(secret));
						throw new Error(secret);
					},
				});
				coordinator.checkDue();
				await Promise.resolve();
				expect(reads).toBe(6);
				expect(
					coordinator
						.getState()
						.every((s) => s.status === "error" && s.error.code === "internal"),
				).toBe(true);
			}
			expect(diagnostic.mock.calls).toEqual(
				Array.from({ length: 12 }, () => [
					"Service quota state publication failed",
				]),
			);
			expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(secret);
		} finally {
			diagnostic.mockRestore();
		}
	});

	test("unit changes reject a source snapshot until explicit rebind", async () => {
		const h = harness();
		h.coordinator.checkDue();
		await h.finish(0, success([balance()]));
		h.at(START + INTERVAL);
		h.coordinator.checkDue();
		await h.finish(1, success([]));
		h.at(START + INTERVAL * 2);
		h.coordinator.checkDue();
		const euros = {
			...balance(),
			unit: { kind: "currency" as const, code: "EUR" },
		};
		await h.finish(2, success([euros]));
		expect(h.coordinator.getState()[0]).toMatchObject({
			status: "stale",
			error: { code: "invalid_response" },
			sample: { metrics: [] },
		});
		h.coordinator.rebind(source());
		h.coordinator.checkDue();
		await h.finish(3, success([euros]));
		expect(h.coordinator.getState()[0]).toMatchObject({
			status: "ok",
			sample: { metrics: [euros] },
		});
	});

	test("caller configuration, metric and error mutation cannot change bound state", async () => {
		const configured = source();
		const h = harness([configured]);
		configured.id = "mutated";
		configured.adapterId = "unknown";
		configured.label = "mutated";
		configured.credentialEnv = randomUUID();
		h.coordinator.checkDue();
		const metrics = [balance()];
		await h.finish(0, success(metrics));
		fixture(metrics[0]).label = "mutated";
		fixture(metrics[0]).unit = { kind: "currency", code: "EUR" };
		expect(h.coordinator.getState()[0]).toMatchObject({
			id: source().id,
			adapterId: "synthetic",
			label: "anthropic",
			sample: { metrics: [balance()] },
		});
		h.at(START + INTERVAL);
		h.coordinator.checkDue();
		const error: ServiceQuotaReadError = {
			code: "network",
			httpStatus: null,
			retryAfterAt: null,
		};
		await h.finish(1, { ok: false, error });
		error.code = "authentication";
		const snapshot = fixture(h.coordinator.getState()[0]);
		if (snapshot.status === "stale" && snapshot.error)
			snapshot.error.code = "authentication";
		expect(h.coordinator.getState()[0]).toMatchObject({
			status: "stale",
			nextAttemptAt: START + 2 * INTERVAL,
			error: { code: "network" },
		});
		h.coordinator.setSources([source()]);
		expect(h.readers).toHaveLength(1);
	});

	test("malformed errors remain explicit and never publish arbitrary adapter fields", async () => {
		for (const error of [
			{ code: "raw-provider-text", httpStatus: null, retryAfterAt: null },
			{ code: "network", httpStatus: 700, retryAfterAt: null },
			{ code: "network", httpStatus: null, retryAfterAt: 1.5 },
			{ code: "network", httpStatus: null },
		]) {
			const h = harness();
			h.coordinator.checkDue();
			await h.finish(0, { ok: false, error });
			expect(h.coordinator.getState()[0]).toMatchObject({
				status: "error",
				nextAttemptAt: START + INTERVAL,
				error: { code: "internal", httpStatus: null, retryAfterAt: null },
			});
		}
	});

	test("reentrant publication can dispose or replace a source before resolution", () => {
		for (const action of ["dispose", "replace"] as const) {
			let coordinator: ServiceQuotaCoordinator | undefined;
			let intervene = false;
			const references: string[] = [];
			coordinator = createServiceQuotaCoordinator({
				sources: [source()],
				registry: new Map([
					[
						"synthetic",
						{
							id: "synthetic",
							createReader() {
								return { read: async () => success() };
							},
						},
					],
				]),
				resolveCredential(reference) {
					references.push(reference);
					return randomUUID();
				},
				now: () => START,
				onChange() {
					if (!intervene || !coordinator) return;
					intervene = false;
					if (action === "dispose") coordinator.dispose();
					else
						coordinator.rebind({
							...source(),
							credentialEnv: "REPLACEMENT_REFERENCE",
						});
				},
			});
			intervene = true;
			coordinator.rebind(source());
			expect(references).toEqual(
				action === "dispose"
					? [source().credentialEnv]
					: [source().credentialEnv, "REPLACEMENT_REFERENCE"],
			);
			expect(coordinator.getState().map((state) => state.status)).toEqual(
				action === "dispose" ? [] : ["pending"],
			);
		}
	});
});
