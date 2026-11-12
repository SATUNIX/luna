# Cycle 08 plan — Luna ux stream

Mode: fix. Board items V-09 and V-93 are already done and pinned on the base (see `review.md`);
they are re-checked, not reopened. One defect is taken.

## Item 1 — curated `/` menu honours `PI_KIT_ASCII`

Justification: charter §1 (documented behaviour the code does not have). `docs/reference.md:447`
and `docs/control-center.md:42-43` say `PI_KIT_ASCII` belongs to control-center and asks for
printable ASCII; the launch screen and footer comply, the `/` menu descriptions do not.

Change, smallest:
- `packages/extensions/src/control-center/command-menu.ts`: add an `ascii` option (default false)
  to `locationOfRow`/`hubLocationFor`/`locationFor`/`CurationOptions`, plus
  `ALL_COMMANDS_LOCATION_ASCII`. ASCII output uses `moved -> /menu > Page > Row` and `" - "`
  instead of `—`. Default output is byte-identical.
- `packages/extensions/src/control-center/index.ts`: pass
  `ascii: process.env.PI_KIT_ASCII === "1"` to `locationFor` and the provider.
- Docs: `docs/control-center.md` curated-menu section states the env flag switches the location
  hint to ASCII; CHANGELOG entry.

Checks (targeted, never `npm test`/`check:all`):
- `node tests/command-menu-smoke.ts` (new case: with `PI_KIT_ASCII=1` the registered provider's
  hidden-suggestion description matches `/^[\x20-\x7e]*$/` and names the hub in ASCII; direct
  `hubLocationFor(..., true)` / `locationFor(model, true)` assertions). Existing Unicode
  assertions stay unchanged.
- `npm run smoke:docs` (documentation commands/links), `npm run test:typecheck`, `npm run test:lint`
  on the touched files.

## Not taken

- Footer single-critical-chip drop: proposal `luna-ux-01-08-footer-critical-chip-narrow.md`
  (off-limits footer fitting logic).
- `asciiThemeName` env-clause drift: noted in the same proposal; latent only.

## Sequencing and budget

One implementer + gated reviewer plan. Diff is far below 30000 bytes; no new dependency, timer or
network. Record `verify.md`, `report.md`, journal line and the proposal, push.
