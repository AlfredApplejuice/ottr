// Podman injects the host proxy env (HTTP_PROXY/HTTPS_PROXY/NO_PROXY) into every container;
// its NO_PROXY names no compose services, so internal calls bounce off the corporate proxy.
// Coverage test for docker/no-proxy.sh: the sourced merge must keep the injected host list
// first, append the service names, absorb OTTR_WORKER_URLS and OTTR_VM_RUNNER_URL hosts,
// and stay idempotent. The probe tests prove the differential: with an injected HTTP_PROXY
// the board's token-bearing vm-runner /healthz probe reaches a fake proxy zero times.
import { describe, expect, test } from "bun:test";
import { probeVmRunner } from "../src/vmHealth.ts";
import { vmState } from "../src/vmState.ts";

const scriptPath = new URL("../docker/no-proxy.sh", import.meta.url).pathname;

function mergeNoProxy(env: Record<string, string>): {
	noProxy: string;
	lower: string;
} {
	const proc = Bun.spawnSync({
		cmd: [
			"sh",
			"-c",
			`. ${scriptPath} && printf '%s\\n%s' "$NO_PROXY" "$no_proxy"`,
		],
		env,
	});
	const [noProxy = "", lower = ""] = new TextDecoder()
		.decode(proc.stdout)
		.split("\n");
	return { noProxy, lower };
}

const FIXED =
	"localhost,127.0.0.1,alate,server,ottr,ottr-server,worker-a,worker-b";

describe("docker/no-proxy.sh", () => {
	test("keeps the injected NO_PROXY host list first, appends the service names", () => {
		const { noProxy, lower } = mergeNoProxy({
			NO_PROXY: "corp.example,10.0.0.0/8",
		});
		expect(noProxy).toBe(`corp.example,10.0.0.0/8,${FIXED}`);
		expect(lower).toBe(noProxy);
	});

	test("sets both vars even with no proxy vars at all", () => {
		const { noProxy, lower } = mergeNoProxy({});
		expect(noProxy).toBe(FIXED);
		expect(lower).toBe(noProxy);
	});

	test("falls back to lowercase no_proxy when NO_PROXY is unset", () => {
		const { noProxy, lower } = mergeNoProxy({ no_proxy: "internal.corp" });
		expect(noProxy).toBe(`internal.corp,${FIXED}`);
		expect(lower).toBe(noProxy);
	});

	test("does not duplicate an entry already present in the list", () => {
		const { noProxy, lower } = mergeNoProxy({ NO_PROXY: "localhost" });
		expect(noProxy).toBe(FIXED);
		expect(lower).toBe(noProxy);
	});

	test("absorbs OTTR_WORKER_URLS hosts without duplicating known workers", () => {
		const { noProxy, lower } = mergeNoProxy({
			NO_PROXY: "corp.example",
			OTTR_WORKER_URLS: "http://worker-a:8787,http://worker-c:8787",
		});
		expect(noProxy).toBe(`corp.example,${FIXED},worker-c`);
		expect(lower).toBe(noProxy);
	});

	test("absorbs the OTTR_VM_RUNNER_URL host", () => {
		const { noProxy, lower } = mergeNoProxy({
			NO_PROXY: "corp.example",
			OTTR_VM_RUNNER_URL: "http://vm-runner:8787",
		});
		expect(noProxy).toBe(`corp.example,${FIXED},vm-runner`);
		expect(lower).toBe(noProxy);
	});

	test("leaves the list alone when OTTR_VM_RUNNER_URL is empty", () => {
		const { noProxy, lower } = mergeNoProxy({ OTTR_VM_RUNNER_URL: "" });
		expect(noProxy).toBe(FIXED);
		expect(lower).toBe(noProxy);
	});
});

const PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
];

/** Runs fn with exactly these proxy env values set, restoring the ambient ones after. */
async function withProxyEnv(
	env: Record<string, string>,
	fn: () => Promise<void>,
): Promise<void> {
	const saved = Object.fromEntries(
		PROXY_ENV_KEYS.map((k) => [k, process.env[k]]),
	);
	try {
		for (const k of PROXY_ENV_KEYS) delete process.env[k];
		Object.assign(process.env, env);
		await fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** A loopback fake proxy that counts the requests it sees, with the probe's token header. */
function fakeProxy(): {
	url: string;
	hits: { url: string; token: string | null }[];
	stop(): void;
} {
	const hits: { url: string; token: string | null }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => {
			hits.push({ url: req.url, token: req.headers.get("x-otwr-token") });
			return new Response("via proxy");
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		hits,
		stop: () => server.stop(true),
	};
}

describe("the board probe under an injected HTTP_PROXY", () => {
	// The address docs/WORKERS.md tells the owner to set; the board sends
	// OTTR_WORKER_TOKEN on this probe, so a proxy hop discloses the credential
	// (validation run #OTTR-1090 reached a loopback fake proxy with the token).
	const RUNNER = "http://vm-runner:8787";

	test("the sourced bypass list keeps the probe off the proxy", async () => {
		const proxy = fakeProxy();
		// OTTR-1162: the probe writes the shared vmState singleton (health and the
		// OTTR-1142 pool gate). Restore both, or a later test file's dispatch reads a
		// pool max this container's real vm-runner answered with.
		const savedHealth = vmState.health;
		const savedPool = vmState.pool;
		try {
			await withProxyEnv({ HTTP_PROXY: proxy.url }, async () => {
				// The env the entry script leaves behind after sourcing docker/no-proxy.sh.
				const { noProxy, lower } = mergeNoProxy({
					OTTR_VM_RUNNER_URL: RUNNER,
					HTTP_PROXY: proxy.url,
				});
				expect(noProxy).toContain("vm-runner");
				process.env.NO_PROXY = noProxy;
				process.env.no_proxy = lower;
				await probeVmRunner({ urls: [RUNNER], token: "audit-dummy-token" });
			});
			expect(proxy.hits).toEqual([]);
			// The probe still works. The runner may be a real compose sibling that
			// answers 200, or an unresolvable name: either way the probe stays off
			// the proxy, which is what this test watches.
			expect(vmState.health.configured).toBe(true);
		} finally {
			vmState.health = savedHealth;
			vmState.pool = savedPool;
			proxy.stop();
		}
	});

	test("a probe-shaped fetch without the direct override does reach the proxy", async () => {
		// The pre-fix differential (validation run #OTTR-1090): a bypass list that
		// misses the target sends the whole request, credential header included,
		// through the injected proxy. Also proves the fake proxy really intercepts.
		const proxy = fakeProxy();
		try {
			await withProxyEnv(
				{
					HTTP_PROXY: proxy.url,
					NO_PROXY: "localhost,127.0.0.1",
					no_proxy: "localhost,127.0.0.1",
				},
				async () => {
					await fetch("http://unlisted-sim.invalid:8787/healthz", {
						headers: { "x-otwr-token": "audit-dummy-token" },
						redirect: "manual",
						signal: AbortSignal.timeout(3000),
					}).catch(() => {});
				},
			);
			expect(proxy.hits).toHaveLength(1);
			expect(proxy.hits[0]?.token).toBe("audit-dummy-token");
		} finally {
			proxy.stop();
		}
	});

	test("proxy: false keeps the probe direct even where the bypass list misses", async () => {
		const proxy = fakeProxy();
		// OTTR-1162: restore the shared singleton the probe wrote (health and the
		// OTTR-1142 pool gate), like the first probe test does.
		const savedHealth = vmState.health;
		const savedPool = vmState.pool;
		try {
			await withProxyEnv(
				{
					HTTP_PROXY: proxy.url,
					NO_PROXY: "localhost,127.0.0.1",
					no_proxy: "localhost,127.0.0.1",
				},
				async () => {
					await probeVmRunner({
						urls: ["http://unlisted-sim.invalid:8787"],
						token: "audit-dummy-token",
					});
				},
			);
			expect(proxy.hits).toEqual([]);
			expect(vmState.health.configured).toBe(true);
			expect(vmState.health.ok).toBe(false);
		} finally {
			vmState.health = savedHealth;
			vmState.pool = savedPool;
			proxy.stop();
		}
	});
});
