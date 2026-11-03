You are working on the repository in /work, on branch `{{BRANCH}}`. This is improvement cycle {{CYCLE}} of {{CYCLES}} of run {{RUN}}. Each cycle is one session that reviews, plans, improves and verifies, and then records what happened so the next cycle can continue.

The branch starts at the head of `{{INTEGRATION}}`, which holds every cycle merged so far. When this cycle ends, it is merged into `{{INTEGRATION}}` only if it has new commits, the acceptance checks pass on a clean checkout, and an independent review against the charter approves the diff. Partial cycles with green checks can also be reviewed and merged; the report must record what remains. Later cycles build on what is merged.

Previous cycle: {{PREVIOUS}}

Budget for this cycle: about ${{BUDGET_USD}} of model spend (firm stop at ${{HARD_BUDGET_USD}}) and {{SOFT_HOURS}} hours (firm stop at {{HARD_HOURS}} hours). Plan work that fits. A small change that is finished and verified beats a large one that is left half done.

Ground rules (read `autonomy/CHARTER.md` in full; it is the acceptance standard for this work):
- Commit after each logical change, with a message that gives the finding, root cause, fix and verification. Run `git push origin HEAD` after every commit, because only pushed work counts.
- Never leave the branch failing its acceptance checks. A change that cannot be made to pass is fixed or reverted before the cycle ends.
- The merge is refused, before any review, when the cycle changes `autonomy/CHARTER.md`, a path the operator lists as a control path, or the `scripts` of any `package.json`, or when the diff (lockfiles excluded) is longer than the review reads. Keep each cycle's change small enough to be reviewed whole, and propose control changes in `{{PROPOSALS_PATH}}`.
- There is no network apart from the model{{NETWORK_NOTE}}. Adding dependencies is out of scope unless the objective says so. Reference material you may read is under `/reference/` if present.
- Work through subagents; don't do everything in this one context. Use the `subagent` tool (roles: `scout`, `planner`, `implementer`, `reviewer`) to send scouts out in parallel during review, give each separate change to an implementer, and have a `reviewer` that did not write the change check it before you accept it. Keep this session for coordinating, deciding and recording.

Work precedence: (0) red gate / broken branch, (1) upstream merge conflict, (2) steward board items in order, (3) HANDOFF carry-overs, (4) defects you find, (5) security, (6) tests/docs, (7) cleanup. Own new ideas go into `{{PROPOSALS_PATH}}` as proposals, not into this cycle, unless they block the assigned item.

Choosing the cycle's work. Decide the mode during review and state it in `plan.md`:
- **Fix mode** is the default whenever there is something to fix. That covers a failing check, work carried over in the handoff, a bug, a security gap, untested behaviour, docs that don't match the code, or code that needs cleaning up (dead code, duplication, needless complexity, shown with evidence). Follow the charter's priority order.
- **Improve mode** is for assigned improvements; board items outrank cleanup. Propose your own new improvements at `{{PROPOSALS_PATH}}` for the steward to assign. Make the assigned system more capable, faster, more reliable or easier to use: extend what it can do, remove a limitation the docs admit to, speed up a path you have measured, or smooth a workflow users hit. Every improvement needs evidence of the need (a measured baseline, a documented limitation, a gap you can demonstrate), with tests and docs. Prefer improving what exists over adding new systems.
- **Consolidate after improving.** When the previous merged cycle was in improve mode, start with a fix-and-cleanup pass over what it changed (bugs, edge cases, missing tests, docs drift, leftover complexity) after higher-priority gate, upstream conflict and board work. New code is where the next bugs are, so improvements feed the next round of fixes.
- **Nothing found.** If an honest review finds nothing to fix and no improvement with evidence behind it, don't invent work: cosmetic churn is not an improvement. The review should cover scouts across the codebase and every open backlog item checked against the code. Write the review, record the outcome as `nothing found`, note in `{{HANDOFF_PATH}}` what you checked, push, and end the session.

Phases. Write each artefact under `{{CYCLE_DIR}}/` as you go and commit it:

1. **Review** (`review.md`). Read `autonomy/CHARTER.md`. {{REVIEW_BOOKKEEPING}} Read the previous cycle's `report.md` and `git log {{BASE_REF}}..HEAD --oneline`. Follow the work precedence above. Send scout subagents in parallel to check the candidate backlog items against the actual code (treat audit and roadmap docs as hypotheses) and to look for new problems. Record findings with evidence (file:line, command output).
2. **Plan** (`plan.md`). Choose the items for this cycle. For each item, give its justification against the charter, the change you intend, and the checks that will prove it (tests to add or run, docs to update). Set `/goal` and the task graph from the plan.
3. **Improve**. Implement item by item: an `implementer` subagent makes the change, and then a `reviewer` subagent checks it against the plan and the charter. Add or extend tests for every behaviour you change, and update the docs that describe it. Commit and push after each item.
4. **Verify** (`verify.md`). Run the tests for what you changed, record the results, then finish. Do not run the whole `npm run check:all` yourself: the host gate runs it on a clean checkout afterwards. Have an independent reviewer subagent check the cycle's diff (`git diff <cycle start>..HEAD`) against the charter. Record each item's verdict with its evidence. Fix or revert anything that fails.
5. **Record** (`report.md`). Start the report with two lines, `Outcome: successful`, `partial`, `failed` or `nothing found`, and then `Mode: fix` or `Mode: improve`. For each board item worked on, add exactly one line `Board: <ID> done|progress|blocked - <one sentence>`. Then give the items completed with their commits, what was left and why, and anything the next cycle should know. {{RECORD_BOOKKEEPING}} Commit, `git push origin HEAD`, and end the session.

The cycle is complete once `{{CYCLE_DIR}}/report.md` is pushed.
