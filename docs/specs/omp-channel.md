# omp channel: every board tracks a published verified omp list

Status: proposed (OTTR-1127). Accepted together with ADR 0016
(`docs/adr/0016-omp-runtime-channel.md`); then this spec replaces
`docs/specs/omp-watch.md` and supersedes its ADR 0010 flow.

## Goal

Every Ottr board, also a self-hosted one without the ottr-ai/ottr project, gets new omp
versions without a new Ottr release. Ottr publishes a verified list of omp versions.
Boards install from that list into a runtime layer. The image's omp stays the floor and
the fallback, and a user can turn the whole channel off.

Today a release image bakes omp in at build time (`Dockerfile.worker`,
`ARG OMP_VERSION=18.15.0`). A release-image deployment updates only by moving its image
tag (`docs/WORKERS.md`, "Updates"), so it gets a new omp only with a new Ottr release.
The ADR 0010 watch edits `Dockerfile.worker` through a card, so it helps only a board
that holds the Ottr repo. On 2026-11-18 the board missed GPT-6.2 for days: omp 18.15.0
hides `gpt-6.2-sol` and `gpt-6.2-astra` (both are in omp's models.db), omp 18.22.2 lists
them, and the 7-day gate held 18.22.2 until 2026-11-25.

## Decisions (from the user, 2026-11-18)

1. Keep the 7-day release age gate (global rule 21: at least 7 days old, unless a
   security fix needs a newer one).
2. Bump earlier than 7 days only when (a) a security advisory affects the running omp
   and the candidate fixes it, or (b) the candidate shows models that the running omp
   hides, for providers with an active sign-in.
3. Run smoke tests before every bump: the board must work with the new omp.
4. Never bump a major version automatically. Show it to the admin with the smoke-test
   evidence, and bump only after approval.
5. Every board gets new omp versions through Ottr's published verified list.
6. A user can turn this off and run only the omp version of the installed release image.

## Modes: the board setting "omp updates"

Choice: one board-level setting, not a project setting. Reason: omp is one runtime for
the whole deployment — the server and every runner spawn the same binary — so a
per-project setting cannot express the real unit, and the old `ompWatch` project
setting (a board feature in project clothing) had no recorded reason to be per project.

- Key `ompUpdates` in the stored config row (`gstore.get<StoredConfig>("config")`, the
  same row the other general settings use), values `"list" | "early" | "image"`.
  Absent or wrong type restores as `"list"`.
- `POST /api/settings` accepts `ompUpdates`; an unknown value returns 400
  `ompUpdates must be "list", "early" or "image"`. The GET payload carries it.
- The General settings page (`src/ui/settings.tsx`) gains a section "omp updates"
  (anchor `omp-updates-section`) with three radio rows:
  - **Verified list** (default). The board fetches the list hourly, installs a verified
    version above the running one, smokes it, and flips.
  - **Verified list plus early bumps**. The same, plus the board runs triggers 2a/2b
    itself against npm and GitHub, without waiting for the list.
  - **Release image only** (decision 6). No runtime layer, no fetch of any kind; the
    image's omp runs. The section shows the image pin and nothing else.
- The section shows the live state: running version, image floor, last check time, and
  warning lines (an unfetchable list, a refused entry, a failed smoke run).

## The verified list

Choice: a committed JSON file at a fixed path in ottr-ai/ottr, not a release asset.
Reason: git history is the audit trail, a card can commit it through the normal merge
flow, and a release asset would tie list updates to release cuts — the coupling this
design removes.

- Path: `docs/compat/omp-compat.json` on the default branch of `ottr-ai/ottr`, fetched
  from raw.githubusercontent.com. The file is public: the fetch sends no token, also
  never an enterprise-host token (the release-notes rule of `docs/specs/omp-watch.md`).
  Every board, also a fork's board, fetches upstream `ottr-ai/ottr`.
- Schema (normative):

```json
{
  "schema": 1,
  "updatedAt": "2026-11-19T00:00:00Z",
  "floor": "18.15.0",
  "versions": [
    {
      "version": "18.22.2",
      "publishedAt": "2026-11-15T12:00:00Z",
      "integrity": "sha512-base64",
      "tarball": "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/-/pi-coding-agent-18.22.2.tgz",
      "smoke": "pass",
      "review": "pass",
      "reason": "age",
      "major": false,
      "notes": "https://github.com/can1357/oh-my-pi/releases/tag/v18.22.2"
    }
  ]
}
```

- `reason` is `"age"`, `"security"` or `"models"`: the exemption that put the version on
  the list before its 7th day, else `"age"`. `major` is true when the version's major
  is above the floor's major (`"needs approval"`). `versions` is ascending, stable
  semver only.
- Consumer validation (all must hold, else the entry is refused and logged):
  `schema === 1`; each version matches `^\d+\.\d+\.\d+$`; `integrity` matches
  `^sha512-[A-Za-z0-9+/=]+$`; `publishedAt` parses; ascending order. Refused entries
  never install; the rest of a valid list still applies.
- Trust rules: the entry's `integrity` must equal the npm packument's
  `versions[<v>].dist.integrity`, and `tarball` must equal `dist.tarball` (the packument
  at `OMP_PACKAGE_URL`, the constant `src/ompWatch.ts` already pins). The board then
  downloads that exact tarball and re-checks its sha512 against `integrity` before
  install. A mismatch at any of the three points refuses the entry: the board never
  guesses and never installs from a registry tag directly.
- A list that cannot be fetched, parsed or validated keeps the current version, shows a
  warning line in the settings section, and retries on the next tick. An old list never
  triggers a downgrade.

## The runtime omp layer

Choice: the tools.json pattern. Reason: `src/tools.ts` already installs pinned
artifacts into the shared home volume and puts them on PATH through a link dir; Alate
layers and `.ottr` lists prove the volume reaches every runner.

- Layout in the shared agent home (the volume that carries `.ottr`):
  `~/.ottr/omp/versions/<x.y.z>/` holds one installed version;
  `~/.ottr/omp/current` is a symlink to the serving version's dir.
- Install: download the verified tarball, re-check its sha512, then
  `BUN_INSTALL=<versions dir>/<version> bun install -g --ignore-scripts <tarball>`.
  Install scripts stay off (supply-chain hardening; the integrity checks above are the
  provenance gate). A failed or half-installed version dir is removed before the next
  attempt; a failed install never flips the link.
- Switch: the smoke suite runs first (below). On a pass, the board creates the new
  `current` link at a temp name and renames it over the old one — one atomic rename.
  Every runner resolves `current` at spawn time, so the flip switches the server and all
  runners at their next spawn, and a running turn keeps the binary it already started.
- Resolution: one shared resolver, `boardOmpEnv` (`src/login.ts`), prepends
  `~/.ottr/omp/current/bin` to PATH, and every board-side omp spawn goes through it:
  the turn launcher (`src/runner.ts`), `omp models --json` (`src/models.ts`),
  `omp usage --json` (`src/quota.ts`, env passed from its `boardOmpEnv()` callers),
  `omp login` (`src/login.ts`), `omp token` (`src/tokens.ts`), the fork-analysis
  gateway (`src/forkAnalysis.ts`) and the omp stats dashboard
  (`src/ompStatsDashboard.ts`, env from `server.ts`). One resolver is the point: a
  flip switches every board-side call at once, and a spawn site that skips
  `boardOmpEnv` would run the image omp beside the layer omp. The worker and microVM
  guest spawn points (`src/workers.ts`, `src/vmGuest.ts`) already take `opts.ompPath`;
  they receive the resolved `current/bin/omp`. Each runner kind must resolve the
  volume; a runner that cannot see it (no volume mount) keeps the image omp through
  the fallback.
- Floor and fallback: the board never installs a version at or below the image pin
  (read from the deployment's `Dockerfile.worker` when the repo is present, else from
  `omp --version` of the image binary). When `current` is missing, broken or points at a
  version whose binary does not run, every spawn falls back to the PATH `omp` — the
  image's binary.

## Smoke tests (decision 3)

Choice: five checks, run before every flip, on the image's bun. Reason: they prove the
surface Ottr actually uses — the JSON shapes, the extension, and one real turn parsed by
the production parser — and a bun gap can only surface by running on that bun.

1. `<candidate> --version` prints the candidate version.
2. `omp models --json` parses and carries the fields `src/models.ts` reads; at least one
   model.
3. `omp usage --json` parses and carries the fields `src/quota.ts` `parseUsage` reads.
4. The tracker extension loads: the turn of check 5 runs with
   `--extension extension/tracker.ts --config run.yml` (the `buildOmpArgs` argv shape)
   and its tool events include tracker tools.
5. One print-mode turn: `-p --mode json` on the cheapest model with an active sign-in
   (`src/login.ts` provider list), a fixed one-line prompt, `--max-time 120`, parsed by
   the production runner parser (session file, tool events, `report_outcome`).

- Cost per run: the cheapest signed-in chat model by list price, one fixed short prompt,
  one attempt, 120 s cap — under $0.05 at list price. The smoke result records the
  model and the usage total.
- Where: on the server host, and on one runner of each kind the deployment runs (one
  classic worker through the worker protocol; the microVM guest when `microVm` is on).
  All must pass before the flip.
- No provider has an active sign-in: checks 4–5 cannot run, so the bump waits and the
  settings section says so. No blind flip.
- Bun rule: an omp that needs a newer bun than the image has fails here (check 1 or the
  turn) and waits for a release image. The channel never ships a bun; only a release
  image can.

## Major versions (decision 4)

- The list marks them `major: true`. The consumer stops its walk at the first major
  entry: it installs nothing at or above that version without approval, also nothing
  inside that major line (a 19.0.1 does not slip past a held 19.0.0).
- The pending approval surfaces as a needs-you notice in the bell, linked to
  `Settings → omp updates` (the deep-link scheme of `docs/specs/settings-deep-links.md`).
  The section shows the version, the smoke evidence (checks 1–5 results), the review
  result and the notes link, with **Approve** and **Keep** actions. Approve installs
  that version (full smoke again, then flip). Keep dismisses the notice; the walk stays
  stopped until a higher version the admin approved, or until the admin approves later.

## Early bumps (mode "early", triggers 2a/2b)

Choice: the board runs only the two cheap, deterministic triggers itself; it never
re-runs the model changelog review locally. Reason: the review needs Ottr's own
dependency context and is the producer's paid gate; the triggers are checks a board can
run without it.

- On each hourly tick, the board reads the npm packument for stable versions above the
  running one that the list does not cover, oldest first.
- Trigger 2a (security): the GitHub security advisories of `can1357/oh-my-pi` (public,
  tokenless) name an advisory that affects a version at or below the running one and
  that the candidate fixes. Evidence: the advisory id.
- Trigger 2b (hidden models): the board installs the candidate into the version dir
  without flipping, runs `omp models --json` for candidate and running omp, and
  compares the model ids per provider with an active sign-in (`src/login.ts`). The
  candidate lists an id the running omp hides. Evidence: the model ids.
- An eligible candidate runs the full smoke suite; on a pass it flips. The early bump
  never touches the list and never bumps a major (decision 4 holds in every mode).
- Guard: at most one early bump per 24 hours per board. Reason: a model-release flurry
  must not churn the fleet; the next tick catches up.

## The producer (Ottr's own board)

Choice: the producer role activates by repo detection, not by a second setting.
Reason: the watch already knew its project by the `Dockerfile.worker` pin; a fork's
board must not publish upstream, so detection needs the origin too.

- Active when a board project's origin URL names `ottr-ai/ottr` (the pinned `originUrl`)
  and its root has `Dockerfile.worker` with `ARG OMP_VERSION`. Otherwise off, and the
  settings section says why (a fork sees "producer off: origin is not ottr-ai/ottr").
- Hourly, single-flight tick (the `src/ompWatch.ts` tick shape). For each stable npm
  version above the pin, oldest first, the producer runs the gates in order:
  1. Changelog review: the PASS/FAIL model review of `docs/specs/omp-watch.md`,
     unchanged contract (tool-free `runGateway` call, `PASS`/`FAIL` first line, fail
     reasons, DATA-fenced notes). The review prompt constant moves out of
     `src/prompts.ts` verbatim — see "Later hard stops".
  2. Age gate: `releaseLineAccepts` (the settled-line rule of
     `docs/specs/release-line-gate.md`, 7 days, 14-day cap), with the two exemptions:
     a security advisory fixed by the version (2a), or hidden models with an active
     sign-in (2b, proven by the producer's own candidate install and model compare).
  3. Smoke suite: the producer installs the candidate and runs all five checks.
  4. Major hold: a major above the floor gets `major: true` and stops there.
- A version that passes all gates becomes a list entry with its `reason`. The producer
  files one card `Publish omp-compat.json for <version>` that adds the entry to
  `docs/compat/omp-compat.json` and commits it through the normal merge turn. One card
  per version; a card for X is not filed again while X is on the list.
- The image pin moves only through a card, only to a version already on the list,
  typically in release prep (`Move the image pin to <version>`). This replaces the
  `Bump omp to <version>` Dockerfile card of ADR 0010. The pin is the floor every
  release image ships.
- A failed publish card (no push rights, a refused commit) fails visibly; the producer
  state records the error and does not re-file while the card is open.

## Settings and migration

- Additive, one-way, no value conversion (ADR 0003 style: the config and settings
  stores ignore unknown keys):
  - `ProjectSettings.ompWatch` goes away: the field in `src/types.ts`, the
    `DEFAULT_SETTINGS` entry and validator row in `src/store.ts`, the 400 text, the
    settings check row. A stored `ompWatch` value stays in the table and is ignored,
    like every stale key.
  - The board-level `ompUpdates` key is absent on every existing board, so every board
    converges to "Verified list" (decision 5), also a board that had `ompWatch` on.
    Turning it off is one click (decision 6). "early" is never auto-enabled.
  - The old watch's repo-holding board becomes the producer automatically by repo
    detection; it needs no migration of its verdict state, which starts empty.
- `src/ompWatch.ts` and its tests go away with build card B6; the module's useful parts
  (the packument reader, the review call shape, `bumpTarget`'s walk) move into the
  channel module. The store keys `ompWatch:<project>` are abandoned and ignored.

## Error cases

- List fetch, parse or validation failure: keep the current version, one warning line,
  retry next tick. No install, no flip, no guess.
- Integrity mismatch (list vs packument vs downloaded tarball): refuse the entry, log,
  warning line; never install.
- Install failure or smoke failure: keep the current version, record the failure for
  that version, clean the partial dir, do not retry the same failed entry until its
  list entry changes (a new `updatedAt` and hash reset the guard).
- No signed-in provider: checks 4–5 wait; the section explains; trigger 2b is off.
- npm, GitHub or model outage: log, retry next tick; no card and no entry from a
  failure (today's watch rule).
- Producer without push rights: the publish card fails visibly; no silent drop.
- A hand-bumped pin above the list's top: versions at or below the pin are ignored,
  like today's watch.

## Alternatives considered

1. **An automatic patch release per omp bump with a one-click pull.** Rejected: it
   couples the omp cadence to Ottr releases, which is the problem this design removes;
   a self-hoster on a tag still waits for the release, and Ottr would cut releases per
   bump.
2. **Each board runs the full gates alone.** Rejected: every board pays the model
   review and the smoke cost per version; verdicts diverge with no shared record; the
   changelog review needs Ottr's own dependency context, which a random board lacks;
   and a board without a signed-in review model stalls at the review gate.
3. **The user's first idea: bump at once with smoke tests, no 7-day gate.** Rejected:
   smoke tests prove behavior, not provenance. A hijacked npm publish passes a smoke
   test. The 7-day window is the quarantine that bounds a compromised release (global
   rule 21), so it stays, with the two named exemptions.
4. **A release asset as the list carrier.** Rejected above: it re-couples list updates
   to release cuts; the committed file needs no release tooling and keeps history.
5. **A per-project omp mode (keep `ompWatch`, add per-project channels).** Rejected
   above: one runtime per deployment; per-project settings cannot express it.

## Risks

- **The list is a trust point.** A hostile or wrong list can point boards at a version
  Ottr verified in error, or at a hash the board refuses. Mitigations: schema
  validation, the three-point integrity check, tokenless fetch of a public file,
  reviewed cards and public git history. Residual: boards trust Ottr's verification,
  like they trust Ottr releases today.
- **Boards and release images can differ.** A candidate can pass on Ottr's bun and fail
  on an older image's bun. Mitigations: the smoke suite runs on the deployed bun; the
  floor rule; the fallback keeps the image omp; a bun gap waits for a release image.
- **The smoke turn costs money and needs a working provider.** Mitigations: cheapest
  signed-in model, fixed prompt, 120 s cap, under $0.05 per run; no sign-in waits
  instead of flipping; a provider outage keeps the current version.
- **Early-bump churn.** A flurry of model releases could flip often. Mitigation: one
  early bump per 24 hours per board.
- **Producer outage.** The list goes stale; boards keep running their current verified
  version and never downgrade. A stale list degrades to today's behavior, slower.

## Acceptance checks

Per build card; every card also runs `bun run check` and `bun test` to exit 0, and adds
fixed-seed property tests (100–200 runs) for every parser it adds.

### B1 — list module (`src/ompCompat.ts`, `src/ompCompat.test.ts`)

- A valid list parses; each broken rule (schema, version shape, integrity shape, date,
  order) refuses that entry and keeps the others.
- An entry whose `integrity` or `tarball` differs from the packument is refused, with a
  logged reason; the packument fetch is mocked.
- A fetch or parse failure returns "no list" plus a warning reason, never a partial
  list; the caller keeps the current version.
- Property: fuzzed JSON bodies never throw; the result is always accept/refuse with a
  reason.

### B2 — runtime layer (`src/ompLayer.ts`, `src/ompLayer.test.ts`)

- Install from a fixture tarball with the right sha512 lands in
  `versions/<version>` with scripts off; a wrong hash refuses before install.
- The flip is one rename; a reader that resolves `current` during the flip sees either
  the old or the new target, never a missing link.
- A missing or broken `current` resolves to the fallback; a version at or below the
  floor is refused.
- A failed install leaves the flip untouched and removes its partial dir.
- Each runner kind resolves the layer: the server PATH prepend, the `ompPath` argument
  for workers and microVM guests (pinned argv in tests).
- Every board-side spawn site runs the layer binary after a flip: the turn launcher,
  `omp models`, `omp usage`, `omp login`, `omp token`, the fork-analysis gateway and
  the stats dashboard each resolve through `boardOmpEnv` (pinned env tests); a site
  that builds its own omp PATH or skips the resolver fails the check.

### B3 — smoke suite (`src/ompSmoke.ts`, `src/ompSmoke.test.ts`)

- All five checks run against a stub omp binary; a stub that prints wrong JSON shapes,
  hides tracker tools, or never calls `report_outcome` fails the suite.
- The model pick takes the cheapest signed-in provider's model; no sign-in skips checks
  4–5 and reports "waiting".
- `--max-time 120` is in the turn argv; the result records model and usage.
- A bun failure (the stub exits nonzero on `--version`) fails the suite with the bun
  reason.

### B4 — setting and migration (`src/types.ts`, `src/store.ts`, `src/app.ts`, `src/ui/settings.tsx`)

- `POST /api/settings` accepts the three values and 400s anything else; the GET payload
  carries `ompUpdates`; a config row without it restores as `"list"`.
- The stored project key `ompWatch` is ignored after the field removal (the settings
  reader skips unknown keys — pinned by a test).
- The General settings section renders the three radio rows, the state line and warning
  lines; the needs-you notice deep-links to `Settings → omp updates`.
- `settings.test.tsx` covers the section; `settingsSearch.test.ts` covers the new TOC
  entry.

### B5 — consumer poller (`src/ompChannel.ts`, `src/ompChannel.test.ts`)

- Mode "list": the highest verified non-major entry above the running version installs,
  smokes and flips once; a second tick files no second install; the walk stops at the
  first `major: true` entry, also for a later minor inside that line.
- Approval: the notice appears with the evidence; nothing installs before it; Approve
  installs after a fresh smoke; Keep dismisses and the walk stays stopped.
- Mode "early": trigger 2a with an advisory fixture bumps after smoke; trigger 2b with a
  hidden-model fixture bumps after smoke; no sign-in keeps 2b off; the 24-hour guard
  holds the second bump.
- Mode "image": no fetch of list, packument or advisories (spy), no install, no layer
  writes.
- Unfetchable list: keeps the current version, sets the warning, no flip.
- Ticks are single-flight.

### B6 — producer and retirement (`src/ompChannel.ts` producer half, `docs/compat/omp-compat.json`, deletions)

- Gates in order: a FAIL review, an unmet age gate, a failed smoke, each hold the
  entry; the exemptions (advisory fixture, hidden-model fixture) let an entry pass
  before day 7 with the right `reason`.
- One publish card per verified version; no re-file while the entry is on the list; the
  pin-move card only names a listed version.
- `src/ompWatch.ts`, `src/ompWatch.test.ts`, `ompBumpCardPrompt`, `ompFailCardPrompt`
  and the `ompWatch` project setting are gone; `knip` reports no orphans; the review
  prompt constant is byte-identical after its move (a string-equality test).
- `docs/WORKERS.md` ("Updates") and `GLOSSARY.md` (the terms "verified list" and
  "omp channel") describe the new flow; `.github/workflows/omp-bump.yml` still passes
  on a pin change.

## Later hard stops

- `src/prompts.ts` is under hard stop 3 (no new wording without the user). Build cards
  move `OMP_REVIEW_INSTRUCTIONS` verbatim and delete the two dead prompt builders. If
  the review prompt or any turn/settings copy needs new wording, that is a separate
  user-approved change and does not ride these cards.

## Non-goals

- Implementation. This card writes the ADR and this spec only.
- No rollback or downgrade automation below the running version; downgrades stay a
  manual admin action.
- No per-project omp modes; one runtime per deployment.
- No change to the bun pin, `minimumReleaseAge`, the Dependabot cooldown, or the
  release-line-gate rule for other packages.
- No hosted-tenant-specific omp choice; tenants follow the deployment's mode.
- No CI change beyond the existing `omp-bump.yml` check.
- No new dependency: `fetch`, `node:fs` and bun's own installer suffice.

## Detailed Implementation Plan

Build cards in order, each against this spec:

1. **B1 list module** — `src/ompCompat.ts` (+ tests). No dependencies.
2. **B2 runtime layer** — `src/ompLayer.ts` (+ tests). Needs B1's integrity types.
3. **B3 smoke suite** — `src/ompSmoke.ts` (+ tests). Independent of B1/B2 (takes a
   binary path); can run parallel with B2 and B4.
4. **B4 setting and migration** — types, store, `/api/settings`, settings UI. Parallel
   with B2/B3.
5. **B5 consumer poller** — `src/ompChannel.ts` (+ tests), needs B1–B4.
6. **B6 producer and retirement** — producer half, `docs/compat/omp-compat.json`,
   delete the watch, docs (`docs/WORKERS.md`, `GLOSSARY.md`). Needs B5.
