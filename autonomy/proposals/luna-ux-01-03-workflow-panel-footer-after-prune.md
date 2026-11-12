# Workflow panel shows the list with the run-view footer after its run is pruned

Run `luna-ux-01`, cycle 03 (stream `ux`). Status: **proposed** — found during this cycle's review by a
read-only scout, not fixed here (one finished change per cycle). Not an assigned board item.

## Problem

`WorkflowPanel.render()` decides the body from the run it can find:

- `packages/extensions/third_party/subagent/wf-panel.ts:788` — `const run = this.view === "run" ? this.current() : undefined;`
  and the `else` branch draws the run **list** when `run` is `undefined`.
- `packages/extensions/third_party/subagent/wf-panel.ts:773-776` — `footer()` keys off `this.view`
  alone, so it still returns the run footer
  `↑↓ select · k skip · x stop · p pause · s save · esc back`.

`RunRegistry.prune()` (`run-model.ts`, `MAX_FINISHED_RUNS = 20`) drops the oldest finished runs. A
run that is open in the panel when it is pruned therefore renders a list body under the run-view key
legend. The panel's input handlers also still believe it is in the run view, so the first key press
(`down`) is consumed switching to the list and nothing visible moves; `esc` appears dead once.

Reproduction with the real registry (no model runs):

```
open the panel on a finished run, then start and finish 21 more runs
render() -> "Workflows (20 runs, 0 active)" ... "↑↓ select · k skip · x stop · p pause · s save · esc back"
press("down") -> view flips to "list"; selection does not move
```

## Suggested fix

Derive the effective view once, for example `const inRun = this.view === "run" && this.current() !== undefined;`
and use it for the body branch, `footer()` and the key handling (or, when `current()` is gone, reset
`view` to `"list"` before rendering). Pin it in `tests/workflow-panel-smoke.ts` with the prune case:
assert the list footer, and that the first `down` moves the selection. Do not change the existing
assertions in that smoke; add a new case.
