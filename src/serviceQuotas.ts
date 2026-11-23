import type {
	ServiceQuotaAdapterDefinition,
	ServiceQuotaMetric,
	ServiceQuotaReadError,
	ServiceQuotaReader,
	ServiceQuotaSourceConfig,
	ServiceQuotaSourceIdentity,
	ServiceQuotaSourceState,
	ServiceQuotaUnit,
} from "./types.ts";

const INTERVAL = 5 * 60 * 1000;
const MAX_ACTIVE = 4;
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const display = (value: unknown): value is string =>
	typeof value === "string" && value.length <= 256;
const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);
const timestamp = (value: unknown): value is number | null =>
	value === null || (typeof value === "number" && Number.isSafeInteger(value));
const optionalDisplay = (value: unknown): value is string | null =>
	value === null || display(value);

function unit(value: unknown): ServiceQuotaUnit | null {
	if (!record(value)) return null;
	if (value.kind === "currency" && display(value.code))
		return { kind: "currency", code: value.code };
	if (value.kind === "count" && display(value.name))
		return { kind: "count", name: value.name };
	return null;
}

function sameUnit(left: ServiceQuotaUnit, right: ServiceQuotaUnit): boolean {
	return left.kind === "currency"
		? right.kind === "currency" && left.code === right.code
		: right.kind === "count" && left.name === right.name;
}

type MetricIdentity = Pick<ServiceQuotaMetric, "id" | "label" | "unit">;

function normalizeWindow(
	value: Record<string, unknown>,
	identity: MetricIdentity,
	resetsAt: number | null,
): ServiceQuotaMetric | null {
	if (
		!finite(value.used) ||
		!finite(value.limit) ||
		value.used < 0 ||
		value.limit < 0 ||
		!timestamp(value.startsAt) ||
		(value.startsAt !== null && resetsAt !== null && value.startsAt >= resetsAt)
	)
		return null;
	return {
		...identity,
		kind: "window",
		used: value.used,
		limit: value.limit,
		startsAt: value.startsAt,
		resetsAt,
	};
}

function normalizeMetric(
	value: Record<string, unknown>,
	identity: MetricIdentity,
): ServiceQuotaMetric | null {
	if (!timestamp(value.resetsAt)) return null;
	if (value.kind === "window")
		return normalizeWindow(value, identity, value.resetsAt);
	if (
		value.kind !== "balance" ||
		!finite(value.remaining) ||
		!(value.reportedTotal === null || finite(value.reportedTotal)) ||
		!optionalDisplay(value.providerStatus) ||
		!optionalDisplay(value.plan)
	)
		return null;
	return {
		...identity,
		kind: "balance",
		remaining: value.remaining,
		reportedTotal: value.reportedTotal,
		resetsAt: value.resetsAt,
		providerStatus: value.providerStatus,
		plan: value.plan,
	};
}

function normalizeMetrics(
	input: unknown,
	prior: ReadonlyMap<string, ServiceQuotaUnit>,
): readonly ServiceQuotaMetric[] | null {
	if (!Array.isArray(input) || input.length > 32) return null;
	const ids = new Set<string>();
	const metrics: ServiceQuotaMetric[] = [];
	for (const value of input) {
		if (!record(value) || !display(value.id) || !display(value.label))
			return null;
		const normalizedUnit = unit(value.unit);
		if (normalizedUnit === null || ids.has(value.id)) return null;
		const oldUnit = prior.get(value.id);
		if (oldUnit && !sameUnit(oldUnit, normalizedUnit)) return null;
		ids.add(value.id);
		const metric = normalizeMetric(value, {
			id: value.id,
			label: value.label,
			unit: normalizedUnit,
		});
		if (metric === null) return null;
		metrics.push(metric);
	}
	return metrics;
}

/** Validate the whole sample before any cache update. Copy only public fields. */
export function validateServiceQuotaMetrics(
	input: unknown,
	previous: readonly ServiceQuotaMetric[] = [],
): readonly ServiceQuotaMetric[] | null {
	return normalizeMetrics(
		input,
		new Map(previous.map((metric) => [metric.id, metric.unit])),
	);
}

export interface ServiceQuotaCoordinatorOptions {
	sources: readonly ServiceQuotaSourceConfig[];
	registry: ReadonlyMap<string, ServiceQuotaAdapterDefinition>;
	resolveCredential(reference: string): string | undefined;
	now?(): number;
	onChange?(): void;
}

export interface ServiceQuotaCoordinator {
	getState(): readonly ServiceQuotaSourceState[];
	checkDue(): void;
	setSources(sources: readonly ServiceQuotaSourceConfig[]): void;
	rebind(source: ServiceQuotaSourceConfig): void;
	remove(id: string): void;
	dispose(): void;
}

interface Binding {
	config: ServiceQuotaSourceConfig;
	revision: number;
	duplicate: boolean;
	reader: ServiceQuotaReader | null;
	state: ServiceQuotaSourceState;
	history: Map<string, ServiceQuotaUnit>;
}

function validSource(source: ServiceQuotaSourceConfig): boolean {
	return (
		display(source.id) &&
		display(source.adapterId) &&
		display(source.label) &&
		typeof source.credentialEnv === "string" &&
		source.credentialEnv.trim().length > 0
	);
}

function validCredential(value: unknown): value is string {
	if (typeof value !== "string" || !value.trim()) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return false;
	}
	return true;
}

function canReuseBinding(
	old: Binding | undefined,
	source: ServiceQuotaSourceConfig,
	duplicate: boolean,
): old is Binding {
	return (
		old !== undefined &&
		!duplicate &&
		!old.duplicate &&
		old.config.adapterId === source.adapterId &&
		old.config.label === source.label &&
		old.config.credentialEnv === source.credentialEnv
	);
}

function identity(
	source: ServiceQuotaSourceConfig,
): ServiceQuotaSourceIdentity {
	return {
		id: source.id,
		adapterId: source.adapterId,
		label: display(source.label) ? source.label : "Invalid source label",
	};
}

function unconfigured(
	source: ServiceQuotaSourceConfig,
): ServiceQuotaSourceState {
	return {
		...identity(source),
		status: "unconfigured",
		lastAttemptAt: null,
		nextAttemptAt: null,
		sample: null,
		error: { code: "configuration" },
	};
}

function readError(code: ServiceQuotaReadError["code"]): ServiceQuotaReadError {
	return { code, httpStatus: null, retryAfterAt: null };
}

function safeError(value: unknown): ServiceQuotaReadError {
	if (
		!record(value) ||
		!(
			[
				"authentication",
				"rate_limit",
				"timeout",
				"network",
				"http",
				"invalid_response",
				"internal",
			] as unknown[]
		).includes(value.code) ||
		!(
			value.httpStatus === null ||
			(typeof value.httpStatus === "number" &&
				Number.isInteger(value.httpStatus) &&
				value.httpStatus >= 100 &&
				value.httpStatus <= 599)
		) ||
		!timestamp(value.retryAfterAt)
	)
		return readError("internal");
	return {
		code:
			value.httpStatus === 401 || value.httpStatus === 403
				? "authentication"
				: value.httpStatus === 429
					? "rate_limit"
					: (value.code as ServiceQuotaReadError["code"]),
		httpStatus: value.httpStatus,
		retryAfterAt: value.retryAfterAt,
	};
}

export function createServiceQuotaCoordinator(
	options: ServiceQuotaCoordinatorOptions,
): ServiceQuotaCoordinator {
	const now = options.now ?? Date.now;
	let bindings = new Map<string, Binding>();
	// Obsolete requests retain both their global slot and their source slot until settlement.
	const active = new Map<string, AbortController>();
	let revision = 0;
	let disposed = false;
	let configuring = 0;
	let scheduling = false;

	function notify(): void {
		if (disposed) return;
		try {
			void Promise.resolve(options.onChange?.()).catch(() => {
				console.error("Service quota state publication failed");
			});
		} catch {
			// A publication failure must not leak adapter data or interrupt request accounting.
			console.error("Service quota state publication failed");
		}
	}

	function current(binding: Binding): boolean {
		return !disposed && bindings.get(binding.config.id) === binding;
	}

	function freshState(binding: Binding, at: number): ServiceQuotaSourceState {
		const state = binding.state;
		return state.status === "ok" && at - state.sample.observedAt >= INTERVAL
			? { ...state, status: "stale", staleReason: "expired" }
			: state;
	}

	function bind(binding: Binding): void {
		const source = binding.config;
		if (!current(binding) || binding.duplicate || !validSource(source)) return;
		try {
			const adapter = options.registry.get(source.adapterId);
			if (!adapter || adapter.id !== source.adapterId) return;
			const credential = options.resolveCredential(source.credentialEnv);
			if (!current(binding) || !validCredential(credential)) return;
			const reader = adapter.createReader({ credential });
			if (!current(binding) || !reader || typeof reader.read !== "function")
				return;
			binding.reader = reader;
			binding.state = {
				...identity(source),
				status: "pending",
				lastAttemptAt: null,
				nextAttemptAt: now(),
				sample: null,
				error: null,
			};
		} catch {
			// Resolution and factory errors have no completed attempt and no public detail.
			if (current(binding)) {
				binding.reader = null;
				binding.state = unconfigured(source);
			}
		}
	}

	function newBinding(
		source: ServiceQuotaSourceConfig,
		duplicate: boolean,
	): Binding {
		return {
			config: {
				id: source.id,
				adapterId: source.adapterId,
				label: source.label,
				credentialEnv: source.credentialEnv,
			},
			revision: ++revision,
			duplicate,
			reader: null,
			state: unconfigured(source),
			history: new Map(),
		};
	}

	function setSources(
		sources: readonly ServiceQuotaSourceConfig[],
		publish = true,
	): void {
		if (disposed) return;
		const counts = new Map<string, number>();
		for (const source of sources)
			counts.set(source.id, (counts.get(source.id) ?? 0) + 1);
		const next = new Map<string, Binding>();
		const replacements: Binding[] = [];
		for (const source of sources) {
			if (next.has(source.id)) continue;
			const old = bindings.get(source.id);
			const duplicate = (counts.get(source.id) ?? 0) > 1;
			if (canReuseBinding(old, source, duplicate)) next.set(source.id, old);
			else {
				const replacement = newBinding(source, duplicate);
				next.set(source.id, replacement);
				replacements.push(replacement);
			}
		}
		const old = bindings;
		bindings = next;
		configuring++;
		try {
			for (const [id, binding] of old)
				if (next.get(id) !== binding) active.get(id)?.abort();
			if (publish) notify();
			for (const binding of replacements) bind(binding);
			if (publish && replacements.length > 0) notify();
		} finally {
			configuring--;
		}
	}

	function complete(binding: Binding, result: unknown): void {
		const at = now();
		let error: ServiceQuotaReadError;
		if (record(result) && result.ok === true) {
			const metrics = normalizeMetrics(result.metrics, binding.history);
			if (metrics !== null) {
				for (const metric of metrics)
					binding.history.set(metric.id, metric.unit);
				binding.state = {
					...identity(binding.config),
					status: "ok",
					lastAttemptAt: at,
					nextAttemptAt: at + INTERVAL,
					sample: { observedAt: at, metrics },
					error: null,
				};
				return;
			}
			error = readError("invalid_response");
		} else {
			error =
				record(result) && result.ok === false
					? safeError(result.error)
					: readError("internal");
		}
		completeFailure(binding, error, at);
	}

	function completeFailure(
		binding: Binding,
		error: ServiceQuotaReadError,
		at: number,
	): void {
		const nextAttemptAt =
			error.code === "authentication"
				? null
				: Math.max(
						at + INTERVAL,
						error.code === "rate_limit" ? (error.retryAfterAt ?? 0) : 0,
					);
		const common = {
			...identity(binding.config),
			lastAttemptAt: at,
			nextAttemptAt,
			error,
		};
		binding.state =
			binding.state.sample === null
				? { ...common, status: "error", sample: null }
				: {
						...common,
						status: "stale",
						staleReason: "refresh_error",
						sample: binding.state.sample,
					};
	}

	async function attempt(
		binding: Binding,
		reader: ServiceQuotaReader,
		capturedRevision: number,
		controller: AbortController,
	): Promise<void> {
		const matches = () =>
			current(binding) &&
			binding.reader === reader &&
			binding.revision === capturedRevision;
		try {
			const result = await reader.read({ signal: controller.signal });
			if (matches()) complete(binding, result);
		} catch {
			if (matches())
				complete(binding, { ok: false, error: readError("internal") });
		} finally {
			active.delete(binding.config.id);
			if (matches()) notify();
			startDue();
		}
	}

	function startDue(): void {
		if (disposed || configuring > 0 || scheduling) return;
		scheduling = true;
		try {
			const at = now();
			for (const binding of bindings.values()) {
				if (disposed || active.size >= MAX_ACTIVE) break;
				const { reader, state } = binding;
				if (
					!current(binding) ||
					!reader ||
					active.has(binding.config.id) ||
					state.nextAttemptAt === null ||
					state.nextAttemptAt > at
				)
					continue;
				const controller = new AbortController();
				active.set(binding.config.id, controller);
				void attempt(binding, reader, binding.revision, controller);
			}
		} finally {
			scheduling = false;
		}
	}

	setSources(options.sources, false);
	return {
		getState() {
			const at = now();
			return [...bindings.values()].map((binding) =>
				structuredClone(freshState(binding, at)),
			);
		},
		checkDue() {
			if (disposed) return;
			const at = now();
			let changed = false;
			for (const binding of bindings.values()) {
				const state = freshState(binding, at);
				if (state !== binding.state) {
					binding.state = state;
					changed = true;
				}
			}
			if (changed) notify();
			startDue();
		},
		setSources,
		rebind(source) {
			if (disposed) return;
			const binding = newBinding(source, false);
			bindings.set(source.id, binding);
			configuring++;
			try {
				active.get(source.id)?.abort();
				notify();
				bind(binding);
				notify();
			} finally {
				configuring--;
			}
		},
		remove(id) {
			if (disposed || !bindings.delete(id)) return;
			active.get(id)?.abort();
			notify();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			bindings.clear();
			for (const controller of active.values()) controller.abort();
		},
	};
}
