import { validateServiceQuotaMetrics } from "./serviceQuotas.ts";
import type {
	ServiceQuotaReadError,
	ServiceQuotaReader,
	ServiceQuotaReadResult,
} from "./types.ts";

export interface ServiceQuotaHttpReaderOptions {
	endpoint: string;
	credential: string;
	decode(body: unknown): unknown;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
}

function failure(
	code: ServiceQuotaReadError["code"],
	httpStatus: number | null = null,
	retryAfterAt: number | null = null,
): ServiceQuotaReadResult {
	return { ok: false, error: { code, httpStatus, retryAfterAt } };
}

function retryAfter(value: string | null, now: number): number | null {
	if (value === null) return null;
	const text = value.trim();
	let timestamp: number;
	if (/^\d+$/.test(text)) {
		timestamp = Math.trunc(now) + Number(text) * 1000;
	} else {
		// Date.parse alone also accepts numbers and non-HTTP date formats.
		const httpDate =
			/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;
		if (!httpDate.test(text)) return null;
		timestamp = Date.parse(text);
		if (!Number.isFinite(timestamp)) return null;
		const date = new Date(timestamp);
		const canonical = date.toUTCString();
		const day = text.includes(",")
			? text.slice(text.indexOf(",") + 2, text.indexOf(",") + 4)
			: text.slice(8, 10);
		if (
			Number(day) !== date.getUTCDate() ||
			text.slice(0, 3) !== canonical.slice(0, 3) ||
			!text.includes(canonical.slice(17, 25))
		)
			return null;
	}
	return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function statusFailure(
	response: Response,
	now: () => number,
): ServiceQuotaReadResult {
	const status = response.status;
	if (status === 401 || status === 403)
		return failure("authentication", status);
	if (status === 429)
		return failure(
			"rate_limit",
			status,
			retryAfter(response.headers.get("retry-after"), now()),
		);
	return failure("http", status);
}

async function readBoundedBody(
	body: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<Uint8Array | null> {
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for (;;) {
		const chunk = await body.read();
		signal.throwIfAborted();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > 65_536) return null;
		chunks.push(chunk.value);
	}
	const contents = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		contents.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return contents;
}

function decodeResponse(
	contents: Uint8Array,
	decode: ServiceQuotaHttpReaderOptions["decode"],
	status: number,
): ServiceQuotaReadResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(contents),
		);
	} catch {
		return failure("invalid_response", status);
	}
	try {
		const metrics = validateServiceQuotaMetrics(decode(parsed));
		return metrics === null
			? failure("invalid_response", status)
			: { ok: true, metrics };
	} catch {
		return failure("internal", status);
	}
}

export function createServiceQuotaHttpReader({
	endpoint,
	credential,
	decode,
	fetch: request = globalThis.fetch,
	now = Date.now,
}: ServiceQuotaHttpReaderOptions): ServiceQuotaReader {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error("Invalid service quota endpoint");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		endpoint.includes("#") ||
		/^https:\/\/[^/?#]*@/i.test(endpoint.trim())
	) {
		throw new Error("Invalid service quota endpoint");
	}

	return {
		async read({ signal }) {
			if (signal.aborted) return failure("network");
			const controller = new AbortController();
			let timedOut = false;
			let body: ReadableStreamDefaultReader<Uint8Array> | undefined;
			let status: number | null = null;
			const interrupted = Promise.withResolvers<ServiceQuotaReadResult>();
			const interrupt = () => {
				controller.abort();
				interrupted.resolve(failure(timedOut ? "timeout" : "network", status));
			};
			signal.addEventListener("abort", interrupt, { once: true });
			const timer = setTimeout(() => {
				timedOut = true;
				interrupt();
			}, 10_000);

			const receive = async (): Promise<ServiceQuotaReadResult> => {
				try {
					const response = await request(endpoint, {
						method: "GET",
						headers: {
							Accept: "application/json",
							Authorization: `Bearer ${credential}`,
						},
						redirect: "manual",
						signal: controller.signal,
					});
					status = response.status;
					body = response.body?.getReader();
					if (controller.signal.aborted) {
						// An injected fetch can settle after the caller has already aborted.
						void body?.cancel().catch(() => undefined);
						return failure(timedOut ? "timeout" : "network", status);
					}
					if (!response.ok) return statusFailure(response, now);
					if (!body) return failure("invalid_response", status);
					const contents = await readBoundedBody(body, controller.signal);
					return contents === null
						? failure("invalid_response", status)
						: decodeResponse(contents, decode, status);
				} catch {
					return failure(timedOut ? "timeout" : "network", status);
				}
			};

			try {
				return await Promise.race([receive(), interrupted.promise]);
			} finally {
				clearTimeout(timer);
				signal.removeEventListener("abort", interrupt);
				// Cancellation failures cannot replace the explicit read result or leak provider text.
				void body?.cancel().catch(() => undefined);
			}
		},
	};
}
