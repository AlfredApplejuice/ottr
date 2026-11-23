import { VM_UNCONFIGURED, vmState } from "./vmState.ts";
import type { WorkerTarget } from "./workers.ts";

/** One GET /healthz of the microVM runner into vmState.health; unconfigured stays unconfigured. */
export async function probeVmRunner(
	target: WorkerTarget | null,
): Promise<void> {
	if (target === null) {
		vmState.health = { configured: false, ok: false, reason: VM_UNCONFIGURED };
		vmState.pool = { busy: 0, max: 0 };
		return;
	}
	const url = target.urls[0];
	if (url === undefined) {
		vmState.health = { configured: false, ok: false, reason: VM_UNCONFIGURED };
		vmState.pool = { busy: 0, max: 0 };
		return;
	}
	try {
		const res = await fetch(`${url}/healthz`, {
			headers: target.token ? { "x-otwr-token": target.token } : {},
			// The worker token never follows a redirect off-host.
			redirect: "manual",
			// vm-runner is a compose sibling: a runtime-injected HTTP_PROXY (Podman
			// copies the host's in) must never see the token, even where NO_PROXY
			// misses the host; false connects directly past the proxy env.
			proxy: false,
			signal: AbortSignal.timeout(5000),
		});
		// vm-runner's 503 body is its own one-line reason ("vm-runner: /dev/kvm is missing");
		// the UI already names vm-runner, so the prefix and the URL stay out of the text.
		const body = (await res.text())
			.trim()
			.replace(/^vm-runner:\s*/, "")
			.slice(0, 300);
		if (res.status !== 200) {
			vmState.health = {
				configured: true,
				ok: false,
				reason: body || `/healthz answered HTTP ${res.status}`,
			};
			return;
		}
		vmState.health = { configured: true, ok: true, reason: null };
		// OTTR-1142 pool usage (x-ottr-vms-busy / x-ottr-vms-max). A runner without the
		// headers resets the pool to unknown; its start gate then falls back to the
		// per-card busy back-off. A failed probe leaves the last pool state: health
		// already holds the cards while the runner does not answer.
		const busy = Number(res.headers.get("x-ottr-vms-busy"));
		const max = Number(res.headers.get("x-ottr-vms-max"));
		vmState.pool =
			Number.isFinite(busy) && Number.isFinite(max) && max > 0
				? { busy, max }
				: { busy: 0, max: 0 };
	} catch (err) {
		vmState.health = {
			configured: true,
			ok: false,
			reason: `no answer from ${url} (${err instanceof Error ? err.message : String(err)})`,
		};
	}
}
