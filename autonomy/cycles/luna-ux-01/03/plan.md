# Cycle 03 — Plan (run luna-ux-01, stream `ux`)

Goal: land the carried, independently reviewed overlay-readability change (V-01) on a green branch,
confirm the acceptance failure that rejected cycle 02 was not caused by it, and hand V-03 to cycle 04.

Mode: **fix** (re-land carried work; no new improvement).

## Item 1 — V-01 re-land (P1, board item 1)

Justification (charter 1, 2, 3): cycle 02 shipped and tested the change but was rejected on a red
acceptance run. The code is unchanged from the reviewed `72d1f4c`/`404b13a`; the scout confirmed the
two copies are byte-identical, the logic restores the transcript on `done`/`dispose`, and the
targeted smokes pass. Re-landing it is the smallest finished, verifiable unit.

Change: cherry-pick `72d1f4c` (frame + dim implementation and the two smoke additions) and
`404b13a` (doc sentence naming the smokes) from `origin/attempts/luna-ux-01/cycle-02` onto this
branch. No code edits: if a cherry-pick does not apply cleanly, stop and re-evaluate rather than
rewriting reviewed code.

Checks (targeted only; never `npm test` or `npm run check:all`):

- `npm run smoke:control-center` (28 checks) and `npm run smoke:workflow-panel` (14 checks).
- `npm run test:typecheck`, `npm run test:lint`.
- `cmp` the two `overlay-frame.ts` copies.
- Confirm the diff touches no `packages/web-ui/`, no `package.json` `scripts`, no lockfile, no
  `tool-firewall/`.

Independent review: a `reviewer` subagent that did not write the change, on
`git diff 876471a5bdbe..HEAD`, against the charter and this plan, ending PASS only if correct.

## Item 2 — V-03 (P1, board item 2) — not taken this cycle

Justification for deferral: the re-landed V-01 diff alone measures 31267 characters (lockfile and
records excluded), past the cycle's 30000-character "stop taking new items" threshold, so starting
V-03 would break the review budget rule. V-03's plan is fully written in
`autonomy/cycles/luna-ux-01/02/plan.md` and validated in `02/review.md`; it starts cycle 04.

## Provenance of the recorded acceptance failure

Cycle 02's red run named `check-all` and `check-all:smoke:web-console`. The carried diff touches no
web-console code, and the smoke passes both standalone and from the branch worktree; two concurrent
runs fail on the shared `packages/web-ui/.runtime/console.token`. This is recorded as a proposal in
`autonomy/proposals/luna-ux-01-03-web-console-smoke-shared-runtime.md` for the owner of that test; it
is outside the UX stream.

## Checks that prove the cycle

- Targeted smokes for every changed file (Item 1).
- `npm run test:typecheck`, `npm run test:lint`.
- Independent `reviewer` on `git diff 876471a5bdbe..HEAD` against `autonomy/CHARTER.md`.
- Never `npm test` or `npm run check:all`; the host gate runs the full suite on a clean checkout.

## Workflow plan (item 1)

`workflow_run {steps}`: `implementer` cherry-picks the two commits, runs the four targeted checks and
commits/pushes; then a gated `reviewer` (did not write the change) reviews against this plan and the
charter, `max_loops` 1. Fallback if refused: `subagent` implementer then reviewer, plus a
`Workflow: refused <reason>` line in `report.md`.

## Out of scope (recorded, not taken)

- Idle-cat blink intent (`autonomy/proposals/luna-ux-01-01-idle-cat-blink.md`) and human-console
  multi-card focus theft (`luna-ux-01-01-human-console-multi-card-focus-theft.md`).
- The ≤3-character hidden-command reveal gap; V-03 removes it.
- Any change under `tool-firewall/` or to `package.json` `scripts`.
