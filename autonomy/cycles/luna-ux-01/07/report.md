# Cycle 07 report: launch-screen ASCII parity, workflow-panel column widths

Outcome: successful
Mode: fix

Test-change justification: no existing assertion was weakened. `tests/launch-screen-smoke.ts`
gained new cases (ISO theme names render ASCII and equal an explicit ASCII render; `gitops-dark`
keeps block art; a footer-parity loop over eight theme names), and `tests/workflow-panel-smoke.ts`
gained a new section 2c rather than changing the existing snapshot and key cases. The snapshot
cases still pass unchanged because the `cell()` helper pads plain ASCII exactly like `padEnd`.

Board: V-09 done - already merged and verified at the cycle base (dated `SOURCE.md` entries,
`docs-smoke` provenance scan); re-checked by the reviewer, not reopened this cycle.
Board: V-93 done - already merged and verified at the cycle base (single `visible-text.ts` source,
generated copies, hand-written count 4 to 1); re-checked, no code change.

Item: Launch screen follows the footer's automatic ASCII theme choice (defect D1) - 05e275d6, 04a98bf2 - `npm run smoke:launch-screen` 16/16; footer-parity case ties `asciiThemeName` to `footerGlyphs`.
Item: Workflow panel columns measured and cut in display width (defect D2) - 488b64f9, 98127528 - `npm run smoke:workflow-panel` 22/22; 2c case fails on the base source, `renderText` ESC case fails on 488b64f9 without the strip fix.

## What changed

- `launch-screen.ts` now derives the ASCII choice from the theme name the same way the vendored
  footer does (`iso`/`ansi`/`tty`/`ascii`), so header and footer agree; `PI_KIT_ASCII=1` still
  forces it. Pinned by `tests/launch-screen-smoke.ts`; docs and CHANGELOG updated.
- `wf-panel.ts` sizes the phase title, agent id, model and run name columns with `visibleWidth` and
  clips/pads them through one `cell()` helper (ellipsis on cut), instead of `String.prototype.length`
  and `padEnd`. Long text no longer pushes done/total, tokens, elapsed or status off the row, and a
  wide glyph (`阶段 🚀`) keeps the following columns aligned. `cell()` strips the ANSI resets that
  `truncateToWidth` appends, so the non-TUI `renderText` fallback stays plain. The whole-line clamp
  is unchanged. Dated `SOURCE.md` entry, regenerated notices, CHANGELOG, and `docs/workflows.md`
  (including the carry-over sentence that an open stop/save confirm still owns the keys after the
  prune fallback).
- Verification: `check-all --for-changed` named 11 checks, all RUN and PASS (table in `verify.md`),
  plus `smoke:tui-layout` 5/5. Two independent reviewers; the first FAILed on a mangled docs
  paragraph and the ANSI leak, both fixed and re-reviewed to PASS. Diff 23316 bytes (< 30000).

## Left and next

- Not taken (diff budget, and out of this cycle's two items): `wf-panel.ts` `footer()` still looks up
  `current()` twice (readability only); `autonomy/lib/engine.ts:1011` continues to apply the
  notebook-reexported hidden-char transform (no class duplicate, outside V-93).
- The unauthenticated `/mcp`/`/llama` dedupe and `hub.ts` cancel mapping carry-overs were confirmed
  already fixed by the scout pass; nothing left there.
- No new proposals were needed this cycle.
