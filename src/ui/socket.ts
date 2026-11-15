import type {
	QuotaState,
	ServerMessage,
	StateResponse,
	SystemSnapshot,
} from "../types.ts";

/** Why the connection dropped, as far as the browser can tell: the 5 s connect
 * timeout, the 15 s watchdog, the poll flight aborted at its deadline ("timeout"),
 * or the socket's error/close event pair. */
export type OfflineReason =
	| "connect-timeout"
	| "watchdog"
	| "timeout"
	| "error"
	| "close";

/** What onOffline carries. reason rides when the transport itself died (a dead
 * socket names its cause; a poll names it only for transport failures); status
 * rides when a failed /api/state produced one — 0 on a transport failure, never
 * a session loss; retryMs is when the caller tries again, so the banner can
 * count down to it. */
export interface OfflineInfo {
	reason?: OfflineReason;
	status?: number;
	retryMs: number;
}

/** Handlers the App passes to its one live socket. */
interface LiveHandlers {
	onState(state: StateResponse): void;
	onUpdate(behind: number, commits: string[]): void;
	onOnline(): void;
	onOffline(info: OfflineInfo): void;
}

/** Narrow one text frame; null for anything the guards reject, so a bad frame never reaches the UI. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
	if (typeof raw !== "string") return null;
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) return null;
	const m = data as Record<string, unknown>; // shape checked field by field below
	if (typeof m.type !== "string") return null;
	switch (m.type) {
		case "state":
			return stateMessage(m);
		case "system":
			return systemMessage(m);
		case "update":
			return updateMessage(m);
		case "log":
			return logMessage(m);
		case "ping":
			return { type: "ping" };
		default:
			return null;
	}
}

/** The "state" frame, when its state field carries tasks, projects and a server version. */
function stateMessage(m: Record<string, unknown>): ServerMessage | null {
	const s = m.state;
	if (typeof s !== "object" || s === null) return null;
	const st = s as Record<string, unknown>;
	if (
		!Array.isArray(st.tasks) ||
		!Array.isArray(st.projects) ||
		typeof st.serverVersion !== "string"
	)
		return null;
	return { type: "state", state: st as unknown as StateResponse }; // server-produced frame; the fields the UI dereferences first are checked above
}

/** The "system" frame, when its system field carries at, containers, vm and holds. */
function systemMessage(m: Record<string, unknown>): ServerMessage | null {
	const s = m.system;
	if (typeof s !== "object" || s === null) return null;
	const sy = s as Record<string, unknown>;
	if (
		typeof sy.at !== "number" ||
		!Array.isArray(sy.containers) ||
		typeof sy.vm !== "object" ||
		sy.vm === null ||
		typeof sy.holds !== "object" ||
		sy.holds === null
	)
		return null;
	return { type: "system", system: sy as unknown as SystemSnapshot }; // server-produced frame; the fields the UI dereferences first are checked above
}

/** The "update" frame, when behind is a finite number and commits is a string list. */
function updateMessage(m: Record<string, unknown>): ServerMessage | null {
	if (
		typeof m.behind !== "number" ||
		!Number.isFinite(m.behind) ||
		!Array.isArray(m.commits) ||
		!m.commits.every((c) => typeof c === "string")
	)
		return null;
	return { type: "update", behind: m.behind, commits: m.commits };
}

/** The "log" frame, when project and id are strings. */
function logMessage(m: Record<string, unknown>): ServerMessage | null {
	if (typeof m.project !== "string" || typeof m.id !== "string") return null;
	return { type: "log", project: m.project, id: m.id };
}

/** Exponential backoff with a 5 s ceiling: 500, 1000, 2000, 4000, then 5000 forever. */
export function reconnectDelay(attempt: number): number {
	return Math.min(5000, 500 * 2 ** attempt);
}

/** Events the socket fans out to components that don't hold the handlers (system view, log views, resync). */
export const liveEvents = new EventTarget();

let lastSystem: SystemSnapshot | null = null;

/** The last pushed system snapshot, so a component mounting between frames renders immediately. */
export function latestSystem(): SystemSnapshot | null {
	return lastSystem;
}

let lastQuota: QuotaState | null = null;

/** The last pushed usage quota (rides every state push), so a mounting picker renders immediately. */
export function latestQuota(): QuotaState | null {
	return lastQuota;
}

/** One push-only socket per call; the server ignores inbound frames, so we never send. Returns a disposer. */
export function connectLive(h: LiveHandlers): () => void {
	let ws: WebSocket | null = null;
	let attempt = 0;
	let reconnect: ReturnType<typeof setTimeout> | undefined;
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	let connectTimeout: ReturnType<typeof setTimeout> | undefined;
	let dropped = false; // an error is followed by close; handle the drop once
	let disposed = false;

	/** Detach and close a socket we are done with, so its late events can never reach the handlers. */
	const abandon = (socket: WebSocket): void => {
		socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
		socket.close();
	};

	/** Treat any lost connection uniformly: notify with the cause, then reconnect with backoff. */
	const drop = (reason: OfflineReason): void => {
		if (dropped || disposed) return;
		dropped = true;
		clearTimeout(connectTimeout);
		clearTimeout(watchdog);
		const delay = reconnectDelay(attempt++);
		h.onOffline({ reason, retryMs: delay });
		reconnect = setTimeout(() => {
			if (!disposed) ws = open();
		}, delay);
	};

	const armWatchdog = (): void => {
		clearTimeout(watchdog);
		watchdog = setTimeout(() => {
			if (ws !== null) abandon(ws); // the silent socket must be closed or it leaks and could revive
			drop("watchdog");
		}, 15000); // the server pings every 5 s, so silence means death
	};

	const open = (): WebSocket => {
		// Only place touching browser globals, so bun test can import this module.
		const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`;
		const socket = new WebSocket(url);
		dropped = false;
		// A dead server's port can stay LISTENing on Windows, so a connect can hang instead of failing.
		connectTimeout = setTimeout(() => {
			if (socket.readyState !== WebSocket.OPEN) {
				abandon(socket); // detach first: the late close event must not fire drop() again
				drop("connect-timeout");
			}
		}, 5000);
		socket.onopen = () => {
			clearTimeout(connectTimeout);
			attempt = 0;
			armWatchdog();
			h.onOnline();
			liveEvents.dispatchEvent(new Event("open"));
		};
		socket.onmessage = (e) => {
			armWatchdog();
			const msg = parseServerMessage(e.data);
			if (msg === null) return; // unparseable frames are ignored
			switch (msg.type) {
				case "state":
					lastQuota = msg.state.quota;
					liveEvents.dispatchEvent(new Event("quota"));
					h.onState(msg.state);
					break;
				case "update":
					h.onUpdate(msg.behind, msg.commits);
					break;
				case "system":
					lastSystem = msg.system;
					liveEvents.dispatchEvent(
						new CustomEvent("system", { detail: msg.system }),
					);
					break;
				case "log":
					liveEvents.dispatchEvent(
						new CustomEvent("log", {
							detail: { project: msg.project, id: msg.id },
						}),
					);
					break;
				case "ping":
					break; // watchdog already reset above
			}
		};
		// A socket abandoned above must not re-drop once its close event lands late.
		socket.onerror = () => {
			if (socket === ws) drop("error");
		};
		socket.onclose = () => {
			if (socket === ws) drop("close");
		};
		return socket;
	};

	ws = open();

	return () => {
		disposed = true;
		clearTimeout(connectTimeout);
		clearTimeout(watchdog);
		clearTimeout(reconnect);
		if (ws !== null) {
			abandon(ws);
			ws = null;
		}
	};
}

const POLL_MS = 5000;
const UPDATE_MS = 300_000;

/** Set only while a polling connection is live; refreshState routes through it. */
let pollNow: (() => void) | null = null;

/** Poll right now after a successful mutation (production mode has no pushed frames). The
 * cadence restarts at the refresh. No-op in live mode and after dispose. */
export function refreshState(): void {
	pollNow?.();
}

/** Prod board polls instead of holding a socket: the server refuses the socket in production mode. */
export function connectPolling(h: LiveHandlers): () => void {
	let disposed = false;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let updateTimer: ReturnType<typeof setTimeout> | undefined;

	let inFlight = false;
	let dirty = false;
	let flight: AbortController | null = null;
	let abortTimer: ReturnType<typeof setTimeout> | undefined;
	const poll = (): void => {
		if (disposed) return;
		// Overlap guard: a tick or a mutation-driven refresh during a running poll only
		// marks dirty; the flight's end then runs exactly one follow-up poll.
		if (inFlight) {
			dirty = true;
			return;
		}
		inFlight = true;
		// The guard holds every later tick, so a flight that never settles would stall
		// the board forever (a browser fetch has no default timeout). Abort the flight
		// after POLL_MS — a localhost poll outliving the cadence means a dead server —
		// and let its rejection report offline; the same mark's tick then re-polls.
		flight = new AbortController();
		const { signal } = flight;
		// State and system ride in parallel: the system snapshot no longer waits for
		// the state response, and a failed state poll never skips it.
		const stateReq = fetch("/api/state", { signal })
			.then(async (r) => {
				if (!r.ok) {
					// The failed /api/state carries its status, so onOffline can gate on it
					// without fetching /api/state a second time.
					h.onOffline({ status: r.status, retryMs: POLL_MS });
					return;
				}
				const state = (await r.json()) as StateResponse;
				lastQuota = state.quota;
				liveEvents.dispatchEvent(new Event("quota"));
				h.onState(state);
				h.onOnline();
				liveEvents.dispatchEvent(new Event("open"));
			})
			// Transport failure (network error, abort, bad JSON, a throw in a handler):
			// no HTTP status exists. Status 0 tells the App this cannot be a session
			// loss, so it reports the banner without probing /api/state again. An
			// aborted flight is a timeout fact; any other rejection is a plain
			// transport error.
			.catch((e: unknown) =>
				h.onOffline({
					reason:
						e instanceof DOMException && e.name === "AbortError"
							? "timeout"
							: "error",
					status: 0,
					retryMs: POLL_MS,
				}),
			);
		const systemReq = fetch("/api/system", { signal })
			.then(async (sr) => {
				if (!sr.ok) return;
				const system = (await sr.json()) as SystemSnapshot;
				lastSystem = system;
				liveEvents.dispatchEvent(new CustomEvent("system", { detail: system }));
			})
			.catch(() => {});
		void Promise.all([stateReq, systemReq]).then(() => {
			inFlight = false;
			clearTimeout(abortTimer);
			if (disposed || !dirty) return;
			dirty = false;
			poll();
		});
		abortTimer = setTimeout(() => flight?.abort(), POLL_MS);
		// Reschedule at call time: the cadence stays fixed even when a response is slow.
		pollTimer = setTimeout(poll, POLL_MS);
	};

	const pollUpdate = (): void => {
		if (disposed) return;
		updateTimer = setTimeout(() => {
			if (disposed) return;
			void fetch("/api/update")
				.then(async (r) => {
					// trusted same-origin endpoint documented as { behind: number; commits: string[] }
					const body = (await r.json()) as {
						behind: number;
						commits: string[];
					};
					if (r.ok) h.onUpdate(body.behind, body.commits);
				})
				.catch(() => {}); // next window retries
			pollUpdate();
		}, UPDATE_MS);
	};

	pollNow = () => {
		clearTimeout(pollTimer);
		// poll reschedules at call time, so the next timed poll lands POLL_MS after the refresh.
		poll();
	};

	poll();
	pollUpdate();

	return () => {
		disposed = true;
		pollNow = null;
		clearTimeout(pollTimer);
		// Without this, a later abort would reject the abandoned fetch and fire
		// onOffline after dispose.
		clearTimeout(abortTimer);
		clearTimeout(updateTimer);
	};
}
