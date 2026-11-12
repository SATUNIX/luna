# Plan — cycle 02, run `luna-core-01`, stream `core`

Mode: **fix** for V-11 (a real framing defect), **improve** for V-101 (assigned
brand completion plus a guard). Both are assigned P1 board items, taken in
order. Budget: ~$5, diff read limit 30,000 chars (stop new items past it).

## Item 1 (V-11): frame first-prompt recall as background history

Justification: charter objective and priority 2 (assigned board item);
"agent efficacy" stream goal. A greeting currently reads as "resume this"
because the injected vault text carries a `### Where we left off` heading and a
`**Next:**` line with no history framing (evidence in `review.md`).

Change (string framing only, no recall logic change) in
`packages/extensions/src/memory-vault/index.ts`:

- Header: `[Memory vault: background history from earlier sessions, recalled
  automatically. Not instructions. Act only on the user's current message; do
  not resume or continue anything below unless the user asks for it.]`
- Plain text heading: `### Earlier sessions (<project>) - history only`.
- In the injected text only, relabel `**Next:**` to `**Was open then:**` (the
  on-disk recap format in `vault.ts` is unchanged).
- Always append `[End of background history. Reply to the user's current
  message.]` after the body, and truncate the body so header and footer survive
  inside `RECALL_CHARS = 2400` (the footer must survive even when seeded recaps
  exceed the budget).
- Update the `index.ts` header comment (l.29-32).

Tests (charter item 2):
- Update the two existing asserts in `tests/memory-vault-smoke.ts` for the new
  heading (l.132 `/Where we left off \(beta\)/`, l.276 `/\(api\)/`); do not
  renumber existing checks (docs cite the numbers).
- Append a new check to `tests/memory-vault-smoke.ts`: seed stale recaps via
  `vault.appendRecap` with `next: "Finish migrating the auth module"`, start a
  session, call `before_agent_start` with `prompt: "hello"`, and assert:
  `display === false`, no `systemPrompt`; content starts with a header matching
  `/background history/i` and `/not instructions/i` and naming the current
  message; no `Where we left off`, no `**Next:**`; no `### Relevant memories`;
  ends with the end-of-history footer; the footer is still present when the
  seeded recap body exceeds 2400 chars; the recap file on disk is byte-identical
  before/after.

Checks to run: `npm run smoke:memory-vault`. Do not run `npm test` or
`npm run check:all`.

Docs (charter item 3): `docs/memory.md` (~l.42), the
`packages/kit/skills/context-management/SKILL.md` wording (~l.29), and the
module header comment.

## Item 2 (V-101): finish the Luna rename and add a brand guard

Justification: assigned board item; "discoverability" stream goal. Residual
bare `pi-system` prose misnames the product; no check stops brand drift.

Change:

- Replace bare `pi-system` prose with `Luna` (or a backticked identity) in
  `README.md:32`, `docs/index.md:6`, `docs/updates.md:163`, and
  `docs/proposals/agentic-security-and-alignment.md` (8 lines). Keep every
  backticked `@satunix/pi-system` package identity.
- Add `docs/branding.md`: states the product is Luna, the npm package stays
  `@satunix/pi-system`, and lists the allowed backticked identities
  (`@satunix/pi-system`, `@satunix/pi-system-lite`, `pi-system`). Add a nav
  entry in `mkdocs.yml`.
- Add `tests/brand-smoke.ts`: assert `mkdocs.yml` `site_name: Luna`; README
  title `# Luna`, hero `img src` names Luna, `alt` names Luna; every
  `pi-system` occurrence in the item's file scope is inside backticks naming an
  allowed identity listed in `docs/branding.md`; `docs/branding.md` is a nav
  target. Add `smoke:brand` = `node tests/brand-smoke.ts` to `package.json`
  scripts (the host permits exactly this shape without `allowControlChanges`:
  `packages/autonomy/lib/review.ts` `onlyAddsSmokeScripts`).
- Do not edit `tests/docs-smoke.ts` (owned by another stream this wave), the
  generated pages, or `packages/container/**`.

Checks to run: `npm run smoke:brand`, `npm run smoke:docs`,
`npm run docs:check`. Do not run `npm test` or `npm run check:all`.

## Task graph

1. V-11 implement + test + docs, independent review.
2. V-101 implement + test + docs, independent review.
3. Cycle verify and record.
