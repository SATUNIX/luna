VERDICT: PASS

## Files reviewed

- `packages/extensions/src/control-center/hub.ts` (lines 255-260, 304-356)
- `tests/control-center-smoke.ts` (lines 89-121, 623-679)
- `docs/control-center.md` (lines 103-120)
- `docs/status-bar-and-costs.md` (lines 94-124)
- commits `e23b6f3` (control-centre fix) and `4d5686a` (cat docs), diff scoped to four files excluding records/lockfile.

## Evidence

### Scope and plan match
- `git diff --stat a014133e398a..HEAD` touches only `docs/control-center.md`, `docs/status-bar-and-costs.md`,
  `packages/extensions/src/control-center/hub.ts`, `tests/control-center-smoke.ts` (92 insertions, 15 deletions;
  well under the 30k-character limit). No `package.json`, CI, credential, release, lockfile or
  `autonomy/CHARTER.md` change. The two commits are one logical change each.
- Item 1 is implemented as planned: one `typedCommand()` resolver (`hub.ts:308-322`) and one
  `typedSuffix()` (`hub.ts:324-327`) are used by `textPage` (`hub.ts:258`), RPC `rowLabel`
  (`hub.ts:329-333`) and the TUI `SettingItem.label` (`hub.ts:353`). `row.label`, `description` and
  `currentValue` are untouched; the suffix precedes the RPC `— unavailable` and TUI `(unavailable)`
  markers. `typedSuffix` omits the suffix when the typed command equals the label, which covers the
  All commands page (`model.ts` builds `/name` labels and `/name ` prefills).
- Item 2 removes `alert` from the reachable-result row and adds it to the "Not covered" sentence.
  The animation table and priority list are intentionally unchanged.

### Tests genuinely pin the fix
- Pre-fix `rowLabel` rendered only `row.command`; TUI items used `row.label` unaided. Therefore
  each new assertion that depends on legacy/prefill/informational command text fails on the pre-fix
  source:
  - RPC Autonomy option `[/auto]` (legacy) and RPC Session option `[/compact]` (prefill).
  - TUI Autonomy `Approvals ... [/auto]` and TUI Doctor `Update ... [/update status]` (the Doctor
    description has no brackets, so it cannot satisfy the assertion pre-fix).
  - The second test case's wide render assertion `[/auto]` fails pre-fix, so the test case as a
    whole fails; the narrow assertion then proves the row name survives at width 20 while the
    suffix is cut. The All commands assertion keeps the option exactly `/auto`, guarding against
    the naive "append everywhere" implementation. The existing exact-option assertion still passes.
- `makeUi` only gained a `renderWidth = 120` parameter; existing call sites and behaviour are
  unchanged, so no existing test is weakened.

### Alert documentation
- `setResult` callers are exactly `index.ts:507` (`classifyToolError`, which returns only `denied`
  or `warning` per `cat.ts:134-146`), `index.ts:524` (`error`/`cancelled`/`success`) and
  `index.ts:534` (`warning`). No caller passes `alert` (or `retrying`/`sleeping`). The updated
  `docs/status-bar-and-costs.md:120-124` now states this accurately while keeping the face in the
  table/priority list as a future driver.

### Checks run (targeted only)
- `npm run smoke:control-center` — 39/39 passed, including both new tests.
- `npm run smoke:command-menu` — 13/13 passed.
- `npm run smoke:docs` — passed (links, command docs, profiles).
- `npm run smoke:cat-status` — 12/12 passed (supports the edited cat docs).
- `npm run test:typecheck` — passed.
- `npm run test:lint` — passed (zero warnings).
- `npm run verify` — all checks passed.
- `npm test` / `npm run check:all` were not run, as required.

## Warnings (should fix, not blocking)

- `tests/control-center-smoke.ts:662-666` — the All commands duplication check covers the RPC
  dialog but not a TUI/print render, while the plan asks for "an All commands render and RPC
  dialog". Both renderers share `typedSuffix`, so the risk is low, but adding the TUI assertion
  would pin the stated contract completely.
- `tests/control-center-smoke.ts:668-676` — the narrow-width `doesNotMatch` assertion alone would
  pass pre-fix; the test is still valid because its wide-width sibling fails pre-fix. A comment or
  an additional "suffix is visible when there is room, absent when there is not" pairing makes the
  intent clearer.
- `hub.ts:313-319` — sanitising a `legacy` value by deleting control characters (rather than
  rejecting it) would join `/auto\non` into `/autoon`. Current built-in values are clean and this
  is display-only, but rejecting rather than concatenating would be safer for future registered
  controls.

## Summary

The change is scoped, matches the two plan items, fixes the evidenced TUI/RPC gap with tests that
fail on the pre-fix source, corrects the stale `alert` documentation against the actual
`setResult` callers, and updates both user-facing docs. All targeted checks pass and no tests,
CI, credentials, release configuration, scripts, dependencies or charter were changed. Only minor
test-coverage and sanitisation hardening notes remain.

VERDICT: PASS
