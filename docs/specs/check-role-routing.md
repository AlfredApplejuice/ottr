# Check role routing

The second-model check picks its model role from vendor rules that the user sets. A board with only Chinese models (or any other vendor set) gets a real second opinion. Today `checkRoleFor` (`src/scheduler.ts`) is hard-coded: an Anthropic work model gets the `critic` role, everything else gets `adversary`.

## Setting

- Name: `checkRouting`. Board-wide. Stored in the `GlobalStore` `config` row (the same row that holds `trendingScan`, `alate`, `hindsightUrl`), restored at boot by `restoreRunConfig` (`src/app.ts`). A wrong-shape stored value keeps the default `null`. The `settings` tables of `ProjectStore` stay untouched, so no database migration is needed and an old database opens unchanged.
- Shape: `{ rules: { vendor: string; role: string }[], fallback: string } | null`. `null` is the automatic routing (no setting). The type lives in `src/types.ts` as `CheckRoutingSetting`.
- `vendor` is a lowercase vendor key, `/^[a-z][a-z0-9_-]*$/`. The keys `modelVendor` (`src/vendor.ts`) can return are valid, and `unknown` is valid too: it matches a work model with no known vendor.
- `role` is a role name, `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/` (the model-roles editor rule). `fallback` is a role name or `""`; `""` means "the default rule when no rule matches".
- `rules` may be empty (a fallback-only pin). The first rule whose vendor matches the work model's vendor wins; later duplicates never run.
- The setting never names a role that must exist: a rule or fallback that names a role without a configured model falls back at check time (below), never errors.

### API

- `GET /api/settings/check-routing` answers `{ routing: CheckRoutingSetting | null }`.
- `POST /api/settings/check-routing` takes `{ rules: [...] | null, fallback: string | null }`. A body with `rules: null` and `fallback: null` clears the setting (back to `null`). The route validates the shape and answers 400 `{ error }` on a bad vendor, role, or rule. Admin-guarded like the other `/api/settings/*` routes (the `hindsight` pattern: read the saved value at boot, save through `saveConfig`).

## Resolution

Pure functions in `src/scheduler.ts`, next to `checkRoleFor`. `roles` is the omp config role map (`modelRoles()`, role → selector, file order). The work model's vendor is `modelVendor(reviewModel)`; `null` vendor means unknown.

The default rule (the built-in routing, also the fallback of every failed user rule):

1. Candidates in order: `critic`, `adversary`, then every other configured role in config order, except `default`.
2. Pick the first candidate that has a configured selector whose `modelVendor` is non-null and differs from the work model's vendor.
3. When none differs, use today's rule: an Anthropic work model gets `critic`, everything else `adversary`. A same-vendor check keeps the existing "same vendor" card warning (`checkModelWarning`).

An empty setting runs the default rule. Today's two-role setup (critic = OpenAI model, adversary = Anthropic model) produces the same roles as now for Claude and GPT runs, so no behavior migration is needed.

With a setting:

1. The first rule whose `vendor` matches the work model's vendor (`unknown` matches a `null` vendor) names the check role. When that role has a configured model, it is the check role.
2. A matched rule whose role has no configured model falls back to the default rule and the check logs one line.
3. No rule matches: a nonempty `fallback` with a configured model is the check role. A nonempty `fallback` with no configured model falls back to the default rule and logs one line. An empty `fallback` goes straight to the default rule.

Exports:

- `checkRoleFor(settings: CheckRoutingSetting | null, roles: Record<string, string>, reviewModel: string | null): string` — the check role name only.
- `checkRoutingNote(settings, roles, reviewModel): string | null` — the one-line log text when the route fell back from a user rule or the user fallback, else `null`. Note texts: `check routing: rule <vendor> -> <role> names no configured role, using the default rule` and `check routing: fallback <role> names no configured role, using the default rule`.

The check never fails because of routing: every path returns a role name.

## Turn wiring

- `TurnOps` gains `checkRouting?: () => CheckRoutingSetting | null`, overridable for tests like `modelRoles`. The default in `src/turn.ts` returns `null` (automatic). `createApp` wires the boot-restored in-memory value into every project's loop.
- `workCheckRoles` and `reviewCheckInput` route through the seam. When `checkRoutingNote` returns a line, the caller logs it once per check flow through `st.log` before the first attempt (work check and review check both).
- The stored run role (`WorkCheckRun.role`, `src/types.ts`) and the internal signatures widen from `"critic" | "adversary" | "default"` to `string`. The store parser (`src/store.ts`) accepts any nonempty string role and drops non-strings. Old records keep their stored values. The meter role and the `"default"` stamp (selector undefined → `"default"`, `src/turn.ts`) stay as they are.

## Vendor module

`VENDOR_TOKENS`, `O_SERIES` and `modelVendor` move from `src/scheduler.ts` to a new pure module `src/vendor.ts` (no Node imports, so the browser bundle can use it; it may import `splitLevel` from `src/tokens.ts` only if that module is dependency-free). Every caller imports from the new module; `scheduler.ts` keeps no re-export.

## UI

Inside **Settings → Model roles**, after the role save button, a **Check routing** block. It renders when the roles load succeeded (the pickers list the configured roles).

- One row per vendor the configured models use: the vendors of the configured role selectors (a selector with no known vendor counts as `unknown`), in first-appearance order. Each row has the vendor label and a role `<select>`: "Automatic" (no rule for that vendor) or one of the configured roles.
- A fallback `<select>`: "Automatic" or one of the configured roles.
- The block tracks its own dirty state against the saved value and has its own **Save** button (POST above), an error line on 400, and a **Reset to automatic** action that clears the setting.
- `missingCheckRoles` (`src/ui/models.ts`) changes: it takes the role map (role → selector) and returns the vendors in use that have no configured role of a different vendor. The editor's warning note names those vendors and explains the fix (add a role of another vendor, or set a routing rule); the "Add critic/Add adversary" buttons go. A board whose vendors all have a cross-vendor role shows no warning.

## Card display

A check run with a stored role other than `default` shows the role name on the card (`src/ui/app.tsx`); `default` keeps "default role". Old records render as before.

## Docs

`docs/configuration.md` (Model roles row), `docs/specs/model-roles-editor.md` (missing-check-role paragraph), and `docs/specs/hosted-mode.md` (check role line) describe the new routing; this spec is the source of truth.

## Acceptance

- Only-Chinese board: roles `adversary` = a GLM model and `critic` = a Qwen model, no setting; a GLM work run checks with `critic`, a Qwen work run checks with `adversary`.
- A user rule `zai -> reviewer` with a configured custom role `reviewer` routes a GLM work run to `reviewer`, including the meter/hosted report role through a real app boot (createApp + gstore, not a stub-only path).
- A rule to a missing role falls back to the default rule and logs one line.
- Today's setup (critic = OpenAI model, adversary = Anthropic model, no rules) gives the same roles as now for Claude and GPT runs.
- The editor does not warn on a board whose vendors all have a cross-vendor role, and warns for a vendor that has none.
- An old database without the setting opens and checks as before; the old-schema fixture in `src/store.test.ts` still passes.
- Screenshots of the Check routing table at desktop width and 375 px; the impeccable detector runs on the changed UI files; `bun run check` and `bun test` exit 0.

## Alternatives considered

- A second hard-coded vendor list in the UI: rejected — the vendor keys already live in `modelVendor`; a second list drifts.
- Storing the rules in `config.yml` next to `modelRoles`: rejected — routing is board logic, not omp config, and the data-repo save path (GitHub commits, conflicts, seed wait) is disproportionate.
- Per-project routing in `ProjectSettings`: rejected — roles are board-wide (one `config.yml`), so per-project rules would surprise; the Model roles section is board-wide.
- A role registry enum instead of a free string: rejected — role names are user data; a string keeps old runs valid with no migration.

## Risks

- A rule that routes to a role whose model equals the work model: the check still runs, and `checkModelWarning` reports "same model" as today. No new failure path.
- Loose vendor validation lets a saved unknown key survive; the UI only offers known keys plus `unknown`, and an unmatched vendor simply never matches.
- A fallback without its log line would be invisible; tests assert the note line.
