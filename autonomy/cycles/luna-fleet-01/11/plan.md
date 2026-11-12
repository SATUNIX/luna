# Cycle 11 plan — luna-fleet-01

Mode: **fix** (consolidate the rejected cycle-10 work).

## Item 1 — Carry the three sound cycle-10 code commits

`91a56a6`, `6879700`, `0b6f90a` from `origin/attempts/luna-fleet-01/cycle-10`.

**Why:** priority 0/broken-branch recovery. The base `eval-footprint` check is red on the stale
lite literal, and the O-01 fleet slice was reviewed and only rejected for its docs and one
assertion, so its code is worth keeping.

**Checks:** `node tests/eval-footprint-smoke.ts`, `node tests/autonomy-cli-smoke.ts`,
`node tests/autonomy-command-smoke.ts`, `npm run smoke:docs`, `npm run test:typecheck`, eslint on
changed files.

## Item 2 — Restore the autonomy-run README fleet paragraph

Put back the sentence opening and the `autonomy: 3 runs — ...; blocked: <run> (<question>)` example
deleted by the bad edit; keep the worker-text sanitising and unusable-status notes.

**Why:** the merge review's first rejection; user-facing docs must describe the footer the code
sets (charter rule 3).

**Checks:** `npm run smoke:docs`; manual read of the rendered paragraph.

## Item 3 — Anchor the written-baseline assertion

Replace the unanchored regex with parsed equality on `profiles.lite.toolText`.

**Why:** the merge review's third rejection; a wrong measurement must not pass the suite.

**Checks:** `node tests/eval-footprint-smoke.ts` (13), `npm run test:typecheck`, eslint.

## Not in this cycle

- PG-06 host event log, PG-07 live widget, PG-08 web console panel, PG-09 owner inbox and the
  non-Claude walkthrough: O-01 stays **progress**, not done.
- A-92a dispatch template: needs a cycle of its own; 56k reviewable diff.
- The duplicated `oneLine` helper: the extension is intentionally self-contained; accepted as a
  warning rather than adding a cross-package dependency.

## Done when

The targeted checks pass on the pushed head, the diff stays under the review cap, and an
independent reviewer approves the diff against this plan and `autonomy/CHARTER.md`.
