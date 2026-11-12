# Cycle 23 — Review (run `luna-ux-01`, stream `ux`)

Mode: fix

## Base and prior cycle

The branch starts at `cf7d7865ea81` (head of `stream/ux`, cycle 22 merged). `git diff
cf7d7865ea81..HEAD` is empty at the start. Cycle 22 report:
`autonomy/cycles/luna-ux-01/22/report.md` (successful, fix mode). Its handoff records the
`/workflows` list-view / tiny-height gap as an open proposal, and the gated `workflow_run`
reviewer step as stalling (use `subagent`).

## Board item PG-12 — already done at base

Scout verification (read-only, `smoke:update-notice` 8/8):

- `packages/extensions/src/kit-update/index.ts:739-742` — `trunkNotice()` prints
  `trunk is N commits ahead — /update channel next`, `null` at 0/negative/no channel.
- `index.ts:760-766` — `sessionStartNotice()` gives the trunk line precedence and stays silent
  when there is no update (`{ notices: [], setStatus: false }`).
- `index.ts:791` — `formatReport()` carries the same line in `/update status`; `index.ts:1311`
  notifies it on the bare `/update` screen.
- `index.ts:1259-1273` — the start-up check is a fire-and-forget `void check(...).then(...)`, so a
  hanging git probe cannot block start-up.
- `tests/update-notice-smoke.ts` — exact wording, git gap, in-sync silence, offline silence,
  hanging-git non-blocking start, single start-up notice, and the `/update` screen.

Board evidence was stale; no code change is needed for PG-12.

## Candidate found: `/workflows` panel does not fit a short terminal (list view and tiny heights)

Evidence measured with the real modules through `packages/core/eval/harness.ts` (14 runs in the
registry, a run with agents, a stop confirm open):

```
list rows=12 body=18 budget=8  framed=20 cap=10 footer=true
list rows=16 body=18 budget=12 framed=20 cap=14 footer=true
list rows=20 body=18 budget=16 framed=20 cap=18 footer=true
run  rows=10 body=10 budget=7  framed=12 cap=9  footer=true
run  rows=12 body=10 budget=8  framed=12 cap=10 footer=true
```

`WorkflowPanel.render` (`packages/extensions/third_party/subagent/wf-panel.ts:727-754`) passes the
height budget only to `renderRunLines` (`:741-742`); `renderListLines` (`:396-415`) still renders
`LIST_ROWS = 12` rows with no budget, so the framed panel is 20 rows against an 18-row host cap at
20 terminal rows and the bottom rule/footer are clipped. On the run view, `renderRunLines`
(`:392-394`) returns `[...header, "… n more"]` even when `maxLines` is 0, so the composite exceeds
the budget by 3 rows on a 10–12 row terminal. This is the defect the cycle-21 proposal
`autonomy/proposals/luna-ux-01-21-workflow-list-height.md` recorded, with the same measurements.

Impact: the `/workflows` overlay, a UX surface in this stream (V-02), loses its footer keys and
bottom border exactly when the terminal is short.

## Candidate found: stale doc comment on the trunk notice

`packages/extensions/src/kit-update/index.ts:732-734` says the notice "names the install's real
channel", but every call site passes `TRUNK_CHANNEL = "next"` and `tests/update-notice-smoke.ts`
asserts the trunk channel, not the installed release channel. A doc comment that contradicts the
code and its test; correct it in the same cycle.

## Checked and left alone

- Open proposals idle-cat blink, inert Settings value rows, Work page lab group, hub `ctx.mode`
  fallback and `TRUNK_CHANNEL` alias: no new evidence in this cycle, and the first two are not in
  this stream's assigned overlay/menu work.
- The `smoke:docs` journal gate: every cycle record needs its `autonomy/JOURNAL.md` line in the
  same push (cycle 21 rejection cause); this cycle adds its line with the report.
