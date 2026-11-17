import {
	createServiceQuotaHttpReader,
	type ServiceQuotaHttpReaderOptions,
} from "./serviceQuotaHttp.ts";
import type {
	ServiceQuotaAdapterDefinition,
	ServiceQuotaMetric,
} from "./types.ts";

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

function decodeBalance(body: unknown): readonly ServiceQuotaMetric[] | null {
	if (!record(body) || !record(body.credits) || !record(body.subscription))
		return null;
	const { credits, subscription } = body;
	const plan = "plan" in subscription ? subscription.plan : null;
	if (
		!finite(credits.usd) ||
		!finite(subscription.generations) ||
		!finite(subscription.total) ||
		typeof subscription.status !== "string" ||
		("type" in credits && credits.type !== "usd") ||
		("type" in subscription && subscription.type !== "generations") ||
		(plan !== null && typeof plan !== "string")
	)
		return null;

	return [
		{
			id: "usd-credits",
			label: "USD credits",
			kind: "balance",
			unit: { kind: "currency", code: "USD" },
			remaining: credits.usd,
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
			remaining: subscription.generations,
			reportedTotal: subscription.total,
			resetsAt: null,
			providerStatus: subscription.status,
			plan,
		},
	];
}

export function createPixellabQuotaAdapter(
	options: Pick<ServiceQuotaHttpReaderOptions, "fetch" | "now"> = {},
): ServiceQuotaAdapterDefinition {
	return {
		id: "pixellab-v2",
		createReader({ credential }) {
			return createServiceQuotaHttpReader({
				endpoint: "https://api.pixellab.ai/v2/balance",
				credential,
				decode: decodeBalance,
				fetch: options.fetch,
				now: options.now,
			});
		},
	};
}
