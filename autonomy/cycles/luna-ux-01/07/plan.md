# Cycle 07 plan — stream ux (luna-ux-01)

Mode: **fix**.

## Items, in work-precedence order

### 1. P0 upstream merge (priority 1) — done

Merge `refs/upstream/trunk` (5a888fe) into `stream/ux`, preserving both sides' intent, then
re-run the targeted checks. Resolution: keep both `package.json` smoke scripts and keep
upstream's trunk branch/tag/channel fields alongside this branch's `trunkAhead` gap count.
Proof: conflict markers gone; `npm run test:typecheck`, `npm run test:lint`,
`npm run smoke:update-notice`, `npm run smoke:kit-update-channel`,
`npm run smoke:launch-screen`.

### 2. PG-59 [P0] — pi-compat red gate

Change `packages/extensions/src/kit-update/index.ts` so the trunk-gap notice takes precedence in
session start. Extract a pure decision helper (notices + whether the status bar is set) used by
the handler:

- gap report → exactly the trunk notice; the generic `summaryLine` notice is suppressed.
- no gap but updates → the existing summary notice (unchanged).
- nothing to do → no notice.

Test `tests/update-notice-smoke.ts`:

- Replace the exact-single-notification assertion with: the trunk notice is present exactly once
  and no second kit notice is added. A pi built-in update notice
  (`Updates available: pi X → Y. Run /update.`) is tolerated and does not count as the kit
  notice; a simulated built-in entry proves the filter.
- Add a case that builds the report with pi `0.99.2` against the `1.4.0` registry, so
  `report.pi.available` is true, and asserts the session-start decision is still only the trunk
  notice. This fails with the old fall-through.
- Keep the missing-trunk-notice failure: the gap report must still yield the trunk line, so a
  change that drops it fails the case.
- Docs: note the precedence in `docs/updates.md` and
  `packages/extensions/src/kit-update/README.md`.

Checks: `npm run smoke:update-notice`, `npm run smoke:kit-update-channel`,
`npm run test:typecheck`, `npm run test:lint`. On a pi older than the pin the same test must
produce only the trunk kit notice (pi's own built-in notice is ignored by the filter).

### 3. V-05 [P2] — already satisfied

No change. Verified by `npm run smoke:launch-screen` (11/11) and the scout's acceptance matrix;
recorded as done in `report.md`.

## Not taken

- HANDOFF carry-overs (duplicate `/mcp` and `/llama` rows; cancelled RPC value dialog returns
  `"back"`) are confirmed real but are left for a later cycle: the mandatory merge already puts
  the review diff far past the 30000-character stop line. They stay in
  `autonomy/runs/luna-ux-01/HANDOFF.md`.
- No new proposals unless the implementation uncovers a separate problem.

## Verification

Run only targeted scripts (`smoke:update-notice`, `smoke:kit-update-channel`,
`smoke:launch-screen`, `smoke:command-menu`, `smoke:control-center`, `test:typecheck`,
`test:lint`). Never `npm test` or `npm run check:all`; the host gate owns the full suite.
