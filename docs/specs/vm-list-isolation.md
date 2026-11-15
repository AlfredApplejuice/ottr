# The vm-runner bake reads its lists from the dispatch, not the shared home

The vm-runner bake path reads a project's provisioning lists from the
worker-writable shared home, so one project's turn can choose what another
project's microVM turn gets baked and executed. Same finding class as
`docs/specs/worker-list-isolation.md` (OTTR-961, classic workers): a planted
`~/.ottr/workers/<victim>/tools.json` (or `apt.txt`, `requirements.txt`) in the
shared home changes the victim project's VM layer content and layer key, and
the VM turn executes attacker-pinned binaries. The `home:/root:ro` mount does
not help: the plant is written through the workers' read-write mount of the
same volume.

This spec removes the shared home as a provisioning input for the VM path: the
board sends the lists it trusts on the dispatch, vm-runner hashes the
request-borne lists into the layer key and pushes them into the bake VM, and
the guest installs from the request texts only. Recorded decision context:
R5-1 (docs/WORKERS.md) — a worker turn can write the shared home, so nothing
from it may drive a privileged consumer. The board already follows R5-1 for its
own reads; the VM bake path did not.

`VmSpec` lives in `src/workers.ts` (the task text says `src/types.ts`; the
type's real home wins). `src/vmrun.ts` from the task text is `src/vmRootfs.ts`
on this branch. `WorkerRequest.lists` and the classic worker path belong to
OTTR-961 and are not changed here; both cards converge on one `ProvisionLists`
shape at the merge.

## Behavior

### Request contracts

`src/workers.ts` gains one exported type:

```ts
/** The board's trusted provisioning lists, raw text. Every field is optional;
 * a missing field means an empty list. No `aptAll`: apt installs read only the
 * project's own list (src/apt.ts), so the fleet apt list has no consumer. */
export interface ProvisionLists {
	tools?: string;
	toolsAll?: string;
	apt?: string;
	requirements?: string;
	requirementsAll?: string;
}
```

- `VmSpec` (src/workers.ts) gains `lists?: ProvisionLists`.
- `ValidateRequest` (src/vmValidateShared.ts) gains `lists?: ProvisionLists`.
- The vm-runner `/run` body check (`checkVmSpec`) and the `/validate` body
  check reject a `lists` that is not an object with string values when present
  (400, before any bake). Content validation happens at the consumer through
  the existing parsers, like OTTR-961. No size cap: the body already carries
  prompts unbounded (same call as the sibling spec).
- The guest `/bake` body becomes `{ project, lists? }` with the same shape
  rule; a violation answers 400.

### Board side (src/trustedLists.ts, src/runner.ts, src/sandboxRun.ts)

- New module `src/trustedLists.ts` exports:
  - `turnListHome(): string` — `OTTR_WORKERS_HOME ?? boardOmpHome()`, the same
    resolution the board's own provisioning reads use.
  - `projectTrustedLists(project: string, home = turnListHome()): ProvisionLists`
    — reads the raw texts with the existing path helpers
    (`toolsListPath`, `aptListPath`, `requirementsListPath` for `project` and
    `_all`; apt reads the project list only) and omits a field whose file is
    missing. A missing file never becomes an empty-string field.
- `startVmRun` (src/runner.ts) sets `spec.lists =
  projectTrustedLists(vm.grant.project)`.
- The validate dispatch (src/sandboxRun.ts) sets `request.lists =
  projectTrustedLists(project)`.

### vm-runner side (src/vmRootfs.ts, src/vmRunner.ts)

- `layerKey(base, lists)` hashes `[base, [apt, tools, toolsAll, requirements,
  requirementsAll]]` with `null` for an absent field. The hash no longer reads
  any file. **The key format changes, so the first turn of every project after
  this ships bakes its layer again, once.** docs/WORKERS.md notes this.
- `VmRootfs.layer(project, lists, bake)` threads the lists through `layerNow`;
  the cache path stays `layers/<project>/<key>.ext4`.
- New `listFiles(project, lists): { path: string; text: string }[]` returns one
  entry per present field, at the guest-absolute paths the guest's ensure
  wrappers read: `apt` → `/root/.ottr/workers/<project>/apt.txt`, `tools` →
  `<project>/tools.json`, `toolsAll` → `_all/tools.json`, `requirements` →
  `<project>/requirements.txt`, `requirementsAll` → `_all/requirements.txt`.
  `workerListPaths` loses its last callers and is deleted.
- Both bake sites (the run path and the validate path) push a copy-in tar whose
  members are exactly `listFiles(project, lists)` with the request texts —
  built in memory, never read from `homeRoot`. Member names keep today's
  relative-to-/ form. The `/bake` request body carries the same lists.
- `homeRoot` stays a vm-runner input for the pinned agent layer (`vm.layerDir`
  copy-in), so the compose mount stays. Only the lists stop riding it.

### Guest side (src/vmGuest.ts)

- `/bake` parses `project` (existing rules) and `lists` (shape rule above).
- `GuestOptions` gains `home?: string` (default `"/root"`), the home the guest
  writes lists into and passes to the ensure steps (test seam, mirroring
  OTTR-961's `serveWorker` `opts.home`).
- `runBake`: parse every present text first (`parseToolsJson`,
  `parseAptTxt`, `parseRequirements`). A parse error ends the bake with exit 1
  and the parser's message as the stderr tail, naming the list, before any
  write or install. Then write each present raw text to its resolved list path
  (`toolsListPath`/`aptListPath`/`requirementsListPath` for `project` and
  `_all`, resolved against `home`) with parent dirs created, then run the
  three ensure steps as today. The raw text is written as-is; the wrappers
  re-parse it.
- A `/bake` with no lists writes nothing; the wrappers' missing-file guards
  return empty, so nothing installs. No shared-home fallback exists anywhere on
  the path.
- The lists the guest writes persist in the layer image (the bake VM's
  `/root` is the writable layer disk), so a run VM keeps reading the baked
  lists from its own layer, exactly as today — but the content now comes from
  the dispatch.

## Error cases

- A sent list fails its parser: the bake ends with exit 1 and the parser's
  message names the list (the classic channel).
- A `lists` field is not a string: the dispatch answers 400 before any bake.
- No lists on the dispatch (board without a seed yet, or an old board): the
  bake provisions nothing; the turn runs on the image PATH. No fallback read of
  the shared home.
- An old vm-runner behind a new board: the old `checkVmSpec` ignores the
  unknown `vm.lists` field and keeps today's behavior (shared-home bake). Both
  ship in one image, so compose rolls them together; the window is no worse
  than today.

## Acceptance checks

- `bun run check` and `bun test` exit 0 (worktree root, output read).
- vmRunner.test.ts plant test: a fake shared home (`homeRoot` fixture) holds
  planted `tools.json`/`apt.txt`/`requirements.txt` for the victim project; the
  dispatch carries trusted texts whose tool URL a local listener serves. The
  run proves the copy-in tar holds exactly the request-borne members with the
  trusted bytes (planted names absent) and the `/bake` body carries the trusted
  texts. The same dispatch with no `lists` proves the tar holds no list members
  and the `/bake` body names none.
- vmRunner.test.ts validate test: same plant, same assertions on the validate
  bake.
- vmGuest.test.ts plant test: stale planted lists (planted tool on listener B)
  sit in the guest home; `/bake` carries trusted lists (trusted tool on
  listener A) and runs the real `ensureProjectTools` and `buildToolsPath`, with
  capture fakes only where the real command would install on the test machine
  (`ensurePackages`, `ensurePython`). The run proves listener A was fetched,
  listener B never, and neither the guest home's tools tree nor the
  `buildToolsPath` dir holds the planted name.
- vmGuest.test.ts no-lists test: `/bake` with no lists writes no list files and
  provisions nothing.
- vmGuest.test.ts parse test: a broken `tools.json` text ends the bake with
  exit 1 and a message naming `tools`.
- vmRunner.test.ts layerKey tests: the key is a function of the base and the
  five texts; a change in any field, or a field gained or lost, moves the key.
- trustedLists.test.ts: `projectTrustedLists` reads the board home (through the
  layer-resolving path helpers), omits missing files, and `turnListHome()`
  resolves `OTTR_WORKERS_HOME ?? boardOmpHome()`.
- A dispatch capture proves a `startVmRun` /run body carries the board home's
  list texts.

## Non-goals

- The classic worker path (`src/tools.ts`, `src/apt.ts`, `src/python.ts`,
  `src/workers.ts` provisioning, `src/worker.ts`, `src/runner.ts`
  `startWorkerRun`): OTTR-961 owns it.
- The pinned agent layer channel (`vm.layerDir` copy-in from the shared home):
  a worker can still write layer content there. Its controls stay alate's
  provisioning and the post-run drift audit; prevention here covers the three
  lists. Noted as the residual in docs/WORKERS.md.
- `GET /api/provisioning` display rows.
- alate's provisioning of the shared home: the files stay there for the
  manifest and the provision guard; they stop being a VM provisioning input.

## Alternatives considered

- Per-project home volumes — rejected in OTTR-961 (user): needs per-project
  containers.
- Detect only (drift audit extension) — rejected: the audit acts after a run;
  the plant takes effect on the next bake before any audit acts.
- vm-runner reads the board home over the trusted channel — rejected: gives
  vm-runner a credential-bearing read path into the board home; the dispatch
  already is the trusted channel.
- Keep hashing `_all/apt.txt` — rejected: no consumer installs it
  (`ensureProjectPackages` reads the project list only), so hashing it would
  rebake layers on a file nothing reads.

## Risks

- One-time rebake of every project layer after this ships (key format change);
  acceptable and noted in docs.
- A project whose lists exist only in the shared home (no board seed yet) loses
  its VM packages until the seed runs — the rule server-local turns already
  live by.
- Request size grows by the list texts (a few KB each, pinned one-liners); no
  cap, same as the sibling spec.
