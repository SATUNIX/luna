# Cycle 09 — Plan (run luna-ux-01, stream `ux`)

Mode: **fix**. One code item, plus the P0 and V-73 verification recorded in `review.md`.

## Goal

Back from a page reached through another page returns to the page it was opened from, not to a
static parent.

## Item 1 — page-stack back navigation in the control centre (HANDOFF carry-over)

**Justification (charter §Priorities 3 and 4; evidence in `review.md`).** `openHub` resolves Back
with the single static `parent` in `PAGES`, so Settings → Display → Back lands on System. The
docs already promise "Back returns the cursor to the row that opened the page"
(`docs/control-center.md:95`), so the code contradicts its documentation.

**Change.**

- In `packages/extensions/src/control-center/hub.ts` `openHub`, keep a `stack: string[]` of the
  pages visited by navigation. On `"back"`, if the stack is non-empty pop it and go there; otherwise
  fall back to `parentPage` as today. Push the current page when a `kind: "page"` row changes the
  page. Pass the effective back target as `PageInput.parent` so the renderer's `‹ Back`/Esc entry
  is offered whenever a back step exists.
- Keep the existing focus behaviour: on returning, focus the row on the parent that targets the page
  just left.
- Do not touch page ids, `PAGES`, row ids or handlers.

**Tests.** Extend `tests/control-center-smoke.ts` (owned by `smoke:control-center`) with a case that
drives a multi-page path — open on `settings`, choose the `settings.display` page row, then `back` —
and asserts the reopened page is Settings (`→ Display` cursor) rather than System. The case must
fail on the current code and pass after the change. Keep the existing
`Back returns the cursor to the row that opened the page` case green (directly-opened page still
uses the static parent).

**Docs.** `docs/control-center.md` around line 95: state that Back follows the path the operator
took and only falls back to the page's parent when the page was opened directly.

**Checks (only these; never `npm test` or `npm run check:all`).**

- `npm run -s smoke:control-center`
- `npm run -s test:typecheck`
- `npm run -s test:lint`
- `node tests/docs-smoke.ts` (only if a doc file changes)

**Do not change** `package.json` `scripts`, `HARNESS_COMMANDS`, command names, handlers or any
control path. `overlay-frame.ts` is untouched, so its two byte-identical copies stay identical.

## Task graph

1. Item 1 implementation + tests + docs → gated review.
2. Verify: targeted smokes, independent reviewer over `git diff 25cc6eab64b5..HEAD`.
3. Record: `verify.md`, `report.md`, HANDOFF, journal line, push.
