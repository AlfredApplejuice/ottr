import { VM_UNCONFIGURED, vmState } from "./vmState.ts";
import type { WorkerTarget } from "./workers.ts";

/** One GET /healthz of the microVM runner into vmState.health; unconfigured stays unconfigured. */
export async function probeVmRunner(
	target: WorkerTarget | null,
): Promise<void> {
	if (target === null) {
		vmState.health = { configured: false, ok: false, reason: VM_UNCONFIGURED };
		return;
	}
	const url = target.urls[0];
	if (url === undefined) {
		vmState.health = { configured: false, ok: false, reason: VM_UNCONFIGURED };
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
		vmState.health =
			res.status === 200
				? { configured: true, ok: true, reason: null }
				: {
						configured: true,
						ok: false,
						reason: body || `/healthz answered HTTP ${res.status}`,
					};
	} catch (err) {
		vmState.health = {
			configured: true,
			ok: false,
			reason: `no answer from ${url} (${err instanceof Error ? err.message : String(err)})`,
		};
	}
}
