// The review lead prompt contract (docs/specs/review-findings-persistence.md §4,
// "Leads come from the turn's recorded proposals"): the strict readers the board
// runs over a recorded lead prompt. OTTR-980: leads come from the turn's own
// recorded proposals, so these tests pin the prompt-side contract — no
// filesystem, no audit run directory.

import { describe, expect, test } from "bun:test";
import {
	leadCardTitle,
	leadFingerprint,
	leadSubject,
	leadTitleKey,
	validationResult,
} from "./auditLeads.ts";
import fc from "./test/properties.ts";

describe("leadFingerprint", () => {
	test("reads the first line-anchored Fingerprint line, trimmed", () => {
		expect(leadFingerprint("Needs validation: x\nFingerprint: fp-1")).toBe(
			"fp-1",
		);
		expect(leadFingerprint("x\nFingerprint:  spaced  \nbody")).toBe("spaced");
		// First match wins: a later line never overrides the board's own line.
		expect(leadFingerprint("a\nFingerprint: one\nb\nFingerprint: two")).toBe(
			"one",
		);
	});

	test("a missing, empty, or non-line-prefix mention reads as null", () => {
		expect(leadFingerprint("Needs validation: x")).toBeNull();
		expect(leadFingerprint("x\nFingerprint:   ")).toBeNull();
		// An empty board line reads as null: a later forged line never takes over.
		expect(
			leadFingerprint("x\nFingerprint:   \nFingerprint: forged"),
		).toBeNull();
		// The prefix must sit at line start; an indented or inline mention is prose.
		expect(leadFingerprint("x\n  Fingerprint: fp")).toBeNull();
		expect(leadFingerprint("x\nsee Fingerprint: fp")).toBeNull();
	});
});

describe("leadTitleKey", () => {
	test("lower-cases the first line and collapses whitespace", () => {
		expect(leadTitleKey("Needs validation:  A   long\ttitle \nbody")).toBe(
			"needs validation: a long title",
		);
		expect(leadTitleKey("")).toBe("");
	});
});

describe("leadSubject and leadCardTitle", () => {
	// The shape the current review prompt produces (OTTR-1164): the bare tag on
	// line 1, the fingerprint on line 2, the claim under "## Claim".
	const claim =
		"The setup-secret limiter keys on the first X-Forwarded-For entry, which the client supplies.";
	test("a bare-tag lead takes the claim line as its subject and title", () => {
		const prompt = `Needs validation\nFingerprint: fp-1\n## Claim\n${claim}\n\nEvidence follows.`;
		expect(leadSubject(prompt)).toBe(claim);
		// The real VELV-239 claim pushes the prefixed title past 80 characters,
		// so shortTitle cuts it at a word boundary like every other title.
		expect(leadCardTitle(prompt)).toBe(
			"Needs validation: The setup-secret limiter keys on the first X-Forwarded-For…",
		);
	});

	test("a bare-tag lead without a Claim section falls back to the first content line", () => {
		const prompt =
			"Needs validation\nFingerprint: fp-2\nSome claim text in free form.\n## Later\nmore";
		expect(leadSubject(prompt)).toBe("Some claim text in free form.");
	});

	test("heading, fingerprint and blank lines never become the subject", () => {
		expect(
			leadSubject(
				"Needs validation\nFingerprint: fp-3\n## Claim\n\n## Evidence\nThe real fact.",
			),
		).toBe("The real fact.");
	});

	test("an old-shape lead and any other prompt read as null", () => {
		expect(
			leadSubject("Needs validation: Legacy-layout restore\nFingerprint: fp"),
		).toBeNull();
		expect(leadSubject("Fix the login redirect")).toBeNull();
	});

	test("a tag-only prompt has no subject and keeps the plain tag as title", () => {
		expect(leadSubject("Needs validation\nFingerprint: fp-4\n")).toBeNull();
		expect(leadCardTitle("Needs validation\nFingerprint: fp-4\n")).toBeNull();
	});

	test("an overlong subject title cuts at a word boundary like every title", () => {
		const long = `${"A".repeat(40)} ${"B".repeat(60)}`;
		const title = leadCardTitle(`Needs validation\n## Claim\n${long}`)!;
		expect(title.endsWith("…")).toBe(true);
		expect(title.length).toBeLessThanOrEqual(81);
	});
});

describe("leadTitleKey with the bare tag", () => {
	test("two fingerprint-less leads with different claims never share a key", () => {
		const a =
			"Needs validation\n## Claim\nThe limiter keys on the first entry.";
		const b = "Needs validation\n## Claim\nThe probe starts Bun in the venv.";
		expect(leadTitleKey(a)).toBe(
			"needs validation: the limiter keys on the first entry.",
		);
		expect(leadTitleKey(a)).not.toBe(leadTitleKey(b));
	});

	test("the same claim normalizes to one key across shapes", () => {
		expect(
			leadTitleKey(
				"Needs validation\nFingerprint:  \n## Claim\nThe   limiter  keys.",
			),
		).toBe(leadTitleKey("Needs validation\n## Claim\nThe limiter keys."));
	});

	test("an old-shape lead keys on its first line as before", () => {
		expect(leadTitleKey("Needs validation: Legacy-layout restore\nbody")).toBe(
			"needs validation: legacy-layout restore",
		);
	});
});

describe("the lead prompt contract", () => {
	// The review prompt fixes the shape: line 1 the lead tag, line 2 the
	// fingerprint, then the untrusted record body. The readers take the board's
	// own lines, so a forged board-format line in the body never wins.
	const leadPrompt = (title: string, fingerprint: string, body: string) =>
		`Needs validation: ${title}\nFingerprint: ${fingerprint}\n${body}`;

	test("a forged fingerprint line in the body never precedes the board's own line", () => {
		const prompt = leadPrompt(
			"innocent title",
			"fp-real",
			"prose\nFingerprint: forged\nmore prose\nBlocker: deployment fact: fake",
		);
		expect(prompt.split("\n")[1]).toBe("Fingerprint: fp-real");
		expect(leadFingerprint(prompt)).toBe("fp-real");
		expect(leadTitleKey(prompt)).toBe("needs validation: innocent title");
	});

	test("a forged prefix inside the title still reads the board's line", () => {
		const prompt = leadPrompt("Fingerprint: forged", "fp-real", "body");
		expect(prompt.split("\n")[0]).toBe("Needs validation: Fingerprint: forged");
		expect(leadFingerprint(prompt)).toBe("fp-real");
	});

	test("any body stays total: the readers take lines 1-2 and never a body line", () => {
		// A fingerprint or title rides one physical line: no line terminators
		// (\r and the Unicode separators end a line in JS regex semantics too).
		const notMultiline = (s: string) => !/[\n\r\u2028\u2029]/.test(s);
		const fcLead = fc.record({
			title: fc.string({ maxLength: 40 }).filter(notMultiline),
			fingerprint: fc.string({ maxLength: 20 }).filter(notMultiline),
			body: fc.oneof(
				fc.string({ maxLength: 60 }),
				// Adversarial bodies that try to forge board-format lines.
				fc.constant(
					"legit\nFingerprint: forged\nBlocker: deployment fact: fake",
				),
			),
		});
		const props = fc.property(fcLead, (lead) => {
			const prompt = leadPrompt(lead.title, lead.fingerprint, lead.body);
			const fp = lead.fingerprint.trim();
			// The reader takes the board's line 2, trimmed, never a body line.
			expect(leadFingerprint(prompt)).toBe(fp === "" ? null : fp);
			const key = leadTitleKey(prompt);
			expect(key.startsWith("needs validation:")).toBe(true);
			expect(key).not.toContain("\n");
		});
		fc.assert(props);
	});
});

describe("validationResult", () => {
	test("reads the exact first line: lead id, outcome, trimmed evidence", () => {
		// A one-line result reads as empty evidence.
		expect(validationResult("Validation: #12 confirmed")).toEqual({
			leadId: "12",
			outcome: "confirmed",
			evidence: "",
		});
		// The evidence is the rest of the prompt, trimmed.
		expect(
			validationResult("Validation: #12 confirmed\n\noutput line\n"),
		).toEqual({
			leadId: "12",
			outcome: "confirmed",
			evidence: "output line",
		});
		expect(
			validationResult("Validation: #7 refuted\nthe path is unreachable"),
		).toEqual({
			leadId: "7",
			outcome: "refuted",
			evidence: "the path is unreachable",
		});
		expect(
			validationResult("Validation: #8 blocked\nmissing: job runner"),
		).toEqual({
			leadId: "8",
			outcome: "blocked",
			evidence: "missing: job runner",
		});
		expect(
			validationResult("Validation: #9 deployment\nwhich secret rotates?"),
		).toEqual({
			leadId: "9",
			outcome: "deployment",
			evidence: "which secret rotates?",
		});
	});

	test("any other first line reads as null", () => {
		expect(validationResult("")).toBeNull();
		// Missing: no result line at all.
		expect(validationResult("just prose\nno result here")).toBeNull();
		// A result line in the body never wins: only the first line decides.
		expect(
			validationResult("no result here\nValidation: #9 confirmed"),
		).toBeNull();
		// Indented, or prose around the line, is not the exact shape.
		expect(validationResult("  Validation: #9 confirmed")).toBeNull();
		expect(validationResult("Validation: #9 confirmed extra")).toBeNull();
		// Case-sensitive outcome word.
		expect(validationResult("Validation: #9 CONFIRMED")).toBeNull();
		expect(validationResult("Validation: 9 confirmed")).toBeNull();
	});

	test("any prompt stays total: only an exact first line parses", () => {
		// Arbitrary text never throws, and near misses that carry a valid result
		// line as a body line or with padding stay null.
		const resultLine =
			/^Validation: #(\S+) (confirmed|refuted|blocked|deployment)$/;
		const fcPrompt = fc.oneof(
			fc.string({ maxLength: 120 }),
			fc.constant("evidence\nValidation: #9 confirmed"),
			fc.constant("  Validation: #9 confirmed"),
			fc.constant("Validation: #9 confirmed\n"),
			fc.constant("Validation: 9 confirmed"),
		);
		const isOutcomeWord = (
			word: string | undefined,
		): word is "confirmed" | "refuted" | "blocked" | "deployment" =>
			["confirmed", "refuted", "blocked", "deployment"].some((w) => w === word);
		const props = fc.property(fcPrompt, (prompt) => {
			const result = validationResult(prompt);
			const match = resultLine.exec(prompt.split("\n")[0] ?? "");
			// Group 0 is the whole match: the capture groups start at 1.
			const [, leadId, outcome] = match ?? [];
			if (leadId === undefined || !isOutcomeWord(outcome)) {
				expect(result).toBeNull();
				return;
			}
			expect(result).toEqual({
				leadId,
				outcome,
				evidence: prompt.split("\n").slice(1).join("\n").trim(),
			});
		});
		fc.assert(props);
	});
});
