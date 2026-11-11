# Cycle 13 — Review (run `luna-ux-01`, stream `ux`)

Base `7647d1b2f347` (head of `stream/ux`). Read: `autonomy/CHARTER.md`, the cycle 12 report,
verify and HANDOFF on `origin/attempts/luna-ux-01/cycle-12`, this run's open proposals, and
`git log --oneline 7647d1b2f347..HEAD`.

## Priority 0 — the rejected cycle 12 red gate

Cycle 12 was not merged because the host acceptance run was red:
`check-all` failed on `check-all:smoke:firewall-workflow-approvals` (exit 1). Reproduced in a
clean worktree of `origin/attempts/luna-ux-01/cycle-12`:

```text
node tests/firewall-workflow-approvals-smoke.ts
ok - broker: 2 outstanding per run, groups by hash, sticky denials, no high grants, pause after 10 distinct
AssertionError [ERR_ASSERTION]: two prompts at most are open for one run
1 !== 2
    at tests/firewall-workflow-approvals-smoke.ts:140:10
```

Root cause: the cycle 12 V-02 fix wrapped every human-console card in the shared input-owner
hold (`packages/extensions/src/human-console/index.ts`, `processRunApproval`). Workflow-run
approval cards are the exception the run broker was built for: `RUN_OUTSTANDING_MAX = 2`
(`packages/extensions/src/human-console/run-broker.ts:39`) deliberately keeps two prompts open
for one run, and the smoke pins that contract at `tests/firewall-workflow-approvals-smoke.ts:140`.
A global hold makes the broker's second slot unreachable. In the same worktree the parallel
`wf-e`/`wf-f` pause-question case then timed out because two runs waited on each other's holds.

The rest of cycle 12 is sound and was verified on its attempt branch: the cycle 11 docs/journal
repair, the overlay-frame and `/kit` menu fixes, the non-run console hold, and the `ask_human`
hold. None of that is re-opened.

## Priority 2 — board item PG-09 (`pi-autonomy inbox`)

PG-09 asks for a new `pi-autonomy inbox` card list with deadlines and default decisions, plus
`tests/autonomy-inbox-smoke.ts`. There is no inbox command today: `packages/autonomy/cli.ts:1-15`
lists the command surface, and `grep -n inbox packages/autonomy/cli.ts` finds only the unrelated
control-inbox delivery field at `:574`. The evidence paths named by the assignment
(`docs/2026-11-11-completion-plan.md`, `luna-steward/state/notes.md`) are not in the repository.

Not started this cycle. Cherry-picking the reviewed cycle 11/12 work already puts the branch diff
at **44289 characters**, over the cycle rule's 30000 stop-new-items line (and under the 60000
merge-review budget). Adding a new subsystem and its smoke would risk pushing the diff past the
merge budget, so the item is recorded as blocked by that budget rather than half-built.

## Mode

**Fix mode**: priority 0 red gate first, then consolidate the previous cycle's reject.
