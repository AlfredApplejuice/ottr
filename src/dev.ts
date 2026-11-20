// A board for UI work, e.g. impeccable live: each start gets its own fresh scratch root under
// .dev/ (OTTR_DEV_ROOT pins it) and no agent runs.
// Never `bun start` in a checkout for this: it adopts every project in the parent folder, marks the
// live board's running turns "tracker restarted" and queues them again, so they run twice.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Scratch root for this board: OTTR_DEV_ROOT pins it (deterministic e2e/CI runs);
 * otherwise every spawn gets its own mkdtemp root under .dev/, so two dev boards in
 * one checkout never share a seeded database and a crashed board cannot hold the
 * seed lock (OTTR-676). Called from bootstrap only: module import stays side-effect-free.
 */
export function devRoot(): string {
	const pinned = process.env.OTTR_DEV_ROOT;
	if (pinned) return pinned;
	const dev = resolve(import.meta.dir, "..", ".dev");
	mkdirSync(dev, { recursive: true });
	return mkdtempSync(join(dev, "board-"));
}

/**
 * Seeds the scratch root, points the env at it, and loads the server. Entry-only behavior,
 * exported so dev.test.ts can drive it behind mocks. Importing this module runs nothing:
 * Stryker's bun runner eagerly imports every mutated file to prime per-test coverage
 * (coverage-preload.js in @hughescr/stryker-bun-runner 1.6), and side effects there would
 * seed demo data and leak env into every test file before any test installs its mocks.
 */
export async function bootstrap(): Promise<void> {
	process.env.PORT ??= "5747"; // outside 4700-4899, where scripts/e2e-steer.js picks its ports
	const { heldDb, seedDemo, seedDemoOmp, startDemoAlate } = await import(
		"../scripts/demo-data.ts"
	);
	let root = devRoot();
	// A board that still runs on a pinned OTTR_DEV_ROOT holds its dbs under an exclusive
	// lock, and server.ts refuses a second instance. This board then seeds its own root
	// per port, so it boots beside the other one. A fresh root is never held: no other
	// board knows its mkdtemp name.
	const held = heldDb(root);
	if (held !== null) {
		root = resolve(import.meta.dir, "..", `.dev-${process.env.PORT}`);
		console.warn(
			`dev board: ${held} is held by another board; seeding ${root} instead`,
		);
	}
	// Full demo pool for design work: five projects with backdated tasks, turns and events.
	// A pinned OTTR_DEV_ROOT seeds once; `bun scripts/demo-data.ts <root> --force` rebuilds it.
	// An unpinned root is fresh every spawn, so every board seeds its own pool.
	await seedDemo(root);
	process.env.OMP_TRACKER_ROOTS = root;
	process.env.OTTR_STATE_DIR ??= resolve(root, "state");
	// The Settings Env section reads <home>/.ottr/workers/<project>/env.txt; the dev board
	// reads this fixture home instead of the real one, so demo names never touch a live home.
	process.env.OTTR_WORKERS_HOME ??= resolve(root, "workers-home");
	{
		const home = process.env.OTTR_WORKERS_HOME;
		for (const [project, names] of [
			["_all", ["GODOT_EXPERIMENT", "MQTT_HOST plain"]],
			["pixelforge", ["PIXELLAB_API_KEY"]],
		] as const) {
			const dir = resolve(home, ".ottr", "workers", project);
			mkdirSync(dir, { recursive: true });
			writeFileSync(resolve(dir, "env.txt"), `${names.join("\n")}\n`);
		}
	}
	// Settings → Provider sign-in reads omp's store and Model roles reads alate: the dev board
	// gets an invented store and a loopback stand-in alate, never the real home's sign-ins.
	process.env.PI_CODING_AGENT_DIR = seedDemoOmp(root);
	process.env.ALATE_URL = startDemoAlate(root);
	process.env.ALATE_API_KEY = "demo-key";
	// Fabricated running/preparing cards must survive recoverRestarted and sweepLostTurns, and
	// queued ones must never start: no agent processes exist here. OTTR_DEMO blocks all three.
	process.env.OTTR_DEMO = "1";
	// The quota chips need a usage report; the dev board has no omp sign-in, so fetchQuota
	// reads this one instead of spawning `omp usage --json`.
	const hour = 3600_000;
	process.env.OTTR_DEMO_USAGE = JSON.stringify({
		reports: [
			{
				provider: "anthropic",
				metadata: { planType: "max" },
				limits: [
					{
						label: "Claude 5 Hour",
						window: {
							id: "5h",
							label: "5 Hour",
							resetsAt: Date.now() + 2 * hour,
						},
						amount: { usedFraction: 0.42 },
					},
					{
						label: "Claude 7 Day",
						window: {
							id: "7d",
							label: "7 Day",
							resetsAt: Date.now() + 70 * hour,
						},
						amount: { usedFraction: 0.81 },
					},
				],
				resetCredits: { availableCount: 0, credits: [] },
			},
			{
				provider: "openai-codex",
				limits: [
					{
						label: "Codex 5 Hour",
						window: {
							id: "5h",
							label: "5 Hour",
							resetsAt: Date.now() + 4 * hour,
						},
						amount: { usedFraction: 0.12 },
					},
					// Used up: the picker's "limit · back in …" state, and the reason the demo
					// card "Tune the presence sensor debounce" waits (scripts/demo-data.ts usageHold).
					{
						label: "Codex 7 Day",
						window: {
							id: "7d",
							label: "7 Day",
							resetsAt: Date.now() + 0.7 * hour,
						},
						amount: { usedFraction: 1 },
					},
				],
				resetCredits: {
					availableCount: 2,
					credits: [
						{
							expiresAt: new Date(Date.now() + 12 * 24 * hour).toISOString(),
							status: "available",
						},
						{
							expiresAt: new Date(Date.now() + 26 * 24 * hour).toISOString(),
							status: "available",
						},
					],
				},
			},
		],
	});
	// The header shows n/∞ by default, as on a board with no cap; an explicit
	// OMP_TRACKER_MAX_TOTAL (a shot of the Slots meter needs a cap) wins.
	process.env.OMP_TRACKER_MAX_TOTAL ??= "none";
	// Opts into Bun's HTML dev server (HMR); see the development flag in server.ts.
	process.env.NODE_ENV ??= "development";
	// Dynamic on purpose: server.ts reads the env and scans the roots while it loads, and a static
	// import would load it before the lines above run.
	await import("./server.ts");
}

if (import.meta.main) await bootstrap();
