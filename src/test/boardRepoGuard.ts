/**
 * OTTR-1162: a bun test run must never write the board's own repository. A session whose env
 * carried `GIT_DIR` (a merge-turn shell, a process launched from a git hook) once redirected the
 * suite's fixture writers into /workspace/ottr/.git: a fixture `commit -m a` landed on the board
 * main, `git config` wrote the board config, and `git update-ref -d` deleted the board's
 * refs/remotes/origin/main — while the suite stayed green, because the redirected calls succeed.
 * The spawn-level strip (gitRepoEnv, production gitEnv, fixture helpers) removes the env vector;
 * this preload (bunfig [test] preload, bun test only) removes the rest of the class: every git
 * exec of the suite runs through a PATH shim that refuses a write command whose repo resolves to
 * the enclosing repository. Reads stay allowed (the suite reads the checkout legitimately, and a
 * concurrent tracker merge may move the refs — so a byte-compare would false-red on a busy board;
 * the shim's refusal is the proof that this run wrote nothing).
 *
 * Fail-closed: an installation error throws (red run). No enclosing repo (a Stryker sandbox, a
 * bare checkout) keeps the guard inert: there is nothing to protect there.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGitEnv } from "../gitRepoEnv.ts";

export interface BoardGuard {
	/** realpath of the enclosing repo's git common dir (the watched repository). */
	repo: string;
	/** The installed shim script (first on PATH for this process). */
	shim: string;
	/** The real git binary the shim execs. */
	git: string;
	/** Append-only log of refused calls. */
	log: string;
}

const holder = globalThis as { __ottrBoardGuard?: BoardGuard };

const SHIM = [
	"#!/bin/bash",
	"# ottr board-repo guard (OTTR-1162), installed by src/test/boardRepoGuard.ts as a bun test",
	"# preload. Every git exec of the suite runs through this shim: a write command whose repo",
	"# resolves to the enclosing repository is refused (exit 126); reads pass through. The baked",
	"# values come from the preload, not from env, so a poisoned session env cannot disarm the guard.",
	"realgit='@@REALGIT@@'",
	"repodir='@@REPODIR@@'",
	"guardlog='@@GUARDLOG@@'",
	'dir="$PWD"',
	'override=""',
	'sub=""',
	'expect=""',
	'args=("$@")',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion, not a TS template
	"n=${#args[@]}",
	"i=0",
	'while [ "$i" -lt "$n" ]; do',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion, not a TS template
	'  a="${args[$i]}"',
	'  if [ -n "$expect" ]; then',
	'    case "$expect" in dir) dir="$a";; gdir) override="$a";; esac',
	'    expect=""',
	"    i=$((i+1)); continue",
	"  fi",
	'  case "$a" in',
	'    -C) expect="dir";;',
	'    --git-dir) expect="gdir";;',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion, not a TS template
	'    --git-dir=*) override="${a#--git-dir=}";;',
	'    -c|--namespace|--super-prefix|--exec-path|--work-tree) expect="skip";;',
	"    -*) ;;",
	'    *) sub="$a"; break;;',
	"  esac",
	"  i=$((i+1))",
	"done",
	"# The repo this call would touch: the override, the ambient GIT_DIR, or discovery from the cwd.",
	'target=""',
	'if [ -n "$override" ]; then',
	'  case "$override" in /*) target="$override";; *) target="$dir/$override";; esac',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion, not a TS template
	'elif [ -n "${GIT_DIR:-}" ]; then',
	'  case "$GIT_DIR" in /*) target="$GIT_DIR";; *) target="$dir/$GIT_DIR";; esac',
	"else",
	'  d="$(cd "$dir" 2>/dev/null && pwd -P)" || d=""',
	'  while [ -n "$d" ]; do',
	'    if [ -d "$d/.git" ]; then target="$d/.git"; break; fi',
	'    if [ -f "$d/.git" ]; then',
	"      g=$(sed -n 's/^gitdir:[[:space:]]*//p' \"$d/.git\" 2>/dev/null | head -n 1)",
	'      case "$g" in /*) target="$g";; "") ;; *) target="$d/$g";; esac',
	"      break",
	"    fi",
	'    p=$(dirname "$d"); [ "$p" = "$d" ] && break; d="$p"',
	"  done",
	"fi",
	"inrepo=0",
	'if [ -n "$target" ]; then',
	'  t="$(cd "$target" 2>/dev/null && pwd -P)" || t=""',
	'  if [ -n "$t" ]; then',
	'    case "$t" in "$repodir"|"$repodir"/*) inrepo=1;; esac',
	"  fi",
	"fi",
	"# Server-side commands serve the repository named by their first non-flag operand, not the",
	"# cwd: a fixture server execs them from the suite's own cwd with a /tmp repo path, and cwd",
	"# discovery there would misread the enclosing repo as the served one (OTTR-1162 follow-up).",
	'case "$sub" in',
	"  upload-pack|receive-pack|upload-archive)",
	'    served=""',
	"    j=$((i+1))",
	'    while [ "$j" -lt "$n" ]; do',
	'      case "${args[$j]}" in -*) ;; *) served="${args[$j]}"; break;; esac',
	"      j=$((j+1))",
	"    done",
	"    inrepo=0",
	'    if [ -n "$served" ]; then',
	'      st="$(cd "$served" 2>/dev/null && pwd -P)" || st=""',
	'      if [ -n "$st" ]; then',
	'        case "$st" in "$repodir"|"$repodir"/*) inrepo=1;; esac',
	"      fi",
	"    fi",
	"  ;;",
	"esac",
	"# Write decision. Unconditional writers, then per-subcommand reads (config/remote/worktree/",
	"# tag/branch/reflog have read forms; init/clone are safe with an explicit path operand).",
	"write=0",
	'case "$sub" in',
	'  "") ;;',
	"  commit|update-ref|push|fetch|pull|merge|rebase|revert|cherry-pick|reset|checkout|switch|stash|am|apply|mv|rm|add|gc|prune|repack|notes|replace|filter-branch|filter-repo|maintenance|send-pack|receive-pack|unpack-objects|index-pack|read-tree|write-tree|annotate) write=1;;",
	"  config)",
	"    vals=0; j=$((i+1))",
	'    while [ "$j" -lt "$n" ]; do',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion, not a TS template
	'      case "${args[$j]}" in -*) ;; *) vals=$((vals+1));; esac',
	"      j=$((j+1))",
	"    done",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion, not a TS template
	'    case " ${args[*]:$((i+1))} " in',
	'      *" --get "*|*" --get-all "*|*" --get-regexp "*|*" --list "*|*" -l "*|*" --show-origin "*|*" --show-scope "*|*" --get-urlmatch "*|*" --name-only "*) ;;',
	'      *" --unset "*|*" --unset-all "*|*" --replace-all "*|*" --rename-section "*|*" --remove-section "*|*" --edit "*|*" -e "*) write=1;;',
	'      *) [ "$vals" -ge 2 ] && write=1;;',
	"    esac;;",
	"  remote)",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion, not a TS template
	'    case "${args[$((i+1))]}" in add|remove|rename|prune|set-head|set-url|set-branches) write=1;; esac;;',
	"  worktree)",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion, not a TS template
	'    case "${args[$((i+1))]}" in add|remove|prune|repair|move|lock|unlock) write=1;; esac;;',
	"  reflog)",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion, not a TS template
	'    case "${args[$((i+1))]}" in expire|delete|drop) write=1;; esac;;',
	"  tag)",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion, not a TS template
	'    case " ${args[*]:$((i+1))} " in',
	'      *" -l "*|*" --list "*|*" --contains "*|*" --no-contains "*|*" --merged "*|*" --no-merged "*|*" --points-at "*|*" --sort "*|*" --format "*|*" -n "*) ;;',
	'      *) [ "$((i+1))" -lt "$n" ] && write=1;;',
	"    esac;;",
	"  branch)",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion, not a TS template
	'    case " ${args[*]:$((i+1))} " in',
	'      *" --list "*|*" -v "*|*" -vv "*|*" -a "*|*" -r "*|*" --show-current "*|*" --contains "*|*" --merged "*|*" --no-merged "*|*" --format "*|*" --sort "*|*" --points-at "*) ;;',
	'      *) [ "$((i+1))" -lt "$n" ] && write=1;;',
	"    esac;;",
	'  init) [ "$((i+1))" -ge "$n" ] && write=1;;',
	"  symbolic-ref)",
	'    case " ${args[*]:$((i+1))} " in',
	'      *" --delete "*|*" -d "*) write=1;;',
	"      *)",
	"        ops=0; j=$((i+1))",
	'        while [ "$j" -lt "$n" ]; do',
	'          case "${args[$j]}" in -*) ;; *) ops=$((ops+1));; esac',
	"          j=$((j+1))",
	"        done",
	'        [ "$ops" -ge 2 ] && write=1;;',
	"    esac;;",
	"esac",
	'if [ "$inrepo" = 1 ] && [ "$write" = 1 ]; then',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion, not a TS template
	'  msg="ottr board-repo guard: refused git $sub that would write $repodir (cwd=$PWD GIT_DIR=${GIT_DIR:-})"',
	'  printf \'%s\\n\' "$msg" >> "$guardlog" 2>/dev/null',
	"  printf '%s\\n' \"$msg\" >&2",
	"  exit 126",
	"fi",
	'exec "$realgit" "$@"',
].join("\n");

function install(): BoardGuard | null {
	// Resolve before the PATH change: this is the binary the shim must exec.
	const git = Bun.which("git");
	if (!git) return null; // no git here: nothing spawns git, nothing to guard
	const probe = spawnSync(git, ["rev-parse", "--git-common-dir"], {
		cwd: process.cwd(),
		env: fixtureGitEnv(),
		encoding: "utf8",
	});
	if (probe.status !== 0 || probe.stdout.trim() === "") return null; // not a checkout (Stryker sandbox): inert
	const raw = probe.stdout.trim();
	const common = realpathSync(
		raw.startsWith("/") ? raw : join(process.cwd(), raw),
	);
	const dir = mkdtempSync(join(tmpdir(), "ottr-board-guard-"));
	const log = join(dir, "blocks.log");
	const shim = join(dir, "git");
	const script = SHIM.replace("@@REALGIT@@", git)
		.replace("@@REPODIR@@", common)
		.replace("@@GUARDLOG@@", log);
	writeFileSync(shim, script);
	chmodSync(shim, 0o755);
	process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
	process.stderr.write(`ottr board-repo guard: watching ${common}\n`);
	return { repo: common, shim, git, log };
}

try {
	holder.__ottrBoardGuard = install() ?? undefined;
} catch (err) {
	throw new Error(`ottr board-repo guard failed to install: ${err}`);
}
