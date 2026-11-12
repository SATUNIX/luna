# Cycle 14 — Plan (run `luna-ux-01`, stream `ux`)

Mode: improve. One assigned item.

## PG-09 — `pi-autonomy inbox`: owner cards that expire into a default

**Justification (charter 1, 2, 3, 4, 5).** A `blocked` board item (`lib/board.ts:66-83`) only
waits for a person to rewrite `board.json`; there is no question, deadline or recorded decision
anywhere (`lib/board.ts:5-15`, `cli.ts:552-563`). The improvement gives the steward a card list
and makes a past-due card settle into its recommended default, so work continues.

**Change.**

1. New `packages/autonomy/lib/inbox.ts`: validated card record
   `{ id, question, default, deadline, board?, answer?, outcome? }`; `readInbox`,
   `readInboxFile`, `writeInbox`, `settleInbox(inbox, now)` and `applyOutcomes(board, inbox)`.
   Bounds and unknown-key rejection follow `lib/board.ts`. Missing file means an empty inbox.
   An outcome is `{ at, via: "answer" | "deadline", text }`.
2. `packages/autonomy/cli.ts`: new `inbox --run <id> [--file <path.json> | --json |
   --answer <card-id> --value <text>]` command, USAGE row and header row. It is self-improve only,
   like `board`. Every invocation settles cards whose deadline has passed (recording the default,
   `via: "deadline"`) and unblocks the card's board item (`blocked` → `ready`); `--answer` records
   the owner's text with `via: "answer"`. Settling is idempotent: a card with an outcome is never
   rewritten. No state or control message is touched; the command only records.
3. `package.json`: add exactly `"smoke:autonomy-inbox": "node tests/autonomy-inbox-smoke.ts"`,
   the root-only new-smoke exception pinned at `lib/review.ts:160-187`. No existing script changes.
4. New `tests/autonomy-inbox-smoke.ts`: create a self-improve run through `tests/autonomy-harness.ts`,
   write a board with three blocked items and an inbox with three cards — one answered before its
   deadline, one past due, one unanswered and not due. Assert the answered and past-due cards
   record their outcomes and unblock their items, the open card leaves its item `blocked`, the
   default is the past-due card's text, a second run changes no `at` (idempotent), and invalid
   cards/unknown ids/empty answers are refused.
5. Docs: `docs/autonomy.md` command block and a card-format section (including the settle rule
   and test citation), `packages/autonomy/README.md` role/suite tables, `CHANGELOG.md` under
   Unreleased → Added.

**Checks.** `node tests/autonomy-inbox-smoke.ts`, `npm run smoke:autonomy-cli`,
`npm run smoke:autonomy-selfimprove`, `npm run smoke:autonomy-review-inputs`, `npm run
smoke:wiring`, `npm run smoke:docs`, `npm run test:typecheck`, `npm run test:lint`. The host gate
owns the full suite; never run `npm test` or `npm run check:all`.

**Risks.** `--json` listing settles expired cards, which is intentional ("nothing waits"); docs
must say so. Board writes must be atomic and mode 0600 like `board`.
