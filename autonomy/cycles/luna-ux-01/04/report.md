Outcome: successful
Mode: fix

Board: V-93 done - one hidden-character class and `oneVisibleLine` now live in `packages/core/shared/visible-text.ts`, with generated copies for control-center, autonomy-run and subagent and imports in the autonomy CLI, store and notebook; hand-written copies 4 -> 1.
Board: V-09 done - checked against the base, not redone: the remaining clause is merged at `c8e76e2` (`SOURCE.md:279` dated 2026-11-12 entry naming `wf-panel.ts`, `tests/docs-smoke.ts:473-490` pinning it).

Item: V-93 one shared hidden-character filter and oneVisibleLine - 36565d9, 5f59714 - `npm run -s smoke:control-center` (`all 46 checks passed`, incl. the new bidi/single-literal case and the unchanged 600->500 cap), `node packages/core/gen-shared.ts --check`, `npm run -s test:lint`, `npm run -s test:typecheck`, `npm run -s verify`.

# Cycle 04: hidden-character filter consolidated (V-93)

## What was asked

The board's V-09 had one clause left; cycle 03 landed and merged it, so this cycle checked it at
the base and left it alone. V-93 was the real work: the same "strip `Cc`, `Cf` and
default-ignorable code points, then collapse to one line" rule was written out in four places.

## Finding and evidence

`grep -rln 'Default_Ignorable_Code_Point' packages tests docs` named four hand-written class
literals: `control-center/hub.ts:177`, `autonomy/lib/notebook.ts:126`,
`autonomy-run/index.ts:192`, `third_party/subagent/run-query.ts:216`. The one-line rule was
duplicated in `autonomy/cli.ts:719` and `autonomy/lib/store.ts:148`, with a third variant at
`cli.ts:249`. Cycle 01 had already had to fix the same escape-stripping hole in more than one copy,
which is the reliability cost of the duplication.

## Fix

New `packages/core/shared/visible-text.ts` holds the class once, plus `isHiddenChar`,
`stripHiddenChars` (keeps tab/newline) and `oneVisibleLine` (hidden removed, tab/newline to a
space, whitespace collapsed, trimmed). `SHARED_COPIES` in `packages/core/gen-shared.ts` generates
byte-identical copies into control-center, autonomy-run and subagent (`npm run gen:shared`), and
the autonomy CLI (both call sites), store and notebook import the source directly. The notebook
keeps its `HIDDEN_CHARS`/`isHiddenChar` re-exports for existing importers.

Behaviour is unchanged: the hub still runs pi-tui's sequence strip first, trims and caps at 500
code points; the notebook still keeps tab/newline in `state`; `workerText()` still caps at 400.
Docs (`docs/control-center.md`, `docs/autonomy.md`), `CHANGELOG.md`, the subagent `SOURCE.md`
(dated 2026-11-12 entry naming `third_party/subagent/run-query.ts`) and `THIRD_PARTY_NOTICES.md`
are updated.

## Test justification

No existing assertion changed. `tests/control-center-smoke.ts` gains one case: a bidi override is
removed by both helpers, a 600-code-point string is not capped by `oneVisibleLine` (the hub's 500
cap stays pinned by the unchanged case above it), and the class literal appears once outside the
generated copies. The case fails on the base tree, where the literal lives in four files and the
shared module does not exist.

## Checks

Planned with `check-all --for-changed` over the changed paths; every planned check ran and passed:
`docs:check`, `smoke:autonomy`, `smoke:autonomy-run`, `smoke:autonomy-selfimprove`,
`smoke:control-center`, `smoke:docs`, `smoke:eval-footprint`, `smoke:new-extension`,
`smoke:subagent-roles-isolation`, `smoke:workflow-notify`, `test:lint`, `test:typecheck`,
`verify`, plus `smoke:autonomy-inbox`, `smoke:redaction-corpus`, `smoke:autonomy-notebook`,
`smoke:tui-layout` and `smoke:run-query`. `npm test`, `npm run check:all` and
`/opt/autonomy/gate.sh` were not run locally (host-gate only). Detail and proving lines are in
`verify.md`; the non-record diff is 35,648 characters.

## Review

The gated implementer/reviewer plan returned FAIL on the uncommitted tree, a `TS2322` synchronous
smoke callback and a dynamic anchored RegExp that `test:lint` rejects. All three were fixed
(`36565d9` commits the consolidation, `5f59714` rebuilds `isHiddenChar` without a second pattern),
and an independent reviewer subagent then returned PASS on the pushed HEAD with no must-fix items.

## Left

- `autonomy/lib/engine.ts:1011` still applies its own `HIDDEN_CHARS` transform (imported through
  the notebook re-export) rather than `oneVisibleLine`; it duplicates no class literal and is
  outside V-93's scope. A later cleanup can route it through the shared helper if behaviour allows.
- The `wf-panel.ts` footer/`render()` divergence after `RunRegistry.prune()` (handoff carry-over,
  proposal `luna-ux-01-03-workflow-panel-footer-after-prune.md`) still needs its own failing test.
