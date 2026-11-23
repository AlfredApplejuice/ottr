import { shortTitle } from "./prompts.ts";

// The review lead prompt contract (docs/specs/review-findings-persistence.md §4).
// A lead is a `Needs validation` finding the review pass records through
// propose_task, the turn's own result channel; the board reads the prompt's
// fixed lines with the strict readers below.
//
// OTTR-980: the pass reads no audit run directory. The run directories live on
// the worker-shared home (/root/security-audit-skill), where every classic
// worker mounts the volume read-write and every turn runs as root, so a planted
// run-N directory with a chosen mtime inside the turn window could forge or
// suppress another project's leads, and a planted FIFO as findings.json could
// block the board's thread. The review prompt instead tells the agent to put
// the audit record's fingerprint on the prompt's second line, before any
// record prose that could forge it.

/** A lead's audit fingerprint, read from its fixed line `Fingerprint: <value>`
 * (docs/specs/review-findings-persistence.md §4; the value is the record's
 * fingerprint from the security-audit-harness audit output). Strict: the first
 * line that carries the exact prefix decides, so a forged line in the record
 * body never beats the board's line 2 — an empty value reads as null instead of
 * falling through to a later line. Null: the lead carries no line and dedupes
 * by title only. */
export function leadFingerprint(prompt: string): string | null {
	const line = prompt.split("\n").find((l) => l.startsWith("Fingerprint: "));
	if (line === undefined) return null;
	const value = line.slice("Fingerprint: ".length).trim();
	return value === "" ? null : value;
}

/** The review prompt's bare lead tag line (OTTR-1164): "Needs validation"
 * alone on line 1. The older shape put the subject on line 1
 * ("Needs validation: <subject>"); the current prompt wording produces the
 * bare tag and the "## Claim" section below it. */
const LEAD_TAG = "Needs validation";

/** The subject of a lead whose prompt carries the bare tag line: the first
 * content line of the "## Claim" section, else the first line that is not the
 * tag, a `Fingerprint:` line, a heading, or blank (docs/specs/
 * review-findings-persistence.md "Lead title"). Null: any other prompt shape —
 * for example the older "Needs validation: <subject>" first line — or a
 * bare-tag prompt with no content line at all; the caller keeps the plain
 * first-line title then. */
export function leadSubject(prompt: string): string | null {
	const lines = prompt.split("\n").map((line) => line.trim());
	if (lines[0] !== LEAD_TAG) return null;
	const isContent = (line: string) =>
		line !== "" && !line.startsWith("#") && !line.startsWith("Fingerprint: ");
	const claim = lines.findIndex(
		(line, index) => index > 0 && /^#{1,6}\s+Claim$/.test(line),
	);
	if (claim !== -1) {
		const subject = lines.slice(claim + 1).find(isContent);
		if (subject !== undefined) return subject;
	}
	return lines.slice(1).find(isContent) ?? null;
}

/** A bare-tag lead's board title: "Needs validation: <subject>", cut with
 * shortTitle at 80 characters like every other prompt-derived title. Null: no
 * subject — the plain tag stays the title (docs/specs/
 * review-findings-persistence.md "Lead title"). */
export function leadCardTitle(prompt: string): string | null {
	const subject = leadSubject(prompt);
	return subject === null ? null : shortTitle(`${LEAD_TAG}: ${subject}`, 80);
}

/** A lead card's title key for the fingerprint-less dedupe: the subject title
 * for a bare-tag lead, else the prompt's first line; lower-cased, with runs of
 * whitespace collapsed to one space and trimmed (docs/specs/
 * review-findings-persistence.md "Lead title dedupe"). The subject keeps two
 * fingerprint-less leads with different claims on different keys, so neither
 * dedupes the other away (OTTR-1164). */
export function leadTitleKey(prompt: string): string {
	const subject = leadSubject(prompt);
	const line =
		subject === null
			? (prompt.split("\n")[0] ?? "")
			: `${LEAD_TAG}: ${subject}`;
	return line.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The minimal query surface both store backends expose (the SQLite wrapper
 * the store opens and the PostgreSQL wrapper in postgresDriver.ts share the
 * shape). */
interface LeadStoreDb {
	run(text: string, ...params: unknown[]): Promise<unknown>;
	query<Row, Params extends unknown[]>(
		text: string,
	): {
		all: (...params: Params) => Promise<Row[]>;
	};
}

/** OTTR-1164: leads filed while the review prompt put only the bare tag on
 * line 1 kept "Needs validation" as their whole title. Both store backends run
 * this step on open: every open card (not done, not cancelled) whose title is
 * exactly the bare tag gets the subject title derived from its stored prompt.
 * A card the user renamed — any other title — keeps its title, and so do done
 * and cancelled cards. Idempotent: the new title names the claim, so the
 * bare-title match never fires again. */
export async function retitleBareLeadTitles(db: LeadStoreDb): Promise<void> {
	const rows = await db
		.query<{ id: string; prompt: string }, []>(
			"SELECT id, prompt FROM tasks WHERE title = 'Needs validation' AND stage != 'done' AND cancelled_at IS NULL",
		)
		.all();
	for (const row of rows) {
		const title = leadCardTitle(row.prompt);
		if (title === null) continue;
		await db.run("UPDATE tasks SET title = ? WHERE id = ?", [title, row.id]);
	}
}

/** A validation run's per-lead result, read from the recorded prompt's exact
 * first line `Validation: #<lead id> <outcome>` (OTTR-1047,
 * docs/specs/review-findings-persistence.md "Batch validation of leads").
 * Strict: only the first line decides, so a result line in the evidence body
 * never wins, and the outcome word is matched case-sensitively. The trimmed
 * rest of the prompt is the evidence; a one-line prompt reads as empty
 * evidence. Null: any other shape — no recorded result. Never throws. */
export function validationResult(prompt: string): {
	leadId: string;
	outcome: "confirmed" | "refuted" | "blocked" | "deployment";
	evidence: string;
} | null {
	const lines = prompt.split("\n");
	const match =
		/^Validation: #(\S+) (confirmed|refuted|blocked|deployment)$/.exec(
			lines[0] ?? "",
		);
	if (match === null) return null;
	const leadId = match[1];
	const outcome = match[2];
	if (leadId === undefined || outcome === undefined) return null;
	return {
		leadId,
		outcome: outcome as "confirmed" | "refuted" | "blocked" | "deployment",
		evidence: lines.slice(1).join("\n").trim(),
	};
}
