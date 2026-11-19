# Start retro proposals without asking

## Behavior

A new per-project setting, `retroAutoStart` (boolean, default `false`), shows as a sub-row of Retro in **Settings → Proposals** and in the Automation step of the add-project wizard. Its name is "Start retro proposals without asking". The stored default stays `false`, so existing projects do not change. The add-project wizard starts with it on and sends it on Finish, as it does for Retro (`docs/specs/add-project-wizard.md`, "Drafts and clone settings").

When the setting is on, a retro proposal with no decision is filed as a queued todo card. It is the same card that Accept makes. The board starts it like any other queued card, and it merges like any other card.

A retro proposal with a decision is still held at needs_you, with the same reason and Accept, Edit and Cancel as today. The drawer's decision panel shows the decision first.

When the setting is off, nothing changes: every retro proposal is held.

## The decision field

`propose_task` in retro mode gets an optional `decision` string (1-400 characters, trimmed). It holds the question that the user must answer before the task can start, for example a choice between two designs or a scope call. The agent leaves it out when the task needs no decision.

- `PROPOSE_TOOL_DESCRIPTION` in `src/prompts.ts` and its inlined copy in `extension/tracker.ts` describe the field. They also say that a card can start without an Accept. The user approved this wording change on 2026-11-19 (AGENTS.md hard stop 3).
- `retroPrompt` says that the card waits for the user, "unless the project starts proposals without asking". The user approved this wording change on 2026-11-19.
- The runner records `decision` on the proposal itself (`RunResult.proposed.decision`). When the summary is valid, it also stores it in `ProposalSummary.decision` (optional), in the existing `tasks.proposal_summary` JSON. So the database needs no schema change. A summary without the field reads as "no decision".
- A decision holds the card also when a summary field is missing. Then the summary is not stored, so the panel cannot show the question. It shows the first paragraph of the prompt, as for any proposal without a summary.

## Filing rules (`src/turn.ts`, the retro proposal filing)

- The board reads the setting from the project that the card is filed in.
- `held = !retroAutoStart || proposed.decision != null`.
- A held card: today's behavior. `state: "needs_you"`, `needsReason: proposedReason(...)`, and the cap of 3 open proposals applies.
- A started card: `state: "queued"`, `needsReason: null`, `queuedAt: now`, the same `followUpOf`, `promptAuthor: "board"`, `model` and `proposalSummary`. The cap of 3 open proposals does not apply, because the card is not an open proposal. The card queues no "." reply, so it never claims that the user wrote it.
- The retro log names the started card: `retro: proposal started without asking: <id>`.

## Acceptance checks

- Setting off: a retro proposal is held as today.
- Setting on, no decision: the card is queued, todo, `needsReason` null, `followUpOf` the source card. It is not an open proposal.
- Setting on, with a decision: the card is held, and its summary keeps the decision.
- Setting on: three held proposals do not block a started one.
- The extension refuses an empty `decision` or one longer than 400 characters.
- The drawer shows "Decision" as the first line of the panel when the field is set.

## Non-goals

- Fork proposals do not change.
- No change to the stored default (`false`): only the add-project wizard starts with the setting on.
- No change to how a started card merges. The merge holds apply as for any card.

## Risks

- Each started proposal runs a work turn with no person in the loop. A retro still files at most one proposal: the extension refuses a second `propose_task` call. One live retro per project runs at a time.
- The agent decides when a decision is needed. A wrong call starts a task that you would have wanted to decide. Cancel still stops the card.
