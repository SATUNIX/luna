# Run `luna-ops-01` — handoff

## Cycle 07 close (current checkout)

State after cycle 07 on `pi/luna-ops-01`, base `0b8b2c9bceb2`, head before records `69e6e586`:

- Cycle 07: **successful**, mode fix. The merged DE-105/DE-106 work was re-verified; three
  evidenced ops defects were fixed. `5853db1a` gates the installer's global `.env` scaffold to
  `--scope global`, so a project install no longer creates or reports the global `.env` (real and
  dry runs tested). `69e6e586` handles `install.ts --help` before argument validation and validates
  unknown `--skip` names before `check-all --for-changed` plan mode. `docs/INSTALL.md` states the
  global-only `.env` rule.
- Checks at head: `smoke:redaction-corpus` 6/6, `smoke:workflow-policy` 5 checks/48 mutations,
  `smoke:install-marker`, `smoke:check-all-npm`, `test:typecheck`, `test:lint`, `smoke:docs`,
  `docs:check`, `verify` all pass. Never run `npm test` or `npm run check:all` here.
- Diff excluding lockfiles and cycle/run records is 13981 characters, under the 30000 new-item
  budget. No control path or `package.json` script changed; no new proposal needed.
- Remaining: the DE-106 12-minute PR wall-time target is still unmeasured offline; host PR runs are
  the measurement. The coverage-threshold policy question remains in
  `autonomy/proposals/luna-ops-01-06-coverage-threshold-policy.md`.

## Cycle 06 close (historical)

State after cycle 06 on `pi/luna-ops-01`, base `70650a313022`, head `7da244a8`:

- Cycle 06: **successful**, mode fix. (1) **DE-105** verified without code change: check 5 of
  `smoke:redaction-corpus` uses the injected fake clock and passes deterministically; under two busy
  cores 20/20 runs passed. Under four busy cores real-timing check 4 still failed in 5/20 runs;
  check 5 never failed, so the residual is the intentionally real-time check, not the guard.
  (2) **DE-106** `3da123a9` - `coverage` is a 4-shard matrix with `--coverage-out`, raw V8 and eval
  cache uploads that run even on failure, and a measure-only `coverage-merge` that downloads all
  shards with `merge-multiple` and runs `coverage --report`; both stay outside `ci-complete.needs`.
  `coverage.ts` adds the tested splitter and `--coverage-out`/`--report`. The 12-minute PR median
  was **not measured** offline; GitHub-hosted PR runs remain the measurement. No threshold was
  added (none exists after `25f9c40e`); the proposal records the policy question.
  (3) Review fixes `83992142 7da244a8` - `--coverage-out` refuses the checkout, ancestors and
  filesystem roots and clears only `coverage-*.json` (no recursive delete); hidden cache uploads,
  docs and policy tests updated. Independent reviewer returned `VERDICT: PASS` after running
  `smoke:workflow-policy` (48 mutations) and `smoke:check-all-npm` itself.
- Checks at head: `smoke:redaction-corpus` 6/6, `smoke:workflow-policy`, `smoke:check-all-npm`,
  `test:typecheck`, `test:lint`, `smoke:docs`, `docs:check`, `verify`, `smoke:release-workflow`
  all pass. Never run `npm test` or `npm run check:all` here.
- Push state: `origin/pi/luna-ops-01` carries `70650a31..7da244a8` plus the cycle records. Diff
  excluding lockfiles and cycle/run records is 50123 chars, over the 30000 new-item budget, so no
  post-board item was started. Cycle-07+ items remain unstarted.

## Cycle 05 close (historical)

State after cycle 05 on `pi/luna-ops-01` at base `4da2716e9c9f`:

- Cycle 05: **successful**, mode fix. (1) **DE-105** `39c2e6c` - `assertSubQuadratic` takes an
  injected clock defaulting to `performance.now`; redaction check 5 uses a fake clock, so the guard
  test is timing-independent. Proven by 20/20 `smoke:redaction-corpus` runs with four busy cores.
  (2) **DE-106** `f7c7031 72c5af7` - `pi-compat` is a `pi` x `shard` matrix (8 non-advisory
  lanes), with the skip list and `--check-timeout=600` unchanged; workflow policy now requires
  every direct `check:all` job to be sharded, with three new mutations; docs updated. The 12-minute
  PR median was **not measured** offline and is left to the host's PR runs; the coverage-threshold
  half was already superseded by the reviewed measure-only policy.
- Checks at head: `smoke:redaction-corpus` 20/20 under load, `smoke:workflow-policy` 5/5 (31
  mutations), `test:typecheck`, `test:lint`, `smoke:docs`, `docs:check`, `verify`,
  `smoke:pi-host-peers`, `smoke:release-workflow`, `journal --check` all pass. Never run `npm test`
  or `npm run check:all` here.
- Push state: `origin/pi/luna-ops-01` carries the cycle-05 commits and records. This checkout's
  base is `4da2716e9c9f`; the cycle-08..20 text below belongs to a different lineage and its shas
  are not ancestors of this head.

State after cycle 20 (branch `pi/luna-ops-01`; the promotion branch is `pi/luna-ops-01-reland`
at `b859d1e`):

- Cycle 20: **successful**, mode fix.
  (1) **PG-52 consolidation** — cycle 19's copy-pair mapping was completed:
  `packages/core/lib/check-map.ts` now maps both sources of the `subagent/fence.ts` byte-copy pair
  and a changed test file to its own check, unions the table with `scriptTargets` from
  `packages/core/lib/wiring.ts`, and `check-all.ts` announces `checkNames` once only on a real
  `runAll` (no contradictory plan-mode skip line). Run-branch commit `ad74513`; pinned by
  `smoke:autonomy-selfimprove` 41/41, `smoke:check-all-npm`, the four `--for-changed` fixtures in
  `cycles/luna-ops-01/20/verify.md`; independent reviewer PASS. Cycle diff 18154 chars.
  (2) **PG-52 clean re-land** — the publish was blocked because `3c7c8ae` (old-shape subject) sat
  only in the local branch. Per the operator instruction, `pi/luna-ops-01-reland` was advanced by
  fast-forward from `15e5068` to `b859d1e` (cycle-19 `03c5305` + cycle-20 `b859d1e`), messages cite
  only `PG-52`/`PG-60`; `prepush-scan range --base a7cb461 a7cb461..b859d1e` is clean (6 commits).
  The integrator fast-forwards `stream/ops` from `pi/luna-ops-01-reland`, not the run branch.
  (3) No control-path change; no new proposal.

- Cycle 19: **successful**, mode fix.
  (1) **PG-52** — a cycle's verify list is now derived from its changed files. New
  `packages/core/lib/check-map.ts` holds the glob→checks data table plus `checksForChangedPaths` and
  `verifyPlan` (the disjoint run/skipped split); `check-all.ts --for-changed=<a,b>` prints the plan
  as `check-all: run:` / `check-all: skipped:` and runs nothing (`0ce02ec`); the self-improve prompt
  and `cycle.md` require the worker to derive the plan from its diff and record each check RAN or
  SKIPPED in `verify.md`. `docs/ARCHITECTURE.md` and `docs/ci-security.md` updated, pinned by
  `smoke:autonomy-selfimprove` 41/41. Checks: `smoke:autonomy-run` 15/15, `smoke:autonomy` 32/32,
  `smoke:check-all-npm`, `smoke:docs`, `docs:check`, `test:typecheck`, `test:lint`, `verify`;
  independent reviewer PASS on all seven acceptance points. Diff 26080 chars.
  (2) No control-path change and no new proposal: `--for-changed` is opt-in and the default gate
  path is unchanged.
- Cycle 18: **successful**, mode fix.
  (1) **PG-60 sync** — the run branch had silently drifted behind `origin/stream/ops` (`a7cb461f`;
  merge-base `616aa06`) and was deleting `packages/autonomy/lib/unpublished.ts`, the cycle-15
  records, and parts of `packages/autonomy/cli.ts` / `packages/core/install.ts` because cycles 16/17
  were built on the stranded cycle-12 head. Merged `origin/stream/ops` into the run branch
  (`865e670`), resolving the one `HANDOFF.md` conflict; the union restores cycles 08-15 and keeps
  16/17. Checks pass: `smoke:autonomy-cli` 21/21, `smoke:autonomy` 32/32, `smoke:install-marker`,
  `test:typecheck`, `smoke:docs`.
  (2) **PG-60 re-land** — the run branch itself stays non-promotable (`range origin/stream/ops..HEAD`
  refused, 37 findings in 29 commits, first `3c7c8ae` message line 1, from the cycle-12 `-s ours`
  bridge `b2a409a`). A single commit off `a7cb461f` with the run-branch tree was pushed as
  `pi/luna-ops-01-reland`; `range origin/stream/ops..pi/luna-ops-01-reland` is clean
  (1 commit, no findings) and its tree is identical to the run-branch head. The integrator must
  fast-forward `stream/ops` from `pi/luna-ops-01-reland`, not from `pi/luna-ops-01`.
  (3) **PG-63** — no production change; the cycle-17 fixtures still pass
  `smoke:autonomy-review-inputs` 23/23 (257/402-char own diffs against the 60000 budget, 60001-char
  own diff refused).
- Cycle 17: **successful**, mode fix.
  (1) **P0 upstream merge** — `refs/upstream/trunk` (`5a888fe`) was not an ancestor of the
  cycle-12 head `2e3155f` (merge-base `bf6d2bb`). Conflicted in `tests/firewall-gate-smoke.ts`
  and `tests/redaction-corpus-smoke.ts`; both resolved keeping both timing intents
  (`assertSubQuadratic` and `assertCpuWithin`), merged as `bfb0b18`.
  (2) **PG-63** — the board item said a post-sync merge review counts the whole upstream merge
  side and is rejected as too large. It does not reproduce on this head: `upstreamMergeScope`
  plus `readReviewDiff {restrict}` already scope to the cycle's own paths. Two end-to-end
  fixtures were added to `tests/autonomy-review-inputs-smoke.ts` (`0854e8c`): a host-synced
  trunk with a ~108 KB unrelated file judges a **257-char** diff, a conflict-resolving cycle a
  **402-char** diff, both against the **60000** budget, and a 60001-char own diff is still
  refused. No production change was needed.
  (3) **PG-60** — `origin/stream/ops` is now `a7cb461f` and carries the re-landed cycles 08, 09,
  10, 12 and 15, so its missing-08-10 defect is repaired. The run branch was pushed
  (`bfb0b18`, 29 commits checked, no blocked identifiers), but the promotion range is still
  refused (37 findings / 25 commits, first `22fdf7f .../08/review.md:70`) because the branch
  carries the cycle-12 `-s ours` bridge (`b2a409a`).
- All targeted checks pass at head: `test:typecheck`, `smoke:autonomy-review-inputs` 23/23,
  `smoke:autonomy-selfimprove` 40/40, `smoke:firewall-gate` 20/20, `smoke:redaction-corpus`
  6/6, `smoke:web-ui-bind-policy` 23/23, `smoke:docs`, `journal --check`. Never run `npm test` or
  `npm run check:all` here; run the targeted `npm run -s smoke:<name>`.

## Cycle-12 entry (historical)

State after cycle 12 (branch `pi/luna-ops-01`, rebased onto the published `ba62ea1`;
`origin/stream/ops` fast-forwarded to the cycle-12 head):

- Cycle 15: **successful**, mode fix.
  (1) **P0 upstream merge** — `refs/upstream/trunk` (`5a888fe`) was not an ancestor. Re-used the
  reviewed cycle-14 merge `9b751ee` (conflicts `tests/firewall-gate-smoke.ts` and
  `tests/redaction-corpus-smoke.ts` resolved keeping **both** `assertSubQuadratic` and upstream's
  `assertCpuWithin`). No branch work dropped.
  (2) **PG-56** — read-only `status`/`top`/`inbox`/`doctor` view of merged work not yet on the
  remote (`6aabc4d`), plus two review-found defect fixes (`f15a143`): `publish()` now records the
  pushed integration head in `refs/integration/remote`, and a newer `"publish recovered"` log line
  clears a stale failure reason/timestamp.
  (3) Installer `--scope`/`--help` carry-over (`6f5e765`).
- All targeted checks pass at head: `test:typecheck`, `test:lint`, `smoke:autonomy` 32/32,
  `smoke:autonomy-cli` 21/21, `smoke:install-marker`, `smoke:firewall-gate` 20/20,
  `smoke:redaction-corpus` 6/6, `smoke:docs`, `journal --check`. Never run `npm test` or
  `npm run check:all` here; run the targeted `npm run -s smoke:<name>`.

## Push state (cycle 19 close)

## Push state (cycle 20 close)

The run branch `origin/pi/luna-ops-01` carries cycle 20's commit `ad74513` plus the record commits;
it is still **non-promotable** (cycle-12 `-s ours` bridge ancestry). `origin/stream/ops` is still
`a7cb461f`; the worker does not move it. The promotion path is `origin/pi/luna-ops-01-reland`
(`b859d1e`), whose `origin/stream/ops..pi/luna-ops-01-reland` range scan is clean (6 commits); the
integrator fast-forwards `stream/ops` from it. Never push `stream/ops` from the run branch.

The run branch `origin/pi/luna-ops-01` gets cycle 19's commit `0ce02ec` plus the record commits; it
is still **non-promotable** (it carries the cycle-12 `-s ours` bridge ancestry). `origin/stream/ops`
is still `a7cb461f`; the worker does not move it. Cycle 19 also has to be re-landed: build a clean
re-land branch off `origin/stream/ops` as cycles 12/18 did, confirm
`node packages/core/prepush-scan.ts range origin/stream/ops..pi/luna-ops-01-reland` is clean, and
let the integrator fast-forward `stream/ops` from it.

## Push state (cycle 18 close)

`origin/stream/ops` is still `a7cb461f`; the worker does not move it. The promotion path is the new
branch `origin/pi/luna-ops-01-reland`, whose range scan is clean, so the integrator can
fast-forward `stream/ops` from it. The run branch `origin/pi/luna-ops-01` is at `865e670`; its
promotion range is refused and must not be pushed to `stream/ops`. Stranded shas for the operator:
`3c7c8ae`, `a482425`, `c3a1ecb`, `f1da979`, `22fdf7f`, `e3c7fc9`. A stray remote branch `tmp-sync`
(`724b0cb`) was created by an accidental `git push origin HEAD`; the remote refuses deletion.

## Push state (cycle 17 close)

`origin/stream/ops` is published at `616aa06` (clean scan). The run branch `origin/pi/luna-ops-01`
was stranded at `e3c7fc9` (pre-re-land), so a normal push was non-fast-forward. It was bridged with
a `-s ours` merge (`b2a409a`, tree unchanged) and fast-forwarded to the cycle head: no history was
rewritten and no force-push was used. `stream/ops` keeps the clean lineage.
**Caution:** the run branch now carries the stranded `e3c7fc9` ancestry through the bridge, so do
NOT fast-forward `stream/ops` from it. The next cycle must re-land its new commits onto
`origin/stream/ops` (`616aa06`), as cycle 12 did for cycle 09/10, or the leak scan will refuse
again. Check `git ls-remote origin refs/heads/stream/ops` and
`node packages/core/prepush-scan.ts range 616aa06..HEAD` before claiming a publish, and fail loudly
rather than merging when a publish is refused.


At cycle 17 the remote `origin/stream/ops` had advanced to `a7cb461f` (the relaunch re-land,
carrying cycles 08–15). The run branch was pushed to `origin/pi/luna-ops-01` (`bfb0b18`) with a
clean scan over `2e3155f..HEAD`. The promotion range `origin/stream/ops..HEAD` is **still refused**
(37 findings in 25 commits, first `22fdf7f .../08/review.md:70`): the run branch cannot be
fast-forwarded into `stream/ops` while it carries the cycle-12 `-s ours` bridge and the stranded
`e3c7fc9` ancestry. The next cycle must re-land its new commits onto `a7cb461f` (or the current
tip), never push `stream/ops` directly from the run branch. Check
`git ls-remote origin refs/heads/stream/ops` and
`node packages/core/prepush-scan.ts range <stream-tip>..HEAD` and fail loudly when the scan refuses.

## Board IDs and hard rules that still apply

- **Board IDs are `PG-<n>` / `DE-<n>`.** The pre-push leak scan blocks the old single-letter shape
  in commit messages as well as added lines. Cite only the new ID everywhere. Never use
  `--no-verify` and never touch the hook.
- Never change `autonomy/CHARTER.md`, operator control paths or any `package.json` `scripts`; those
  go in `autonomy/proposals/`.
- The host acceptance gate (`/opt/autonomy/gate.sh`) runs on the pushed head; it is not run here.
- Never re-register `/subagents`: three tests pin its removal (`tests/docs-smoke.ts`,
  `tests/run-query-smoke.ts`, `tests/subagent-observability-smoke.ts`).
- `checkJournal` must stay a hard failure for a genuinely missing entry, and the fail-closed
  harness must not be loosened into warn-and-continue; independent review rejects that as weakening
  a control.

## Open follow-ups

- **PG-52** — **done** (cycle 19 `0ce02ec`; consolidated in cycle 20, run `ad74513` / re-land
  `b859d1e`): the glob→checks data table lives in `packages/core/lib/check-map.ts`;
  `packages/core/check-all.ts --for-changed=<a,b>` prints the plan and runs nothing; both sources of
  the `subagent/fence.ts` byte-copy pair and a changed test file now map to their checks; the table
  is unioned with `scriptTargets`; `checkNames()` prints the informational
  `check-all: skipping test:security: …` line only on a real `runAll`, never in plan mode;
  `cyclePrompt`/`cycle.md` require one RAN/SKIPPED line per check.
- **PG-53** deferred: re-landing the tool-firewall boundary probe on a 73-file merge is unverified
  risk.
- The rest of cycle 14 (its record commits) stays on `origin/attempts/luna-ops-01/cycle-14`.
- **V-04** open from cycle 04: unify workflows doc sweep,
  `autonomy/proposals/V-04-unify-workflows.md`.
- Flake `autonomy/proposals/luna-ops-01-08-flaky-resume-checkout.md`: the workflow-resume
  checkout-queue test is timing-shaped and fails on the clean base. `smoke:redaction-corpus`'s
  sub-quadratic growth check is the same shape: it failed once under load in cycle 15 and passed
  four consecutive reruns.
- Installer CLI bad-`--profile` wording: done (cycle 12, `af39987` fix, `94c9802` docs).

## Durable lessons

- Keep proposals short: record findings and counts, not pasted transcripts. Measure
  `git diff --no-renames <stream-head>..HEAD -- . ':(exclude)package-lock.json'
  ':(exclude)autonomy/cycles/...' ':(exclude)autonomy/runs/...' | wc -c` after every commit; the
  review reads at most 60,000 characters and new items stop at 30,000.
- Derive the journal line with `node packages/core/journal.ts` after writing `report.md`, then
  `--check`. `tests/docs-smoke.ts` runs `checkJournal(ROOT)`, so a report without a journal line is
  a red branch.
- When the run branch's ancestry is stranded, do not force-push: build a clean re-land from
  `origin/stream/ops`, verify the code trees match with `git diff --quiet` over the non-record
  paths, confirm the scan is clean, then fast-forward `stream/ops`.
