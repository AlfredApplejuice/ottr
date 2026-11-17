/** Match labels, descriptions and keys as literal text, never as a pattern. */
export function settingsMatch(
	query: string,
	fields: readonly string[],
): boolean {
	const needle = query.trim().toLowerCase();
	return (
		needle === "" ||
		fields.some((field) => field.toLowerCase().includes(needle))
	);
}

const ROW = ".alate-def-row, .env-table tbody tr";
const BLOCK = ".sec-block, .alate-def-rows, .settings-form, .pending-key";
const TEXT =
	".alate-def-name > b, .alate-def-name > span, .role-name, .help-pop";
const OMIT =
	"input, textarea, select, option, button, .save-tick, .state-chip, [role='status'], [role='alert']";

/** Read only descriptive text nodes. Controls can contain saved or secret values. */
function description(element: Element): string {
	if (element.matches(OMIT)) return "";
	let text = "";
	for (const node of element.childNodes) {
		if (node.nodeType === 3) text += node.textContent ?? "";
		else if (node.nodeType === 1) text += description(node as Element);
	}
	return text;
}

function fields(row: HTMLElement): string[] {
	return [
		row.dataset.settingKey ?? "",
		...Array.from(row.querySelectorAll(TEXT), description),
	];
}

/** Restore only elements that this filter hid, not controls hidden by the page itself. */
function hide(element: HTMLElement, hidden: boolean): void {
	if (hidden && !element.hidden) {
		element.dataset.settingsSearchHidden = "";
		element.hidden = true;
	} else if (!hidden && element.hasAttribute("data-settings-search-hidden")) {
		element.hidden = false;
		delete element.dataset.settingsSearchHidden;
	}
}

function containerMatches(
	element: HTMLElement,
	rows: readonly HTMLElement[],
	query: string,
	textSelector: string,
): boolean {
	if (rows.length > 0) return rows.some((row) => !row.hidden);
	return settingsMatch(
		query,
		Array.from(element.querySelectorAll(textSelector), description),
	);
}

/** Hide settings in place so each control keeps its identity and unsaved draft. */
export function filterSettings(
	root: HTMLElement,
	query: string,
): ReadonlySet<string> {
	const visible = new Set<string>();
	const filtering = query.trim() !== "";
	for (const card of root.querySelectorAll<HTMLElement>(".settings-sec[id]")) {
		const rows = Array.from(card.querySelectorAll<HTMLElement>(ROW));
		for (const row of rows) hide(row, !settingsMatch(query, fields(row)));
		const blocks = Array.from(card.querySelectorAll<HTMLElement>(BLOCK));
		for (const block of blocks.reverse()) {
			const children = Array.from(block.querySelectorAll<HTMLElement>(ROW));
			const matches = containerMatches(
				block,
				children,
				query,
				":scope > h4, :scope > .hint",
			);
			hide(block, filtering && !matches);
		}
		// A card's title must not make all of its unrelated rows match.
		const matches =
			containerMatches(
				card,
				rows,
				query,
				":scope > .sec-head h3, :scope > .sec-head > .hint",
			) ||
			blocks.some((block) => {
				const hidden = block.closest("[hidden]");
				return hidden === null || hidden === card;
			});
		hide(card, filtering && !matches);
		if (!card.hidden && card.id !== "") visible.add(card.id);
	}
	for (const group of root.querySelectorAll<HTMLElement>(".settings-group")) {
		hide(
			group,
			filtering &&
				!Array.from(
					group.querySelectorAll<HTMLElement>(".settings-sec[id]"),
				).some((card) => !card.hidden),
		);
	}
	return visible;
}
