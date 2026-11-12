# HANDOFF — run luna-fleet-01 (stream `fleet`)

- Current cycle: `autonomy/cycles/luna-fleet-01/11/` — review, plan, verify and report written;
  branch `pi/luna-fleet-01`. Merge only after the host gate and review.
- Cycle 11 is a **fix** cycle: it carried the three sound code commits from the rejected cycle-10
  attempt and repaired both named defects. `0228b7c` fixed the red eval gate; `b9dcd07` replaced
  an unanchored `toolText` regex with exact parsed equality. The O-01 fleet slice
  (`bd3df4c`, `5bbaa6e`) now answers what is running, its step, spend/budget and blocker from
  `pi-autonomy status` and the no-run `/autonomy` footer; `05c6300` restored the README paragraph
  the cycle-10 bad edit had corrupted; `8f37da4` documents the unusable-status clear. Pinned by
  `node tests/autonomy-cli-smoke.ts` (16), `node tests/autonomy-command-smoke.ts` (12) and
  `node tests/eval-footprint-smoke.ts` (13).
- Reviewable diff `2c6b0737a66c..HEAD` excluding lockfile and cycle/run records: about 22k chars —
  under both the 30,000 new-item stop and the 60,000 review cap.
- **Next cycle, in order:**
  1. **O-01 remainder** (P0, recorded as progress, not done): PG-06 host event log, PG-07 live
     `/autonomy` widget, PG-08 web console panel, PG-09 owner inbox, then the recorded non-Claude
     walkthrough. None of the four surfaces exists in the tree.
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
- Carried proposal `autonomy/proposals/luna-fleet-01-04-autonomy-control-ids.md`: `/workflows`
  control completions still offer autonomy ids `workflow_control` cannot act on.
- Red-gate note: `check-all:smoke:workflow-resume` reported by cycle 09 did not reproduce in
  cycles 10–11. `smoke:env-isolation`, `smoke:redaction-corpus` and `smoke:firewall-gate` failures
  are DE-93's budget issue.
