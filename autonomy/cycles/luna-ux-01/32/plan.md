# Cycle 32 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. One item: DE-98, the missing release record and the QR fixture regression.

## Item — DE-98 release record and QR fixture (ux, release hygiene)

**Justification (charter 1, 3, 5):** the changes are already merged and user-visible; the
repository's own release record omits them, and `AGENTS.md` requires an entry per user-visible
change. The fixture reduction is a test-coverage regression shown by `git log -S`. One small
docs/test change, no source behaviour change.

**Change:**
1. Bring over `40913ec` from `origin/pi/luna-ux-01-cycle31`: seven `### Fixed` entries under
   `## [Unreleased]`, one per user-visible change, each naming the smoke that truly pins it.
2. Correct the `/remote` entry's pin: only `smoke:tui-layout` fails on the base bug;
   `smoke:remote-control` only exercises the panel (ASCII fixture).
3. `tests/tui-layout-smoke.ts`: restore the pairing QR fixture to `size = 25` with both long
   addresses (the original 25-row fixture had short addresses, so this is stricter).
4. No source, script, profile or control-path change.

**Checks that prove it:**
- `npm run smoke:tui-layout` (25-row fixture, CJK wrap, all four surfaces).
- `npm run smoke:docs` (documentation and journal gate).
- `npm run smoke:remote-control`, `smoke:status-bar`, `smoke:workflow-panel`,
  `smoke:control-center` (the surfaces named in the entries).
- `npm run test:typecheck`, `npm run test:lint`, `npm run verify`.
- Do **not** run `npm test` or `npm run check:all`; the host gate owns the full suite.
- Diff size: `git diff --no-renames 88572f57c2ed..HEAD -- . ":(exclude)package-lock.json"
  ":(exclude)autonomy/cycles/luna-ux-01/" ":(exclude)autonomy/runs/luna-ux-01/" | wc -c`
  must stay well under 30000.

**Acceptance:** every listed change has an accurate Unreleased entry; the QR fixture is 25 rows;
the targeted smokes and checks pass; the independent reviewer passes the diff; no source
behaviour changes beyond the fixture.

**Out of scope:** the run-card input-hold proposal; rewriting published history; pre-range ux
changes and non-TUI user-visible changes the board did not list.

## Goal and task graph

Goal: the Unreleased section records every user-visible ux change from the board's merged range,
the pairing QR fixture is back at 25 rows, and the targeted checks are green.
Tasks: implement (CHANGELOG + fixture, correcting the remote pin), independent review, verify,
record.
