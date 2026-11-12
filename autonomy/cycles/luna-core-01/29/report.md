Outcome: successful
Mode: fix

Board: DE-96 done - the pre-push leak scan is now context-aware: it admits the product's own
documented identifiers (the `--answer` card-id example, the `user`/`username` home-path
placeholders, a legacy board id cited in a run record or a commit message) while every true
positive still refuses, so the publication freeze it caused is lifted.
Board: DE-97 done - the brand smoke no longer reads or echoes a populated dotenv file, reports a
finding as `file:line` only, and scans the deterministic tracked-file set instead of walking
untracked files.

Item: Context-aware leak scan (DE-96) - ee08e5f - `npm run smoke:prepush-scan` (16/16, was 13;
the three new checks fail when the placeholder lookahead, the `--answer` carve-out or the
run-record/commit-message context is reverted), plus an independent reviewer `VERDICT: PASS` on
ee08e5f. `docs/security-standard.md` names the three carve-outs.
Item: Safe, deterministic brand smoke (DE-97) - 72bae06 - `npm run smoke:brand` (23/23, was 18;
the two new temporary-repository cases fail when `isTextFile` accepts `.env`, when the message
prints the matched text, or when the tracked-file scope is bypassed).
Item: Cycle-29 records (review, plan, verify, report, journal, handoff) - d0f77a5 and this record
chain - records only, no behaviour change. The single behaviour commits are ee08e5f and 72bae06;
any record commit after this line is the same record chain and is exempt (a commit cannot name its
own sha).

## What changed and why

`packages/core/lib/leak-scan.ts`: split the roadmap-board class into its own `ROADMAP_ID` regex;
`blockedMatches(line, { allowRoadmapIds? })` is strict by default and, when true, admits that class
(and drops a match preceded by the documented `--answer` marker). The home-path classes treat a
path component that is exactly `user` or `username` as the placeholder and keep blocking any other
user name, including one that only begins with it. `packages/core/prepush-scan.ts`: the commit
message/identity scan passes `allowRoadmapIds: true`; an added line passes it only when the file is
under `autonomy/cycles/`, `autonomy/proposals/` or `autonomy/runs/`; every other class stays
strict.

`tests/brand-smoke.ts`: `isDotenvName` excludes every dotenv name except the documented
`.env.example`; a finding is `file:line` only; `brandFiles` lists the tracked files with
`git ls-files` (explicit allowlist) and only falls back to the fixed-skip filesystem walk when git
cannot enumerate; `brandFiles`/`scanBrand` are factored out so a temporary tree can be exercised.

## Left-overs and other findings

- **Review caught a regression, now fixed.** The first DE-96 cut used a `\b` lookahead, which let
  `<home>/user-x`, `<home>/user.dev` and `<Users>/user.dev` through. The reviewer reproduced it and
  returned `VERDICT: FAIL`; the lookahead now requires the placeholder to be the whole path
  component and `tests/prepush-scan-smoke.ts` pins the boundary characters.
- **DE-96 reproduction.** Four false-positive refusals were reproduced on the base (a documented
  inbox `--answer` example, the compose-dev placeholder path, a legacy board id in a run record,
  and one in a commit subject); the three shapes are now accepted and each other class still
  refuses.
- **Workflow: refused** — the DE-96 implement/review `workflow_run` reported failed because the
  implement step did not write its declared `de-96-implement.md` output file. Its code changes were
  present and staged, so review continued with the `subagent` fallback; no work was lost.
- Carried HANDOFF items 1-17 are unchanged and out of scope this cycle.
- No new proposals; the out-of-stream problems noted in review are unchanged.

## Checks

See `verify.md`. Never ran `npm test` or `npm run check:all`. The external gate
`/opt/autonomy/gate.sh` ran on a clean checkout: `green: true` (install, check-all with 218 checks,
security, docs and gitleaks-secrets all exit 0). Diff budget 25,963 chars, under the 30,000 stop
line. Merge `pi/luna-core-01` into `stream/core` after the host gate.
