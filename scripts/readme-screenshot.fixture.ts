import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vmRunnerFromEnv } from "../src/runner.ts";

export type Scenario = {
	readyAttempt: number | null;
	failure: "reject" | "non-2xx" | "slow-body";
	earlyExit?: boolean;
};

export type Trace =
	| {
			kind: "board-spawn";
			attempt: number;
			at: number;
			port: string;
			devRoot: string | undefined;
			stateDir: string | undefined;
	  }
	| { kind: "stop"; attempt: number; at: number; child: "board" | "chrome" }
	| { kind: "fetch"; attempt: number; at: number; url: string }
	| { kind: "cdp"; at: number; method: string; url?: string }
	| { kind: "write"; at: number; path: string };

const root = process.env.README_SHOT_FIXTURE_ROOT;
const rawScenario = process.env.README_SHOT_SCENARIO;
if (!root || !rawScenario)
	throw new Error("missing screenshot fixture settings");
const scenario = JSON.parse(rawScenario) as Scenario;
const fixtureRoot = root;
const asset = join(
	import.meta.dir,
	"..",
	".github",
	"assets",
	"screenshot.png",
);
const png = readFileSync(asset);
let elapsed = 0;
let attempt = 0;
let boardPort = "";
const epoch = Date.now();
Date.now = () => epoch + elapsed;
Object.defineProperty(performance, "now", { value: () => elapsed });
Bun.sleep = (async (ms: number | Date) => {
	if (typeof ms !== "number") throw new Error("unexpected sleep date");
	elapsed += ms;
}) as typeof Bun.sleep;

const timeout = AbortSignal.timeout.bind(AbortSignal);
const signalDeadlines = new WeakMap<AbortSignal, number>();
AbortSignal.timeout = (ms: number) => {
	const signal = timeout(ms);
	signalDeadlines.set(signal, elapsed + ms);
	return signal;
};

function requestDelay(
	ms: number,
	signal: AbortSignal | null | undefined,
): void {
	if (signal?.aborted) throw signal.reason;
	const deadline = signal ? signalDeadlines.get(signal) : undefined;
	const remaining = (deadline ?? Infinity) - elapsed;
	elapsed += Math.min(ms, Math.max(0, remaining));
	if (remaining <= ms) {
		throw new DOMException("The operation timed out.", "TimeoutError");
	}
}

function trace(event: Trace): void {
	appendFileSync(
		join(fixtureRoot, "trace.jsonl"),
		`${JSON.stringify(event)}\n`,
	);
}

function child(kind: "board" | "chrome", childAttempt: number) {
	const exit = Promise.withResolvers<number>();
	const early = kind === "board" && scenario.earlyExit;
	const handle = {
		exitCode: early ? 7 : null,
		exited: exit.promise,
		stderr: new ReadableStream<Uint8Array>({
			start(controller) {
				if (kind === "chrome") {
					controller.enqueue(
						new TextEncoder().encode(
							"DevTools listening on ws://fixture.invalid/devtools/browser/test\n",
						),
					);
				}
				controller.close();
			},
		}),
		kill() {
			trace({ kind: "stop", child: kind, attempt: childAttempt, at: elapsed });
			handle.exitCode = 0;
			exit.resolve(0);
		},
	};
	if (early) exit.resolve(7);
	return handle;
}

// Only the isolated subprocess receives these boundary replacements.
Bun.spawn = ((cmd: string[], options: { env?: Record<string, string> }) => {
	if (cmd[0] === "bun" && cmd[1] === "src/dev.ts") {
		attempt++;
		const env = options.env;
		if (!env?.PORT) throw new Error("board spawn has no port");
		boardPort = env.PORT;
		trace({
			kind: "board-spawn",
			attempt,
			at: elapsed,
			port: env.PORT,
			devRoot: env.OTTR_DEV_ROOT,
			stateDir: env.OTTR_STATE_DIR,
		});
		if (vmRunnerFromEnv(env) !== null)
			throw new Error("the demo board must not use a microVM runner");
		return child("board", attempt);
	}
	if (cmd[0] !== "fixture-chrome") throw new Error("unexpected child command");
	return child("chrome", 0);
}) as unknown as typeof Bun.spawn;

const write = Bun.write.bind(Bun);
Bun.write = ((destination: string, data: Uint8Array) => {
	if (destination !== asset)
		throw new Error("unexpected screenshot destination");
	const output = join(fixtureRoot, "capture.png");
	trace({ kind: "write", at: elapsed, path: output });
	return write(output, data);
}) as typeof Bun.write;

globalThis.fetch = (async (
	input: string | URL | Request,
	init?: RequestInit,
) => {
	const url = String(input);
	if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) {
		throw new Error(`unexpected readiness URL: ${url}`);
	}
	trace({ kind: "fetch", attempt, at: elapsed, url });
	if (url !== `http://127.0.0.1:${boardPort}/`) {
		throw new Error("readiness request targets an old board");
	}
	if (scenario.readyAttempt === attempt) return new Response("ready");
	if (scenario.failure === "slow-body") {
		// The last poll reaches its deadline during body cancellation.
		requestDelay(200, init?.signal);
		return new Response(
			new ReadableStream({
				cancel() {
					requestDelay(600, init?.signal);
				},
			}),
			{ status: 503 },
		);
	}
	requestDelay(900, init?.signal);
	if (scenario.failure === "reject") throw new TypeError("connection refused");
	return new Response("not ready", { status: 503 });
}) as typeof fetch;

class FixtureSocket extends EventTarget {
	constructor(_url: string | URL) {
		super();
		queueMicrotask(() => {
			this.dispatchEvent(new Event("open"));
		});
	}

	send(data: string): void {
		const message = JSON.parse(data) as {
			id: number;
			method: string;
			params?: { url?: string };
			sessionId?: string;
		};
		trace({
			kind: "cdp",
			at: elapsed,
			method: message.method,
			url: message.params?.url,
		});
		let result: Record<string, unknown> = {};
		if (message.method === "Target.createTarget") result = { targetId: "page" };
		if (message.method === "Target.attachToTarget") {
			result = { sessionId: "session" };
		}
		if (message.method === "Page.captureScreenshot") {
			result = { data: png.toString("base64") };
		}
		queueMicrotask(() => {
			this.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ id: message.id, result }),
				}),
			);
		});
		if (message.method === "Page.navigate") {
			// A later task lets the real CDP client register its page-load waiter.
			setTimeout(() => {
				this.dispatchEvent(
					new MessageEvent("message", {
						data: JSON.stringify({
							method: "Page.loadEventFired",
							sessionId: message.sessionId,
						}),
					}),
				);
			}, 0);
		}
	}
}
globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
