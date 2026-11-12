# Cycle 29 verify — luna-core-01

Base `ddf708469b4b`; behaviour head `72bae06`, records head `4ce7316`. Targeted checks were run
on the behaviour head; the external gate ran the full suite on the final records head (see below).
Never ran `npm test` or `npm run check:all` by hand.
external gate ran the full suite on a clean checkout (see below). Never ran `npm test` or
`npm run check:all` by hand.

## DE-96 — context-aware leak scan (`ee08e5f`)

- `npm run smoke:prepush-scan` — **PASS** — `prepush-scan smoke: 16 checks passed` (base 13). The
  three added checks: the documented `--answer` card-id example passes; the `<home>/user` and
  `<Users>/user` placeholders pass while a real user name and a name that merely begins with the
  placeholder (`user-x`, `user.dev`) stay blocked; a run record under `autonomy/cycles/` that cites
  a legacy board id passes, an added line under `docs/` citing the same id still fails, and a commit
  message citing it passes.
- Falsification (independent reviewer on `ee08e5f`): reverting the placeholder lookahead to `\b`
  makes `<home>/user-x` and `<Users>/user.dev` pass, and the new assertions fail; the `--answer`
  carve-out was shown to apply only when the id is immediately preceded by `--answer` plus
  whitespace (`--answerD-1` is not an id; a bare id in prose stays blocked), and the run-record
  prefix cannot be spoofed by `docs/autonomy/cycles`, `autonomy/cyclesx` or `xautonomy/cycles`.
- `npx tsc -p tests/tsconfig.json` — **PASS** — exit 0.
- `npx eslint packages/core/lib/leak-scan.ts packages/core/prepush-scan.ts tests/prepush-scan-smoke.ts`
  — **PASS** — exit 0.
- Independent reviewer verdict on `ee08e5f`: **VERDICT PASS** (no must-fix; the prior FAIL on the
  `\b` regression was fixed and re-checked).

## DE-97 — safe, deterministic brand smoke (`72bae06`)

- `npm run smoke:brand` — **PASS** — `[brand-smoke] all 23 checks passed` (base 18). The two added
  temporary-git-repo cases: a tracked populated `.env` is never scanned and no finding contains its
  value, while `.env.example` stays in scope and a prose finding is exactly `file:line`; and the
  `brandFiles` set is unchanged by an untracked ignored file.
- Falsification (implementer, then re-checked here): forcing `isTextFile` to accept `.env` fails
  "a dotenv file is never scanned"; restoring the text in the message fails "a prose finding is
  file:line only"; bypassing `gitTrackedFiles` fails "the tracked-file scope ignores untracked
  files". Each mutation was restored and the suite re-run green.
- `npx tsc -p tests/tsconfig.json` — **PASS** — exit 0.
- `npx eslint tests/brand-smoke.ts` — **PASS** — exit 0.
- Scope assertions still hold: `scanned.length > 100`; `packages/core/install.ts` and
  `packages/container/capability.yaml` are in scope.

## Docs and gates

- `npm run smoke:docs` — **PASS** — `14 documented commands validated, 62 relative links resolved;
  balanced profile resolved; 23 external lines skipped; skills catalogue visible 4/38`.
- `npm run smoke:security-docs` — **PASS** — `61 controls, 9 attackers and 12 pages checked`.
- External gate `/opt/autonomy/gate.sh` on a clean checkout, re-run on the final records head
  `4ce7316` — **PASS** — `green: true`; steps install 0, check-all 0 (`all 218 check run(s) passed
  in 421.9s`), security 0, docs 0, secrets 0 (gitleaks: `no leaks found`). The same gate also
  passed on the behaviour head `72bae06`.
  install 0, check-all 0 (`all 218 check run(s) passed in 339.8s`), security 0, docs 0, secrets 0
  (gitleaks: `no leaks found`).

## Diff budget

`git diff --no-renames ddf708469b4b..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-core-01/" ":(exclude)autonomy/runs/luna-core-01/" | wc -c`
measured **25,963** chars (non-record files: `leak-scan.ts`, `prepush-scan.ts`, `brand-smoke.ts`,
`prepush-scan-smoke.ts`, `docs/security-standard.md`), under the 30,000 stop line and the 60,000
review budget. No `autonomy/BACKLOG.md` edit.
