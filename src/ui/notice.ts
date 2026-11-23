/** The bell line's notice-text helpers, DOM-free so server-side tests import
 *  them without the UI module's window state (OTTR-1097). */

/** True for a whitespace-delimited token whose shape is host detail the collapsed
 * line must not carry (OTTR-1084): a path (holds "/", but an http(s) link stays),
 * a CLI flag ("-d", "--no-deps"), or a container-style name ("ottr-worker-1").
 * Card refs ("OTTR-1071", "ottr#OTTR-1071") match no shape. The tests run on the
 * token's bare core: sentence punctuation and brackets ride on the token
 * ("ottr-worker-1.", "(alate-seed-2)") and must not hide the shape from the
 * anchored tests. */
function isNoticeDetailToken(token: string): boolean {
	const core = token.replace(/^[^\w/@#-]+/, "").replace(/[^\w/@#-]+$/, "");
	if (/^https?:\/\//i.test(core)) return false;
	if (core.includes("/")) return true;
	if (/^-{1,2}[a-zA-Z0-9]/.test(core)) return true;
	return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d+$/.test(core);
}

/** A notice line's collapsed copy: detail tokens gone, repeated spaces
 * collapsed, and a connector word popped with a removed token so the line does
 * not end on a dangling preposition ("in /opt/x" goes as a unit). A removed
 * token keeps its trailing punctuation so its sentence end survives and the
 * next sentence does not merge into it; that punctuation drops when no kept
 * word precedes it (a line of detail tokens alone strips empty). */
function stripNoticeTokens(line: string): string {
	let out = "";
	for (const token of line.split(/\s+/)) {
		if (token === "") continue;
		if (isNoticeDetailToken(token)) {
			const punct = /[.,;:!?]+$/.exec(token)?.[0] ?? "";
			const head = out.slice(out.lastIndexOf(" ") + 1);
			if (
				out.includes(" ") &&
				/^(?:in|at|on|from|with|to|for|by|into|under|via)$/.test(head)
			)
				out = out.slice(0, out.lastIndexOf(" "));
			if (out !== "" && punct !== "") out += punct;
			continue;
		}
		out += (out === "" ? "" : " ") + token;
	}
	return out;
}

/** The collapsed form of a bell entry's text: the first line, stripped of host
 * detail first (stripNoticeTokens) so no cut point can still carry a path or
 * flag, then cut at the end of its first sentence when more sentence follows,
 * then capped at maxChars on a word boundary with an ellipsis. The cap is for
 * the update script's flattened records, which hold no line break to cut at
 * (SeedFailedLine passes 160); the default leaves the line uncapped. A line
 * that strips empty returns "". Whatever this drops, the entry's Details
 * disclosure must carry. */
export function shortNoticeText(
	text: string,
	maxChars = Number.POSITIVE_INFINITY,
): string {
	const nl = text.indexOf("\n");
	const line = nl < 0 ? text : text.slice(0, nl);
	const stripped = stripNoticeTokens(line);
	let out = stripped;
	for (let i = 0; i < stripped.length - 1; i++) {
		const ch = stripped[i];
		if (
			ch !== undefined &&
			".!?;:".includes(ch) &&
			stripped[i + 1] === " " &&
			stripped.slice(i + 2).trim() !== ""
		) {
			out = stripped.slice(0, i + 1);
			break;
		}
	}
	if (Number.isFinite(maxChars) && out.length > maxChars) {
		// Cut at the last whole word that fits; a single word past the cap
		// hard-cuts mid-word, since there is no boundary to cut at.
		const space = out.lastIndexOf(" ", maxChars);
		out =
			space < 0
				? `${out.slice(0, maxChars)}…`
				: `${out.slice(0, space).trimEnd()}…`;
	}
	return out;
}
