# Cycle 15 verification — run `luna-ops-01` (stream `ops`)

Order: (a) targeted smokes for each changed file, (b) independent reviewer on the diff,
(c) re-land verification, (d) flake check, (e) failures fixed/reverted.

## (a) Targeted smokes (all run as `npm run -s <check>` on the branch head)

- `test:typecheck` — PASS (exit 0) — every changed TypeScript file compiles strict.
- `test:lint` — PASS (exit 0) — no lint rule broken by the new code.
- `smoke:autonomy` — PASS 32/32 — includes the two new assertions in `tests/autonomy-smoke.ts`
  that a successful publish records `refs/integration/remote` (first publish → `seed`, later
  publish → `c2`), which fail without the `gitmirror.publish` fix.
- `smoke:autonomy-cli` — PASS 21/21 — the four PG-56 checks plus the new "a publish recovery
  clears a stale failure reason" check: after a `publish failed` line then a newer
  `publish recovered` line, `status` drops the reason and `inbox` drops "waiting on operator".
- `smoke:install-marker` — PASS — the installer `--scope`/`--help` carry-over.
- `smoke:firewall-gate` — PASS 20/20 — the merge keeps `assertSubQuadratic` **and**
  `assertCpuWithin` at every call site.
- `smoke:redaction-corpus` — PASS 6/6 (repeat; see (d)).
- `smoke:docs` — PASS — "14 documented commands validated, 62 relative links resolved"; the new
  `docs/autonomy.md` and `docs/INSTALL.md` claims resolve.

## (b) Independent reviewer

- Reviewer subagent on `git diff 2e3155fb135c..HEAD` plus `git show 9b751ee`: **PASS**. It
  confirmed the merge is faithful to both parents (`git diff 5a888fe 9b751ee` adds only branch
  `luna-ops-01` work; `git diff 2e3155f 9b751ee` adds only upstream `luna-core-01` work), the two
  conflicted test files keep both guards, the re-land branch is code-identical to the run head for
  non-record paths, PG-56 and both fixes are correct with fail-without-the-change tests, and no
  check or guard is weakened; `autonomy/CHARTER.md`, operator control paths and `package.json`
  scripts are untouched by the authored commits. No critical or warning defects.

## (c) Re-land verification (unblocks the publish)

- `git branch reland/cycle15 origin/stream/ops`; `git merge refs/upstream/trunk`; the same two
  conflicts resolved with `9b751ee`'s reviewed copies.
- `git diff --quiet reland/cycle15 HEAD -- . ':(exclude)autonomy/cycles/' ':(exclude)autonomy/runs/'`
  — exit 0: the re-land code tree equals the run head.
- `node packages/core/prepush-scan.ts range origin/stream/ops..HEAD` — **"37 commit(s) checked, no
  blocked identifiers or private paths"**. Before the re-land the same range was refused:
  "37 finding(s) in 61 commit(s)".

## (d) Flake

- `smoke:redaction-corpus` failed once (exit 1, under concurrent load) and passed 6/6 on four
  consecutive runs. The failing check is the load-sensitive sub-quadratic growth + CPU-time budget
  (check 4), already recorded in `autonomy/proposals/luna-ops-01-08-flaky-resume-checkout.md`. No
  file changed by this cycle touches redaction.

## (e) Failures fixed / reverted

- None. No check was disabled or weakened; no revert was needed. The one red
  (`smoke:redaction-corpus`) is the known flake above and is green on rerun.
