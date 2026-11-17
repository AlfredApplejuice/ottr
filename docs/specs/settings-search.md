# Settings search

## Assumptions

- Search applies to the current General or project settings page.
- A case-insensitive contains match checks each setting label, key, and description, including help text.
- The page hides settings without a match and sections without a matching setting.
- Matching settings retain their card titles and topic headers.
- The filter does not search saved values, secret values, or task data.

## Behavior

A visible Search settings field follows the Settings title on General and project pages.
The filter updates as the user types.
The query uses literal substring comparison, not regular expressions.
The filter ignores letter case and whitespace at either end of the query.
An empty or whitespace-only query restores the full page.
A Clear search button clears the query and returns focus to the field.
A query without matches shows a status message with a clear recovery action.

The filter keeps existing controls mounted, so a hidden field retains its unsaved value.
Search does not save settings or cause new requests.
The settings map contains only visible cards while the filter is active.
A rowless section can match its heading or hint without a match in a sibling form.
The project header stays visible to identify the current search scope.
Hosted mode keeps its existing restrictions before search applies.
Page changes clear the query.
A valid deep link clears the filter before the page reveals and focuses its target.

## Implementation boundaries

Use the existing SettingsPage, row components, card structure, and design tokens.
Keep filter logic in src/ui/settingsSearch.ts.
Export settingsMatch(query: string, fields: readonly string[]): boolean for literal matching.
Export filterSettings(root: HTMLElement, query: string): ReadonlySet<string> with the visible card ids.
The filter uses setting labels, descriptions, help text, and explicit setting-key metadata.
Do not use input values or entire card text as a search index.
Keep normal card actions and related help usable for each matching setting.
The Worktrees card must retain its Save action, which the current function child omits.

## Acceptance checks

- On a project page, firecracker shows the microVM setting under Work and Runners.
- The same query hides the unrelated runner cap and other settings.
- FIRECRACKER produces the same visible settings.
- microVm finds the microVM setting by its key.
- On General, a description-only query finds its setting and hides unrelated rows.
- Clearing the query restores all allowed settings and retains an unsaved field value.
- A query without matches shows the empty state and no empty section headings.
- Search remains usable at desktop width and at 320px and 375px in both themes.
- Component tests cover filtering, reset, hosted restrictions, and draft preservation.
- Property tests compare literal contains behavior with a simple reference using the existing fixed-seed setup.
- bun run check and bun test pass after the final edit.

## Non-goals

- No global search across other settings pages or projects.
- No fuzzy match, regular expression syntax, ranking, or match highlight.
- No server, database, authentication, dependency, or setting-save changes.
- No changes to the omp usage reader owned by OTTR-1088.
