# Cycle 17 verify — `luna-core-01`, stream `core`

Base `ff6083ca18b2`; head `3c1a9f3` (code commit). Mode: fix. Diff (records excluded) 11,112 chars,
3 files, +81/−26.

- `node tests/memory-vault-smoke.ts` — **PASS** 14/14, including the new check
  `pinned memories ranking above a relevant one do not crowd it out of the first-prompt recall`
  (`[memory-vault-smoke] all 14 checks passed`).
- Base-source check — **FAIL as required**: with
  `git checkout ff6083ca18b2 -- packages/extensions/src/memory-vault/index.ts` and the new test in
  place, the run exits on `expected: /### Relevant memories/`; head source restored and the tree is
  clean. This is the fails-on-base/passes-on-head evidence for the new check.
- `npm run test:typecheck` — **PASS** (all eight tsconfig projects, no output past the npm banner).
- `npx eslint --flag unstable_native_nodejs_ts_config packages/extensions/src/memory-vault/index.ts tests/memory-vault-smoke.ts` — **PASS** (no findings).
- `node tests/docs-smoke.ts` — **PASS** (`14 documented commands validated, 62 relative links resolved …`).
- Never ran `npm test` or `npm run check:all`.

## Independent review

The reviewer subagent hung without a verdict again: run
`2026-11-11T22-23-38-772Z-reviewer-20dbf0` ends on a bare `tool_execution_start` (a `git archive`
base-check bash call) with status `toolUse` and no `VERDICT` frame. As in cycle 16, the verdict was
replaced by the objective base-vs-head checks above: the new check fails on base source and passes on
head, and every targeted check passes on head. A second reviewer run was not possible because the
request's agent allowance was spent.

## Scope check

No test was weakened or skipped; no dependency, `package.json` `scripts`, `.github/`, control path or
`autonomy/CHARTER.md` change; no commit list in this file. The change is one logical commit
(`3c1a9f3`) plus the record commits.
