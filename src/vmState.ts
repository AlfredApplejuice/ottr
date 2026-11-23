/**
 * Board-side state of the microVM runner (docs/adr/0009-microvm-workers.md): the last
 * /healthz probe of OTTR_VM_RUNNER_URL and the cards whose last dispatch vm-runner refused
 * as busy. The server's probe tick and the turn loop write it; boardCards and the project
 * settings route read it.
 */
export interface VmRunnerHealth {
	/** OTTR_VM_RUNNER_URL is set (with OTTR_WORKER_TOKEN). */
	configured: boolean;
	/** The last GET /healthz answered 200. */
	ok: boolean;
	/** Why the runner cannot take turns; null while ok. */
	reason: string | null;
}

export const VM_UNCONFIGURED = "OTTR_VM_RUNNER_URL is not set";

export const vmState: {
	health: VmRunnerHealth;
	/** "project/id" of cards whose last /run got the busy answer; cleared on the next dispatch. */
	busy: Set<string>;
	/** OTTR-1142 pool state from the /healthz probe headers (x-ottr-vms-busy / -max);
	 * max 0 = unknown (a runner without the headers). */
	pool: { busy: number; max: number };
	/** OTTR-1142: claimed, unfinished microVM turns of this board; the pool start gate
	 * counts them beside the probed busy count. */
	inflight: number;
} = {
	health: { configured: false, ok: false, reason: VM_UNCONFIGURED },
	busy: new Set(),
	pool: { busy: 0, max: 0 },
	inflight: 0,
};

export const VM_BUSY_HOLD = "waiting for a free microVM";

/** The singleton's boot state, for test isolation: a suite that reads vmState resets it
 * first instead of trusting earlier test files, and leaves it pristine afterwards. */
export function resetVmState(): void {
	vmState.health = { configured: false, ok: false, reason: VM_UNCONFIGURED };
	vmState.busy = new Set();
	vmState.pool = { busy: 0, max: 0 };
	vmState.inflight = 0;
}

/**
 * The queued-card hold text for a project with microVM mode on, or null when nothing holds
 * the card back on the microVM side. A full pool holds every microVM card of the board
 * (OTTR-1142), so each waiting card names the hold on the board, not only the one card
 * whose own dispatch got the busy answer.
 */
export function vmHoldFor(
	microVm: boolean,
	project: string,
	id: string,
	health: VmRunnerHealth = vmState.health,
	busy: ReadonlySet<string> = vmState.busy,
	pool: { busy: number; max: number } = vmState.pool,
	inflight: number = vmState.inflight,
): string | null {
	if (!microVm) return null;
	if (!health.ok)
		return `waiting for the microVM runner: ${health.reason ?? "not reachable"}`;
	if (busy.has(`${project}/${id}`)) return VM_BUSY_HOLD;
	if (pool.max > 0 && (pool.busy >= pool.max || inflight >= pool.max))
		return VM_BUSY_HOLD;
	return null;
}
