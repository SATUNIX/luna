# Cycle 04 — Plan (run luna-ux-01, stream `ux`)

Mode: **fix** (consolidation of a measured duplication). One board item, one logical change.

## Item 1 — V-93: one shared hidden-character filter and `oneVisibleLine`

**Justification.** Four hand-written copies of the `Cc`/`Cf`/default-ignorable class and several
copies of the one-line rule are a correctness hazard: cycle 01 had to fix the same escape-stripping
hole in more than one file. `packages/core/gen-shared.ts` already exists to keep one source and
byte-identical consumers (charter item 1: evidenced duplication; item 3: one obvious way).

**Change.**

1. New `packages/core/shared/visible-text.ts` holding the class once:
   `HIDDEN_CHARS`, `isHiddenChar`, `stripHiddenChars` (keeps tab/newline) and `oneVisibleLine`
   (hidden to nothing, tab/newline to space, whitespace collapsed, trimmed). No new dependency.
2. `SHARED_COPIES["visible-text.ts"]` targets the three extension consumers:
   `packages/extensions/src/control-center/shared/visible-text.ts`,
   `packages/extensions/src/autonomy-run/shared/visible-text.ts`,
   `packages/extensions/third_party/subagent/shared/visible-text.ts`; run `npm run gen:shared`.
3. Consumers import instead of re-declaring:
   - `control-center/hub.ts` uses the generated copy's `HIDDEN_CHARS` inside `displayText()`
     (keeps `stripTerminalSequences`, the trim and the 500-code-point cap).
   - `autonomy-run/index.ts` uses `oneVisibleLine`.
   - `third_party/subagent/run-query.ts` uses `oneVisibleLine`/`stripHiddenChars` in `workerText()`
     (same 400-cap behaviour).
   - `autonomy/lib/notebook.ts` imports the class and helpers from
     `../../core/shared/visible-text.ts` and keeps its public re-exports (`HIDDEN_CHARS`,
     `isHiddenChar`) so existing importers and tests keep working.
   - `autonomy/cli.ts` (both call sites) and `autonomy/lib/store.ts` use `oneVisibleLine` (or the
     shared class where the current code deliberately does not collapse whitespace).
4. Docs: `docs/control-center.md` no longer says the filter is local to the hub; it names the shared
   source and generated copy. `docs/autonomy.md` names the shared source for the notebook filter.
   `CHANGELOG.md` entry under `[Unreleased]`.
5. Vendored provenance: dated 2026-11-12 entry in
   `packages/extensions/third_party/subagent/SOURCE.md` for the `run-query.ts` change, then
   `node packages/core/gen-notices.ts` if `THIRD_PARTY_NOTICES.md` changes.

**Tests.** No existing assertion changes. Add one focused case in an existing smoke (no new
`package.json` script) proving the shared filter still removes a bidi override and still bounds a
600-code-point string through the hub's `displayText` path; `smoke:control-center` already has the
600-character and bidi assertions and must stay green. `smoke:autonomy-inbox`,
`smoke:redaction-corpus`, `smoke:autonomy-notebook`, `smoke:tui-layout` keep every current
assertion. `npm run gen:shared` must leave no diff.

**Acceptance.** Hand-written copies of the filter class: 4 -> 1. `npm run gen:shared` clean; the
three extension copies are generated; the named smokes green.

**Checks.** `docs:check`, `smoke:autonomy`, `smoke:autonomy-run`, `smoke:autonomy-selfimprove`,
`smoke:control-center`, `smoke:docs`, `smoke:eval-footprint`, `smoke:new-extension`,
`smoke:subagent-roles-isolation`, `smoke:workflow-notify`, `test:lint`, `test:typecheck`,
`verify`, `smoke:autonomy-inbox`, `smoke:redaction-corpus`, `smoke:autonomy-notebook`.

## Not taken

- `wf-panel.ts` footer/`render()` divergence after `RunRegistry.prune()` (handoff carry-over and
  proposal `luna-ux-01-03-workflow-panel-footer-after-prune.md`): needs its own failing test; V-93
  is a board item and the budget is one item.
- V-09: already merged and pinned at the base; not re-opened.

## Budget and diff

About $5 model spend, 3 hours. One item through one `workflow_run` plan (implementer, then a
reviewer that did not write the change, `max_loops` 1). Stop taking new items when the non-record
diff passes 30,000 characters.
