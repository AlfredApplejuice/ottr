# Add project wizard: settings before the rules interview

The Add project flow is one guided wizard: source, board settings that are
still missing, project settings, rules interview. The interview starts only
at the last step, after the settings are saved, so PR mode and similar
choices hold for the project's first commit (OTTR-1064's failure on
AWSI-1: the interview ran before PR mode could be set).

## Steps

The wizard has five steps. Step 1 lives in the Add project form; the rest
render in the same dialog after a successful add.

| # | Name | Content | Shown when |
|---|------|---------|------------|
| 1 | Source | The existing Add form: URL or New tab, name, task ID prefix, git host access | Always (unchanged) |
| 2 | Automation | Retro + friction filter, fork research (+ GitHub facts), hold update merges, hold fork-born merges | Board settings not done yet |
| 3 | Runners | Runner cap (`maxParallel`), extra paths (`copyExtra`) | Board settings not done yet |
| 4 | Project | PR mode (`prMode`), target branch (`targetBranch`) | Always, unless hosted (see below) |
| 5 | Rules | The existing rules section: git init for a gitless folder, align, open the live card, or start the interview | Always, last |

Steps 2 and 3 reuse the `ProjectSetupSteps` sections that exist today
(the same forms the setup wizard and the settings page use; no second
copy). Step 4 reuses `CheckRow` for PR mode and posts `targetBranch`
through the same settings route the Worktrees card uses.

## Which board settings count as "not done yet"

The wizard reads the setup state that already exists — the same facts the
setup checklist (`SetupChecklist`) reads. No new flag:

- Retro is off: `settings.retroSince === null`.
- Fork research is off on a GitHub project: `project.github !== null && !settings.forkResearch`.

The board step (steps 2 and 3) shows only when at least one of these is
open. A project that lands with both done (a clone that carries a
committed `.tasks` store) starts at step 4. Step numbering in the strip
marks settled steps done.

## Project step fields

- **PR mode** — the `CheckRow` semantics of the Merging card:
  disabled while `project.github === null`, save posts
  `POST /api/projects/:project/settings { prMode }`. The server refuses
  `prMode: true` without a GitHub remote (400). Hidden in hosted mode:
  hosted hides the whole Merging card (`HOSTED_HIDDEN`, docs/specs/hosted-mode.md
  section 7), so the wizard checks the same `hostedHidden(hosted, "project-merging-section")`.
- **Target branch** — text input, empty = origin default. Saved on the
  step's Next through `POST /api/projects/:project/settings
  { targetBranch }`; an unresolvable branch is the route's 409, shown
  inline.

No other settings join this step: holds live in the board step, runner
fields in the Runners step, and the rest of the project settings keep
their home on the settings page. The wizard only shows existing settings.

## API order

1. `POST /api/projects` — creates the project, saves `setupChecklist: true`
   and `taskIdPrefix`. It **no longer starts the interview** and no longer
   returns `interview`/`id`; the response is `{ project }` (the
   `AddProjectResponse` shape in `src/types.ts` shrinks to the project view).
2. Settings saves — `POST /api/projects/:project/settings`, one patch per
   change, as today. They run before the interview exists.
3. `POST /api/projects/:project/init` — git-inits a gitless project. It
   **no longer starts the interview**; the response is `{ project }`.
4. `POST /api/projects/:project/interview` — the existing route starts the
   interview. The wizard's last step calls it on Done; it stays idempotent
   (`queued`/`running`/`not-needed`) and still refuses a gitless project
   with 409. The wizard's Done inits first when the project is still
   gitless, then calls it.

## Gitless and hosted-mode behavior

- **Gitless** (added by name without GitHub, or a commit-less clone):
  the settings routes 409 while gitless, so the wizard's first step after
  Source is the rules section's "Create git repo" panel. Creating the
  repository moves the wizard to the first unsettled settings step, so the
  Automation, Runners and Project steps still come before the interview;
  Done on the last step inits first when the project is still gitless, then
  starts the interview. The step strip marks a step done only once the
  wizard showed it or the add settled it by default. Closing before init
  leaves the project with the gitless advisory ("Create git repo") and the
  checklist.
- **Hosted mode**: the Project step shows the target branch only; the PR
  mode row is hidden exactly when the settings page hides the Merging
  card. Everything else is identical; hosted tenants run the interview
  like any project.

## Closing mid-way

Every settings change saves at once (checkbox patches, fork pre-check and
target branch on Next), so a closed dialog never loses a saved choice —
the existing wizard model, unchanged. Closing at any point after the add
leaves a project without an interview card. The ways back in:

- The setup checklist (`setupChecklist` is true for every add) gains a
  rules item while `!project.hasRules`: "Open rules task" while the
  interview card is live, "Create git repo" while gitless, otherwise
  "Start rules interview" (`POST /interview`).
- The board's no-rules advisory keeps its "Discuss rules" button; the
  gitless advisory's button becomes a plain "Create git repo" (`/init` no
  longer queues the interview, so it no longer reports an interview
  verdict).

The wizard's final step keeps "Finish later" (keeps the checklist, closes
without the interview) next to the primary action; the primary action on
each settings step gains "Skip, use defaults", which advances without
saving that step's unsaved drafts (already saved choices stay).

## Non-goals

- No change to the interview prompt text (`src/prompts.ts`).
- No new settings, no new setup flag: the wizard reads `retroSince`,
  `forkResearch`, `hasRules` and `gitless` as they exist.
- The fix for interview commits on main stays in OTTR-1064.

## Acceptance checks

- Add a project, turn PR mode on in the wizard, finish: the interview card
  exists only after the settings save, and the card is created with PR
  mode on. The UI test fails before the change.
- Closing the wizard after the add step leaves no interview card and shows
  the way to start it (checklist rules item).
- The board step shows only when board settings are missing: one test for
  each case.
- Screenshots of each wizard step at desktop and 375 px width; WCAG 2.1 AA
  kept; impeccable detector run on the changed UI files.
- `bun run check` and `bun test` exit 0.
