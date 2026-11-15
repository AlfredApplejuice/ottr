/**
 * The board's trusted provisioning lists (docs/specs/vm-list-isolation.md): raw
 * texts read from the board home through the same layer-resolving path helpers
 * the board's own provisioning reads use, then sent on the dispatch. Nothing on
 * this path reads the worker-writable shared home (R5-1, docs/WORKERS.md).
 */
import { readFileSync } from "node:fs";
import { aptListPath } from "./apt.ts";
import { boardOmpHome } from "./login.ts";
import { requirementsListPath } from "./python.ts";
import { toolsListPath } from "./tools.ts";
import type { ProvisionLists } from "./workers.ts";

/** The home the board reads its lists from: the dev override, else the board's
 * own home — the exact resolution server.ts's prepareTurn uses. */
export const turnListHome = (): string =>
	process.env.OTTR_WORKERS_HOME ?? boardOmpHome();

/** The file's text, or undefined when it is missing (never an empty string). */
const readIfPresent = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};

/** The project's trusted lists: every list file the home holds, raw; a missing
 * file omits its field. apt reads the project list only (src/apt.ts), so there
 * is no aptAll read. `_all` shares the tools and requirements lists. */
export function projectTrustedLists(
	project: string,
	home: string = turnListHome(),
): ProvisionLists {
	const lists: ProvisionLists = {};
	const tools = readIfPresent(toolsListPath(project, home));
	if (tools !== undefined) lists.tools = tools;
	const toolsAll = readIfPresent(toolsListPath("_all", home));
	if (toolsAll !== undefined) lists.toolsAll = toolsAll;
	const apt = readIfPresent(aptListPath(project, home));
	if (apt !== undefined) lists.apt = apt;
	const requirements = readIfPresent(requirementsListPath(project, home));
	if (requirements !== undefined) lists.requirements = requirements;
	const requirementsAll = readIfPresent(requirementsListPath("_all", home));
	if (requirementsAll !== undefined) lists.requirementsAll = requirementsAll;
	return lists;
}
