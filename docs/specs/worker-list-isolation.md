# Worker provisioning lists ride the /run request

A worker turn can write `~/.ottr/workers/<project>/tools.json`, `apt.txt` and
`requirements.txt` in the shared home volume (`home:/root` in docker-compose.yml),
because worker turns run as root in that volume. Today `ensureProjectTools`,
`ensureProjectPackages` and `ensureProjectPython` read those files at provision
time, so a turn of project A can choose what a later turn of project B installs
and puts on its PATH (OTTR-953 proved the reach with a real `ensureProjectTools`
+ `buildToolsPath` fixture). This spec removes the shared home as a provisioning
input for classic worker turns: the board sends the lists it trusts in the
`/run` request, and the worker validates and uses only those.

Recorded decision context: R5-1 (docs/WORKERS.md) — a worker turn can write the
shared home, so nothing from it may drive a privileged consumer. The board
already follows R5-1 for its own reads; the worker turn path did not.

## Behavior

### Request contract

`WorkerRequest` (src/workers.ts) gains one optional field:

```ts
/** The board's trusted provisioning lists, read from the board home. A worker
 * never reads the shared home copies. Classic worker turns only; a vm-runner
 * dispatch may carry it but the VM bake path ignores it (out of scope here). */
lists?: {
	tools?: string;      // raw tools.json text, the project's own list
	toolsAll?: string;   // raw tools.json text, the fleet (_all) list
	apt?: string;        // raw apt.txt text, the project's own list
	requirements?: string;          // raw requirements.txt, the project's own
	requirementsAll?: string;       // raw requirements.txt, the fleet list
};
```

- Every field is optional and must be a string when present; `validRunBody`
  rejects other shapes with 400. Content validation happens through the
  existing parsers (below), so a broken list ends the run with the parser's
  message, like a failed install does today.
- `aptAll` does not exist: today's turn-time provisioning reads only the
  project's `apt.txt` (`ensureProjectPackages` reads one file); the fleet apt
  list only fed the removed worker boot pre-warm. Parity beats symmetry.
- Missing fields mean empty lists. A worker never falls back to the shared
  home files. A board whose seed has not run yet therefore provisions nothing,
  the same rule server-local turns already live by.

### Worker side (src/workers.ts, src/tools.ts, src/apt.ts, src/python.ts)

- After `parseRunBody`, the worker parses each present text once with the
  existing parsers: `parseToolsJson`, `parseAptTxt`, `parseRequirements`. A
  parse error is raised through the same channel as an install failure
  (`provisionResponse`): the run ends with the message as its stderr tail and
  exit 1. The error names the list it came from.
- `provisionRun` consumes the parsed lists (a `TurnLists` struct) and an
  explicit home instead of reading files. The cores change from
  `(project, home)` to list-first signatures; the file-reading project-based
  wrappers survive only for the server-local path:
  - tools: `installTools(entries: ToolEntry[], home)` installs; install order
    stays `_all` entries first, then the project's. `buildToolsPath(entries,
    home)` links; link priority stays project name first, then `_all`
    (first wins on a name clash, `linkTargets`). `readToolsList(project, home)`
    (the old private `readTools`) is exported for the server wrapper.
    `ensureProjectTools(project, home)` stays as the server wrapper: read both
    files, install.
  - apt: `ensurePackages(names: string[], source: string, run?)` runs the
    existing guard and `install` flow; `source` is a display name for the
    "only root on Debian or Ubuntu installs them here" line (the file path for
    the server wrapper, the run request for the worker). `ensureProjectPackages(project, home)`
    stays as the server wrapper.
  - python: `ensurePython(lines: RequirementLine[], home, run?)` builds the
    venv keyed by `requirementsKey(lines)`; `pythonPathFor(lines, home)`
    returns the venv bin dir or `""`. The project-wins merge of the two
    requirement lists moves into a shared helper both the server wrapper and
    the worker path use. `ensureProjectPython(project, home)` stays as the
    server wrapper.
  - `ensureAllTools`, `ensureAllPackages`, `ensureAllPython` and
    `eachWorkerProject` lose their last caller (the worker boot pre-warm,
    below) and are deleted.
- `serveWorker` opts gain `home?: string` (default `homedir()`), threaded
  through provisioning so tests run the real path against a temp home.
  The injected seams (`opts.ensurePackages`, `opts.ensureTools`,
  `opts.ensurePython`, `opts.buildPath`) keep working with the new signatures.

### Worker boot (src/worker.ts)

The `ensureAllPackages/ensureAllTools/ensureAllPython` boot block goes away:
the shared home is no longer a trusted source, so startup has nothing to
pre-warm from. The first turn of a project on a fresh worker installs its
tools inline (as it already did for anything missing). Serving still starts
immediately; the boot log loses the pre-warm lines.

### Board side (src/runner.ts or a helper it calls)

The classic worker dispatch (`startWorkerRun`) reads the project's trusted
lists from the same home the server-local provisioning reads
(`OTTR_WORKERS_HOME ?? boardOmpHome()`) with the existing path helpers
(`toolsListPath`, `aptListPath`, `requirementsListPath`) and puts their texts
into `body.lists`. A missing file omits its field. The resolution helper is
exported and unit-tested. VM dispatch (`startVmRun`) is unchanged.

### Server-local turns

`prepareTurn` keeps reading the board home. One wiring fix in the same class:
`ensurePackages: (project) => ensureProjectPackages(project, workersHome)`
passes `undefined` through to the `homedir()` default when `OTTR_WORKERS_HOME`
is unset, and on the server `homedir()` is the shared home (`home:/root`), so
a merge turn today reads a worker-plantable `apt.txt` and runs `apt-get` on
the server. It becomes `ensureProjectPackages(project, turnListHome())` with
`turnListHome(): string` = `OTTR_WORKERS_HOME ?? boardOmpHome()` — the exact
resolution `prepareTurn` already uses. Regression test: with `HOME` pointed at
a planted home, `OTTR_WORKERS_HOME` unset and `OTTR_BOARD_OMP_HOME` at a
trusted home, the apt provisioning line names the trusted path, never the
planted one.

## Error cases

- A sent list fails its parser: run ends, exit 1, the parser's message as the
  stderr tail, naming the list.
- A `lists` field is not a string: 400 `bad request`, before any provisioning.
- No `lists` on a project run: provisioning installs and links nothing; the
  turn runs on the container PATH. No shared-home fallback.
- No `OTTR_PROJECT` in the request env: no provisioning, `lists` ignored
  (unchanged).
- An old board against a new worker (no `lists`): the turn runs with no
  provisioned tools; the shared home is still not read. Both ship in one
  image, so compose rolls them together.

## Acceptance checks

- `bun run check` and `bun test` exit 0.
- The card's acceptance test (src/workers.test.ts): a planted entry in the
  shared-home `tools.json` plus planted `apt.txt` and `requirements.txt` for
  the project, a temp `home` on the worker server, real `ensureTools` and
  `buildPath` (no injection), capture fakes only where the real command would
  install on the test machine (`ensurePackages`, `ensurePython`), and a
  `globalThis.fetch` shim serving the trusted and the planted tool bytes
  (a real local HTTP listener cannot serve a `tools.json` entry: the entry
  parser rejects every non-`https://` URL). The run proves:
  - the child PATH dir holds the trusted tool link and no planted name;
  - the planted entry's URL was never fetched (listener count 0);
  - the captured apt names and requirement lines carry only the request
    lists' content, never the planted files' content.
- A second test plants the lists and sends no `lists` field: the planted
  tools still never install and never link (no fallback read).
- Regression test for the server-side `turnListHome()` wiring, as above.
- The dispatcher test: a `startWorkerRun` dispatch carries the board home's
  list texts in the request body (captured request assertion).

## Non-goals

- The vm-runner bake path: it mounts the shared home read-only
  (`home:/root:ro`) and bakes project layers from `workerListPaths(homeRoot,
  project)` (src/vmrun.ts) — the same plant class on a different subsystem
  (vmRunner, vmGuest, vmrun). Filed as its own card.
- env var name lists (`env.txt`): the board already reads them from the board
  home only (`envListPath` defaults to `boardOmpHome()`).
- `GET /api/provisioning` display rows (presence flags only).
- alate's provisioning of the shared home: the files stay there for alate's
  manifest and the provision guard; they stop being a worker provisioning
  input.
- Server-local `prepareTurn` flow beyond the one wiring fix above.

## Alternatives considered

- Per-project home volumes — rejected (user): needs per-project containers,
  the largest compose change.
- Detect only: extend the post-run provision guard — rejected (user): the
  guard audits when a run closes, so a plant takes effect on the next turn
  before any audit acts; prevention, not detection, closes the window.
- Manifest check before provisioning — rejected (user): needs a trusted write
  path per host anyway; weaker than removing the input.
- tools.json only — rejected (user): `apt.txt` and `requirements.txt` share
  the exact read path and reach; the class ships fixed or not at all.

## Risks

- A project whose lists exist only in the shared home (alate provisioned, no
  board seed yet) loses its worker tools until the seed runs. Mitigation: the
  seed runs on the hourly deploy and board boot; server-local turns already
  behave this way.
- Request size grows by the list texts (a few KB each, pinned one-liners).
  The body already carries prompts unbounded; no cap is added.
- Mixed versions during a rolling update keep old behavior on old workers;
  no worse than today.

## Detailed Implementation Plan

1. `src/tools.ts`: split `ensureProjectTools` into `installTools(entries,
   home)` + the project wrapper; entries-based `buildToolsPath`/`linkTargets`;
   export `readToolsList`; delete `ensureAllTools`/`eachWorkerProject`.
2. `src/apt.ts` / `src/python.ts`: same split (`ensurePackages(names, source,
   run)`, `ensurePython(lines, home, run)`, `pythonPathFor`); delete the
   `ensureAll*` functions.
3. `src/workers.ts`: `WorkerRequest.lists`, `validRunBody` shape check,
   parse-at-boundary + `TurnLists`, `provisionRun(lists, home)`, `opts.home`.
4. `src/worker.ts`: drop the boot pre-warm block and imports.
5. Dispatcher: trusted-list read helper + `startWorkerRun` carries `lists`.
6. Tests: acceptance plant tests, no-fallback test, dispatcher capture test,
   `turnListHome()` regression, updates for every moved signature
   (tools.test.ts, apt.test.ts, python.test.ts, workers.test.ts).
7. Docs: docs/WORKERS.md pre-warm and list sections; README staleness check.
