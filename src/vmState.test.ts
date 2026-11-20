import { describe, expect, test } from "bun:test";
import {
	VM_BUSY_HOLD,
	VM_UNCONFIGURED,
	type VmRunnerHealth,
	vmHoldFor,
} from "./vmState.ts";

const ok: VmRunnerHealth = { configured: true, ok: true, reason: null };
const down: VmRunnerHealth = {
	configured: true,
	ok: false,
	reason: "connection refused",
};

describe("vmHoldFor", () => {
	test("microVM off holds nothing", () => {
		expect(
			vmHoldFor(false, "p", "t1", ok, new Set(), { busy: 1, max: 1 }, 1),
		).toBeNull();
	});

	test("a down runner names its reason", () => {
		expect(
			vmHoldFor(true, "p", "t1", down, new Set(), { busy: 0, max: 1 }, 0),
		).toBe("waiting for the microVM runner: connection refused");
		expect(
			vmHoldFor(
				true,
				"p",
				"t1",
				{ configured: false, ok: false, reason: VM_UNCONFIGURED },
				new Set(),
				{ busy: 0, max: 1 },
				0,
			),
		).toBe(`waiting for the microVM runner: ${VM_UNCONFIGURED}`);
	});

	test("the busy answer's own mark names the hold", () => {
		expect(
			vmHoldFor(true, "p", "t1", ok, new Set(["p/t1"]), { busy: 0, max: 1 }, 0),
		).toBe(VM_BUSY_HOLD);
		expect(
			vmHoldFor(true, "p", "t2", ok, new Set(["p/t1"]), { busy: 0, max: 1 }, 0),
		).toBeNull();
	});

	test("a full pool holds every microVM card, marked or not (OTTR-1142)", () => {
		expect(
			vmHoldFor(true, "p", "t2", ok, new Set(), { busy: 1, max: 1 }, 0),
		).toBe(VM_BUSY_HOLD);
		expect(
			vmHoldFor(true, "p", "t2", ok, new Set(), { busy: 3, max: 2 }, 0),
		).toBe(VM_BUSY_HOLD);
		// The board's own claims fill the pool: the same signal the start gate reads.
		expect(
			vmHoldFor(true, "p", "t2", ok, new Set(), { busy: 0, max: 2 }, 2),
		).toBe(VM_BUSY_HOLD);
	});

	test("a free pool holds nothing without a mark", () => {
		expect(
			vmHoldFor(true, "p", "t2", ok, new Set(), { busy: 0, max: 1 }, 0),
		).toBeNull();
		expect(
			vmHoldFor(true, "p", "t2", ok, new Set(), { busy: 1, max: 2 }, 0),
		).toBeNull();
	});

	test("an unknown pool size falls back to the busy mark only", () => {
		expect(
			vmHoldFor(true, "p", "t2", ok, new Set(), { busy: 0, max: 0 }, 5),
		).toBeNull();
		expect(
			vmHoldFor(true, "p", "t1", ok, new Set(["p/t1"]), { busy: 0, max: 0 }, 0),
		).toBe(VM_BUSY_HOLD);
	});
});
