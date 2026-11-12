# Cycle 12 plan — run `luna-ops-01` (ops stream)

Mode: **fix**. Base `e3c7fc9d6a94`; budget ~$5 / 3 h. Small, finished, verified.

## Goal

Make the run publish: unblock the `stream/ops` fast-forward that the leak scan has refused since
cycle 09, then land the sound cycle-11 installer fix and record the cycle.

## Item 1 — PG-60: publish the stuck cycles via a clean re-land (operator steering)

Justification (charter priority 0, red/broken pushed state): 20+ reviewed commits could not reach
the trunk; the operator reports CI minutes and six hand-written journal repairs as the cost.
Change: `git rebase --onto ba62ea1 4431288 pi/luna-ops-01` — replay the first-parent cycle-09/10
commits on the published `ba62ea1`, dropping the `-s ours` merge whose second parent carries the
pre-rename commits. Verify the tree is byte-identical and the scan over `ba62ea1..HEAD` is clean,
then fast-forward `stream/ops` (no force-push). Record the stranded commit (`3c7c8ae`).
No repository file changes from this item; it is an ops action.

## Item 2 — Installer bad `--profile` (cycle-11 carry-over)

Cherry-pick `7e3caad` onto the clean lineage. Justification (charter 1, 2, 4): user-error stack
trace in the first command `AGENTS.md` tells users to run; the test reds on the base. Already
independently reviewed in cycle 11 (PASS); cycle 11's red gate was the unrelated timing flake
confirmed green here.

Docs: none beyond the error text (the interface already lists profiles).

## Item 3 — PG-20 / PG-53 board state

PG-20: confirmed met, no code. PG-53: blocked on operator container config; no control changed.

## Checks

- `npm run test:typecheck`, `npm run test:lint`.
- `npm run -s smoke:profile-transaction` (owns the changed test).
- `npm run -s smoke:docs`, `npm run -s smoke:redaction-corpus`, `journal --check`,
  `reference.ts --check`.
- `node packages/core/prepush-scan.ts range ba62ea1..HEAD` (publish rehearsal).
- Do **not** run `npm test` or `npm run check:all`.
- One independent `reviewer` subagent over `git diff e3c7fc9d6a94..HEAD`.

## Diff budget

Stop taking new items once the measured diff passes 30,000 characters; this cycle is far below it.
