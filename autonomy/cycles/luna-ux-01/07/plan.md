# Cycle 07 — Plan (run luna-ux-01, stream `ux`)

Mode: **fix**. Board V-09 and V-93 are done on the trunk (review.md); this cycle fixes two
user-visible defects in the same stream files and one documentation carry-over.

## Goal

The launch screen's automatic ASCII choice and the workflow panel's column layout both break on the
surfaces they exist for; after this cycle each is pinned by a test that fails on the base commit.

## Item 1 — Launch screen honours the theme-derived ASCII mode (defect D1)

- **Justification:** `custom-footer/render.ts:110-113` already treats themes named iso/ansi/tty/ascii
  as ASCII. `launch-screen.ts:117-145` only honours `PI_KIT_ASCII=1`, so on `iso-dark`, `ansi-dark`
  and `tty-dark` the header still emits `██╗` and `·` while the footer next to it emits `[x]` and
  `|`. Same glyph-consistency problem the stream owns (V-09), but a distinct, previously unfixed
  surface, not a re-open of the merged footer work.
- **Change:** one small predicate in `launch-screen.ts` matching the footer's theme-name rule (with
  a comment naming the footer as the source of truth); `launchHeader` computes
  `ascii = opts.ascii || predicate(theme.name)` per render and passes it to `launchLines`.
  Update `docs/status-bar-and-costs.md:211` and `docs/control-center.md:42` to say the launch screen
  follows the same automatic choice, and add a `CHANGELOG.md` Unreleased entry.
- **Checks:** `tests/launch-screen-smoke.ts` gains cases: (a) `launchHeader` rendered with
  `theme.name = "iso-dark"` produces no block-art and no `·`, and its output equals the
  `ascii: true` render; (b) a non-matching theme name (`gitops-dark`) keeps the block art. Then
  `npm run -s smoke:launch-screen`, `npm run -s smoke:docs`, `npm run test:typecheck`,
  `npm run test:lint`.

## Item 2 — Workflow panel columns survive narrow and wide-glyph rows (defect D2)

- **Justification:** `wf-panel.ts:309-313,321,408,412` sizes and pads every column by `.length`, and
  the only clamp is the whole-line `truncateToWidth` at `:837`. `docs/workflows.md:473-476` promises
  each phase's status/done-total and each agent's model/tokens/elapsed/status, so a long title
  silently deletes the column; a wide glyph (`阶段 🚀`, 7 columns, `.length` 5) shifts it left. The
  panel is an assigned stream renderer and `tests/tui-layout-smoke.ts` only asserts "fits".
- **Change:** measure each cell with pi-tui's `visibleWidth`, clip it with `truncateToWidth`, and pad
  it to the column width by display width (a local helper reused by phase title, agent id, model
  and list run name). Column widths stay bounded as today. Fold in the HANDOFF carry-over: one
  sentence in `docs/workflows.md` saying an open save/stop confirm still owns the keys after the
  prune fallback. Add a dated `2026-11-12` entry to `third_party/subagent/SOURCE.md` and run
  `node packages/core/gen-notices.ts` if the notices change. `CHANGELOG.md` entry.
- **Checks:** `tests/workflow-panel-smoke.ts` gains cases with a long phase title and a wide-glyph
  agent id/model, asserting each documented column (`running`, `done/total`, model, tokens,
  `elapsed`, `status`) is still present and every line fits the width; then
  `npm run -s smoke:workflow-panel`, `npm run -s smoke:tui-layout`, `npm run -s smoke:docs`,
  `npm run test:typecheck`, `npm run test:lint`, `node packages/core/gen-notices.ts` (then
  `git status` shows no notices drift).

## Verification plan

`node packages/core/check-all.ts --for-changed=<changed files>` for the final tree; run each named
smoke, plus `verify` and `docs:check` if docs change the navigation or generated catalogues. One
independent reviewer over `git diff 210390b86be2..HEAD` against `autonomy/CHARTER.md`. No `npm test`
and no `npm run check:all`.

## Stop conditions

Diff under 30000 characters (excluding records and the lockfile); stop taking new items past it.
If an item cannot reach a green check, revert it and record it as left for the next cycle.
