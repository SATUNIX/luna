# Cycle 03 — Review (run luna-ux-01, stream `ux`)

- Branch `pi/luna-ux-01`, cycle base `876471a5bdbed66ce1497da2883bf24b7a08a21c` (head of `stream/ux`).
- Stream area: TUI overlays, the `/` menu, launch screen, animation and polish (V-01, V-02, V-03,
  V-05, V-09).
- Assigned board items: **V-01** (overlay readability) and **V-03** (fold `/settings` into the
  `/` menu, rename `kit` → `menu`). There is no board file; the items are as given in the cycle prompt.
- Previous cycle 02 is not on this branch. Its commits, report and handoff live on
  `origin/attempts/luna-ux-01/cycle-02`; cycle 02 was rejected only because the host acceptance run
  went red (`check-all`, `check-all:smoke:web-console` exit 1).

## Precedence

No red gate on this branch (it is the head of `stream/ux`) and no upstream conflict. Board item V-01
is carried, reviewed and green on `origin/attempts/luna-ux-01/cycle-02`, so it lands first.

## Method

Direct reading of the overlaid change on the attempts branch, plus one `scout` (the E3 tier allows
one; the second parallel scout was refused by the host). The scout re-read the module, both call
sites and the tests, ran the targeted smokes on a worktree of the branch tip, and checked whether the
carried change can cause the recorded acceptance failure. Docs and the attempts-branch report were
treated as hypotheses and checked against the code.

## Confirmed — V-01 carry-over is sound (P1, rank 5)

Evidence (scout run `2026-11-11T05-57-28-261Z-scout-56a3f9`):

- `72d1f4c` + `404b13a` apply cleanly onto base `876471a` (`git apply --check` exit 0).
- The two `overlay-frame.ts` copies are byte-identical (sha256 `d41d3aa9…ec8e`). The frame pads every
  line to exactly `width`; widths below 10 return the input unchanged; image lines bypass dim; the
  `compositeOverlays` patch is `Symbol.for`-guarded, idempotent and restored on `done` and `dispose`.
- `tests/control-center-smoke.ts:556-613` asserts border colour, widths 40/12/8, dim-while-open and
  restore after `done` and `dispose`; `tests/workflow-panel-smoke.ts:460-505` asserts the panel's
  border and dim/restore. `smoke:control-center` (28 checks) and `smoke:workflow-panel` (14 checks)
  pass on the branch tip, as do `test:typecheck` and `test:lint`.

## The recorded acceptance failure is not attributable to V-01

`git diff --name-only 876471a..404b13a` touches no `packages/web-ui/`, no `package.json` `scripts`
and no lockfile. `smoke:web-console` passes from the branch worktree. That smoke is already a
`SERIAL` check (`packages/core/check-all.ts:70-76`) that exclusively creates the repo-relative
`packages/web-ui/.runtime/console.token` and starts a detached server; a stale runtime dir or port in
the gate environment explains a one-off exit 1. Independently reproduced: two concurrent
`smoke:web-console` runs always fail with `PI_CONSOLE_TOKEN_FILE could not be read (ENOENT)` because
they share that path, while a single run passes. Recorded as a proposal, not fixed here (outside the
UX stream).

## Confirmed — V-03 (P1, rank 4), planned but not taken

The cycle-02 review pinned V-03 against the code (`02/review.md`): `index.ts:171-189` registers
`kit`/`helpers` and `alt+m` sends `/kit`; `command-menu.ts:26,29-30,192-193` carry the `kit` menu
strings; `hub.ts:183` help row; `custom-footer/widgets.ts:74` tip; `settings` is a pi built-in and
must be a `prefill` row, never a registered command. That review is unchanged code, so its line
references still hold.

## Checked and set aside

- The ≤3-character hidden-command reveal gap (`command-menu.ts:184`): unreachable today; already
  proposed on the attempts branch. V-03 removes the last instance.
- Idle-cat blink (`cat.ts:36` never rendered, docs say it does not happen) and the human-console
  multi-card focus theft: both need an operator intent decision and are already proposed. Not taken.
- No other runtime-reachable defect was found in the stream area beyond the board items.

## Items chosen for this cycle

1. **V-01** — re-land the reviewed overlay frame and transcript dim (board item 1).
2. **V-03** — **not taken**: re-landing V-01 alone is 31267 characters (records excluded), over the
   cycle's 30000-character "stop taking new items" threshold, so V-03 starts cycle 04 with the plan
   in `02/plan.md`.

This is fix mode: the cycle's work is re-landing carried, rejected work and confirming the
acceptance story, not a new improvement.
