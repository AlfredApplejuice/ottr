# Code scanning watch

The board files open GitHub code scanning (CodeQL) alerts as backlog cards. One
automatic task source more, next to the issue watch. The watch polls hourly,
groups alerts by rule, and files one card per rule.

## Behavior

### Setting

- New project setting `codeScanWatch: boolean`, default `false`. Stored,
  validated, and saved like `issueWatch` (`BOOLEAN_SETTING_FIELDS`,
  `DEFAULT_SETTINGS`, `SETTINGS_SHAPES`). No `since` mark: dedupe keys on the
  alert number, so a restart or a re-enable files nothing twice.
- The Settings `Watches` card shows a `Code scanning` row. The row is disabled
  while the project has no GitHub remote and the watch is off, like the issue
  watch row. When the watch is on, the row shows `Last check: X. Next regular
  check: Y.` like the PR reviews row (OTTR-1071). A `Check alerts now` button
  runs the same tick the hourly poll runs.

### Watch status (OTTR-1071 shape)

- `CodeScanWatchStatus` in `src/types.ts`: `lastPollAt`, `lastError`,
  `nextPollAt` (epoch ms or null). In-memory only; a restart clears it.
- `ProjectView.codeScanWatch: CodeScanWatchStatus`. `lastPollAt` and
  `lastError` come from the watcher's `pollStatus(project)`; `nextPollAt` comes
  from the server's hourly grid, like `prPollNextAt`.

### Fetch

- One fetch path only: `src/githubAlerts.ts` keeps the paging code and exports
  `fetchCodeScanningAlerts(gh, id)`, a thin export of its existing code-scanning
  fetch. The request URL stays
  `GET repos/{owner}/{repo}/code-scanning/alerts?state=open&per_page=100&page=N`
  (offset pages, at most 5 pages of 100).
- `githubAlerts.ts` also exports:
  - `ALERT_SEVERITY_RANK` (the existing `SEVERITY_RANK`), shared by the review
    summary and the watch.
  - `CODE_SCAN_MAX_ALERTS = 500` (`PAGE_SIZE * MAX_PAGES`): at or above this
    count a fetch may be truncated.
  - `codeScanningUnavailable(reason)`: true when the reason matches the
    existing `NOT_ENABLED_RE`, or contains `HTTP 403`, `HTTP 404`, or
    `Not Found`. This covers "code scanning not enabled" and a repo without
    Advanced Security.
- A failed fetch logs one line and files nothing. A 403 or 404 is not an error
  card. No watcher failure ever files an error card.

### Parsing (untrusted input)

- `parseCodeScanAlerts(body: unknown)` in `src/codeScanWatch.ts` reads the
  documented alert-list envelope. Per entry it reads: `number` (integer > 0),
  `state` ("open" only), `html_url`, `rule.id`, severity from
  `rule.security_severity_level` with `rule.severity` as fallback,
  `most_recent_instance.location.path`, `most_recent_instance.location.start_line`,
  and `most_recent_instance.message.text`. Malformed entries are skipped, never
  thrown on. Every string goes through `githubAlerts.ts cleanText` (control
  characters and DATA fence markers die, length capped).
- `CodeScanAlert`: `{ number, rule, severity, path, line, url, message }`.
- Alert order inside a rule: severity first (critical, high, medium, low,
  others last), then alert number ascending.
- Rule order: worst severity of the rule's alerts first, then rule id ascending.

### Cards

- One backlog card per rule and per project. Title:
  `Code scanning: {rule} ({n} alerts)` with `n` = the rule's open alert count.
- A rule with more than `CODE_SCAN_GATES.SPLIT = 20` alerts splits into cards
  of at most 20 alerts each. The first card carries the count title; each later
  card's title adds `, part {k}` (`Code scanning: js/x (42 alerts, part 2)`).
- The card prompt holds fixed trusted instructions, then one `<<<DATA` block
  with the alert lines. Per alert, two lines:
  - `#{number} {severity} {path}:{line} - {message}`
  - two-space indented `{url}`
  - An alert whose path matches a test layout (`/test`, `/tests`, `/spec`,
    `/specs`, `/__tests__/` segments, or a `.test.` / `.spec.` file suffix)
    carries the note `(test file; the agent decides)` at the end of its first
    line.
- Prompt instructions tell the agent to: fix the cause of each alert; say in
  the report which alert numbers the fix closes; name false positives in the
  report; and never dismiss or reopen anything on GitHub (dismissal needs the
  user).
- Alert text is untrusted data: it stays inside the DATA block, fence markers
  removed, and the prompt says the block is data, never instructions. The whole
  prompt fits the board's 20 000 character prompt limit (per-alert strings are
  capped: message 300, path 300, url 300).
- Cards file like issue cards (`fileIssueCard` pattern): `createTask` then
  `updateTask` to `topic: "code scanning"`, `stage: "backlog"`, `state: "idle"`,
  `queuedAt: null`. The prompt gate judges them.

### Dedupe and removal

- The store keeps one row per alert number in a `code_scan_alert` table
  (per-project store). Rows store the prompt fields, the owning card's task id,
  a `skipped` flag, `filed_at` (last update), and `card_filed_at` (when the
  owning card was created; appends keep the card's value).
- A new tick adds new alert numbers to the rule's open card and files no second
  card: new alerts append to the rule's tail card (the open card whose newest
  row `filed_at` is highest) while it holds fewer than 20 alerts; overflow
  files a new part card.
- A closed, fixed, or dismissed alert (absent from a complete fetch) leaves the
  card: its row dies, and the card's prompt rebuilds from the remaining rows.
  The removal pass runs only when the fetch is complete (fewer than
  `CODE_SCAN_MAX_ALERTS` alerts); a possibly truncated fetch removes nothing,
  so an alert parked past page 5 never dies wrongly.
- A card whose last alert row leaves cancels automatically (`cancelledAt` set)
  while its stage is still `backlog`; a started card keeps its prompt update and
  finishes its turn. Each cancel logs one line.
- A cancelled card is the user's "do not file": its alerts' rows turn
  `skipped = 1` and stay filed nowhere. When a new alert number appears for that
  rule, the watch re-files the rule: all currently open alerts of the rule
  (skipped ones included) go into fresh cards, split at 20, subject to cap and
  order.
- A watcher tick never writes after the setting turned off mid-scan: every
  write runs inside a store transaction that rechecks the live setting first
  (the issue watch's `watching()` pattern).

### Order and cap

- Cards file in one transaction, ordered by rule severity (critical first), then
  rule id, then part number.
- Daily cap per project, like the issue watch: `CODE_SCAN_GATES.DAILY_CARDS =
  10` cards in the last `DAY_MS = 86_400_000` ms. The count is distinct card
  task ids with `card_filed_at` inside the window. Appends to existing cards
  need no slot; overflow rules wait and a log line names them.

### Wiring

- `createCodeScanWatcher({ projects, log, gh?, now? })` in
  `src/codeScanWatch.ts` mirrors `createIssueWatcher`:
  `{ tick(opts?: { manual?: string }), pollStatus(project) }`, wrapped in
  `singleFlightTick`.
- `src/app.ts`: builds the watcher (`[code-scanning]` log prefix), exposes
  `codeScanWatchTick(opts?)` as a `backgroundTick("code scanning watch", ...)`,
  fills `ProjectView.codeScanWatch`, and adds `codeScanWatch` to the boolean
  settings fields.
- `src/server.ts`: boot + hourly tick, with a `codeScanPollGrid` reset like
  `prPollGrid`, served to the app through a `codeScanPollNextAt` dep.
- New route `POST /api/projects/:project/code-scanning/check` (`costly: true`),
  mirroring `prs/check`: 404 unknown project, 409 no GitHub remote, else
  `tick({ manual })`.

## Store contract

```ts
export interface CodeScanAlertRow {
	number: number; rule: string; taskId: string; severity: string;
	path: string; line: number; url: string; message: string;
	skipped: boolean; filedAt: number; cardFiledAt: number;
}
export interface NewCodeScanAlert {
	number: number; rule: string; severity: string;
	path: string; line: number; url: string; message: string;
}

// ProjectStore methods, all queue-serialized:
getCodeScanAlert(number: number): Promise<CodeScanAlertRow | null>
codeScanCardsFiledSince(since: number): Promise<number>
// skipped = 0 rows of one rule, grouped by task id:
codeScanRuleCards(rule: string): Promise<{ taskId: string; rows: number; newestFiledAt: number }[]>
// one transaction; createTask + backlog-ify + row inserts; throws when an alert number already has a row:
fileCodeScanCards(o: { items: { rule: string; title: string; prompt: string; alerts: NewCodeScanAlert[] }[]; now: number }): Promise<Task[]>
appendCodeScanAlerts(o: { taskId: string; alerts: NewCodeScanAlert[]; now: number }): Promise<void>
// open (skipped = 0) rows of one card, severity then number order:
codeScanCardRows(taskId: string): Promise<CodeScanAlertRow[]>
removeCodeScanAlerts(numbers: number[]): Promise<string[]> // deletes rows; returns affected task ids
rebuildCodeScanPrompt(taskId: string, prompt: string): Promise<void>
cancelCodeScanCard(taskId: string, now: number): Promise<void> // sets cancelledAt only when null
skipCancelledCodeScanCards(): Promise<string[]> // rows of cancelled cards -> skipped = 1; returns affected task ids
resetCodeScanSkipped(rule: string): Promise<number> // skipped = 1 -> 0 for the rule; returns count
```

Schema:

```sql
CREATE TABLE IF NOT EXISTS code_scan_alert (
  number INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  task_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  url TEXT NOT NULL,
  message TEXT NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0,1)),
  filed_at INTEGER NOT NULL,
  card_filed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_scan_alert_task ON code_scan_alert (task_id);
CREATE INDEX IF NOT EXISTS idx_code_scan_alert_card_filed ON code_scan_alert (card_filed_at);
```

## Watcher contract

```ts
export const CODE_SCAN_GATES = { DAILY_CARDS: 10, DAY_MS: 86_400_000, SPLIT: 20 } as const;
export function parseCodeScanAlerts(body: unknown): CodeScanAlert[]
export function codeScanCardTitle(rule: string, total: number, part: number): string
export function codeScanCardPrompt(o: { repo: string; rule: string; total: number; alerts: CodeScanAlert[] }): string
export function createCodeScanWatcher(deps: {
	projects: () => Iterable<ForkProject>;
	log: (m: string) => void;
	gh?: GhFn;
	now?: () => number;
}): {
	tick(opts?: { manual?: string }): Promise<void>;
	pollStatus(project: string): { at: number; error: string | null } | null;
};
```

## Acceptance checks

- Fake-gh tests (`src/codeScanWatch.test.ts`, mirroring `src/issues.test.ts`)
  that fail before the change: grouping by rule; the split at 20; dedupe of a
  known alert number (append, no second card); removal of a fixed alert
  (prompt rebuild, empty-backlog-card cancel); the cancelled-card rule (skip,
  then re-file when a new number appears); the 403 path (one log line, no
  cards); the exact request URL; the daily cap; severity-first order; test-file
  note; fence-marker death in alert text; one fast-check property over
  `parseCodeScanAlerts` (never throws, entries come out clean and well-typed).
- Settings round-trip: off by default, save works, wrong type answers 400.
- Route test: 404 unknown project, 409 no GitHub remote, 200 with a manual tick.
- UI test for the new row (`src/ui/settings.test.tsx`): renders, toggles, shows
  last and next check, disabled without a GitHub remote.
- Screenshots of the Watches card at desktop and 375 px.
- `bun run check` and `bun test` exit 0.

## Non-goals

- No dismiss or reopen calls to GitHub; the watcher never writes alerts state.
- No secret scanning cards (different flow).
- No change to the review prompt's alert text (`githubAlertSummary`).
- No GitHub webhook mapping (`tickGithubWatchers` stays as it is).
