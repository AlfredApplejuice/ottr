# README screenshot capture

## Problem

The README board screenshot (`.github/assets/screenshot.png`) went stale: a direct
session (live mode, not a board card) changed the board UI, committed and pushed
(9ba5bac), and no step anywhere tied a `src/ui` change to the screenshot. The shot was
fixed afterwards (a5019bd) by hand. Two gaps:

1. No repeatable capture: the last updates were manual browser shots.
2. No rule where agents read it: AGENTS.md (local-only) and the work prompt never name
   the screenshot, so live sessions never see a requirement.

An inherited `OTTR_VM_RUNNER_URL` without `OTTR_WORKER_TOKEN` also prevents demo startup.
A readiness retry cannot repair this environment error.

## Scope

- A one-command capture: `bun run readme-screenshot` → `scripts/readme-screenshot.ts`.
- A concrete rule in AGENTS.md (work turn and merge turn) and in the work prompt
  (`src/prompts.ts` `README_RULE`).
- A non-blocking reminder in `bun run check` when the branch diff touches `src/ui/**`
  but not the screenshot.

## Capture behaviour

- Starts the demo board (`bun src/dev.ts`) on a free port in the repo checkout.
  Each attempt uses a fresh temporary demo root and state directory, regardless of inherited
  `OTTR_DEV_ROOT` and `OTTR_STATE_DIR` values. It never uses a real board.
- Demo child environments omit `OTTR_VM_RUNNER_URL`, even when the host sets it.
  Real boards keep the existing VM runner authentication checks.
- If the board misses the 30 s readiness deadline, stops that child through `stopChildren`.
  Starts one new attempt on a free port with a fresh demo root and state directory.
  Waits up to 30 s again. A second timeout exits 1 with the same readiness error.
  An early board exit or capture error does not cause a retry.
- Both `bun run readme-screenshot` and `bash scripts/readme-screenshot.ts` run the capture.
- Drives Chrome headless over CDP with Bun's WebSocket client. No npm dependency:
  adding one is an AGENTS.md hard stop.
- Chrome discovery: `OTTR_SCREENSHOT_CHROME` env wins, else the newest Chrome across the
  puppeteer caches (`~/.cache/puppeteer/chrome*`, then `/root/.cache/puppeteer/chrome*`
  for a service HOME such as `/etc/ottr/home`; the homedir build wins a version tie), else
  `google-chrome` / `chromium` on PATH. Clear error and exit 1 when none exists.
- Emulated view: 1440x900, deviceScaleFactor 1, `prefers-color-scheme: dark`, locale
  `en-US` (else dates render in the host locale, e.g. "27. Okt.").
- Opens `http://127.0.0.1:<port>/#lumen` (the Lumen demo project), waits 2.5 s for the
  card entrance animations, captures, writes `.github/assets/screenshot.png`, verifies
  the PNG header and the 1440x900 IHDR size, and stops the children it spawned.
- Deterministic in locale, theme, and size. Not pixel-stable across days: demo data is
  dated relative to now. That is accepted.

## Rules

- Work turn: a change under `src/ui/**` that alters what the board shows (layout,
  components, styles, copy visible in the shot) reruns the capture and commits the new
  PNG with the work. Behaviour-only or off-screen UI changes need no new shot; the
  report says so.
- Merge turn: never retakes the shot, not even when a rebase pulls in upstream UI
  changes; the shot belongs to the work turn that made it stale.
- `README_RULE` wording is an AGENTS.md hard stop: the user approves the exact new
  text before the edit.

## Reminder (`scripts/ui-shot-reminder.ts`)

- `bun run check` gains a step that diffs the branch against `origin/main`
  (`git diff --merge-base origin/main --name-only`). When the diff touches `src/ui/**`
  and not `.github/assets/screenshot.png`, it prints one reminder line.
- Non-blocking by design: the step always exits 0, because many UI changes legitimately
  leave the shot alone. A missing `origin/main` stays silent.

## Acceptance

- One command regenerates the screenshot from demo data with the settings above; the
  smoke run shows the produced image and a valid PNG header.
- The first ready board requires no retry. A first timeout followed by readiness succeeds.
  Two timeouts stop both board attempts and report
  `the demo board did not become ready within 30 s` with exit 1.
  Readiness checks count request time toward each 30 s deadline.
- An inherited VM runner URL without a worker token cannot block either demo attempt.
- AGENTS.md and the work prompt name the screenshot step for board-visible UI changes.
- Gates stay green: `bun run check` (with the reminder step) and `bun test`.

## Non-goals

- Screenshots of pages other than the Lumen board.
- Visual-regression goldens or pixel-diff gates.
- Making the shot stable across days.
