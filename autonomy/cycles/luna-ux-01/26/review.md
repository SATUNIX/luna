# Cycle 26 — Review (run `luna-ux-01`, stream `ux`)

Base: `5e0050c7a539` (head of `stream/ux`). Branch `pi/luna-ux-01`. Area: TUI overlays, the `/`
menu, launch screen, animation and polish (V-01, V-02, V-03, V-05, V-09).

## Mode: fix

There is a red acceptance check to repair and carried-over work from cycle 25, so this cycle is
fix mode. No board items were assigned.

## State at the start

- `git log --oneline 5e0050c7a539..HEAD` was empty; the branch starts on the `stream/ux` head.
- Cycle 25 ended completed but was **not merged**: acceptance red
  (`check-all`, `check-all:smoke:workflow-resume`, exit 1). Its report, review and handoff are on
  `origin/attempts/luna-ux-01/cycle-25` (`1fae5a6`, `58abbfe`, `ac9bd04`, `527bb00`). The work
  itself is sound: two small, tested fixes in the stream area. It was cherry-picked onto this
  base (commit bodies re-written only to drop the cycle-25 record commit).
- The cycle-25 record commit was **not** carried over: this cycle has its own review/plan/report,
  and copying another cycle's records would duplicate them on `stream/ux`.

## P0 — the red gate, reproduced

`smoke:workflow-resume` is the check cycle 25's acceptance named. It passes on an idle machine
(`node tests/workflow-resume-smoke.ts` → `41 checks passed`), but it fails under CPU contention,
which is how the gate runs it (check-all `--jobs=<cpu quota>`, here 4):

```
$ for i in 1 2 3; do taskset -c 0 yes >/dev/null & done
$ taskset -c 0 node tests/workflow-resume-smoke.ts
  MISS: a stopped run's writer leaves the checkout queue: Expected values to be strictly deep-equal:
  + undefined
  - [ [ 'cancelled', 'stopped' ] ]
AssertionError [ERR_ASSERTION]: resume review regressions
```

Root cause (`tests/workflow-resume-smoke.ts:383-390`): the holder child is held by a **timer**
(`delayMs: 1500`) and the test then does a fixed `await sleep(300)` before stopping the queued
run. `fakeSpawner` (`tests/workflow-fakes.ts:63-88`) schedules the holder's 1500 ms timer before
the test's 300 ms one, so under starvation the holder timer is serviced first; it releases the
writer lock, the queued run launches and finishes, and the late `stop` lands during the
post-child fingerprint. `deriveOutcome` then reports `interrupted` with no omissions, so the
assertion fails. A scout confirmed this is the only true ordering race in
`workflow-resume-smoke.ts`; the file already has the deterministic pattern (a file-gated `git`
wrapper at `:336-356`) to copy.

This is priority 0: a red acceptance check. It is also the same check several runs have recorded
as a host-load flake (`autonomy/cycles/luna-ux-01/06/review.md:32-39`,
`autonomy/cycles/luna-core-01/05/report.md:42`), so fixing the test removes the re-run tax.

## P3 — cycle-25 carry-over

Both changes are inside the stream area and verified there; nothing about them failed, only the
gate did.

- **Hub Security page Effective row.** `securityRows`
  (`packages/extensions/src/control-center/hub.ts:183-190`) printed `values.security`, the
  combined main-row string `"guarded (requested balanced)"`, on the page's Effective line.
  `HubValues.securityEffective` now carries the raw level, unset without the firewall registry.
  Tests in `tests/control-center-smoke.ts`; doc `docs/control-center.md`.
- **`/workflows` list cursor identity.** `WorkflowPanel` kept only a positional `listIndex`
  (`packages/extensions/third_party/subagent/wf-panel.ts:610`), so a run starting or being
  pruned while the list was open moved Enter/x/p/s to another run. It now tracks `listRunId` and
  refreshes `listIndex` from it; the prune fallback is pinned. Tests in
  `tests/workflow-panel-smoke.ts`; doc `docs/workflows.md`.

Both were independently reviewed on the cycle-25 branch (`VERDICT: PASS`) and are re-verified
here with their targeted smokes and a fresh whole-cycle review.

## Checked and not taken

- The cycle-25 report's non-blocking warnings remain: `securityEffective` is unset for
  hand-built `HubValues` (no production path), and `listIndex` stays a public field with no
  production writer after the first render. Neither is a defect; leave them.
- Other stream surfaces (`command-menu.ts`, `launch-screen.ts`, the footer cat, the hub's
  tiny-terminal edges) were reviewed in cycles 24-25 and their open items are already proposals
  (`luna-ux-01-25-hub-tiny-terminal.md`, `luna-ux-01-01-idle-cat-blink.md`). Nothing new was
  found that outranks the gate.
- A scout reported low-probability fixed-timer races elsewhere in
  `tests/workflow-hooks-smoke.ts` (r14: 5 s and 1.5 s timers against a ~200 ms run end). They
  have a 15-20x margin and did not fail the gate; recorded as a proposal, not fixed here.

## Bookkeeping

No upstream conflict, no board items, no edits to `autonomy/BACKLOG.md` or `autonomy/CHARTER.md`.
