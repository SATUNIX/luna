# HANDOFF — run luna-fleet-01 (stream `fleet`)

- Current cycle: `autonomy/cycles/luna-fleet-01/01/` — review, plan, verify and report written;
  branch `pi/luna-fleet-01`, commits `b8c477f..47c8558`. Merge only after the host gate and review.
- Cycle 01 is an **improve** cycle on the O-01 remainder: it exposed the owner inbox through the
  pi extension. `ee2860b` adds `/autonomy inbox` (no argument lists the fleet's waiting runs;
  `--run <id>` with `--file`, `--answer`, `--value`), plus USAGE, completion, extension README,
  `docs/autonomy.md` and generated `docs/reference.md`. `e85aef2` fixes a real defect in that
  change: `--value` is forwarded as one `--value=<text>` argument, because the CLI rejects a
  space-separated value starting with `--` (`--value needs a value`), so "Keep the --local branch"
  was unanswerable. `923f4f0` adds the reviewer-required `--file` and unknown-flag tests and
  corrects the docs citation; `47c8558` scopes settlement to a run's cards, not the fleet view.
  Pinned by `node tests/autonomy-command-smoke.ts` (14 checks; fails on `af7ad8915d5c`).
- Reviewable diff `af7ad8915d5c..HEAD` excluding lockfile and cycle/run records: 11,338 chars —
  under both the 30,000 new-item stop and the 60,000 review cap.
- **Next cycle, in order:**
  1. **O-01 remainder** (P0, still progress, not done): PG-06 host event log, PG-07 live
     `/autonomy` widget, PG-08 web console panel, the rest of PG-09 (creating cards from pi; today
     `--file` writes them), then the recorded non-Claude walkthrough. None of the four surfaces
     exists in the tree.
  2. **A-92a** (dispatch template): complete but unmerged on
     `origin/attempts/luna-fleet-01/cycle-09` (`fbd20c6`..`56d9503`), 56,430-char reviewable diff.
     Give it its own cycle and re-verify (`tests/autonomy-dispatch-smoke.ts`).
  3. Re-adopt a dispatch item already assigned to its run on resume; replace the fixed 300 ms
     lock-contention window with a child-ready signal.
  4. Cycle-03 PG-42 work is sound on `origin/attempts/luna-fleet-01/cycle-03` (`8a3771f`,
     `a397bcc`, `85194b8`); rebase it as its own cycle.
- Cycle-11 reviewer warnings left open: `oneLine` is duplicated in `store.ts` and the extension
  `index.ts` (extension is deliberately self-contained); a malformed blocked row can render the
  literal `undefined` as its run id in the footer.
- Cycle-01 reviewer note: `--answer` card ids beginning with `--` are rejected by the CLI's
  space-separated form; not reachable with real `D<n>` card ids, so left as-is.
- Carried proposal `autonomy/proposals/luna-fleet-01-04-autonomy-control-ids.md`: `/workflows`
  control completions still offer autonomy ids `workflow_control` cannot act on.
- Red-gate note: `check-all:smoke:workflow-resume` reported by cycle 09 did not reproduce in
  cycles 10–11. `smoke:env-isolation`, `smoke:redaction-corpus` and `smoke:firewall-gate` failures
  are DE-93's budget issue.
