import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import fc from "../test/properties.ts";
import { filterSettings, settingsMatch } from "./settingsSearch.ts";

const literalReference = (
	query: string,
	fields: readonly string[],
): boolean => {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return true;
	for (const field of fields) {
		if (field.toLowerCase().indexOf(needle) !== -1) return true;
	}
	return false;
};

const token = fc
	.array(fc.constantFrom(..."aBcDeF019.*+?[](){}^$|\\-_/"), {
		minLength: 1,
		maxLength: 24,
	})
	.map((chars) => chars.join(""));

describe("settingsMatch", () => {
	test("literal punctuation, empty queries, and field boundaries agree with the reference", () => {
		const examples: [string, string[], boolean][] = [
			["FIRECRACKER", ["Each work turn uses Firecracker"], true],
			[" \t microVm \n", ["microVm"], true],
			[".*", ["ordinary words"], false],
			[".*", ["literal .* punctuation"], true],
			["[", ["an unmatched [ bracket"], true],
			["[", ["plain text"], false],
			["a+b", ["AAAB"], false],
			["^$", [""], false],
			["", [], true],
			[" \t\n", [""], true],
			["x", [""], false],
			["runner cap", ["runner", "cap"], false],
			["nercap", ["runner", "cap"], false],
			["cap", ["unrelated", "Runner cap"], true],
		];
		for (const [query, fields, expected] of examples) {
			expect(literalReference(query, fields)).toBe(expected);
			expect(settingsMatch(query, fields)).toBe(expected);
		}
	});

	test("arbitrary queries and separate fields agree with literal contains", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 80 }),
				fc.array(fc.string({ maxLength: 120 }), { maxLength: 6 }),
				(query, fields) => {
					expect(settingsMatch(query, fields)).toBe(
						literalReference(query, fields),
					);
				},
			),
		);
	});

	test("contains matches survive mixed case and query-edge whitespace", () => {
		fc.assert(
			fc.property(
				token,
				fc.string({ maxLength: 30 }),
				fc.string({ maxLength: 30 }),
				fc.array(fc.string({ maxLength: 30 }), { maxLength: 3 }),
				(needle, prefix, suffix, unrelated) => {
					const mixed = [...needle]
						.map((char, index) =>
							index % 2 === 0 ? char.toUpperCase() : char.toLowerCase(),
						)
						.join("");
					const query = ` \t${mixed}\n `;
					const fields = [...unrelated, `${prefix}${needle}${suffix}`];
					expect(settingsMatch(query, fields)).toBe(true);
					expect(settingsMatch(query, fields)).toBe(
						literalReference(query, fields),
					);
				},
			),
		);
	});

	test("a match cannot cross separate field boundaries", () => {
		fc.assert(
			fc.property(token, token, (left, right) => {
				const fields = [left, right];
				const query = `${left} ${right}`;
				expect(settingsMatch(query, fields)).toBe(false);
				expect(settingsMatch(query, fields)).toBe(
					literalReference(query, fields),
				);
			}),
		);
	});
});

describe("filterSettings", () => {
	test("search and clear preserve native hidden rows, blocks, cards, groups, and controls", () => {
		const document = new Window().document;
		const root = document.createElement("div") as unknown as HTMLElement;
		root.innerHTML = `
			<div class="settings-group">
				<section class="settings-sec" id="visible-card">
					<div class="alate-def-row" id="visible-row">
						<div class="alate-def-name"><b>Public setting</b></div>
						<input id="hidden-control" hidden>
					</div>
					<div class="alate-def-row" id="hidden-row" hidden>
						<div class="alate-def-name"><b>Private setting</b></div>
					</div>
					<div class="sec-block" id="hidden-block" hidden>
						<div class="alate-def-row">
							<div class="alate-def-name"><b>Public setting</b></div>
						</div>
					</div>
				</section>
				<section class="settings-sec" id="hidden-card" hidden>
					<div class="sec-head"><h3>Public setting</h3></div>
				</section>
			</div>
			<div class="settings-group" id="hidden-group" hidden>
				<section class="settings-sec" id="group-card">
					<div class="sec-head"><h3>Public setting</h3></div>
				</section>
			</div>`;
		const nativeHidden = [
			"hidden-control",
			"hidden-row",
			"hidden-block",
			"hidden-card",
			"hidden-group",
		].map((id) => {
			const element = root.querySelector<HTMLElement>(`#${id}`);
			if (element === null) throw new Error(`Missing fixture ${id}`);
			return element;
		});
		const publicRow = root.querySelector<HTMLElement>("#visible-row");
		if (publicRow === null) throw new Error("Public row missing");

		for (const query of [
			"Private setting",
			"no match",
			"Public setting",
			"",
			" \t ",
		]) {
			filterSettings(root, query);
			for (const element of nativeHidden) expect(element.hidden).toBe(true);
			expect(publicRow.hidden).toBe(
				query === "Private setting" || query === "no match",
			);
		}
	});

	test("Jira Connections rowless block keeps its mixed card visible without indexing saved list values", () => {
		const document = new Window().document;
		const root = document.createElement("div") as unknown as HTMLElement;
		root.innerHTML = `
			<div class="settings-group" id="jira-group">
				<section class="settings-sec" id="jira-section">
					<div class="sec-head"><h3>Jira connections</h3></div>
					<div class="sec-block" id="connections-block">
						<h4>Connections</h4>
						<ul class="jira-conns" id="saved-list">
							<li class="jira-conn">
								<div class="jira-conn-text">
									<b>saved-value-only-marker</b>
									<span><code>https://jira.example.com</code></span>
								</div>
							</li>
						</ul>
					</div>
					<div class="sec-block" id="editor-block">
						<h4>Add connection</h4>
						<form class="settings-form" id="editor-form">
							<div class="alate-def-rows">
								<div class="alate-def-row" data-setting-key="name">
									<div class="alate-def-name"><b>Name</b></div>
									<input aria-label="Name">
								</div>
								<div class="alate-def-row" data-setting-key="site">
									<div class="alate-def-name"><b>Site URL</b></div>
									<input aria-label="Site URL">
								</div>
							</div>
						</form>
					</div>
				</section>
			</div>`;
		const element = (id: string): HTMLElement => {
			const node = root.querySelector<HTMLElement>(`#${id}`);
			if (node === null) throw new Error(`Missing fixture ${id}`);
			return node;
		};
		const rows = [...root.querySelectorAll<HTMLElement>(".alate-def-row")];

		expect([...filterSettings(root, "connections")]).toEqual(["jira-section"]);
		expect(element("jira-group").hidden).toBe(false);
		expect(element("jira-section").hidden).toBe(false);
		expect(element("connections-block").hidden).toBe(false);
		expect(element("saved-list").closest("[hidden]")).toBeNull();
		expect(element("editor-block").hidden).toBe(true);
		expect(element("editor-form").hidden).toBe(true);
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row.hidden).toBe(true);

		expect([...filterSettings(root, "saved-value-only-marker")]).toEqual([]);
		expect(element("jira-group").hidden).toBe(true);
		expect(element("jira-section").hidden).toBe(true);
		expect(element("connections-block").hidden).toBe(true);
		expect(element("saved-list").closest("[hidden]")).not.toBeNull();
		expect(element("editor-form").hidden).toBe(true);
		for (const row of rows) expect(row.hidden).toBe(true);

		expect([...filterSettings(root, "")]).toEqual(["jira-section"]);
		expect(element("saved-list").closest("[hidden]")).toBeNull();
		expect(element("editor-form").closest("[hidden]")).toBeNull();
		for (const row of rows) expect(row.closest("[hidden]")).toBeNull();
	});

	test("rowless action cards match safe header text but exclude body text and values", () => {
		const document = new Window().document;
		const root = document.createElement("div") as unknown as HTMLElement;
		root.innerHTML = `
			<div class="settings-group">
				<section class="settings-sec" id="action-card">
					<div class="sec-head">
						<div class="sec-title">
							<h3>Local access</h3>
							<span class="state-chip">state-only-marker</span>
						</div>
						<p class="hint">
							Create a link for desktop tools.
							<input value="input-value-marker">
							<textarea>textarea-value-marker</textarea>
							<select><option>option-value-marker</option></select>
							<button type="button">button-only-marker</button>
							<span role="status">status-only-marker</span>
							<span role="alert">alert-only-marker</span>
						</p>
					</div>
					<p class="hint">body-only-marker</p>
					<code>displayed-value-marker</code>
					<button type="button" id="action">Create link</button>
				</section>
			</div>`;
		const card = root.querySelector<HTMLElement>("#action-card");
		const action = root.querySelector<HTMLButtonElement>("#action");
		if (card === null || action === null)
			throw new Error("Action card missing");

		for (const query of ["Local access", "desktop tools"]) {
			expect([...filterSettings(root, query)]).toEqual(["action-card"]);
			expect(action.closest("[hidden]")).toBeNull();
		}
		for (const query of [
			"body-only-marker",
			"displayed-value-marker",
			"input-value-marker",
			"textarea-value-marker",
			"option-value-marker",
			"button-only-marker",
			"state-only-marker",
			"status-only-marker",
			"alert-only-marker",
		]) {
			expect([...filterSettings(root, query)]).toEqual([]);
			expect(card.hidden).toBe(true);
		}
		expect([...filterSettings(root, "")]).toEqual(["action-card"]);
		expect(action.closest("[hidden]")).toBeNull();
	});
});
