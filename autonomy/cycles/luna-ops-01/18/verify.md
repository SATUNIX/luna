# Cycle 18 verify (run `luna-ops-01`, ops stream)

All commands run from `/work` on branch `pi/luna-ops-01`. Targeted smokes only; `npm test` and
`npm run check:all` were not run.

## Targeted tests (changed files)

| Command | Result | Proving line |
| --- | --- | --- |
| `npm run -s smoke:autonomy-cli` | PASS | `21/21` — includes the four PG-56 "merged work not yet published" checks against the restored `packages/autonomy/lib/unpublished.ts` |
| `npm run -s smoke:autonomy` | PASS | `32/32` |
| `npm run -s smoke:install-marker` | PASS | `all checks passed` — installer `--scope`/`--profile` carry-over |
| `npm run -s test:typecheck` | PASS | `tsc --noEmit` exit 0 |
| `npm run -s smoke:autonomy-review-inputs` | PASS | `23/23` — PG-63 fixtures: host upstream sync of a large trunk judged 257 chars, conflict-resolving cycle 402 chars, 60001-char own diff still refused, against the 60000 budget |
| `npm run -s smoke:docs` | PASS | `docs smoke OK` |

## Publication / scan

| Command | Result | Proving line |
| --- | --- | --- |
| `node packages/core/prepush-scan.ts range origin/stream/ops..pi/luna-ops-01-reland` | PASS | `1 commit(s) checked, no blocked identifiers or private paths` |
| `node packages/core/prepush-scan.ts range origin/stream/ops..HEAD` | FAIL (expected) | `37 finding(s) in 29 commit(s); push refused` — the stranded `e3c7fc9`/`22fdf7f` ancestry; this is why the clean re-land branch is the promotion path |
| `git merge-base --is-ancestor origin/stream/ops pi/luna-ops-01-reland; echo $?` | PASS | `0` |
| `git diff --stat pi/luna-ops-01-reland HEAD` | PASS | empty — identical trees |

## Independent review

A `reviewer` subagent that did not write the change reviewed `git diff 7963177..HEAD`, the charter
and the board items. Verdict: **PASS**. It confirmed the merge restores the deleted files, the
re-land is a single-commit fast-forward with a clean scan, no control/dependency/history change, no
conflict markers, and all targeted checks pass. Warnings: the re-land commit message lacks an
explicit verification line (carried by the merge commit and this report); `origin/tmp-sync` is a
stray remote branch the operator may remove.

## Budget

Review diff measured after the sync merge:
`git diff --no-renames 7963177..HEAD -- . ":(exclude)package-lock.json" ":(exclude)autonomy/cycles/luna-ops-01/" ":(exclude)autonomy/runs/luna-ops-01/" | wc -c`
→ 35900 characters. Past the 30000 stop-new-items line, under the 60000 review cap.
