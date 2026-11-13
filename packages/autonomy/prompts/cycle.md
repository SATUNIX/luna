You are working on the repository in /work, on branch `{{BRANCH}}`: cycle {{CYCLE}} of {{CYCLES}} of run {{RUN}}.{{STREAM}}

The branch starts at the head of `{{INTEGRATION}}` (`{{START}}`, the cycle start), which holds every cycle merged so far (`git log --oneline {{START}}..HEAD` shows this cycle's work). Your cycle is merged into it only if it has new commits, the acceptance checks pass on a clean checkout, and the host's review of the diff approves. A partial cycle with green checks can merge too; say in the report what remains.

Previous cycle: {{PREVIOUS}}

Budget: about ${{BUDGET_USD}} of model spend (firm stop at ${{HARD_BUDGET_USD}}) and {{SOFT_HOURS}} hours (firm stop at {{HARD_HOURS}} hours). A small change that is finished and verified beats a large one left half done.{{BOARD}}

Do the work directly. Read `autonomy/CHARTER.md` (it is the acceptance standard for this work.{{CHARTER_NOTE}}). {{REVIEW_BOOKKEEPING}} Look at the code the work touches, choose the smallest complete change, make it, add or extend a test for each behaviour you change, and update the docs that describe it. Treat audit and roadmap documents as hypotheses to check against the code.

Work precedence: {{PRECEDENCE}}.{{OWN_IDEAS}}

Delegate only when it pays for itself: one isolated question, or one independent package of work, sent to a single `subagent`. Do not start scouts, a planner, a reviewer for each item or a reviewer for the whole diff: the host reviews the finished diff once, and a child costs what you do. Children share this cycle's budget and your permissions; a refused tool call is not a reason to reach the same thing another way.

Rules:
- Commit after each logical change, with a message that gives the finding, root cause, fix and verification, and `git push origin HEAD` after every commit: only pushed work counts. Never leave the branch failing its checks; fix or revert.
- Never run `npm test` or `npm run check:all`: the host runs the full suite on a clean checkout after the cycle (about four minutes on the host's reference machine, so waiting on it is wasted spend). Put this rule in every subagent task you send. {{VERIFY_PLAN}}
- The merge is refused, before any review, when the cycle changes `autonomy/CHARTER.md`, a path the operator lists as a control path, the `scripts` of any `package.json`, or a file that sets permissions, budgets, credentials, gate policy or release (the owner decides those: propose the change in `{{PROPOSALS_PATH}}`), and when the diff is too long to review. The review reads at most {{DIFF_BUDGET}} characters of `git diff {{START}}..HEAD` (lockfiles and the record files under {{RECORD_DIRS}} not counted) and never a clipped diff. Measure it after every commit with `{{DIFF_MEASURE}}` and stop taking new items once it passes {{HALF_DIFF_BUDGET}}. Prefer coherent slices.
- The host classifies the risk of the cycle from the paths it changed, not from the report. Recovery, concurrency, persistence, shared-interface and authorisation code gets one specialist question inside the same single review, so say in the commit message what keeps those paths safe.
- There is no network apart from the model{{NETWORK_NOTE}}. Adding dependencies is out of scope unless the objective says so. Reference material may be under `/reference/`.
- Do not search for unrelated work. If nothing is assigned, nothing is failing and {{HANDOFF_PATH}} carries nothing over, do not scout and do not invent work: cosmetic churn is not an improvement. Record `Outcome: nothing found`, push, and stop.

When the work is done, write `{{CYCLE_DIR}}/report.md` and keep it under {{REPORT_LIMIT}} characters with no pasted logs (the review sees the first and last {{REPORT_HALF}} characters). It starts with two lines: `Outcome: successful`, `partial`, `failed` or `nothing found`, then `Mode: fix` (the default: something to fix) or `Mode: improve` (it {{IMPROVE_MODE}} more capable, faster, more reliable or easier to use, and needs evidence of the need).{{BOARD_RECORD}} Then, for each commit of the cycle that changes more than records, one line `Item: <title> - <commit shas> - <test that proves it>`; the host adds commit lists and stats. Then one short note: what you decided, what remains and why, and the justification for any changed test.

If anything must carry over to the next cycle: {{RECORD_BOOKKEEPING}} If the repository has `autonomy/JOURNAL.md`, give this cycle its line there after writing `report.md`: run `node packages/core/journal.ts`, which derives the line from the report, or, where that script does not exist, add one line in the format of the lines already there: `- {{RUN}}/{{NN}} | Board: <the IDs the report names, or none> | <the Outcome, as written in the report> | <one-line summary>`. The docs check fails a report with no journal line. Commit, `git push origin HEAD`, and stop: submitting the head and the note ends your session.
