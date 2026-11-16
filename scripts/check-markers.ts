/**
 * Fails when a tracked Markdown or source file holds an edit-tool marker or
 * a git conflict marker (OTTR-1059): commit 1f3017d wrote the literal line
 * `10: @ours` over the README "How it works" table header, and GitHub
 * rendered the whole table as one paragraph of pipes. Runs inside
 * `bun run check`. Extra path arguments scan those files instead of the
 * tracked tree, so the test drives the real script against throwaway
 * fixtures. A fixture that must hold marker lines is exempted here by exact
 * tracked path, never by weakening the patterns.
 */
import { readFileSync } from "node:fs";

const EXTENSIONS = /\.(md|ts|tsx|mts|cts|js|mjs|cjs|jsx|html)$/;

/** Tracked paths that may hold marker lines (fixtures that copy real
 * conflict output). Exact paths, sorted; the empty list is the default. */
const EXEMPT: readonly string[] = [];

/** The defect lines: `10: @ours`-style edit-tool residue and the git
 * conflict block. `=======` counts only between the two conflict rows, so a
 * setext underline or a rule elsewhere stays legal. */
export function markerLines(
	text: string,
): Array<{ line: number; text: string }> {
	const hits: Array<{ line: number; text: string }> = [];
	const lines = text.split("\n");
	let inside = false;
	for (const [i, line] of lines.entries()) {
		if (/^<<<<<<< /.test(line)) {
			inside = true;
			hits.push({ line: i + 1, text: line });
		} else if (/^>>>>>>> /.test(line)) {
			inside = false;
			hits.push({ line: i + 1, text: line });
		} else if (inside && /^=======$/.test(line)) {
			hits.push({ line: i + 1, text: line });
		} else if (/^[0-9]+: @(ours|theirs)$/.test(line)) {
			hits.push({ line: i + 1, text: line });
		}
	}
	return hits;
}

function scanFile(path: string): Array<string> {
	try {
		return markerLines(readFileSync(path, "utf8")).map(
			(hit) => `${path}:${hit.line}: ${hit.text}`,
		);
	} catch (error) {
		// A tracked path may be absent from the worktree (deleted, staged);
		// an explicitly named path must exist, so only the tree scan skips.
		if (process.argv.length > 2) throw error;
		return [];
	}
}

function main(): number {
	const args = process.argv.slice(2);
	let files: string[];
	if (args.length > 0) {
		files = args;
	} else {
		const out = Bun.spawnSync({
			cmd: ["git", "ls-files"],
			stdout: "pipe",
		});
		if (out.exitCode !== 0) {
			console.error("markers: git ls-files failed:", out.stderr.toString());
			return 1;
		}
		files = out.stdout
			.toString()
			.split("\n")
			.filter((f) => EXTENSIONS.test(f));
	}
	const exempt = new Set(EXEMPT);
	const bad: string[] = [];
	let scanned = 0;
	for (const file of files) {
		if (exempt.has(file)) continue;
		for (const hit of scanFile(file)) bad.push(hit);
		scanned++;
	}
	if (bad.length > 0) {
		console.error(
			"edit-tool or conflict markers in tracked text (fix the lines, or exempt a real fixture by exact path in scripts/check-markers.ts):",
		);
		for (const b of bad) console.error(" ", b);
		return 1;
	}
	console.log(`markers: ok (${scanned} files scanned)`);
	return 0;
}

if (import.meta.main) process.exit(main());
