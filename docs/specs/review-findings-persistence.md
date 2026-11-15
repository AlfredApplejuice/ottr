# Spec: Store review findings as they are recorded

Fix list #44 (2026-11-10). A review turn that never settles loses every finding it
recorded: findings live only in the run's in-memory `RunResult.recorded`
(`src/runner.ts:882`) and are checked and filed only when that same turn settles
(`src/turn.ts` `planTurnChecks` and `runReviewCheck`). Real incident: review card
CSE-6 recorded 65 findings, its turn never settled, and the card reached Done with
no finding cards and no check. `research-report.md` was lost when the Done worktree
was removed, because the report harvest only runs for research cards.

## Behavior

### 1. Findings persist as they arrive

Each valid `propose_task` call of a review card's main run is written to the store
at the moment the runner parses it, before the run settles. The parse point is
`handleEventLine`/`applyEvent` (`src/runner.ts`): when `state.recorded` grows, the
run sink fires a new `onRecorded` callback. `startRun` passes it through from its
options; the turn loop wires it only for review-card main runs
(`idn.reviewCard`), calling `store.appendReviewFinding(cardId, finding)`.

- Both run paths wire it: the local child process and the worker stream
  (`startWorkerRun`), because both parse events through the same run sink.
- Check runs (the second-model session) never get `onRecorded`.
- Retro proposals, scout verdicts, and non-review cards store nothing.

### 2. The review check runs on the stored set

`planTurnChecks` sources review findings from `store.listReviewFindings(cardId)`
instead of `st.result.recorded`. Because arrival persistence already stored this
turn's findings, the stored set is a superset of the run's set. The implemented
rule is the union of the stored set and the run's `recorded` findings, deduped
by prompt with the stored entries first, so a turn that delivered nothing still
checks the stored set and run-result delivery keeps working.

- The check runs when the stored set has findings that were never checked, at
  whichever turn the review lands on `merging` (Done hold) or `needs_you` — the
  same landing gate as today.
- Findings whose prompt matches a filed child card (`followUpOf` + prompt, the
  existing dedupe) stay excluded.
- After a completed check pass the card stores a check stamp
  (`findingsCheckedAt`). New findings reset the stamp to null, so the next
  landing re-checks. With the stamp set and no new findings, no re-check runs.

### 3. Done is refused while stored findings are unchecked

Both Done write paths get the guard, release reviews included:

- `parkReviewDone` (live turn): stored unchecked findings park the card at
  `merging`/`idle` with `UNCHECKED_FINDINGS_HOLD` instead of proceeding to
  Done. For a release card this hold precedes the publish, so the release
  publishes only after the check ran and filed its cards.
- `settleReviewCard` and `settleReleaseCard` (scheduled ticks): they refuse to
  write `stage: "done"` when the stored set has unchecked findings; they park
  needs_you with a reason that names the problem. A reply resumes the review and
  the next settle runs the check.

A shared predicate reads the stored findings and the stamp; both paths call it.

The check settle never writes Done directly: a review parked at merging lands
Done (and a release publishes) through `settleReviewCard` on a later tick,
which does the full Done bookkeeping — commits, mergeHead, uncommitted files,
worktree removal. The post-check write keeps the planned stage and state and
recomputes only the parked reason from the live cards.

### 4. "Needs validation" findings file as backlog cards sorted by their blocker

A lead waits on one of two things: a deployment fact only the user knows, or a run
of the target code in an OS-enforced sandbox this board does not have. The review
prompt tells the reviewer to start lead prompts with the tag `Needs validation`,
rank them below confirmed findings, leave security out, and end each lead prompt
with exactly one blocker line:

- `Blocker: deployment fact: <question>` — a fact only the user knows decides the
  risk; the question asks for that fact.
- `Blocker: sandbox run: <missing control>` — the proof waits on controls this
  runner lacks; the text names the missing control.

(The prompt wording is not part of this change: its exact text ships in the ready
report for the user's approval — hard stop 3 — and lands in `src/prompts.ts` in a
later change, only after approval. Until it lands, no lead carries the line, so
every lead sorts as a sandbox-run lead and no question card files.)

Code partitions the stored set by the `Needs validation` prefix, then sorts leads
with one strict pattern, `/^[^\S\n]*Blocker: (deployment fact|sandbox run): (.+)$/`
per line, first match wins. A lead without a matching line counts as a sandbox-run
lead.

- Confirmed findings: `selectFindings` picks the cap-10 selection plus confirmed
  high/critical security findings, as today; the second model checks them; kept
  ones file as queued cards; below-cap ones stay logged, not filed.
- Sandbox-run leads file as today: backlog card, `createTask(prompt)`, then
  `updateTask` with `followUpOf` (the review), `model`, `stage: "backlog"`,
  `state: "idle"`, `queuedAt: null` (the existing backlog creators' shape), and the
  unverified details note plus ` Waits for a validation sandbox.`
- Deployment-fact leads file the same backlog card, without the sandbox note. When
  the pass filed at least one and the review has no open question card yet, the
  review also files ONE question card: `createTask` with a prompt that starts with
  the fixed prefix `Needs-validation lead questions from review #`, then
  `updateTask` with `followUpOf` (the review), `stage: "backlog"`,
  `state: "needs_you"`, `queuedAt: null`, and `asked` holding one question per
  deployment-fact lead of this pass: question text `<question> (card #<lead id>)`,
  options `Yes, the risk applies` and `No, it does not apply` (free text rides the
  drawer's Other field), `multi: false`, `recommended: null`.
- The question card holds nothing: `findingsOpen` ignores `backlog`-stage children,
  so the review's Done never waits for the answer. A review whose leads are all
  sandbox-run leads files no question card.

The reply route applies the answers (`src/app.ts`). A reply to a card whose prompt
starts with the question-card prefix and whose `asked` is set parses one answer per
question — from the drawer's wire line `For "<question>": <answer>` (shared helper
`askAnswerLine`), or, on a single-question card, from the whole reply text (that
drawer sends the raw answer without the wire line) — applies it to the question's
lead card, records free text no question consumed on the unanswered open leads, and
lands the question card Done (`stage: "done"`, `state: "idle"`, `asked: null`,
`doneAt` set by the store's Done stamp):

- `Yes, the risk applies`: an idle backlog lead moves to `stage: "todo"`,
  `state: "queued"`, `queuedAt` set, and the answer appends to its prompt. A lead
  the user already started (any other stage or state) only records the answer in
  its details — no run state is overwritten.
- `No, it does not apply`: an idle backlog lead cancels with the direct patch
  (`cancelledAt` set, `state: "idle"`) and the answer as its `needsReason`. A
  started lead cancels through the sanctioned `cancel()` (it stops the run,
  disposes the worktree, deletes the branch) and then carries the answer as its
  `needsReason`; a cancel that kept work records that fact in the details.
- Any other text, an empty answer, or no answer line: the lead keeps its state;
  non-empty text appends to its details. Free text the reply carried but no
  question consumed appends to the details of every open lead that got no
  per-question answer.
- Answers only touch lead cards of the same review (`followUpOf` match) that are
  still open (not cancelled, not done). The question card lands Done inside the
  same reply, so a second reply is refused (409, not needs_you).

No schema change: the question card reuses the existing `asked` column and its
`AskQuestion` normalization.

#### A promoted lead of a done review never holds merges (OTTR-963)

A lead that sits in the backlog when its review finishes is optional work: the
review's Done ignored it (`findingsOpen` skips `backlog` children, OTTR-889), and
the review settled. When the user later promotes that lead (the answer above, or a
manual queue), `findingsOpen` counts it again, and the findings hold would park
every non-finding merge of the project behind optional work. Incident 2026-11-15:
seven alate and two velvarr merges waited up to 8 hours behind leads of releases
that had shipped days earlier.

The rule reads the recorded stage at doneAt, not a derivable one. The store
column `lead_at_done` (mapped as `Task.leadAtDone`) is 1 when the finding sat in
stage `backlog` when its review finished:

- The forward write sits in `runTaskUpdate` (`src/store.ts`), the one task
  UPDATE funnel: when a review card lands done (`isReview` only: the review kind
  or a release version), the same transaction stamps
  `lead_at_done = 1` on each open direct backlog child created no later than the
  fresh `done_at`. The stamp never changes afterwards: no patch path exists (the
  field is outside `TaskPatch`), and the write only ever sets 1. A re-queue
  rewrites `queuedAt` — the stamp of the last entry into state `queued` — but
  never this flag, so the scheduler can trust it.
- The scheduler (`reviewHoldFor`, `src/scheduler.ts`): for a review at
  `stage: "done"`, an open finding holds other merges only when it carries no
  stamp. A stamped finding never holds, also after it leaves the backlog. A
  finding without the stamp was a commitment when the review finished and keeps
  holding, even when a reply re-opens it.
- The migration (`ProjectStore.open`) adds the column additively and backfills
  reviews that finished before it existed, from the stage history (`events`,
  kind `stage`): a finding whose last stage change at or before the review's
  `done_at` left it in `backlog` was a parked lead then. The backfill runs on
  the same open that adds the column — `addColumn` records each ALTERed name in
  the column list it works from, so the gate reads a fresh list — and on every
  later open (only NULL rows fill, so it is idempotent). It runs only when the
  tasks table carries every column it reads — tables old enough to miss one
  predate review findings entirely — and a finding without stage history keeps
  NULL and keeps today's hold.
- Direct follow-ups only: leads file as direct children
  (`fileKeptFindings`), and a deeper closure card that misses the stamp keeps
  today's hold.

The review's own Done guard is unchanged: a lead promoted while the review still
runs parks the review at `merging` until the lead reaches done or cancelled, as
today. `reviewBlocked` is unchanged too: a promoted lead still delays the
project's next review until it finishes. All other holds stay: an open release
hold, a running review hold, and the findings hold of a review that is not done.

#### Lead fingerprint dedupe

Each audit run carries its open leads into the next audit (docs/specs/security-audit-harness.md
"Review behavior": every `needs_validation` record has a fingerprint, and a proposal
preserves it). Until OTTR-870 every lead filed a new backlog card, so each release
review of a project refiled the same leads (run-7 carried 51 of 59 leads over
unchanged).

- The lead prompt carries the record's fingerprint on one fixed line:
  `Fingerprint: <value>`. The board reads it with one strict pattern: a line that
  starts with the exact prefix `Fingerprint: `, value = the trimmed rest of that
  line. A lead without the line falls back to the title dedupe below.
- Before the board files a lead, it looks in the same project's cards for one
  whose prompt carries the same fingerprint value. Among several matches the
  lowest card id decides, with priority: open (not done, not cancelled), then
  cancelled, then done.
  - Open card: no new card. The board appends one line to that card's details:
    `Seen again in review <review id> on <YYYY-MM-DD>.` The review card's
    Findings trail counts the lead as `- already open: #<card id> (<prompt
    head>)` and the log says so too; the lead counts as not filed.
  - Cancelled card: no new card, because the user declined the lead. The Findings
    trail notes it (`- not filed: the user cancelled the same lead before,
    card #<card id>`); the lead counts as not filed.
  - Done card: the lead files as today, and the new card's details name the old
    card (`The same fingerprint was already on done card #<card id>; the lead
    came back.`).
- A card filed for a lead joins the fingerprint index for the rest of the same
  pass, so two leads with one fingerprint file once.

The review prompt tells the reviewer to write the fixed line: the audit record's
fingerprint, second line of the lead prompt, before any record body (OTTR-959,
OTTR-980). A lead without the line falls back to the title dedupe below.

#### Lead title dedupe

A lead with no fingerprint match must not file a second card for a topic that an
open lead card already holds (OTTR-929).

- Title key: the first line of the prompt, lower case, each run of whitespace
  changed to one space, trimmed.
- The index holds only open cards (not done, not cancelled) whose title key
  starts with `needs validation`. Done and cancelled cards never block a lead
  by title.
- The board uses the title index when the fingerprint lookup finds no open or
  cancelled card. A title match counts only when the lead or the matched card
  carries no `Fingerprint:` line: two different fingerprints are two records.
  The board removes the cards that do not count first. Then the lowest card id
  of the cards that stay decides.
- A title match acts like an open fingerprint match: no new card, the
  `Seen again in review <review id> on <YYYY-MM-DD>.` line on the open card, and
  `- already open: #<card id> (<prompt head>)` on the review's Findings trail.
- A card filed for a lead joins the title index for the rest of the same pass,
  so two leads with one title file once.

#### Leads come from the turn's recorded proposals (OTTR-959, OTTR-980)

The agent records every `needs_validation` lead with `propose_task`, the same
channel as every other recorded finding, and arrival persistence stores it
before the run settles. The review prompt tells the reviewer to put the audit
record's fingerprint on the prompt's second line, in the exact form
`Fingerprint: <fingerprint>`, before any other text (the value comes from the
audit run's `findings.json`). Line 1 is the lead tag, `Needs validation:
<title>`, and line 2 is the board's fingerprint line: the strict reader takes
the first line that carries the exact prefix (an empty value reads as no
fingerprint), so a forged line in the record body never wins.
The board files the leads from the turn's recorded set, and the fingerprint
dedupe, the title dedupe, and the blocker sorting run on the prompts as below.

The lead source reads no audit run directory. The directory lives on the
worker-shared home (`/root/security-audit-skill`), where every classic worker
mounts the volume read-write and every turn runs as root, so a planted `run-N`
directory with a chosen mtime inside the turn window could once forge or
suppress another project's leads, and a planted FIFO as `findings.json` could
block the board's thread (OTTR-980). The settle pass reads no shared-home path
for leads anymore: a planted run directory is inert whatever its mtime, a pass
whose agent records no lead proposals files none, and the prompts the agent
records carry whatever the audit run held.

### 5. research-report.md survives the worktree

The report harvest (`readReportFile` -> `archiveReport` -> `task.report`) runs
only for research cards today. It also runs for review cards when the file
exists in the worktree, before `stampDoneCard` removes the Done worktree. The
"report missing" needs_you guard stays research-only: a review without the file
still reaches Done. If a review card already has a stored `report`, a later
harvest keeps the existing text (first capture wins).

Since OTTR-826 (docs/specs/saved-files.md), the report is no longer the only
survivor: every uncommitted file of a done card is kept under
`.tasks/quarantine/<id>` and listed as Saved files in the done drawer; the
report also stays in `task.report`.

## Schema (additive, no destructive change)

New table in `SCHEMA` (created on every open, so existing databases converge;
no CHECK constraints, so no enum migration applies):

```sql
CREATE TABLE IF NOT EXISTS review_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  rank INTEGER,
  security TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(card_id, prompt)
);
```

New tasks column via the `addColumn` migration in `ProjectStore.open`:

```sql
ALTER TABLE tasks ADD COLUMN findings_checked_at INTEGER
```

`Task` gains `findingsCheckedAt: number | null` (mapped like the other
camelCase fields). The stamp is the review-check entry the Done guards read.

OTTR-963 adds one more tasks column the same way:

```sql
ALTER TABLE tasks ADD COLUMN lead_at_done INTEGER
```

`Task` gains `leadAtDone: boolean` (mapped from the 0/1 column; NULL reads as
false). The field stays outside `TaskPatch`: the raw write in `runTaskUpdate`
sets it when a review lands done, and nothing clears it.

## Store API contract

```ts
/** Stores one arrived finding; returns true when it was new (not a duplicate
 * of a stored prompt). A new finding clears the card's findingsCheckedAt. */
appendReviewFinding(cardId: string, finding: RecordedFinding): boolean;

/** The card's stored findings in arrival order. */
listReviewFindings(cardId: string): RecordedFinding[];
```

`RecordedFinding` stays `{ prompt, model, rank, security }` (`src/types.ts:575`).

## Runner contract

`startRun` options, `createRunSink` options, and `handleEventLine` options gain:

```ts
/** Fired once per newly parsed propose_task finding, in arrival order. */
onRecorded?: (finding: RecordedFinding) => void;
```

`handleEventLine` fires it when `applyEvent` grew `state.recorded`; it fires
before the run resolves.

## Tests (red before the change)

1. store: an old-schema database (pre-change tasks DDL, no `review_findings`
   table, no `findings_checked_at`) converges on open; findings roundtrip; a
   duplicate prompt stores once and resets a set stamp.
2. runner: the real `createRunSink` fires `onRecorded` per `propose_task` start
   event, in order, before the result resolves; malformed calls store nothing.
3. turn: findings delivered through `onRecorded` during a run whose turn never
   settles survive on the card; a later turn that reports nothing recorded and
   answers still runs the check over the stored findings and files them.
4. turn: Done is refused while stored findings are unchecked (live park and the
   scheduled settle path); with the stamp set and no new findings, Done
   proceeds.
5. turn: lead findings file as backlog cards marked unverified, never enter the
   check input or the cap; below-cap confirmed findings stay logged; leads do
   not hold Done.
6. turn (OTTR-870): a lead whose `Fingerprint:` line matches an open card files
   no new card, and that card's details gain `Seen again in review <id> on
   <date>.`; a cancelled match files nothing; a done match files a new card
   whose details name the old card; a lead without the line falls back to the
   title dedupe.
6a. turn (OTTR-929): a lead without a fingerprint whose title key matches an
   open lead card files no new card, and the task count stays the same; a done
   or cancelled title match files the lead; two leads with one title file once;
   a same-title open card with another fingerprint does not block a
   fingerprinted lead.
7. turn: a review with two deployment-fact leads and one sandbox-run lead files
   three backlog cards and one question card with two questions; the sandbox
   card's details say it waits for a validation sandbox; each question text ends
   with its lead card's id.
8. reply route: the answers "applies" and "does not apply" queue the first lead
   card with the answer in its prompt and cancel the second with the answer as
   its reason; the question card goes Done. Free text leaves the lead card in
   backlog with the answer in its details. A one-question card takes the
   drawer's raw answer text; a started lead cancels through the sanctioned
   cancel and never loses its run to the bare patch.
9. turn: a review with only sandbox-run leads (one without the blocker line)
   files no question card.
10. turn (OTTR-959, OTTR-980): the leads are the turn's own recorded `propose_task`
    proposals. A recorded lead files as a backlog card carrying its
    `Fingerprint:` line; a lead without the line falls back to the title dedupe.
11. turn (OTTR-980): a planted audit run directory inside the turn window — a
    newer mtime, a forged regular `findings.json`, or a FIFO `findings.json` —
    never becomes the lead source, never blocks the settle, and the FIFO stays
    unread; the settle files the agent's recorded lead with the agent's
    fingerprint.
12. auditLeads (unit): `leadFingerprint` reads the first line that carries the
    exact `Fingerprint: ` prefix, trimmed; a missing, indented, inline, or
    empty-valued prefix line reads as null and never falls through to a later
    line; `leadTitleKey` lower-cases the first line and collapses whitespace.
    The property test holds over arbitrary record bodies: the readers take the
    prompt's lines 1 and 2 and never a body line, forged `Fingerprint:` or
    `Blocker:` lines included.
13. turn (OTTR-980): a landing review whose agent recorded no proposals files
    no leads and runs no check.

## Non-goals

- No UI changes (no `src/ui/**` edits beyond the AskPanel's move onto the shared
  `askAnswerLine` wire-format helper, which keeps its output byte-identical; the
  Findings trail text update is card data, not UI code).
- No `src/prompts.ts` change beyond the one OTTR-980 sentence (the user
  approved it): the review prompt tells the agent to put the audit record's
  fingerprint on each lead prompt's second line. The blocker-line wording of
  the original task shipped after its own approval; until then the sorting
  machinery stayed dormant.
- No validation sandbox; sandbox-run leads keep waiting for one.
- No change to leads that already exist (OTTR-929 adds the title dedupe of new
  leads against open lead cards).
- No recovery of findings lost before this change; no parsing of omp session
  files.
- No unverified marker column or UI badge; the mark is the card's details text.
- No structured per-finding check verdict storage beyond the stamp; the card
  summary/details trail stays the check's record.
- No dedupe of confirmed findings and no repair of the duplicate lead cards
  filed before OTTR-870; the fixed line dedupes leads only, from its first
  appearance in a lead prompt onward.
- No back-fill of fingerprints into the lead cards filed before OTTR-959; those
  cards keep the title fallback only.
