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

/** A lead card's title key for the fingerprint-less dedupe: the prompt's first
 * line, lower-cased, with runs of whitespace collapsed to one space and trimmed
 * (docs/specs/review-findings-persistence.md "Lead title dedupe"). */
export function leadTitleKey(prompt: string): string {
	return (prompt.split("\n")[0] ?? "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}
