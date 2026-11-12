# Cycle 12 review — run `luna-ops-01` (ops stream)

Base for the cycle: `e3c7fc9d6a94` (the harness's stream/ops head). The published
`origin/stream/ops` was in fact `ba62ea1` (cycle 09), and `origin/pi/luna-ops-01` was `e3c7fc9`
(cycle 10); the two differ, which is the whole of PG-60.

## PG-60 (operator steering, P0) — the run could not publish

Evidence, commands run in `/work`:

- `git ls-remote origin`: `refs/heads/stream/ops = ba62ea1269e5`, `refs/heads/pi/luna-ops-01 =
  e3c7fc9d6a94`. `git rev-list --left-right --count origin/stream/ops...HEAD` → `0  25`: HEAD is 25
  commits ahead of the published stream branch, so the merge the operator reports is stuck.
- `git push --dry-run origin HEAD` → **passes**, `0 commit(s) checked, no blocked identifiers`
  (the run branch is already at `e3c7fc9`). So the *run branch* was published; it is the
  **stream/ops promotion** that is refused.
- `git push --dry-run origin HEAD:refs/heads/stream/ops` → **refused**: `37 finding(s) in 25
  commit(s)`. The hook reports old-shape board IDs (`packages/core/lib/leak-scan.ts:54`,
  `\b[RPMD]-\d{1,2}\b`) in commit messages and in the cycle-08 record files. This matches
  supervisor.log:139 (`publication blocked by pre-push leak scan: 3c7c8aede6c2 message line 1`).
- Root cause: `4431288` is `git merge -s ours 6f4a7f3` with first parent `ba62ea1` (its tree equals
  `ba62ea1`) and second parent the pre-rename `6f4a7f3` lineage. The merge's second-parent ancestry
  (`3c7c8ae`, `22fdf7f`, `f1da979`, `c3a1ecb`, `a482425`, …) is what the scan sees. The clean
  cycle-08 content already exists on `ba62ea1` as the re-landed `PG-20` commits; only the ancestry
  is polluted.

Fix (per operator step 3, "re-land the content as new commits off the published base, do not
force-push"): rebase the first-parent chain `4d795fe..e3c7fc9` onto the published `ba62ea1`,
dropping the empty `-s ours` join. The tree is byte-identical (`git diff --stat e3c7fc9 <clean>` is
empty), the scan over `ba62ea1..<clean>` is clean (7 commits), and `stream/ops` fast-forwards
`ba62ea1..fbd5dbd`. `pi/luna-ops-01`'s remote ref is left stranded (`e3c7fc9`); the harness `setref`
re-points it next cycle. The stranded old-shape commit is `3c7c8ae` (its message line 1 is an old-shape board ID).

## Cycle 11 carry-over — installer bad `--profile`

`origin/attempts/luna-ops-01/cycle-11` (`7e3caad`) fixes `node packages/core/install.ts --profile
bogus --dry-run` throwing a raw stack trace from `loadProfile` (`install.ts:416`) and exiting 1.
Cycle 11's acceptance was red on `check-all` / `check-all:smoke:redaction-corpus`, unrelated to the
installer. Re-checked here: `smoke:redaction-corpus` and `smoke:docs` both **pass** on this base, so
the red was a timing flake (the sub-quadratic growth check is timing-shaped). The installer fix and
its test are sound and are carried over onto the clean lineage as `af39987`.

## Board items

- **PG-20** (journal line from the report) — already met at the base: `packages/core/journal.ts`
  derives the line, `tests/docs-smoke.ts:491` runs `checkJournal(ROOT)`, the duplicate and
  missing-entry fixtures exist, and `cycle.md:35` names the generator. No code owed.
- **PG-53** (unattended mode refused in this rootless container) — blocked on operator container
  configuration. No change; proposal 09 records the decision.

## New problems / proposals

None new. The redaction-corpus red that rejected cycle 11 is a pre-existing timing flake, already in
proposal `luna-ops-01-08-flaky-resume-checkout.md`'s class; recorded there is appropriate but it was
not edited this cycle.
