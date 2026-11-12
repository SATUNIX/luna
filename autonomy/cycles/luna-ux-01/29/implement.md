# Cycle 29 — Implement (run `luna-ux-01`, stream `ux`)

Base `337fb705914d`, code head `d3ead52`. Item V-91.

The gated `workflow_run` plan produced `eb739d5` but failed before writing this
file: after the implement step it errored with "declared output
`implement.md` not written", so the workflow's own record is missing. The
implementation itself landed and was verified independently. The reviewer step
was therefore run as a separate `reviewer` subagent, and the two coverage gaps
it found were fixed and re-reviewed (`2599c21`, `d3ead52`).

## Commits

| Commit | Change |
| --- | --- |
| `4443f5a` | cycle review and plan records |
| `eb739d5` | `updateTodoWidget` mounts a component with `render(width)`; `smoke:status-bar` mounts it at 24 columns; `tui-layout-smoke` closes the newline/6-status/qr-size clauses; docs and `SOURCE.md` |
| `2599c21` | the todo-widget fixture gets its own 200-character item (the first pass had it only in the footer state, which merely counts todos) |
| `d3ead52` | the wide footer fixture gets a genuinely long cwd (reviewer: the CJK path was wide but short) |

## Deviation from the board text

The board names `width` as `renderTodoWidget`'s 4th parameter. It is the 5th,
after `ascii`, because `ascii` is 4th in the shipped signature and
`smoke:status-bar` pins it. Width was already an optional trailing parameter
from cycle 27; this cycle only makes the mounted widget pass it on every render.

## Negative evidence

Base `337fb705914d` with the final tests overlaid:
`npm run smoke:status-bar` exits 1 with
`FAIL asciiSettingReachesTodoWidget` / `AssertionError: a narrow todo line fits
24 columns: 50 Todos 0/2 ----------  /footer todos off hides this`.
`npm run smoke:tui-layout` passes on base: the layout assertions were already
true from cycles 27-28, so the regression pin for this cycle is the status-bar
mount case, not the layout smoke.
