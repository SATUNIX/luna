# Cycle 04 — Plan (run luna-ops-01, stream `ops`)

Mode: **fix** (branch red), then the assigned board item. Review: `review.md`.

## Item A (priority 0, repair): restore the red `smoke:docs` gate

- **Justification**: charter priority 0 (red gate). `verify (1)` on the integration candidate is
  red because `smoke:docs` fails on the journal; measured on this base in `review.md`.
- **Change**: add one line to `autonomy/JOURNAL.md`:
  `- luna-ux-01/01 | Board: none | successful | <summary of F-1 and F-2>`. No other file changes.
  The in-repo check is left intact; only the missing record is added.
- **Checks**: `npm run -s smoke:docs` (must pass; it exercised `checkJournal`). `npm run -s docs:check`
  already passes and must stay passing.
- **Board line**: none (repair, not a board item), per the prompt.

## Item B (V-41 [P2]): inventory `/workflow` and `/workflows`

- **Justification**: board item, one obvious way (s1 rank 5). The `3c4c571` unification already
  landed, so the remaining work is recording the shipped behaviour and every caller, per the item's
  corrected acceptance.
- **Change**: add exactly one new file `autonomy/proposals/V-04-unify-workflows.md` (the path the
  item's acceptance names). It records, from a `git grep` the implementer runs itself:
  - the shipped behaviour (one handler in `workflow-tools.ts`, both command names, subcommands
    `list` / `panel [id]` / `status <id>`, a bare run id is not a panel open), with the test that
    pins it (`tests/run-query-smoke.ts:268-291`, `docs/reference.md:67-68`);
  - every remaining `/workflow` or `/workflows` caller with an action for each: **change**, **keep**
    (alias or history) or **regenerate** with `npm run catalog`;
  - a statement that the pre-2026-11-11 design (bare `/workflows` or a run id opening the panel,
    exported `runWorkflowCommand`) was superseded by `3c4c571` and must not be re-proposed;
  - the doc sweep as the follow-up, naming `docs/workflows.md:16-24`, `docs/script-workflows.md`
    (183, 387), `docs/agent-orchestration.md:164`, `docs/architecture/workflows-and-skills.md` (5,
    76), `docs/architecture/subagents-and-orchestration.md:244`,
    `packages/extensions/third_party/subagent/control.ts:142`,
    `packages/extensions/src/effort/strategy.ts:66`, `subagent/SOURCE.md:130`,
    `THIRD_PARTY_NOTICES.md:374`.
- No code or doc under `docs/` or `packages/` changes in this item.
- **Checks**: `npm run -s docs:check` and `npm run -s smoke:docs` (the new proposal is a record file,
  not a docs page) plus `git status` showing exactly the one new file for the item.

## Checks not run

`npm test` and `npm run check:all` are forbidden (10+ min each; the host gate runs them on a clean
checkout). Only the targeted scripts above are run.

## Out of scope (proposed/noted, not this cycle)

- The doc sweep itself (explicit follow-up in the proposal).
- The durable journal-merge fix (outside this repository; noted in `review.md`).
