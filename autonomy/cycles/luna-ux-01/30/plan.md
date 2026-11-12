# Cycle 30 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. One item: make the footer's display-width function agree with pi-tui for VS16 /
keycap emoji clusters and tabs, and pin it with a test that measures with pi-tui's own
`visibleWidth`.

## Item — width parity for VS16/keycap emoji and tabs (V-01/V-09)

**Justification (charter 1, 2, 3, 5):** reproduced defect in the status bar's width module (the
review has the command output). The module is the one place every footer and todo line trusts to
fit the terminal; it under-counts common emoji by 1 column each and a tab by 3. Existing tests
cannot see it because they measure with the same module. One small change, one vendored tree.

**Change:**
1. `packages/extensions/third_party/custom-footer/width.ts`:
   - `codePointWidth`: a tab (`\t`) is 3 columns, as pi-tui's `visibleWidth` counts it, checked
     before the generic `\p{Cc}` zero-width rule.
   - `clusterWidth`: after the per-code-point maximum, a cluster containing `U+FE0F` (VS16) or
     `U+20E3` (keycap) is at least 2 columns. This covers `❤️`, `⚠️`, `✔️`, `1️⃣` and any other
     text-presentation base promoted to emoji presentation.
2. `tests/tui-layout-smoke.ts`:
   - import `visibleWidth` from `@earendil-works/pi-tui` and assert every footer/todo/panel line
     also fits by that measurement (the host renderer's actual metric), not just the module's.
   - add a fixture using `❤️`, `⚠️`, `1️⃣` and a tab in a todo item and in the footer state, so
     the base code fails on the new assertion.
3. `packages/extensions/third_party/custom-footer/SOURCE.md`: dated 2026-11-14 cycle 30 entry.
4. `THIRD_PARTY_NOTICES.md`: regenerate with `node packages/core/gen-notices.ts`.
5. No docs change needed: `docs/status-bar-and-costs.md:59` already says emoji are handled in
   terminal columns; this makes the code true. If the implementer finds a sentence that
   contradicts the new behaviour, update it in place.

**Checks that prove it:**
- `npm run smoke:tui-layout` (the new VS16/keycap/tab fixture and the host-width assertion).
- `npm run smoke:status-bar` (footer component, ASCII mode, todo widget mount).
- `npm run test:typecheck`, `npm run test:lint`, `npm run verify` (provenance/notices).
- Negative run: the final `tests/tui-layout-smoke.ts` against base `fc5dc46` fails on the new
  fixture with the pi-tui width, and passes at head.

**Acceptance:** the new assertion fails on base and passes at head; `smoke:tui-layout` and
`smoke:status-bar` exit 0; `renderTodoWidget` with a width cuts every line by pi-tui columns;
no `package.json` script, `CHARTER.md` or control path is touched.

**Out of scope:** full parity with every `get-east-asian-width` rule (regional indicators and
Indic spacing marks are not evidenced here); the run-card input-hold defect (proposal written);
idle-cat blink intent.

## Goal and task graph

Goal: the footer's width measurement matches pi-tui for VS16/keycap emoji and tabs, pinned by a
fixture that fails on base.
Tasks: implement (width fix, test, source entry, notices), independent review, verify, record.
