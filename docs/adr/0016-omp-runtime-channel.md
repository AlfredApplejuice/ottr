# 0016. omp runs as a runtime layer behind a published verified list

Date: 2026-11-19

## Status

proposed (OTTR-1127). Accepted only after the user approves it; on acceptance this ADR
supersedes ADR 0010 and `docs/specs/omp-channel.md` replaces `docs/specs/omp-watch.md`.

## Context

A release image bakes omp in at build time: `Dockerfile.worker` pins
`ARG OMP_VERSION=18.15.0` and installs it with `bun install -g`. Releases v0.4.0
(2026-11-12) and v0.5.0 (2026-11-15) still ship that pin from 2026-11-01. A deployment
that runs a published release image updates only by moving its image tag
(`docs/WORKERS.md`, "Updates"): it never runs a host script and never rebuilds. So a
self-hoster gets a newer omp only when Ottr cuts a release and the self-hoster moves the
tag by hand.

ADR 0010's omp watch narrowed this gap for one board only. The watch is the project
setting `ompWatch` (`src/types.ts`), default off, and it acts by editing
`Dockerfile.worker` through a card. A board that does not hold the Ottr repo gains
nothing from it: its pin sits in an image it cannot rebuild. The setting also carries no
recorded reason for being a project setting. The only pre-bump check is
`.github/workflows/omp-bump.yml`, which proves that the pinned omp starts on the image's
bun; the changelog review reads release notes and runs nothing.

The cost of this shape showed on 2026-11-18. omp 18.15.0 hides the models
`gpt-6.2-sol` and `gpt-6.2-astra` that its own models.db carries; omp 18.22.2 lists
them. The board saw GPT-6.2 days late, and the 7-day release age gate holds 18.22.2
until 2026-11-25.

## Decision

- omp becomes a runtime layer. The image's omp is the floor and the fallback. A board
  installs a chosen omp version into the shared home volume, runs smoke tests against
  it, and switches the server and all runners to it with one atomic link flip. A failed
  install or smoke test keeps the current version.
- Ottr publishes a verified list (`docs/compat/omp-compat.json` in ottr-ai/ottr). Each
  entry carries the npm integrity hash, the publish date, the smoke-test result, the
  review result, and the reason for an early bump (age, security, or hidden models). A
  board installs a version only from the list, refuses a tarball whose hash differs,
  and keeps the current version when the list cannot be fetched or parsed.
- Every board follows the list, not only boards that hold the Ottr repo. A board-level
  setting "omp updates" in the general settings picks the mode: "Verified list"
  (default), "Verified list plus early bumps" (the board also runs the security and
  hidden-model triggers itself), or "Release image only" (no runtime layer, nothing is
  fetched, the image's omp runs).
- The gates stay: the 7-day release age gate with the settled-line rule, the changelog
  review, and smoke tests before every bump. An early bump skips only the age gate, and
  only for a security fix that the running omp needs, or for models that the running
  omp hides while the provider has an active sign-in.
- A major version never installs automatically. The list marks it "needs approval"; the
  board shows a needs-you entry with the smoke evidence and installs after the admin
  approves.
- Ottr's own board produces the list. Its watch runs the gates and commits the list
  through a normal card. This replaces the "Bump omp to X" Dockerfile card; the image
  pin moves at release time, to a version the list already verified, and stays the
  floor.

## Consequences

- A self-hoster on a release image gets new omp versions without a new Ottr release and
  without a host script. Turning the setting to "Release image only" restores today's
  behavior exactly.
- The project setting `ompWatch` and `src/ompWatch.ts` go away; their work moves into
  the channel module. The migration is additive: the settings table ignores the stale
  key.
- The trust point moves from npm's 7-day quarantine to the published list. The list is
  public, committed through a reviewed card, and every tarball is re-hashed against both
  the list and npm's own packument before install. A hostile list entry still cannot
  install code the hash does not match, but it can point boards at a version Ottr
  verified; the list is part of the release's trust base.
- Every enabled board pays one smoke run per candidate version: a short print-mode turn
  on the cheapest signed-in model, capped in time and cost.
- An omp that needs a newer bun than the image has fails the smoke test on the image's
  bun and waits for a release image. The channel cannot fix a bun gap; only a release
  can.
- The `.github/workflows/omp-bump.yml` check keeps its job: it proves the pinned omp
  starts on the image's bun, which is now the floor every candidate must stand on.
- A future change to this rule requires a new ADR that supersedes this one.
