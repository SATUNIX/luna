# Cycle 07 — Review (run luna-ux-01, stream `ux`)

Base `210390b86be2` (head of `stream/ux`), branch `pi/luna-ux-01`. Review is read-only; checks were
run by hand, `npm test` / `npm run check:all` were not run.

## Charter and previous cycle

Read `autonomy/CHARTER.md`, `autonomy/runs/luna-ux-01/HANDOFF.md`, the previous report
(`autonomy/cycles/luna-ux-01/06/report.md`) and `git log --oneline 210390b86be2..HEAD` (no commits
on top of the cycle base). Proposals under `autonomy/proposals/luna-ux-01-*.md` were read; none is
in this cycle's board.

## Board items

The assigned board names two items, and both are already done on the trunk:

- **V-09** — acceptance is one pinned clause (a dated 2026-11-12 entry in
  `packages/extensions/third_party/subagent/SOURCE.md` naming `wf-panel.ts` and `23725c2`, plus a
  generic `tests/docs-smoke.ts` scan). Present: `SOURCE.md:279-283` has
  `- **Workflow panel height budget (2026-11-12):**` naming `wf-panel.ts` and `23725c2`, and
  `tests/docs-smoke.ts:477-512` isolates that entry and then scans every `third_party/*/SOURCE.md`
  for a bolded dated entry. `npm run -s smoke:docs` is green. Nothing to re-open; the TUI width work
  must not be reopened.
- **V-93** — the hidden-character class appears once by hand at
  `packages/core/shared/visible-text.ts:21`, with three byte-identical generated copies from
  `SHARED_COPIES` (`packages/core/gen-shared.ts:105-108`). `autonomy/lib/engine.ts:1011` only uses
  `HIDDEN_CHARS` through `notebook.ts`, a re-export, not a fourth literal. Count is 1. Done.

Work therefore moves to work item (4), defects found in this stream, and the HANDOFF follow-ups.

## HANDOFF carry-overs checked against the code

| Follow-up | State |
|---|---|
| `control-center/index.ts` duplicate `/mcp`/`/llama` rows in `allCommands()` | **DONE** — `index.ts:170-181` dedupes with `seen`, and the comment at `:165` names both commands. |
| `hub.ts` RPC value dialog cancel returns `"back"` | **DONE** — `hub.ts:316-318` maps `undefined` (timeout/cancel) to `undefined` (close), and `"back"` comes only from an explicit `‹ Back` (`:304`). |
| `wf-panel.ts` `footer()` looks up `current()` twice | **STALE** — `wf-panel.ts:779` reads `inRun()` then `current()` once. |
| `docs/workflows.md` confirm-owns-keys after prune fallback | **OPEN** — `docs/workflows.md:462-463` documents the prune fallback but not that an open confirm still owns the keys; the code checks `this.confirm` before `inRun()` (`wf-panel.ts:647-651`). |
| `engine.ts:1011` own `HIDDEN_CHARS` transform | **DONE** — re-export from `notebook.ts:20,25`, outside this stream anyway. |

## New defects (evidence)

Sent two scouts over the pure TUI renderers in this stream. Findings, ranked:

### D1. Launch screen ignores the theme-derived ASCII mode the footer honours (medium)

`custom-footer/render.ts:110-113` switches to ASCII automatically for themes named iso/ansi/tty/ascii.
`launch-screen.ts:117-145` passes only `opts.ascii`, which `control-center/index.ts:114` sets only
from `PI_KIT_ASCII === "1"`; the live theme name is never consulted. On `iso-dark`, `ansi-dark` or
`tty-dark` the footer draws `[x] | ...` while the launch screen still emits `██╗` and `·`, i.e.
mojibake on exactly the terminals those themes exist for. `docs/status-bar-and-costs.md:211`
promises the automatic choice for "footer, todo widget and working line" and `docs/control-center.md:42`
defers to `PI_KIT_ASCII` only, so the two surfaces disagree. Pinned by a new themed render case in
`tests/launch-screen-smoke.ts`.

### D2. Workflow panel columns are measured in code units and never clipped (medium)

`wf-panel.ts:309-313` computes `phaseWidth`/`labelWidth`/`modelWidth` from `.length`, `:321` and
`:412` `padEnd` raw text, and `:408` pads run names the same way; only the finished line is cut
(`:837`). With a long phase title the cell overruns and pushes the phase's `done/total` off the row;
a long agent id/model pushes `tokens`, `elapsed` and the agent's `status` off the row. `阶段 🚀`
measures 7 columns but `.length` 5, so wide glyphs shift the status column left even when the line
fits. `docs/workflows.md:473-476` promises those columns, and `tests/tui-layout-smoke.ts` only
asserts "fits", not that the columns survive. Fix: measure with `visibleWidth`, clip each cell with
`truncateToWidth`, pad by visible width. This is a new defect in the panel renderer, not the merged
custom-footer ASCII/width work V-09 pinned.

## Chosen work

Fix mode: D1 and D2, plus the one-line `docs/workflows.md` carry-over folded into D2 (same file,
same behaviour). Both are user-visible defects in assigned stream files, both have a failing pin
that can be written before the fix.
