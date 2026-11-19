# Hands-off upstream provisioning updates

## Behavior

The per-project switch "Approve upstream provisioning updates before they merge" (`holdUpdateMerges`) now has two meanings:

- **On:** no change. The update rows show in the bell. You file each card, and a ready card waits for your reply before it merges.
- **Off (the default):** the board is hands-off for the project. After each good pull from Alate, the board files the update cards itself. The cards merge with no approval, the same as before.

The decision to make "off" mean hands-off for every project, including the projects that have it off now, is the user's (2026-11-19). Each project with the switch off starts to file update cards after this ships.

## Automatic filing

`refreshUpdates` in `src/app.ts` calls `autoFileUpdates` after it stores a validated pull. This also applies to the `/api/updates/refresh` route. `autoFileUpdates` files a row only when all of these are true:

- The row is not skipped (`loadSkips`).
- `fileableUpdate(id, false)` accepts the row: it is not `removed`, no other updater manages it (`managedBy`), a board project maps its repo, and that project is not gitless.
- The row has a qualified `target`, so the 7-day rule holds. A "young" `latest` is never filed by the board.
- The mapped project has `holdUpdateMerges` off.
- No card of any state (open, done or cancelled) ever carried the id in `updateIds`.

The last rule prevents loops. The id is `<name>@<target>`, so a newer version gets a new id and files again. A done card whose pin Alate still reports, or a card that you cancelled, does not file again for the same version.

The board files the rows through `createUpdateCards(picked, false)`: one card per project, the same prompt and the same `updateIds` as a manual Allow. A failure, for example a race with a manual filing, is logged. It does not stop the pull, and the next pull tries again.

## Bell

The "Upstream updates" bell entry counts:

- the rows that a person must file: a `target`, no open card, and a project that is not hands-off. A row with no mapped project still counts.
- every "Removed upstream" row that no open card covers. A person must file a remove card or skip it, for each project.

The Upstream updates list itself does not change. It still shows every row.

## Acceptance checks

- A hands-off project gets one board-filed card for its qualified rows after a pull. A second pull files nothing new.
- A project with the switch on gets no card from a pull.
- A row that a done or cancelled card carried does not file again. The next version of the same item files.
- Skipped, managed, removed and young rows do not file.
- The bell does not count the rows of a hands-off project. It counts the removed rows.

## Non-goals

- No new setting. No change to the default value.
- No automatic remove cards: a removed item still needs a person.
- No change to the merge hold itself.

## Risks

- Every board with the switch off starts agent turns for update cards. The cost is one turn for each project after each new qualified version.
- A broken update loops only once for each version, because a done or cancelled card blocks the same id.
