# Cycle 08 review — Luna ux stream

Base: `a597e3bf1063` (head of `stream/ux`), branch `pi/luna-ux-01`. Mode: fix.

Charter read in full. Handoff `autonomy/runs/luna-ux-01/HANDOFF.md`, cycle 07 report and the
`luna-ux-01-*` proposals read. Three read-only scouts checked the board items and the ux
renderers against the code (one parallel plan, run `2026-11-12T15-50-07-390Z-plan-a6ed`).

## Assigned board items — both already done on the base

- **V-09 done.** `packages/extensions/third_party/subagent/SOURCE.md` carries the bolded entry
  `Workflow panel height budget (2026-11-12):` naming `wf-panel.ts` and `23725c2`;
  `tests/docs-smoke.ts:473-511` requires one bolded `(YYYY-MM-DD)` entry per
  `third_party/*/SOURCE.md` and the subagent entry to name `wf-panel.ts`. Nothing to add; the
  acceptance clause is already pinned, so the V-09 TUI width work is not reopened.
- **V-93 done.** `packages/core/shared/visible-text.ts` is the single class and
  `oneVisibleLine()`; `packages/core/gen-shared.ts:105-108` generates the extension copies;
  `hub.ts:35`, `cli.ts:39`, `notebook.ts:20` and `store.ts:12` import it. `grep` for the
  property class finds the shared source and its three generated copies, not a hand-written
  re-declaration in a consumer (count 1 hand-written source).

## New findings

1. **The curated `/` menu ignores `PI_KIT_ASCII` (real, user-visible).** `command-menu.ts:26`
   and `:193`/`:245` always emit `moved → … ▸ …` and ` — `. The launch screen and footer honour
   `PI_KIT_ASCII=1` (launch-screen.ts:146 via `opts.ascii`; footer render.ts:120), and
   `docs/reference.md:447` assigns the variable to `control-center`. On the terminal where the
   operator asked for printable ASCII the `/` suggestions still contain `→`, `▸` and `—`.
   Existing tests pin only the Unicode strings (`tests/command-menu-smoke.ts:316-329`).
2. **A single right-side critical chip can be dropped by `renderFooter` at narrow widths.**
   `custom-footer/render.ts:229-232` returns the left side only when `leftRoom < 12`, and
   `:216` merges only when there are at least two critical segments, so one
   `orchestrator: blocked` chip vanishes at 20-37 columns — against the module contract at
   `render.ts:8-13`. **Off-limits this cycle** ("do not touch footer priority/fitting logic");
   recorded as a proposal.
3. **`asciiThemeName` omits the env clause of `footerGlyphs`** (latent parity drift, masked by
   `opts.ascii` ORed in at registration). Not touched; recorded in the same proposal.

## Cycle choice

Fix mode, one defect (finding 1): small, inside the ux stream, evidenced, and independent of the
protected footer fitting code. The two board items are re-checked, not reopened. Finding 2 is
outside this cycle's allowed files; finding 3 is latent.
