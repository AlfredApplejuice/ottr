# Slim board state payload (OTTR-965 P1)

## Problem

`GET /api/state` shipped 28.1 MB of JSON (7.0 MB gzipped, ~1.3-2.4 s server time) on
2026-11-15, because it carried all 2944 cards (2813 done) with every field: prompt
18.0 MB, workCheckLog 3.7 MB, workCheckReport 0.6 MB, summary 0.4 MB, gate 0.3 MB.
A phone on mobile data never finished one frame before the live socket pushed the
next. Web push still worked because it rides the browser push service.

## Behavior

- The state's tasks array carries per card only the fields the lanes, counts,
  badges, rail, search, and holds read: `TaskCard` drops `prompt`, `summary`,
  `details`, `report`, `diffText`, `diffFiles`, `workCheckLog`,
  `workCheckReport`, and `gate` on top of the four the type already omitted.
  `needsReason` and `asked` stay. `taskCardOf` builds the card by stripping the
  nine fields from the row instead of spreading the row, so a small field added
  to `Task` later keeps riding automatically.
- Done and cancelled cards older than the visible Done page do not ride the
  state. Per project the state keeps, in landed order (`cancelledAt ??
  doneAt ?? updatedAt`, newest first): the newest `DONE_PAGE` (20) done and
  cancelled cards, plus every pinned one — a done card that is unread under the
  server's own seen set and `seenDoneSince` baseline (the same rule as the
  client's `isUnread`: answered, or a research card with a steps report), and
  every starred non-cancelled card. Open cards always ride.
- New endpoint `GET /api/projects/<project>/done?page=N` answers
  `{ tasks: TaskCard[], total: number }`: page `N` (20 cards per page, page 1
  first) of the project's done and cancelled cards in the same landed order and
  the same slim shape as the state, plus the total count of the project's done
  and cancelled cards. The Done column's "Show more" fetches the next page and
  appends it; the button counts the cards still on the server
  (`total` minus held minus fetched).
- `state.projects[]` gains `doneTotal`, the project's done and cancelled count,
  so the first "Show more" knows the hidden count before any fetch.
- The drawer loads the large fields on demand. It already fetches
  `GET /api/projects/<p>/tasks/<id>` (`taskView`: the full card minus diffText,
  plus turns) when it opens; the drawer renders prompt, summary, details,
  report, work check runs, and gate from that fetch. While the fetch is in
  flight the prompt panel holds its space with the drawer's loading line; the
  other sections appear when the fetch lands, like the turns already do.
- The fix assumes that old tasks remain in the project store.
- The state window is not the full task history. The existing
  `GET /api/projects/<p>/tasks/<id>` resolves a selected card even when
  `state.tasks` omits it. Keep the card separate from slim state.
- A click on any loaded Done page row or a pasted task URL opens its correct
  drawer. Keep the canonical project/task URL in sync. Back and Forward restore
  the selected task. Close clears it.
- A later slim state frame does not close an old task's drawer. A detail
  response after Close or navigation has no effect.
- If a frame omits the selected card, retain its last state row in the drawer.
  The detail route refreshes that row without a drawer close.
- If detail fails or the task is missing, show an error without another task.
  Allow another open attempt.
- The board search matches `title` and `sessionTitle` only, and only the cards
  the client holds (the state window plus fetched pages). Prompt and summary
  text no longer ride the state, so searching them would mean shipping them.
- Every other consumer keeps working: the check-ottr-board skill reads open
  cards' small fields (`stage`, `state`, `needsReason`, `asked`, `title`,
  timestamps, `cancelledAt`) and `projects[].path` — none move. Its
  duplicate search (step 6) searched done history off the state; the state no
  longer carries it, so the skill pages `GET /api/projects/<project>/done`
  for that search, and its SKILL.md says so (updated in this change).
  `scripts/e2e-steer.js` found the rules interview card by a prompt marker on
  the state card; it now matches the card's `kind`, which stays on the state.
  `/api/seen` validation, web push, and the `/api/system` holds read store
  data or small fields only.

## Boundaries and error cases

- An unknown page or a page past the end answers `{ tasks: [], total }`, so
  "Show more" stops cleanly; `page` below 1 is a 400.
- A state frame that lands while the client holds fetched pages merges by id;
  the frame's copy of a card it still holds wins, fetched older cards keep
  their copy. A fetched card the user re-stars stays stale until the user
  refetches that page (star acts write through the store; the frame only
  covers the held window).
- The server's pinned-keep mirrors the client's pinned rule. The drift guard
  is a test: over a seeded board it computes the expected settled set with
  the client's own `isUnread` (src/ui/queue.ts), the shared `answeredCard`
  oracle for the answered fact, and the starred rule over the store rows and
  the state frame's seen set and baseline, then asserts the frame matches it
  exactly.
- A drawer opened from a fetched page card works like one opened from the
  state window: the detail fetch fills the large fields.
- No schema change: the store, its tables, and `listTasks` stay as they are.
- Do not add old cards to `state.tasks`. Keep the existing API, schema, and
  20-card Done page size.

## Acceptance checks

- A test seeds a board with 3000 cards that each carry a 10 KB prompt and
  asserts `GET /api/state` stays below 1 MB of JSON. It fails before the fix.
- A test seeds done cards past one page plus a starred and an unread answered
  one, and asserts the state holds exactly the window: the 20 newest, the
  starred, and the unread answered card.
- A test asserts the done page endpoint returns page 2 in landed order with
  the right total, and 400 on page 0.
- A UI test opens a drawer for a row whose prompt the state does not carry and
  asserts the prompt renders from the task route fetch.
- A UI test loads Done page 2, opens a card absent from `state.tasks`, and
  checks the correct drawer and canonical task URL.
- A UI test pastes a task URL for an older card and checks the correct drawer
  and canonical URL. It then checks Back, Forward, and Close against the
  drawer and URL.
- A UI test keeps an old task open while a later slim state frame arrives.
- A UI test removes an open pinned card from the next frame and delays its
  detail response. The same drawer and its local state remain visible.
- A UI test supplies a newer state row, then omits it. The drawer keeps the
  newer row instead of an older detail cache.
- A UI test delays a detail response, closes or changes tasks, then checks
  that the late response changes no drawer or URL.
- A UI test checks failed and missing detail responses separately. Each shows
  an error and no wrong card. The test then opens a valid task each time.
- `bun run check` and `bun test` exit 0.
- Screenshots of the board and of an open drawer.
- The live board's `GET /api/state` size gets measured after the deploy and
  named in the report.

## Alternatives considered

- Keep shipping every card and page only in the render (the state before this
  spec): rejected — the wire stays at 7 MB, which is the bug.
- A server-side search over done history: rejected as scope creep; search now
  covers the cards the client holds.
- Cap only done cards, keep cancelled ones whole: rejected — cancelled cards
  settle in the same Done lane and carry the same wide fields.
- Ship the Done window without pinned cards and let "Show more" load them:
  rejected — an unread answer or a starred card must never hide behind the
  cut; the rail and the Inbox would count a card the board does not show.

## Risks

- Search no longer matches prompt text; a user who searched by prompt wording
  now searches by title only. Documented in this spec; no server search.
- Drift between the server's pinned-keep and the client's pinned rule would
  drop a card the board must show. The cross-check test pins the rule.
- Old clients (cached bundle) read dropped fields off new frames: `undefined`
  reads render empty until the drawer fetch lands; the drawer fetch is the
  same call an old client already made. No server compat shim.

## Non-goals

- No offline cache of the state in the service worker.
- No change to push notifications.
- No schema change.
- No server-side search over done history.
