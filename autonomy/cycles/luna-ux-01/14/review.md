# Cycle 14 — Review (run `luna-ux-01`, stream `ux`)

Base `c97a9e60c923` (head of `stream/ux`). Read: `autonomy/CHARTER.md`, cycle 13's report and
verify, this run's open proposals, `autonomy/runs/luna-ux-01/HANDOFF.md`, and
`git log --oneline c97a9e60c923..HEAD` (empty: the branch starts at the merged stream head).
The cycle diff budget is therefore fresh, unlike cycle 13.

## Priority 0 — gate

No red gate is carried over: cycle 13 was merged with green acceptance and its repair
(`028c9ec`) is in this base. `git status` is clean and `git diff c97a9e60c923..HEAD` is empty.

## Priority 2 — board item PG-09: owner inbox

The board asks for `pi-autonomy inbox`: a card list (question, recommended default, deadline,
recorded outcome); a past-due card records its default and work continues; an unanswered
non-expired card leaves its board item `blocked`; and a new `tests/autonomy-inbox-smoke.ts`.

Evidence against the code:

- No inbox command exists. `packages/autonomy/cli.ts:352-684` lists every command; `inbox` is not
  among them. `packages/autonomy/cli.ts:704-716` (USAGE) and the header at `:1-15` have no inbox
  row. A repository grep for `inbox` finds only the unrelated control-inbox delivery of
  `backlog` (`cli.ts:574`) and `RunStore`'s pending-control API (`lib/store.ts:102-135`).
- The owner requests have no structured home. `lib/board.ts:5-15` records id/title/priority/
  acceptance/status only; there is no question, default, deadline or outcome field anywhere in
  `packages/autonomy` (no decision-record file; `lib/cycle.ts:90-97` is the manager's decisions,
  unrelated). The evidence paths named by the assignment
  (`docs/2026-11-11-completion-plan.md`, `luna-steward/state/notes.md`) are still absent from the
  repository, as cycle 13's review recorded.
- The board `blocked` status is the stall mechanism: `lib/board.ts:66-83` only shows non-blocked
  items, so a blocked item waits until a person rewrites `board.json`. Nothing expires it.

The change fits the existing architecture: `board` (`cli.ts:552-563`) already validates and
atomically writes host-owned JSON in `control/` at mode 0600, and `writeJsonAtomic`
(`lib/fsutil.ts:23`) is the established writer. The inbox will be a second control file,
`control/inbox.json`, with cards that name their board item; settling a card rewrites that item
from `blocked` to `ready` and records the outcome on the card. No run state is touched and the
command grants no authority beyond recording, as the board item requires.

## Test wiring

`packages/core/lib/wiring.ts:94-136` fails `check-all` on a new suite that no script names, and
`packages/autonomy/lib/review.ts:160-187` explicitly permits the root `package.json` to gain a
new script when it is exactly `smoke:<name>: node tests/<name>-smoke.ts`. So the new
`tests/autonomy-inbox-smoke.ts` is paired with `"smoke:autonomy-inbox"`; no existing script is
changed. This is the control-path exception the repository itself pins
(`tests/autonomy-review-inputs-smoke.ts:373-385`), not a bypass.

## Mode

**Improve mode**: the assigned board item is a capability improvement with evidenced need.
