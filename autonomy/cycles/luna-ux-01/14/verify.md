# Cycle 14 — Verify (run `luna-ux-01`, stream `ux`)

## What was checked

PG-09: the new `pi-autonomy inbox` command and its card-settlement behaviour. Targeted checks only;
`npm test` and `npm run check:all` are left to the host gate.

| Check | Result |
| --- | --- |
| `node tests/autonomy-inbox-smoke.ts` | 5/5 checks pass: answered and past-due cards settle and unblock, an open card leaves its item `blocked`, settling is idempotent, a later answer records the owner's text, bad input is refused without touching the inbox, an oversized answer cannot wedge it, and the command writes no run state |
| `npm run smoke:autonomy-cli` | 16/16 checks pass, including the command table and exit-code contract |
| `npm run smoke:autonomy-selfimprove` | 37/37 checks pass, including the control-path review rules |
| `npm run smoke:autonomy-review-inputs` | 21/21 checks pass; a cycle that adds one test and only its own smoke script still reaches review and merges |
| `npm run smoke:wiring` | OK (8 checks); the repository is fully wired at 217 test files |
| `npm run smoke:docs` | OK: 14 documented commands, 62 links resolved |
| `npm run test:typecheck` | exit 0 |
| `npm run test:lint` | exit 0 |

All checks were re-run after the final test/docs commit `34dfa0e`.

## Behaviour pinned

`tests/autonomy-inbox-smoke.ts` creates a self-improve run, a board with three `blocked` items and
three cards: `D1` answered before its deadline, `D2` past due with the default `Keep the local
branch`, and `D3` still open. It asserts:

- `D1` and `D2` record outcomes (`via: "answer"` and `via: "deadline"`), and both board items move
  `blocked` → `ready`; `D3` leaves `OWN-3` blocked.
- A second read changes no outcome and decides nothing.
- A later `--answer D3 --value "Ship it"` records the owner's text and unblocks `OWN-3`; a second
  answer does not rewrite the recorded outcome.
- An invalid file, an unknown card and a missing value are refused, and the previous inbox file is
  byte-identical after refusal.
- A 2001-character `--value` is refused before any write.
- The human listing includes the linked `board:` id; `--json` returns cards, decided ids and
  unblocked ids.
- `state.json` is unchanged after the command; only `control/inbox.json` and `control/board.json`
  are written (mode 0600).
- A non-self-improve run is refused.

## Independent review

A reviewer subagent that wrote none of the change read the diff against `autonomy/CHARTER.md` and
the acceptance criteria. First verdict: **FAIL** on one real defect — an over-long `--answer
--value` was written, and every later read then rejected the file, wedging the inbox. The fix
(`748202e`) validates the trimmed value before any write and adds the regression case; it also
shows the board id in the text listing, allows a bare `inbox --run <run>` listing, and keeps the
same-file helper return-type narrowing required by the self-scan. The second review returned
**PASS**, with only non-blocking edge warnings (two cards linking one board item; record-only claim
coverage). The record-only assertion and the pre-deadline answer wording were added in `34dfa0e`;
the duplicate-board-link case is documented as per-card behaviour, not changed.

## Scope and budget

- Diff from `c97a9e60c923`: **29,763 characters** (lockfiles and this run's cycle/run record
  directories excluded), under the 30,000 stop-new-items line and the 60,000 merge-review budget.
- One changed control path: the single new root script
  `"smoke:autonomy-inbox": "node tests/autonomy-inbox-smoke.ts"`, which is the pinned new-smoke
  exception (`packages/autonomy/lib/review.ts:160-187`). No existing script changed, and
  `autonomy/CHARTER.md` and operator control paths are untouched.
- No new dependency and no network use.
