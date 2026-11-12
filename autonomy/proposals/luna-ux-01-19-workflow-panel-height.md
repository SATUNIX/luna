# The `/workflows` panel can be taller than the terminal, hiding its confirm block and key legend

Status: proposed (found during cycle 19 by a scout; not in that cycle's scope)

## Problem

`packages/extensions/third_party/subagent/wf-panel.ts` opens the run panel with
`overlayOptions: { width: "90%", maxHeight: "90%" }` (`:770`), but `WorkflowPanel.render`
(`:676-700`) always emits, in order: the header, every phase, up to `AGENT_ROWS = 10` agent rows,
up to `NARRATION_SHOWN = 6` narration lines, and then the stop/save confirm block, the footer key
legend and the closing rule.

The overlay host keeps the **top** of the content when it clips:
`node_modules/@earendil-works/pi-tui/dist/tui.js:1004-1006` does
`overlayLines = overlayLines.slice(0, maxHeight)`. So on an ordinary 24-row terminal the panel
budget is about 21 lines, while the same renderer measures 30 lines for a run with 10 agents and
5 phases, and 38 lines with a pending confirm. The question, both choices, the "enter confirm"
hint and the bottom border are cut, so pressing `x`/`s` looks like it did nothing.

`tests/workflow-panel-smoke.ts` only asserts the option object (`:499`); it never renders the
panel at a small terminal height.

The control-centre overlay already solves this shape of problem (`hub.ts` reduces visible rows and
drops title/hint rows before the focused row), and cycle 19 fixed its last focus-clipping case.

## Suggested fix

Give `render` a height budget read from `tui.terminal?.rows` per render. Trim only the middle
sections in a fixed order (narration lines, then phase rows, then agent rows beyond the selected
window) and never trim the header, the confirm block, the footer or the final rule. Below the
minimum, keep the header plus the confirm/footer and collapse the middle to one `… n more` line.

## Evidence to pin

Add a `tests/workflow-panel-smoke.ts` case with 10 agents, 6 narration lines and a pending stop
confirm, rendered at 20 and 24 rows: assert the line count fits, the confirm question and both
choices, the confirm hint, the footer and both rules are present. It should fail on the current
source (38 lines at 24 rows).

## Docs

`docs/workflows.md` (panel section, about `:445-497`) needs one sentence: on a terminal too short
for the panel, narration and extra phase/agent rows are dropped; the selected agent and the
confirm/footer are kept.
