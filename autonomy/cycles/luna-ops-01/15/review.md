# Cycle 15 review — run `luna-ops-01` (stream `ops`), mode fix

Base at review time: `2e3155fb135c` (head of `origin/stream/ops` `616aa06` is an ancestor).
Charter read in full (`autonomy/CHARTER.md`); acceptance is a real, evidenced fix, tested,
documented, with the acceptance gate green on a clean checkout and no check weakened.

## P0 — upstream merge (red/broken-branch precedence)

- `refs/upstream/trunk` = `5a888fe5` ("integrate: stream/core into integration/luna"), not an
  ancestor of the branch; merge-base `bf6d2bb`.
- The upstream merge was already produced and reviewed in cycle 14 as `9b751ee` (first parent
  `2e3155f`, second parent `5a888fe`). Cycle 14 recorded the resolution of the two conflicts:
  `tests/firewall-gate-smoke.ts` and `tests/redaction-corpus-smoke.ts`, where both sides hardened
  the same load-sensitive guards. The resolution keeps **both** intents: `assertSubQuadratic`
  (`tests/perf-budget.ts`) and `assertCpuWithin` (`tests/timing.ts`, added upstream).
- Re-using the reviewed merge (`git reset --hard 9b751ee`) is correct and cheaper than rebuilding
  it; a hand-built equivalent (`05cfea6`, backup `refs/backup/cycle15-mymerge`) differed only in a
  comment and a stray brace in `tests/redaction-corpus-smoke.ts`, i.e. my hand merge was worse.
- Evidence the merge preserves both sides: `git diff 2e3155f 9b751ee -- <file>` and
  `git diff 5a888fe 9b751ee -- <file>` agree on the merged docs (`docs/INSTALL.md`,
  `docs/reference.md`, `docs/security.md`, `autonomy/JOURNAL.md`); no branch file was dropped
  (`comm` of tree file lists: only upstream additions). Guard retention is pinned by
  `smoke:firewall-gate` 20/20 and `smoke:redaction-corpus` 6/6.

## Assigned items

### PG-56 [P0] — surface merged work that has not reached GitHub

- Carried from cycle 14 as `6aabc4d`: `packages/autonomy/lib/unpublished.ts` (new), `cli.ts`
  (`unpublishedFor`/`unpublishedText`, `status`/`top`/`inbox`/`doctor`), `docs/autonomy.md`,
  `tests/autonomy-cli-smoke.ts` (4 checks). Read-only: compares `mirror.git
  refs/heads/<integration>` with `refs/integration/remote`; never fetches or writes. `doctor`
  exits 3 while ahead, 0 when equal.
- The feature works: `npm run -s smoke:autonomy-cli` 21/21, including the four PG-56 checks.
- **Two defects found in that carried code** (scout at cycle start, both fixed this cycle, see
  plan/verify):
  1. `packages/autonomy/lib/gitmirror.ts:340` `publish()` pushed the integration branch but never
     advanced `refs/integration/remote`, which is what `unpublishedReport` reads, so after a
     successful publish `status`/`top` still showed `unpublished: …` and `doctor` exited 3 for a
     run that was on the remote.
  2. `packages/autonomy/lib/unpublished.ts:66` `lastPublishFailure()` scanned the supervisor log
     backwards for `"publish failed"` and never stopped at a newer `"publish recovered"` line, so
     once a failure had occurred a later healthy state still reported that failure's timestamp and
     reason (and `inbox` kept the run "waiting on operator").

### PG-52 [P1] — a cycle's own verify list omits checks the gate runs

- Not started this cycle. Confirmed the premise with a scout: no path-glob → check-script mapping
  exists. `packages/core/check-all.ts:196-215,490` enumerates check labels only; `wiring.ts:60`
  and `review.ts:214,237` map a script to the test file it runs (the inverse direction) and
  classify changed paths as "critical" rather than selecting checks. The cycle verify list is
  authored by the worker from prose (`packages/autonomy/prompts/cycle.md:34`) and nothing validates
  it against the gate. Smallest addition point identified: a data table plus `--for-changed=<path>`
  beside `checkNames()` in `packages/core/check-all.ts`, consumed from `cyclePrompt()`.
- Left as a board item for a later cycle; the carry-over and the fix scope are recorded in
  `autonomy/runs/luna-ops-01/HANDOFF.md`.

## Carry-overs landed

- Cycle-14/13 installer fix `6f5e765` (`packages/core/install.ts`, `docs/INSTALL.md`,
  `docs/architecture/profiles-and-install.md`, `tests/install-marker-smoke.ts`): clean `--scope`
  errors and `--help`/`-h`. Green (`smoke:install-marker`).

## Pre-existing findings (not introduced; left in scope)

- `pi-lens` reports four `unknown`-returning helpers in `packages/autonomy/cli.ts` (the `Writer`
  interface, `codeOf`, `messageOf`). They exist unchanged in `9b751ee`
  (`git show 9b751ee:packages/autonomy/cli.ts`); the cycle diff adds only string literals
  `"unknown"`, and `npm run -s test:lint` is green.

## Publish state (found by hand, matches PG-56's own metric)

- `origin/stream/ops` = `616aa06`, an ancestor of the branch. The run branch carries the stranded
  `e3c7fc9`/`22fdf7f` ancestry (cycle-08 review with blocked identifiers), so
  `node packages/core/prepush-scan.ts range 616aa06..HEAD` refuses a fast-forward:
  "37 finding(s) in 61 commit(s)". Publishing needs the documented re-land (cycle 12 procedure),
  built and verified this cycle on branch `reland/cycle15` (see `verify.md` and HANDOFF).
