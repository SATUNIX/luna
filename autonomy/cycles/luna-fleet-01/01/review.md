# Cycle 01 review — luna-fleet-01 (stream `fleet`)

Mode: **improve** (assigned board item O-01, owner visibility).

## State at the cycle start

`git log --oneline af7ad8915d5c..HEAD` is empty: the branch is exactly the head of `stream/fleet`,
which already merged the previous run's fleet cycles 05–11 (`fbf8cbd`). Working tree clean.
`autonomy/cycles/luna-fleet-01/01/` did not exist, so no earlier session of this cycle wrote
anything; `autonomy/runs/luna-fleet-01/HANDOFF.md` carries the previous run's handoff.

No cycle files exist for this run yet, so the review starts from the handoff rather than a prior
`report.md` in this run.

## What the handoff and prior records say

- O-01 is **progress, not done**. The landed slice (`bd3df4c`, `5bbaa6e`, `05c6300`, `8f37da4`)
  gives `pi-autonomy status` and the no-run `/autonomy status` footer: step, `spent $X of $Y` and
  `BLOCKED (kind): question`, pinned by `tests/autonomy-cli-smoke.ts` and
  `tests/autonomy-command-smoke.ts`.
- Still open: PG-06 host event log, PG-07 live `/autonomy` widget, PG-08 web console panel, PG-09
  owner inbox, then the recorded non-Claude walkthrough.
- A-92a (dispatch template) is complete but unmerged on `origin/attempts/luna-fleet-01/cycle-09`
  with a 56,430-char reviewable diff; the handoff says give it its own cycle. The `board claim`
  half of A-92 is already merged (`packages/autonomy/lib/board.ts:120`, `cli.ts` `board claim`).
- Two reviewer warnings from cycle 11: duplicated `oneLine`, and a malformed blocked row rendering
  the literal `undefined` run id.

## Board items checked against the code

### O-01 / PG-09 — owner inbox is unreachable from pi (evidence)

The CLI has a complete, tested owner inbox: `packages/autonomy/cli.ts:684-740`
(`inbox --run <id>`, `--file`, `--answer ... --value ...`), with settlement, board unblocking and
validation pinned by `tests/autonomy-inbox-smoke.ts`. `docs/autonomy.md:718-756` documents it.

The `autonomy-run` extension cannot reach it:

- the command switch has no `inbox` branch (`packages/extensions/src/autonomy-run/index.ts:304-411`;
  `default:` at 409 answers `unknown command "inbox"`),
- `USAGE` (`index.ts:118-132`), the command description (`index.ts:298`) and the completion array
  (`index.ts:299-301`) all omit it,
- `packages/extensions/src/autonomy-run/README.md:8-20` and `docs/autonomy.md:125-131` list the
  `/autonomy` subcommands without it.

Consequence: an owner inside pi who has a card waiting must leave pi and run
`pi-autonomy inbox`. That contradicts O-01 ("operate without Claude ... from pi or the web
console") and the PG-09 surface. Tests: a scout confirmed no `inbox` assertion exists in
`tests/autonomy-command-smoke.ts`.

### O-01 / PG-07 — the fleet footer is not live

`/autonomy status` sets the footer only when the operator runs it (`index.ts:349-359`), and the
extension README says so explicitly ("The line changes only when you run that command"). A live
widget exists only for pairing in `remote-control` (`index.ts:280`), so the API (`ui.setWidget`)
is available. This is a candidate for a later cycle, not chosen now: timers need lifecycle and
fake-clock tests, and the inbox gap above is smaller and fully specified.

### O-01 / PG-06 and PG-08

A per-step event log already exists (`packages/autonomy/lib/store.ts:104`,
`runtime.ts:499`) but no host-level log is surfaced; the web UI has no autonomy panel
(`grep -rn autonomy packages/web-ui/src` returns nothing). Both are larger than this cycle's
budget and are left to later cycles.

### A-92 — dispatch template

`packages/autonomy/lib/templates/index.ts` has no `dispatch` template, while `cli.ts:636` already
lists `dispatch` as a board template in the `board` command guard. The remaining work is the
template and its fan-out, carried as a 56k diff on the attempts branch; it does not fit this
cycle's review budget. Recorded for a cycle of its own in the handoff.

## New defects considered

- Cycle-11 warning: `String(field(r, "run"))` can render `undefined` as the blocked run id in
  `fleetStatusLine` (`index.ts:213-218`). The fleet footer clears on an unusable status, and a
  real `listRuns` row always carries a run id, so it is not reachable through the CLI today; it is
  a malformed-JSON path only. Not chosen over board work.
- Duplicated `oneLine` helper: accepted by the previous review as a deliberate self-containment
  rule for the extension. No change.

No red gate: no failing check was found in the review (the previous run's red `eval-footprint`
gate was fixed in cycle 11; the base here contains the fix).

## Cycle choice

Take **O-01 / PG-09** only: expose the existing, tested owner inbox through `/autonomy` (list,
answer, and the fleet "waiting" view), with the extension tests and the docs it changes. One
finished surface beats a second half-done one; PG-06/PG-07/PG-08 stay in the handoff.
