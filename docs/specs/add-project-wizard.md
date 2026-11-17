# Add project wizard

OTTR-1096 makes Add project one wizard. Source is step 1, not a separate operation before the wizard.
The rules interview starts only after Finish saves the selected settings.
PR mode must apply to the first interview commit, as OTTR-1064 requires.

## Assumptions

- New and Git URL keep the source values and all project settings as local drafts until Finish.
- Next and Back do not create a project, folder, remote repository, clone, or interview.
- No project setting save happens before Finish.
- Before Finish, Cancel discards all local drafts and closes the dialog.
- The close button and Escape have the same effect as Cancel.
- Git host access tests and credential setup keep their existing independent host-level effects.
  These actions must not create a project.
- The clone's actual settings, rules, Git state, and GitHub facts remain unknown until Finish.
  The draft must not claim that it reads the clone.
- This change uses the existing API and project settings.
  It does not change the setup contract for a project that already exists.

## Steps and navigation

The shared stepper appears from the first render and marks Source as the current step.
Both source paths use the same five steps.

| # | Name | Content |
|---|------|---------|
| 1 | Source | New or Git URL, name, task ID prefix, and existing Git host access controls |
| 2 | Automation | Retro, friction filter, fork research, and existing merge holds |
| 3 | Runners | Runner cap (`maxParallel`) and extra paths (`copyExtra`) |
| 4 | Project | PR mode (`prMode`) and target branch (`targetBranch`) |
| 5 | Rules | Explain the rules action that Finish performs after creation and settings saves |

Reuse the existing setup sections and field semantics.
Do not create another set of settings forms.

- Next validates the current draft and advances locally.
- Back returns to the preceding step, including Source.
  All entered values remain intact.
- Source edits apply to the final request, not to an earlier copy of the form.
  Existing name and prefix derivation rules still apply.
- The stepper reflects local progress, not a completed server operation.
- Cancel, the close button, and Escape work from every step before Finish.
- The final primary button says **Finish**.
  No other step starts creation or the rules interview.
- The new-project wizard has no **Finish later** action.
  Cancel does not keep a partial project.

All five steps remain reachable before creation.
Do not skip Automation or Runners based on settings that the clone might contain.
The Rules step does not offer an early init, alignment, or interview action.

## Drafts and clone settings

New uses the existing defaults as draft values.
Git URL shows proposed values, not known clone settings.
Explain that unchanged settings keep the clone's values after Finish.

Track explicit field changes separately from displayed defaults.
At Finish, apply only settings that the user explicitly changes.
Do not send a whole default settings object that overwrites the clone's committed `.tasks` settings.
This rule applies to Automation, Runners, PR mode, and target branch.
It also applies when Back revisits a step.

Existing GitHub facts and fork suggestions need a real project.
Do not create a project to obtain them before Finish.
Do not use unknown clone rules as evidence that an interview is necessary.
After creation, use the actual project state and the existing interview verdicts.

## Project fields and hosted mode

- PR mode keeps the settings page's GitHub requirement.
  Draft controls use the selected source's known GitHub capability.
  The actual created project and server validation remain authoritative.
- Save PR mode through `POST /api/projects/:project/settings`.
  The server still rejects `prMode: true` without a GitHub remote.
- Hide the PR mode row with `hostedHidden(hosted, "project-merging-section")`.
  Hosted mode keeps the target branch field and the Project step.
  This matches the existing Merging card rule in `docs/specs/hosted-mode.md`.
- An empty target branch means the origin default.
  Save it only at Finish, not on Next.
  Show the existing route's 409 inline when the branch cannot resolve.
- Other settings keep their existing locations.
  This wizard adds no setting.

## Finish order

Finish is the first action that can create project state.
Disable duplicate submissions for the whole operation, not only for one request.
Keep a visible busy state until the current operation ends.
Do not present Cancel as a rollback after Finish starts.
Prevent dialog dismissal while the operation is busy.

1. Validate the final source and settings drafts.
2. Call `POST /api/projects` with the final source, task ID prefix, and existing access choices.
   New creates the project here.
   Git URL clones the repository here.
   Retain the returned project identity immediately.
3. If the returned project is gitless, call `POST /api/projects/:project/init`.
   Init creates the Git repository without an interview.
4. Read the actual project settings and apply the explicit draft changes through the existing settings route.
   Wait for every required save to succeed.
   PR mode and target branch must take effect before the interview request.
5. Call `POST /api/projects/:project/interview` through the existing rules flow.
   Keep its `queued`, `running`, and `not-needed` behavior.
   Existing rules and live rules tasks keep their existing behavior.
6. After the rules action succeeds, save `setupChecklist: false`.
   Refresh the board state and close the dialog.
   Preserve the existing rules task access and result notices.

The add and init routes do not start an interview.
Their existing response shape remains unchanged.
The interview route remains idempotent and rejects a gitless project with 409.

## Errors and retry

- Show source, access, settings, init, and interview errors in the dialog.
  Retain the source and settings drafts.
  Do not report completion on an error.
- If add fails before it returns a project, keep the existing add error and access recovery flow.
  Do not advance as if a project exists.
- If add succeeds, all later retries use the returned project.
  Do not call add again, clone again, or create another folder.
- An init failure retries init for that project.
  A settings failure retries the required saves before any interview request.
- An interview failure retries the rules action without another add or clone.
  Do not clear the checklist until the rules action succeeds.
- A checklist save failure retries completion for the same project.
  The existing interview idempotency prevents another interview.
- Once Finish creates a project, later errors cannot restore the pre-Finish cancellation guarantee.
  Keep the project and its existing setup recovery path.
  Do not delete project data or undo a clone.

## Git host access and credentials

Keep the current SSH key choice, explicit host trust, token entry, and board-token opt-in flows.
Source validation must not bypass these safeguards.
Host access tests and credential saves remain independent of project creation.
They may keep host credentials or trust after Cancel, as they do today.
State that boundary where these controls need an explanation.

If Finish receives a token or trust challenge, show the existing recovery controls.
After explicit approval, retry through the same Finish operation.
Do not start an interview before all project settings succeed.
Once the server returns a project, access recovery must not repeat add.

Keep secrets in the existing credential flow and temporary component state only.
Do not place tokens in web storage, draft persistence, URLs, logs, or screenshots.
Cancel clears local token drafts.
Do not embed credentials in source code.
These rules prevent the local wizard draft from becoming a credential store.

## Existing project setup

An existing project's **Open setup** keeps its current behavior.
It uses the actual project state and saves settings through the existing flow.
Automation and Runners appear when the current checklist facts are unsettled:

- `settings.retroSince === null`.
- `project.github !== null && !settings.forkResearch`.

The existing gitless init panel still returns to the first unsettled settings step.
The checklist and no-rules advisory keep their current rules actions.
The existing setup retains **Finish later**, immediate settings saves, and **Skip, use defaults**.
Do not apply the new-project cancellation contract to this flow.

## Acceptance checks

- For New and Git URL, open Add project and observe Source as step 1 in the shared stepper.
  Assert that Next sends no add, init, project settings, or interview request.
- For each source path and each of the five steps, enter draft values and select Cancel.
  Assert zero project writes and no new project, folder, clone, remote repository, or interview.
  Reopen the dialog and assert that the local drafts are absent.
- Repeat the per-step cancellation cases with the close button and Escape.
  Existing host-level credential effects do not count as project writes.
- For both paths, advance to Rules, return to Source with Back, and edit the source values.
  Assert that all other drafts remain intact and no project exists yet.
  Finish and assert that the request uses the edited source and prefix.
- For New and Git URL, assert one add request only after Finish.
  Assert init only when gitless, then required settings saves, interview, and checklist completion in that order.
  Double-click Finish and assert no duplicate add or interview.
- With a Git URL clone that contains rules and non-default settings, leave the proposed settings untouched.
  Assert that Finish preserves those settings and uses the actual rules state.
  Change one field and assert that only that explicit change overrides the clone.
- Select PR mode for a GitHub source.
  Assert that its save succeeds before the first interview request.
  In hosted mode, assert that PR mode stays hidden and target branch remains available.
- Fail a settings save after add succeeds.
  Assert that the dialog retains the error and drafts, and sends no interview request.
  Retry and assert that it uses the same project without another add or clone.
- Fail the interview after all settings saves.
  Retry and assert one project, no second clone, and no checklist completion before interview success.
  Cover init and checklist save failure recovery for the same project.
- Exercise the existing token challenge, board-token opt-in, SSH key, and host trust flows.
  Assert that no access action creates a project before Finish or bypasses explicit trust.
  Assert that Cancel clears local token drafts and web storage contains no token.
- Open setup for an existing project.
  Assert that conditional steps, gitless recovery, immediate saves, and Finish later retain their current behavior.
- Capture every step at desktop and 375 px width in light and dark themes.
  Confirm no clipped fields or actions, keyboard access, visible focus, and WCAG 2.1 AA behavior.
  Run the impeccable detector on the changed UI files.
- `bun run check` and `bun test` exit 0.

## Non-goals

- No interview prompt change in `src/prompts.ts`.
- No new endpoint, response shape, setting, setup flag, or schema.
- No credential storage redesign, dependency, or new persistence for wizard drafts.
- No rollback, project deletion, or clone cleanup after Finish starts.
- No change to existing project setup or hosted PR visibility.
- The interview commit fix remains in OTTR-1064.
