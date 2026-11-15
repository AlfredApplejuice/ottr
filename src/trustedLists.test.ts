import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { projectTrustedLists, turnListHome } from "./trustedLists.ts";

const root = mkdtempSync(join(tmpdir(), "ottr-trusted-lists-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Plants one list file the way alate's provisioning lays it out. */
const plant = (home: string, dir: string, file: string, text: string): void => {
	const d = join(home, ".ottr", "workers", dir);
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, file), text);
};

describe("projectTrustedLists", () => {
	test("reads every present list through the real path helpers and omits the missing ones", () => {
		const home = mkdtempSync(join(root, "read-"));
		plant(home, "proj", "tools.json", '[{"name":"t","url":"u","sha256":"s"}]');
		plant(home, "proj", "apt.txt", "jq\n");
		plant(home, "proj", "requirements.txt", "r==1\n");
		plant(home, "_all", "tools.json", '[{"name":"a","url":"u","sha256":"s"}]');
		plant(home, "_all", "requirements.txt", "q==2\n");
		// The fleet apt list has no consumer (src/apt.ts reads the project's only),
		// so planting one must not leak into the request either.
		plant(home, "_all", "apt.txt", "never\n");
		expect(projectTrustedLists("proj", home)).toEqual({
			tools: '[{"name":"t","url":"u","sha256":"s"}]',
			toolsAll: '[{"name":"a","url":"u","sha256":"s"}]',
			apt: "jq\n",
			requirements: "r==1\n",
			requirementsAll: "q==2\n",
		});
	});

	test("a home with no lists answers an empty object, never empty-string fields", () => {
		const home = mkdtempSync(join(root, "empty-"));
		expect(projectTrustedLists("proj", home)).toEqual({});
	});

	test("list reads follow the home's current agent layer, like the board's own reads", () => {
		const home = mkdtempSync(join(root, "layered-"));
		const layer = join(home, ".alate", "layers", "lay1");
		mkdirSync(layer, { recursive: true });
		symlinkSync(join("layers", "lay1"), join(home, ".alate", "current"));
		plant(layer, "proj", "tools.json", "layer-tools\n");
		// The flat home holds a different list: the layer wins, the flat one is unread.
		plant(home, "proj", "tools.json", "flat-tools\n");
		const lists = projectTrustedLists("proj", home);
		expect(lists.tools).toBe("layer-tools\n");
		expect(JSON.stringify(lists)).not.toContain("flat-tools");
	});

	test("an unsafe project name throws before any read", () => {
		expect(() => projectTrustedLists("../victim", root)).toThrow();
	});
});

describe("turnListHome", () => {
	test("OTTR_WORKERS_HOME overrides, an unset name falls back to boardOmpHome()", () => {
		const workers = mkdtempSync(join(root, "wh-"));
		const board = mkdtempSync(join(root, "bh-"));
		const savedWorkers = process.env.OTTR_WORKERS_HOME;
		const savedBoard = process.env.OTTR_BOARD_OMP_HOME;
		try {
			process.env.OTTR_BOARD_OMP_HOME = board;
			delete process.env.OTTR_WORKERS_HOME;
			expect(turnListHome()).toBe(resolve(board));
			process.env.OTTR_WORKERS_HOME = workers;
			expect(turnListHome()).toBe(workers);
			// The list read resolves against the same home the override names.
			plant(workers, "proj", "apt.txt", "override\n");
			expect(projectTrustedLists("proj").apt).toBe("override\n");
		} finally {
			if (savedWorkers === undefined) delete process.env.OTTR_WORKERS_HOME;
			else process.env.OTTR_WORKERS_HOME = savedWorkers;
			if (savedBoard === undefined) delete process.env.OTTR_BOARD_OMP_HOME;
			else process.env.OTTR_BOARD_OMP_HOME = savedBoard;
		}
	});
});
