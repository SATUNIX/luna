# Handoff — run `luna-core-01`, stream `core`

## Where the work stands

- **Cycle 31 (this cycle)**: base `4e0b562fee2c`, commits `d00f106` (memory-vault first-recall
  flag), `c5db84d` (skill-hint clipping), `986ca5b` (cycle-31 review+plan), plus the records and
  `autonomy/JOURNAL.md` line. No board items assigned. `d00f106` closes HANDOFF #15: the
  `firstPrompt` flag is now consumed only after recall succeeds, so a swallowed recall error no
  longer loses the earlier-session recap and pinned block for the whole session (new check 17
  fails on the base; `smoke:memory-vault` 18/18). `c5db84d`: a fixed 160-char `description.slice`
  cut 25 of 34 hidden skill descriptions mid-word and dropped the "Use when …" clause, and the
  comments claimed a name+path ~30-token hint; a new pure `hintText` cuts at a word boundary and
  both comments now state the real ~61-token cost (mid-word cuts 25 -> 0). `smoke:memory-vault`
  18/18, `smoke:skill-routing`, `smoke:docs`, `verify`, `tsc -p tests/tsconfig.json` and targeted
  eslint green; item 1 falsified on the base; item-1 reviewer and the coordinator's item-2 and
  whole-diff reviews **PASS**, no must-fix. Diff 14,002 chars. The E3 child allowance was spent, so
  item 2 used the `subagent` fallback. Merge `pi/luna-core-01` into `stream/core` after the host
  gate.

- **Cycle 30 (this cycle)**: base `12a464e`, commits `e64256f` (D1 memory-vault injection keyed by a
  body fingerprint, code+test+docs), `fa4a42a` (D2 4-character plurals reach the `-s` stem rule,
  test), `bd36e71` (compaction diagram wording), `ca2ffa5` (regenerated `docs/reference.md`), `042910e`
  (cycle-30 review+plan), plus the records
  under `autonomy/cycles/luna-core-01/30/`. Board DE-96/DE-97 re-verified **done** on the base with
  no code change (`smoke:prepush-scan` 16/16, `smoke:brand` 23/23; four reproductions admitted). D1
  closes HANDOFF #16: `injected` is now a `Map<rel, sha256(body)>` and a rel is filtered only while
  its fingerprint is unchanged, so a note edited mid-session is offered again with its new body (new
  check 6b fails on the base; unchanged-note suppression stays pinned by check 6). D2: the stem early
  guard `t.length <= 4` became `< 4` so the `-s` rule (its own minimum is 4) applies (`logs`->`log`;
  base returned `logs`), pinned by exact assertions and a 4-character round trip in check 16.
  Independent per-item reviews and a final whole-diff review: **VERDICT PASS**, no must-fix.
  `smoke:memory-vault` 17/17, `smoke:docs`, `smoke:prepush-scan` 16/16, `smoke:brand` 23/23,
  `tsc -p tests/tsconfig.json`, targeted eslint green; diff 15,000 chars. Merge `pi/luna-core-01`
  into `stream/core` after the host gate.
- **Cycle 29**: base `ddf7084`, commits `ee08e5f` (DE-96 code+test+doc), `72bae06`
  (DE-97 code+test), `d0f77a5` (cycle-29 review+plan), plus the records under
  `autonomy/cycles/luna-core-01/29/` and the `autonomy/JOURNAL.md` line. DE-96 **done**: the
  pre-push leak scan is context-aware — `blockedMatches` takes `allowRoadmapIds` (strict by
  default); the commit message/identity scan and added lines under `autonomy/cycles|proposals|runs`
  pass it true; the documented `--answer` card id and the `user`/`username` home-path placeholders
  are admitted; every other class still refuses. A review-found `\b` lookahead that let
  `<home>/user-x` and `<Users>/user.dev` through was fixed and pinned with boundary assertions. DE-97
  **done**: `tests/brand-smoke.ts` skips every dotenv file but the documented `.env.example`, prints
  `file:line` only, and scans the `git ls-files` tracked set with a fixed-skip fallback. Independent
  reviewer on `ee08e5f`: **VERDICT PASS** (after a FAIL that named the `\b` regression).
  `smoke:prepush-scan` 16/16, `smoke:brand` 23/23, `smoke:docs`, `smoke:security-docs`,
  `tsc -p tests/tsconfig.json`, targeted eslint and the full external gate (`green: true`, 218
  checks) green; diff 25,963 chars. Merge `pi/luna-core-01` into `stream/core` after the host gate.
- **Cycle 28**: base `ee45b3cc3636`, commits `496e1c1` (code+test+doc), `d42bbeb`
  (records + proposal). PG-66 **done**: the cycle's own pre-report budget check now also covers a
  worker that records `report.md` and then dies, refusing it `partial` with the same
  `refused_budget:` measured number instead of closing `completed` (`budgetRefusal()` in
  `cycle.ts`; the live steer-then-refuse path and the auto-restart path are unchanged). The new
  dead-session fixture fails when the two `budgetRefusal()` calls are removed. Also refuted the
  cycle-27 memory-vault reload proposal (pi replaces the extension runtime, so its fix is a no-op)
  and wrote two memory-vault proposals (injected-by-path staleness; the first-recall flag is not
  testable without a fault-injection seam). Independent reviewer PASS. `smoke:autonomy-selfimprove`
  45/45, `smoke:memory-vault` 16/16, `smoke:docs`, `test:typecheck` and targeted eslint green; diff
  ~7.2k chars. Merge `pi/luna-core-01` into `stream/core` after the host gate.
- **Cycle 27 (this cycle)**: base `6642ee5ceeba`, commits `66e7c51`, `4ece751`, `6f8702f`.
  PG-66 **done**: the cycle's own pre-report check now refuses an over-budget diff that is still
  over budget after the split steer, closing `partial` with a `refused_budget:` reason naming the
  measured number, and keys the warned set on the head `diffBudget` actually measured; a
  memory-vault defect is fixed so an unreadable `memory-local` store is not tombstoned. Independent
  reviewer PASS. `smoke:autonomy-selfimprove` 44/44, `smoke:memory-vault` 16/16, `smoke:docs`,
  `test:typecheck` and targeted eslint green; diff 13,975 chars. Merge `pi/luna-core-01` into
  `stream/core` after the host gate.

- Branch `pi/luna-core-01`, base `cc7f37d2aa6f` for cycle 23 (head of `stream/core`, cycle 22
  merged).
  - Cycle 23 commits: `947f272` (Item A: three doc drifts + README/profiles catalogue assertion),
    `2ef965a` (Item B: context-sieve charges its hidden-message header and still-current line to the
    message budget), `267b96e` (review + plan records), plus the records under
    `autonomy/cycles/luna-core-01/23/`.
  - Cycle 23 outcome: **successful** (V-10 re-verified). Board item V-10 already held on the base,
    so no rebrand commit was made; the cycle closed the two carried HANDOFF defects #10 and #11.
    Reviewer **PASS**, no must-fix. `smoke:context-budget` 16/16, `smoke:extensions-catalogue`,
    `smoke:docs`, `smoke:brand` 18/18, `tsc -p tests/tsconfig.json`, targeted eslint green. Diff
    ~15,883 bytes over 6 non-record files.
- Cycle 24 commits: `24e704d` (Item 1: memory-vault `stem()` now meets singular and plural
  forms), `60cd2c6` (Item 2: `tests/orchestrate-commands-smoke.ts` calls `isolateKitEnv()` at
  all six sites), `5f4426b` (scopes the `docs/memory.md` stemming claim), plus the records under
  `autonomy/cycles/luna-core-01/24/`.
  - Cycle 24 outcome: **successful**; no board items assigned. Closed HANDOFF #4 and the
    review-found memory-vault recall loss: base `files->fil`, `processes->proces`, so a plural
    note was unreachable by a singular query; the fix keeps the sibilant base, restores the
    short-singular `e`, and keeps the stripped base for long singulars. Independent reviewer of
    Item 1: **PASS**. `smoke:memory-vault` 15/15, `smoke:memory-recall` 7/7,
    `smoke:orchestrate-commands` 7/7 (3/7 on the base under `PI_KIT_INTERNAL_CHILD=1`),
    `smoke:docs`, `tsc -p tests/tsconfig.json`, targeted eslint green. Diff 9,973 chars over 4
    non-record files.
  - Cycle 25 outcome: **successful**; no board items assigned. Fixed a review-found token-efficiency
    defect: the ultracode standing reminder was appended as a hidden custom user-role message every
    turn even though the full `policy/standing.md` text is in that turn's system prompt, so the
    152-168-char (~40-token) string accumulated forever. `packages/extensions/src/effort/index.ts`
    now tracks `lastReminder` and emits it only when new/changed (reset when standing is off or the
    `workflow` tool is inactive, and in `session_start`/`session_compact`); `docs/effort.md`
    describes the deduped behaviour. Independent reviewer: **PASS**, no must-fix.
    `smoke:effort-standing` 13/13 (new second-unchanged-turn assertion fails on the base),
    `smoke:effort` 38/38, `tsc -p tests/tsconfig.json`, targeted eslint and `smoke:docs` green.
    The workflow-tool budget was exhausted mid-cycle, so Item 1 used the `subagent` fallback
    (implementer + independent reviewer). Also attempted the cycle-24 `-es` stemmer regression
    (`bus`/`buses`): every heuristic variant that keyed on the plural's stripped base also broke a
    silent-e plural (`cases -> cas` vs `case -> case`), so it was **reverted**; the cycle base
    `search.ts` is untouched and the case needs a lexicon or an operator trade-off decision.
- Cycle 26 commits: `12957da` (PG-66: the self-improve loop now measures the would-be review diff
  while the worker is alive and steers it with the exact measured number and budget; the reset and
  attempts-preservation halves already held), plus the records under
  `autonomy/cycles/luna-core-01/26/` and `autonomy/proposals/luna-core-01-26-pg66-pre-report-refusal.md`.
  - Cycle 26 outcome: **successful**. PG-66 marked **progress** (the stronger host-side "refuse
    before submitting and re-land one item at a time" variant is left to the proposal); V-102 was
    already satisfied on the base and re-verified `done` with no code change. Independent reviewer
    on `12957da`: **VERDICT PASS**, no must-fix. `smoke:autonomy-selfimprove` 44/44 (the new
    pre-report check fails when the probe is removed), `smoke:autonomy-run` 15/15, `smoke:brand`
    18/18, `smoke:kit-update` 40/40, `smoke:install-marker`, `verify`, `test:security`,
    `test:typecheck`, `test:lint` all green; `gen:shared` no drift. Diff 13,909 chars over 4
    non-record files. Recommendation to the steward: merge `pi/luna-core-01` into `stream/core`.
- Branch history before cycle 23: base `59b2a82a7b9a` for cycle 22.
  Cycle 22 commits: `e19f880` + `1acb83c` (V-10 sub-item 3b whole-repo brand smoke, cherry-picked
  unchanged from `origin/attempts/luna-core-01/cycle-21`), `0dec2ed` (review + plan records), plus
  the records under `autonomy/cycles/luna-core-01/22/`.
  - Cycle 22 outcome: **successful** (V-10 done). `tests/brand-smoke.ts` now walks `WORKSPACE_ROOT`,
    skipping generated/vendored trees, the top-level `autonomy/` records, `package-lock.json`,
    `CHANGELOG.md`, `docs/branding.md` and itself; `docs/branding.md` documents the whole-repo scope
    and `CHANGELOG.md` gains one `[Unreleased] Changed` bullet. Reviewer: **PASS** with a regression
    probe proving new prose in a newly scanned file fails `file:line`. `smoke:brand` 18/18,
    `smoke:docs`, `test:typecheck`, targeted eslint green. Diff ~13,094 chars over 3 non-record files.
  - Cycle 21 outcome: **rejected, not merged.** It implemented the same sub-item 3b, green in its own
    tree, but failed the clean-checkout gate because it wrote `report.md` after running `smoke:docs`,
    so `docs-smoke`'s journal gate (`packages/core/lib/journal.ts:94`) had no `JOURNAL.md` line for
    `luna-core-01/21`. Cycle 22 landed its two reviewed commits and wrote its own journal line
    together with `report.md`. Its branch is `origin/attempts/luna-core-01/cycle-21`.
  - Cycles 18–20: V-10 sub-items 1–3a. `docs/branding.md` lists every deliberate identity plus the
    rename proposal; the remaining prose was renamed to Luna in 26 files in cycle 20.
  - Still deferred: V-07/V-08 need the operator's finding list; #1 firewall timing noise is
    out of stream.

## What cycle 15 did

1. **Memory-vault first-prompt recall.** `memory-vault/index.ts` cleared `firstPrompt` on every
   `before_agent_start`, including a run started by an extension custom message, so the real first
   user prompt lost the earlier-session recap and pinned-memory block. Now the flag clears only on
   a user prompt and the recap block is gated on `firstPrompt && "prompt" in event`. Pinned by a
   new assertion in `tests/memory-vault-smoke.ts`; docs say "first user prompt".
2. **Dead code.** Removed the always-empty ternary in `effort/index.ts` and the `memory-vault` /
   `skill-router` ids in `context-sieve/index.ts` that no producer writes. Behaviour unchanged;
   `smoke:effort` 38/38 and `smoke:ctx-contributions` 13/13.

## What cycle 12 did

1. **PG-55: the publish-blocked answer can now publish.** The answer rolls the local integration
   branch back to the last published head with an ancestor-guarded `update-ref`, drops every run
   tag whose commit is not an ancestor of that head (`cycle-NN` and `abandoned-NN` alike), marks
   those history entries `discarded` so the next prompt says to redo the work, and keeps the
   blocker/streak until a real push. A new smoke parks on two refused merges, answers, removes the
   leak, and asserts a later cycle starts.
2. **PG-19: paperwork budget.** `packages/core/paperwork-budget.ts` caps a cycle's four record
   files at 60 lines and requires exactly one matching `JOURNAL.md` line (exit 1 on overrun, 2 on
   bad args). It is a documented manual steward check, not a merge gate. This cycle's own four
   files are 49/60.
3. **V-81: footprint CLI.** `node packages/core/eval/footprint.ts --profile <name> [--json]
   [--write-baseline]` prints the tool text, derived tokens and baseline problems; the write is
   atomic and byte-identical when the record has not changed. Documented in
   `docs/efficiency-and-loops.md`; `smoke:eval-footprint` is 13 checks.

## Checks that were run

`smoke:autonomy-selfimprove` (43/43), `smoke:paperwork-budget` (5/5), `smoke:eval-footprint`
(13/13), `test:typecheck`, targeted `eslint`, `smoke:docs`, and the paperwork CLI on this cycle
(49/60, one journal line). Never ran `npm test` or `npm run check:all`. Independent reviewer on
`363dba0b9a25..be8f294`: **VERDICT PASS** after `be8f294`.

## Merge

All targeted checks pass and the independent review passed. Merge `pi/luna-core-01` into
`stream/core` once the host acceptance checks pass on a clean checkout.

## Carry over to the next cycle

1. **`firewall-gate-smoke.ts:590` redaction guard is noisy under full load.** It keeps best-of-three
   while `workflow-redaction-smoke.ts` is best-of-nine, so `tests/timing-load-check.ts` reports 53/55,
   not 55. Measured alone under load it reads 95 ms vs a 200 ms budget, so it is contention noise,
   not a too-tight budget. Fix: best-of-nine here too, then re-run the harness
   (`autonomy/proposals/luna-core-01-11-load-guard-firewall-noise.md`).
2. **Cycle-08 records live only on the attempt branch.** If a later cycle brings
   `autonomy/cycles/luna-core-01/08/report.md` over, it must add the matching journal line
   `- luna-core-01/08 | Board: PG-55, PG-51 | successful | ...` or `smoke:docs` goes red again.
3. Skill-router `re:` trigger wall cap is 500 ms per trigger (was 50 ms) because a CPU budget cannot
   interrupt a match — operator choice: `autonomy/proposals/luna-core-01-07-skill-trigger-wall-cap.md`.
4. `packages/core/install.ts`'s npm/`trunk` guard is untested until `distribution.json` has an npm
   channel (`autonomy/proposals/luna-core-01-05-npm-trunk-channel.md`).
5. Cycle 03's env-ownership work (`472a37f`, `0b02622`, `31d77ca`) is on
   `origin/attempts/luna-core-01/cycle-03` only; sound but not re-verified on this base.
6. `.github/CODEOWNERS:43` names a path with 0 tracked files — `.github/` is a control path; operator
   decision (`autonomy/proposals/luna-core-01-03-codeowners-dead-path.md`).
7. Sandbox `sliceMs` loses to the wall-clock `idleMs` watchdog under load; operator decision on the
   runner's watchdog semantics (`autonomy/proposals/luna-core-01-08-sandbox-watchdog-load.md`).
8. Defect IDs V-07/V-08 still need the operator's in-tree finding list (V-10 was taken in cycle
   18); the owner-side `coverage` CI job is red and untouched.
9. **HANDOFF #4 — DONE in cycle 24** (`60cd2c6`). `tests/orchestrate-commands-smoke.ts` now
   calls `isolateKitEnv()`, so an ambient `PI_KIT_INTERNAL_CHILD=1` no longer fails three checks.
   The cycle-13 stale "wipe" docs and the cycle-15 dead-code sites were already fixed.
10. **context-sieve hidden-message framing — DONE in cycle 23** (`2ef965a`). The header and the
    `stillCurrent` line are now charged to the message budget and `message.tokens` reports injected
    content; `smoke:context-budget` 16/16. Proposal
    `autonomy/proposals/luna-core-01-17-context-sieve-message-framing.md` can be closed.
11. **Two doc drifts — DONE in cycle 23** (`947f272`). The 64-token sentence now says the floor is
    capped at half the window, the `AGENTS.md` search step is gone, both READMEs list `pentest`, and
    `smoke:extensions-catalogue` ties every README `Included in:` list to its manifest. Proposal
    `autonomy/proposals/luna-core-01-17-doc-drift-64-token-and-guidelines.md` can be closed.
12. **skill-router `re:` switch-off outlives the session** (security-adjacent, operator decision):
    `match.ts` mutates process-lifetime `compiled`/`refusedTriggers` and `session_start` never clears
    them, while the comment and two docs say "for the session". Options in
    `autonomy/proposals/luna-core-01-17-skill-trigger-session-lifetime.md`.
13. **V-10 sub-item 3 — DONE in cycle 22.** The whole-repo brand smoke, `docs/branding.md` scope text
    and the CHANGELOG bullet are landed (`e19f880`, `1acb83c`); the branch `pi/luna-core-01` carries
    them. The older `07a89e0` on `origin/attempts/luna-core-01/cycle-19-subitem3` is superseded.
14. **`.github/codeql/codeql-config.yml` keeps `name: pi-system`** (operator control path): the
    brand smoke masks it with the generic `name:` allowance. Rename to Luna on operator approval.
    See `autonomy/proposals/luna-core-01-19-codeql-config-name.md`.
15. **memory-vault first-recall flag — DONE in cycle 31** (`d00f106`). `firstPrompt` is consumed
    only after recall succeeds (just before the `!final` early return), so a swallowed recall error
    no longer loses the recap and pinned block for the session; every non-throw path is unchanged.
    New `smoke:memory-vault` check 17 fails on the base, so no fault-injection seam was needed.
    `autonomy/proposals/luna-core-01-28-memory-vault-first-recall-flag.md` can be closed; a second
    cycle-31 proposal (`luna-core-01-31-memory-search-exclude.md`) covers the `searchMemories`
    over-fetch.
16. **memory-vault `injected` keyed by path — DONE in cycle 30** (`e64256f`). The record is now keyed
    by `rel` with a sha256 of the note body, so a note updated in-session is offered again with its
    new body; `docs/memory.md` and `docs/architecture/memory-compaction-context.md` say once per
    session per unchanged content. `autonomy/proposals/luna-core-01-28-memory-vault-injected-path.md`
    can be closed.
17. **Cycle-27 reload proposal is a no-op — do not implement.**
    `luna-core-01-27-memory-vault-reload-recap.md` assumes the extension instance survives a
    reload, but pi replaces the extension runtime (pi's bundled extension docs,
    `@earendil-works/pi-coding-agent` `docs/extensions.md` lines 50 and 145), so
    `firstPrompt`/`injected` are fresh per factory invocation.

## Rules for the next session

One logical change per commit (finding, root cause, fix, verification), push after each commit,
targeted checks only, reviewable-diff read budget 60,000 chars and stop new items past 30,000, never
edit `.github/`, `autonomy/CHARTER.md`, or operator control paths (propose them instead). Cite only
the new board-id shape (`PG-<n>`, `DE-<n>`). Never run `npm test` or `npm run check:all`. A
`workflow_run` task text must not contain a literal `{{...}}` that is not a valid template — it fails
the step before any agent launches. A long subagent can hit the wall limit — check its staged output
rather than re-dispatching blind. The E3 child allowance is 3 per request; once spent, `workflow_run`
and `subagent` both refuse until the next user message, so keep the last slot for a reviewer.

## Gotcha: `timing-load-check.ts` orphans its CPU burners if killed

`tests/timing-load-check.ts` spawns one burner per core and kills them in a `finally`, but a killed
parent (`SIGKILL`/a stopped subagent) leaves twelve hour-long burners running. In cycle 11 an earlier
background run was left behind and saturated the host, making `workflow-sandbox-smoke` fail its
watchdog (`'idle' !== 'timeout'`) and stalling a reviewer. Check `ps` for `3_600_000` before trusting
a load-sensitive failure or running the harness.
