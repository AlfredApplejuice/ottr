# Guided review for tasks and releases

Status: proposed design for OTTR-1053. This document implements no feature, API, migration, or workflow change.

## Goal

Add an optional guide to the task or release drawer. The guide explains a changeset in chapters, with core changes before consequences and glue.
Each chapter explains why the change exists and shows the real file diffs. A person can mark each chapter reviewed.
The server guarantees complete file coverage. That guarantee does not prove review quality or whole-repository audit coverage.

## Sources and current board

The upstream documents describe Plannotator, not current Ottr behavior:

- [Guided Review specification, July 2](https://raw.githubusercontent.com/backnotprop/plannotator/main/adr/specs/guided-review-20260702-195351.md) defines structured sections, path validation, exact-once coverage, and per-section state. Its guide uses current diffs and job-local memory.
- [ADR 006](https://raw.githubusercontent.com/backnotprop/plannotator/main/adr/decisions/006-guided-review-first-class-feature-20260702-192821.md) defines core-first chapters, explanations of why, a full-screen view, and shared annotation state.
- [ADR 007](https://raw.githubusercontent.com/backnotprop/plannotator/main/adr/decisions/007-portable-guided-reviews-20260815.md) defines strict versioned snapshots, provenance, and capture of the patch when generation starts. Its D11 addendum says share links exist upstream.

Current Ottr has these separate views:

| View | Current contract | Proposed guide difference |
| --- | --- | --- |
| Result and research report | `DrawerResult` shows summary/details. `DrawerResearch` shows a report and HTML/Markdown downloads. See `src/ui/app.tsx:10564-10588,10835-10891`. | Chapters explain changed files in review order. Reports remain separate evidence and conclusions. |
| Worktree and saved files | `DrawerFiles` provides artifact access, changed-file entries, and diff links. Done cards can retain filenames and saved-file downloads. See `src/ui/app.tsx:10189-10318` and `docs/specs/saved-files.md`. | The guide covers the captured Git changeset, not every worktree artifact. An untracked mockup is not a changed-file reference. |
| Screenshots | `task.shots` supplies thumbnails and full-size views. See `src/ui/app.tsx:10787-10833`. | Screenshots remain visual evidence. They do not count as chapter review or replace a file diff. |
| Task diff | The drawer opens a whole diff or selected files. Open cards use a live base-to-target comparison. Some closed or exceptional cards use stored `diffText`. See `src/ui/app.tsx:2127-2224` and `src/app.ts:8359-8384`. | A guide requires one exact, immutable snapshot. The current task diff route is not an arbitrary base/head snapshot API. |
| Release review | The review uses a frozen commit and a release range. Approval can show later commits as `review fix` or `not reviewed`. See `src/release.ts:587-612`, `src/prompts.ts:288-302,470-487,504-526`, and `docs/specs/late-commits-in-release-approval.md`. | The guide explains the release changeset. The existing review still examines the whole repository at its frozen commit. |

PR inline comments already have a separate contract in [pr-reviews.md](pr-reviews.md#inline-comments) and `src/prInline.ts`.
OTTR-673's exact scope and current board status remain unverified. This proposal does not claim that card is complete or replace its work.

## Assumptions and decisions

These assumptions precede any implementation:

- The first guide supports committed changes in one project repository. Uncommitted and untracked files remain in the existing artifact views.
- A task guide uses an explicit resolved base commit and task head commit. It never substitutes a mutable branch label for either identity.
- A release guide uses its resolved release base and frozen review head. The header names both commits and the release range.
- Without a base commit, generation is unavailable with an explanation. Initial-release whole-history support is outside this first contract.
- One task or release has one active guide. Review state is shared board state, not a new account system or an individual sign-off.
- A person requests generation or regeneration. No watcher, scheduler, or review gate requires a guide.

Ottr adopts the upstream chapter pattern, not its code or packages.
The drawer stays the entry point instead of a full-screen takeover. This keeps reports, files, and screenshots available without a board redesign.
Exact snapshots replace the July specification's live-diff semantics. A same-path file can change meaning, so a path match cannot preserve reviewed credit.
Durable state replaces its job-local memory. ADR 007's capture rule supports this choice, but Ottr does not adopt its export or host design.

## Proposed contract

This section defines future data ownership, not existing endpoints or database tables.

### Agent-authored guide

The agent returns a strict versioned document with these fields:

| Field | Meaning |
| --- | --- |
| `version` | The supported guide format version. |
| `title`, `intent` | A nonempty title and short explanation of the changeset. |
| `sections` | An ordered list of chapters. |
| Section `title`, `overview` | A nonempty title and prose that explains why the change exists. |
| Section `kind` | Exactly `core`, `consequence`, or `support`. |
| Section `diffs` | File references with `file`, optional `note`, and optional `lineStart`/`lineEnd`. |

References use exact repository-relative paths from the server's manifest. Anchors are optional new-side highlight hints, never slices or proof of coverage.
The agent cannot supply reviewed state, snapshot identity, section identifiers, or an authoritative remainder list. Unknown fields and invalid document structure fail validation.

### Server-owned snapshot and state

The server captures these values before the model request:

- Project and task/release identity.
- Full base and head commit identifiers, plus the comparison mode.
- An immutable patch and complete changed-file manifest, with a snapshot identifier over both and their identities.
- File status, old/new paths where applicable, and the line coordinates that the patch exposes.

The server supplies the same snapshot to generation and display. It never replaces a saved patch with the current worktree contents.
The manifest includes binary, deleted, renamed, mode-only, and other Git change entries even when the text patch has no hunks.
A truncated patch or incomplete manifest cannot become a complete guide.

The durable record holds the validated guide, snapshot, generation provenance, server-assigned chapter identifiers, and per-chapter reviewed booleans.
Provenance includes the generation time and model identity. The record also holds a revision for concurrent state updates.
The project store owns this record under the task or release. Normal restart and drawer closure preserve it.
Its lifetime follows the owner record, not the temporary worktree. No separate archive, export, or history browser is required.

A reviewed update names the guide, snapshot, chapter, and expected revision. The server accepts it only for the current, non-stale guide.
A conflict changes nothing and asks the drawer to reload current state. A failed save shows an error and never displays unsaved progress as durable.
Only human actions set or clear reviewed state. Generation always starts with every chapter unchecked.

## Behavior and validation

### Generation and coverage

1. Resolve and capture the selected commit pair before generation. Display its range in the drawer.
2. Give the model the captured diff and manifest as untrusted data. Use the existing model infrastructure without a new provider system.
3. Request core chapters first, consequences next, and support or glue last. Require explanations of why, not a line-by-line restatement.
4. Validate the structured response. Reject an unsupported version, malformed document, or empty `sections` list.
5. Stably order chapters by `core`, `consequence`, then `support`. Preserve agent order within each kind.
6. Discard every reference that does not exactly match a manifest entry. Never probe the filesystem to resolve a model path.
7. Keep the first valid occurrence of each file in that order. Discard later duplicates within or across chapters.
8. Discard chapters with no remaining files. If no authored chapter remains, fail generation with `No usable guide`.
9. Append a server-generated `Everything else` chapter for all remaining manifest entries, in manifest order. Omit it when empty.
10. Verify that every manifest entry appears exactly once across the retained chapters and `Everything else`. Publish the guide and state atomically.

The remainder has a plain explanation that the guide did not place these files. It has the same reviewed control as authored chapters.
It cannot rescue a wholly invalid agent response and present that response as a successful guide.
A partial guide visibly reports discarded references or chapters, without active links for fabricated paths.

An empty changeset shows `No changed files`, not a completed guide. Missing commit objects, failed capture, model errors, and invalid output show explicit errors.
Cancellation saves no partial guide. A failed regeneration retains the previous guide and its identity, with a separate failure notice.
Concurrent generation permits one active request per owner. A stale completion cannot replace a newer guide.

### Files and anchors

- An added or modified file uses its new path as the reference key.
- A deletion uses its old path. The view shows its old-side diff and deletion status without a link to a nonexistent worktree file.
- A rename is one manifest entry under its new path. The view shows both paths and any content change. An old-path reference does not match it.
- A binary entry shows its paths, status, and `Binary diff unavailable`. It remains in coverage and can belong to a reviewed chapter.
- A mode-only entry or rename without text hunks shows its Git metadata. It never disappears from coverage.
- An unreadable or absent snapshot is an error, not an empty diff or an automatic reviewed mark.

An anchor needs both bounds as positive safe integers, with `lineStart <= lineEnd`.
Every line in the range must occur on the new side of one captured hunk. Added and context lines qualify.
Deletion-only lines, binary files, reversed ranges, missing bounds, and ranges outside one hunk fail the anchor check.
The server drops an invalid anchor but retains its valid file reference. The view opens the complete file diff with an anchor-unavailable notice.
No anchor hides unrelated hunks or changes the exact-once file count.

### Staleness and progress

The server compares the selected base/head identity before publication, whenever it serves the guide, and before each reviewed update.
It resolves the current task head or release target head for this check, including commits after a frozen release review.
If that head differs from the captured head, the guide is stale even while the review retains its original frozen commit.
A new head, changed base, changed comparison mode, or different snapshot makes the guide stale, even when the file list is unchanged.
A new commit during generation cannot publish a current guide for the old range.

A stale guide shows its original range and a clear warning. Its captured patch remains available as historical context.
Its reviewed controls are disabled. Its old checks count as zero credit for the current range and cannot produce a current completion label.
Regeneration creates a new guide with no reviewed credit. It transfers no checks by chapter title, path, or unchanged file content.
Once the server marks a guide stale, a later return to the old head does not reactivate its checks.

Within a current guide, progress counts reviewed chapters, including `Everything else`.
A complete guide means only that a person marked every chapter reviewed for that snapshot.
It does not approve a PR, clear findings, certify an audit, change card state, or authorize a release.

## Drawer interaction and accessibility

Add a `Guided review` section beside the existing drawer content. Keep report, file, screenshot, and normal diff access intact.
Do not open the guide automatically or move focus when generation finishes.

The guide header shows its title, intent, exact range, status, and reviewed count.
A chapter list provides named links, chapter positions, and textual reviewed state. Each chapter has a heading, overview, and complete file diffs.
Use native buttons for generation and collapse controls, links for navigation, and labelled checkboxes for reviewed state.

A chapter link moves focus to its heading. The heading remains visible below any fixed drawer header.
A reviewed chapter can collapse, but its heading and controls remain available. Reopening it does not clear its reviewed state.
If a collapse hides focus, move focus to that chapter's collapse control. Keep the drawer's existing close and focus-return behavior.

Every action has a keyboard path and a visible focus indicator. Status never depends on color alone.
Generation, save failures, and stale notices use accessible status text. Long paths wrap without loss of their full text.
At narrow widths and 200 percent text size, prose and controls remain usable. Code may use its own horizontal scroll area.

## PR inline comments and safety

The guide adds no annotation system. It neither parses inline markers in its prose nor converts reviewed checks into GitHub comments.
Existing PR drafts retain the marker format, new-side anchors, same-hunk range checks, suggestions, and invalid-anchor fallback from [pr-reviews.md](pr-reviews.md#inline-comments).
Their Post action and approval rules do not change. A guide anchor is only navigation, not a valid PR comment claim.
This deliberately omits ADR 006's annotation parity because Ottr's current interaction is an editable draft, not an interactive annotated diff.

Model output and repository content remain untrusted data. Generation grants no tool execution against the changeset or new access to credentials.
Render prose through the existing safe Markdown policy. Do not enable raw HTML, executable links, or automatic remote resource loads.
Resolve file links only from the server manifest. Keep project authorization and existing secret-redaction boundaries intact.
Do not store credentials in the guide contract or log raw patch contents. These limits prevent guide data from exposing secrets or creating new execution paths.

## Spec-only delivery acceptance

These required checks cover this spec-only task, not the future implementation. They state requirements, not results.

- Confirm that the spec includes all required sections and the three upstream URLs.
- Confirm that `git diff --stat origin/main` shows only `docs/specs/guided-review.md` and no `package.json` changes.
- Run `bun install --frozen-lockfile`, then `bun run check`, then `bun test`. Each command must exit 0.
- Commit on `ott/ottr-1053-study-plannotator-s-guided-revie`. Confirm that `git status` is clean.

## Future implementation acceptance

These are observable checks for a later implementation. This spec-only task performs none of them.

- A task and a release each produce core-first chapters with explanations of why and real captured diffs.
- A duplicated path appears once. A fabricated, absolute, traversal, or unchanged-file path never becomes an active file reference.
- Invalid-only and duplicate-only chapters disappear. With no usable authored chapters, generation fails instead of synthesizing success.
- With omitted valid files, `Everything else` contains exactly the remainder. With no remainder, that chapter is absent.
- Property tests vary chapter order, duplicate references, invalid paths, and omitted files. The output partition equals the manifest with no duplicate entry.
- Empty, malformed, unsupported, cancelled, failed, and truncated generation inputs produce the explicit states above, not partial success.
- Binary, deleted, renamed, mode-only, and no-hunk entries remain visible and count once. Rename old and new paths do not count twice.
- Valid anchors select visible new-side ranges. Invalid or cross-hunk anchors retain the file and show the full diff without a false highlight.
- Restart and drawer closure preserve current reviewed state. Failed saves and concurrent revision conflicts preserve the server's accepted state.
- New commits, base changes, same-path edits, and generation races yield no stale credit. Regeneration clears all chapter checks.
- An old-head return never silently restores stale credit. A failed regeneration preserves the old snapshot with its correct status.
- A keyboard and screen-reader pass covers generation, chapter navigation, collapse, reviewed state, errors, and drawer closure.
- Reports, downloads, screenshots, normal diffs, and PR inline comments retain their existing behavior.
- Every chapter can be reviewed without any change to review scope, workflow gates, approval, release, or GitHub state.

## Non-goals

- Source changes, migrations, endpoint definitions, dependencies, or upstream code in this task.
- Portable HTML, share links, external hosts, a CDN, or a separate guide renderer package.
- A full-screen workspace, a new editor, inline annotations, PR posting, or a replacement for reports.
- Multi-repository guides, uncommitted snapshots, per-file checkboxes, per-person sign-off, or multiple-guide history.
- Automatic regeneration, automatic reviewed marks, partial credit across commits, or new review/release gates.
- A smaller audit scope. Review-button and release reviews retain their whole-repository contract.
