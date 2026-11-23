import type {
	ServiceQuotaMetric,
	ServiceQuotaReadError,
	ServiceQuotaSourceState,
	ServiceQuotaUnit,
} from "../types.ts";
import { Mark } from "./kit.tsx";
import { age, stamp } from "./time.ts";

// Preserve fractional and signed balances rather than applying currency rounding.
const amount = new Intl.NumberFormat(undefined, {
	maximumSignificantDigits: 21,
});
const percentage = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 1,
});
const readErrors: Record<ServiceQuotaReadError["code"], string> = {
	authentication: "The provider refused the server credentials.",
	rate_limit: "The provider rate limit blocked the read.",
	timeout: "The provider read timed out.",
	network: "The server could not reach the provider.",
	http: "The provider returned an HTTP error.",
	invalid_response: "The provider returned an invalid response.",
	internal: "The server could not complete the read.",
};

function quantity(value: number, unit: ServiceQuotaUnit): string {
	return unit.kind === "currency"
		? `${unit.code} ${amount.format(value)}`
		: `${amount.format(value)} ${unit.name}`;
}

function ServiceMetric({ metric }: { metric: ServiceQuotaMetric }) {
	return (
		<div className="service-metric">
			<dt>{metric.label}</dt>
			<dd>
				{metric.kind === "balance" ? (
					<>
						<div>{quantity(metric.remaining, metric.unit)} remaining</div>
						{metric.reportedTotal !== null && (
							<div className="caption">
								Provider total: {quantity(metric.reportedTotal, metric.unit)}
							</div>
						)}
						{metric.providerStatus !== null && (
							<div className="caption">
								Provider status: {metric.providerStatus}
							</div>
						)}
						{metric.plan !== null && (
							<div className="caption">Plan: {metric.plan}</div>
						)}
					</>
				) : (
					<>
						<div>Used: {quantity(metric.used, metric.unit)}</div>
						<div>Limit: {quantity(metric.limit, metric.unit)}</div>
						{metric.limit > 0 && (
							<div>
								{percentage.format((metric.used / metric.limit) * 100)} % used
							</div>
						)}
						{metric.startsAt !== null && (
							<div className="caption">Starts {stamp(metric.startsAt)}</div>
						)}
					</>
				)}
				{metric.resetsAt !== null && (
					<div className="caption">Resets {stamp(metric.resetsAt)}</div>
				)}
			</dd>
		</div>
	);
}

/** App's clock refreshes these ages even when no new state frame arrives. */
export function ServiceQuotas({
	sources,
	now,
}: {
	sources: readonly ServiceQuotaSourceState[] | undefined;
	now: number;
}) {
	if (sources === undefined || sources.length === 0) return null;
	return (
		<section className="service-quotas" aria-label="Services">
			<h2>Services</h2>
			{sources.map((source) => {
				const stale =
					source.status === "stale" ||
					(source.sample !== null && now - source.sample.observedAt >= 300_000);
				const status = stale
					? "Stale"
					: {
							ok: "Current",
							pending: "Pending",
							unconfigured: "Unconfigured",
							error: "Error",
							stale: "Stale",
						}[source.status];
				const attention =
					source.status === "unconfigured"
						? "needs"
						: source.error !== null && source.nextAttemptAt === null
							? "crit"
							: undefined;
				return (
					<div className="service-source" key={source.id}>
						<h3>{source.label}</h3>
						<p className="caption">
							Source: {source.id} · Adapter: {source.adapterId}
						</p>
						<p
							className="caption service-status"
							data-level={attention}
							role="status"
						>
							{attention !== undefined && <Mark kind={attention} />}
							<span>
								{status}
								{source.sample !== null &&
									` · Observed ${age(source.sample.observedAt, now)}`}
							</span>
						</p>
						{source.status === "unconfigured" ? (
							<p className="caption">
								Server configuration is missing or invalid. Contact the board
								operator.
							</p>
						) : source.error !== null ? (
							<p className="caption" role="alert">
								{readErrors[source.error.code]}
								{source.error.httpStatus !== null &&
									` HTTP ${source.error.httpStatus}.`}
								{source.nextAttemptAt === null
									? " Contact the board operator. Automatic reads are paused."
									: " The server will retry automatically."}
							</p>
						) : source.status === "pending" ? (
							<p className="caption">
								The first provider read has not completed.
							</p>
						) : stale ? (
							<p className="caption">
								The sample is at least 5 minutes old. The server will refresh it
								automatically.
							</p>
						) : null}
						{source.sample !== null &&
							(source.sample.metrics.length === 0 ? (
								<p className="caption">
									The provider reports no quota metrics.
								</p>
							) : (
								<dl className="service-metrics">
									{source.sample.metrics.map((metric) => (
										<ServiceMetric key={metric.id} metric={metric} />
									))}
								</dl>
							))}
					</div>
				);
			})}
		</section>
	);
}
