# Cycle 04 — Review (run luna-ops-01, stream `ops`)

Base: `43ace850dc29` (head of `stream/ops`, cycle start). Branch: `pi/luna-ops-01`.
Charter read in full (`autonomy/CHARTER.md`). Board items under "Assigned work". Read this run's
proposals and `autonomy/runs/luna-ops-01/HANDOFF.md`, and cycle 03's `report.md`.

## P0 (integrator): CI verify (1) is red on the integration candidate

The steward reports PR #61 (`bdc689ad2659`, `integration/luna` + `stream/ops`) red in `verify (1)`,
failing after one rerun. `verify (1)` is shard 1/4 of `npm run -s check:all` (`.github/workflows/ci.yml:22-51`;
shard 1 is `runs[i % 4 == 0]` over the sorted list, `packages/core/check-all.ts:186`).

Reproduced locally, first shard-1 check that is red:

```
$ npm run -s smoke:docs
AssertionError [ERR_ASSERTION]: autonomy/JOURNAL.md disagrees with the cycle reports
+ [ 'report with no journal entry: luna-ux-01/01; add: - luna-ux-01/01 | Board: none | successful | <summary>' ]
- []
    at file:///work/tests/docs-smoke.ts:491:8
EXIT 1
```

Root cause: commit `43ace85` ("merge integration/luna into stream/ops") brought in
`autonomy/cycles/luna-ux-01/01/report.md` (outcome successful, mode fix) but no matching line in
`autonomy/JOURNAL.md`. `checkJournal` (`packages/core/lib/journal.ts`, pinned by
`tests/docs-smoke.ts:491`) requires one journal line per report. This is the same class of failure
cycle 03 fixed for `luna-core-01/01` (`e7a91c8`): a report merged from another stream must arrive
with its journal line, or the branch is red before the ops stream runs.

Evidence:
- `ls autonomy/cycles/luna-ux-01/` -> `01`; report exists.
- `grep luna-ux autonomy/JOURNAL.md` -> no match.
- `npm run -s smoke:docs` -> EXIT 1 (above). `npm run -s docs:check` -> EXIT 0 (the failure is the
  journal, not the docs pages).

Fix: add the missing journal line for `luna-ux-01/01`, summarising its two items (F-1 status-bar
warning printed twice; F-2 `/footer ascii on` did not reach the todo widget). No code change.

## V-41 [P2] V-04 part 1: inventory `/workflow` and `/workflows` callers

Premise re-checked against the code as the steward asked (docs/audit treated as hypotheses):

- One handler, both names: `packages/extensions/third_party/subagent/workflow-tools.ts:724`
  ("One command for both names"), `:855` registers `workflows`, `:860-861` registers `workflow`
  with `description: "Alias of /workflows. …"`.
- Alias documented: `docs/reference.md:67` (alias) and `:68` (`/workflows`).
- Subcommands and sharing pinned: `tests/run-query-smoke.ts:268-291` asserts both registrations,
  that both list the same runs, that `status <id>` shows a past run, and that `panel` opens the
  live view through the one command. `runWorkflowCommand`, `workflowCommandCompletions` and
  `WORKFLOW_SUBCOMMANDS` are intentionally module-locals; nothing exports them.
- `wf-panel.ts` registers no command (`docs/architecture/workflows-and-skills.md:199`).

Conclusion: the design landed in `3c4c571`; the original pre-2026-11-11 design (bare `/workflows`
or a run id opening the panel, exported `runWorkflowCommand`) is superseded and must not be
re-proposed. The genuinely open work is a documentation sweep of remaining `/workflow` callers,
plus recording the shipped behaviour and every caller. A `git grep` run for this cycle is the
evidence base (the proposal records it).

## Other findings (not taken)

- No upstream merge conflict on this branch.
- The journal-drift failure is now recurring across two cycles (`luna-core-01/01`, then
  `luna-ux-01/01`). The in-repo check is correct and must not be weakened; the durable fix belongs
  in the merge step that brings another stream's report onto the integration branch. Recorded for
  the report/handoff; a proposal is not needed because the merge step is outside this repository.
- Installer doc drift and `npmDeliveryEnabled()` vs `docs/releasing.md` carried from HANDOFF remain
  open but are not assigned; left to a future cycle.

## Mode

**Fix mode**: the branch is red (priority 0). After the P0 repair, the one assigned board item
(V-41) is a docs-only recording task, taken next.
