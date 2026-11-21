// Guard for AGENTS.md hard stop 2's second half: a schema change that converges on
// SQLite must also land on the PostgreSQL migration surface. The PG parity test
// (src/postgresStore.test.ts) needs a real server and skips without a fixture, so a
// SQLite-only column once passed every local gate; this test reads the two schemas'
// DDL as data and fails in any container.
import { describe, expect, test } from "bun:test";
import { projectStepOne, projectStepTwo } from "./postgresSchema.ts";
import { SCHEMA } from "./store.ts";

/** Column names of one CREATE TABLE body, in order: the first token of each
 *  depth-0 comma group, constraint groups dropped. */
function columnsOfDdl(ddl: string): string[] {
	const body = ddl.slice(ddl.indexOf("(") + 1, ddl.lastIndexOf(")"));
	const groups: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of body) {
		if (ch === "(") depth += 1;
		if (ch === ")") depth -= 1;
		if (ch === "," && depth === 0) {
			groups.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	groups.push(current);
	return groups
		.map((group) => group.trim().split(/\s+/)[0]?.toLowerCase() ?? "")
		.filter(
			(name) =>
				name !== "" &&
				!["primary", "check", "foreign", "unique", "constraint"].includes(name),
		);
}

function tableColumns(ddl: string, create: string): string[] {
	const start = ddl.indexOf(create);
	expect(start).toBeGreaterThanOrEqual(0);
	const end = ddl.indexOf(");", start);
	return columnsOfDdl(ddl.slice(start, end + 2));
}

/** The ALTER TABLE pr_review ADD COLUMN names of every pure-SQL step list. A later
 *  migration step with only template SQL (schema-qualified functions) must extend
 *  this list or this test. */
function migratedColumns(): Set<string> {
	const columns = new Set<string>();
	const create = projectStepOne.find((statement) =>
		statement.startsWith("CREATE TABLE pr_review"),
	);
	expect(create).toBeDefined();
	for (const column of columnsOfDdl(create!)) columns.add(column);
	for (const statement of projectStepTwo) {
		const match = statement.match(
			/^ALTER TABLE pr_review ADD COLUMN (?:IF NOT EXISTS )?(\w+)/i,
		);
		if (match !== null) columns.add(match[1]!.toLowerCase());
	}
	return columns;
}

describe("PostgreSQL migration surface", () => {
	test("every SQLite pr_review column converges on the PostgreSQL steps", () => {
		const expected = tableColumns(
			SCHEMA,
			"CREATE TABLE IF NOT EXISTS pr_review",
		);
		expect(expected).toContain("posted_via");
		const actual = migratedColumns();
		const missing = expected.filter((column) => !actual.has(column));
		expect(missing).toEqual([]);
	});

	test("the step lists and the migration steps stay in lockstep", () => {
		// Step 1's executor consumes projectStepOne and step 2's consumes
		// projectStepTwo: the lists are the migration source of truth.
		expect(projectStepOne.length).toBeGreaterThan(0);
		expect(projectStepTwo.length).toBeGreaterThan(0);
	});
});
