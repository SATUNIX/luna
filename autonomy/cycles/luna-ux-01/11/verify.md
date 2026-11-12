# Cycle 11 — Verify (run `luna-ux-01`, stream `ux`)

Base `7647d1b2f347` (head of `stream/ux`), branch `pi/luna-ux-01`, code head `faea4f3` before
this record commit. `npm test` and `npm run check:all` were not run, per the cycle rules.

## Assigned items (already green at base; re-verified)

- **PG-59** — `npm run smoke:update-notice` → exit 0, `[update-notice-smoke] all 8 checks
  passed`, including the pi-0.99.2-against-1.4.0 case. No change needed.
- **V-05** — `npm run smoke:launch-screen` → exit 0, `[launch-screen-smoke] all 11 checks
  passed`. No change needed.

## Fixed defects

Each new case was checked against the base source with only the changed source file reverted;
`/work` was restored with `git checkout HEAD -- <file>` and `git status` was clean afterwards.

### Item 1 — framed overlay width and mouse forwarding (`8b5bc41`)

```text
git checkout 3cbb951 -- packages/extensions/src/control-center/overlay-frame.ts \
    packages/extensions/src/control-center/hub.ts \
    packages/extensions/third_party/subagent/overlay-frame.ts
npm run smoke:control-center
  FAIL: the hub overlay draws a theme border and dims the transcript behind it
    AssertionError [ERR_ASSERTION]: the hub's overlay component handles mouse
  [control-center-smoke] 1/34 FAILED
```

At HEAD the same suite passes 34/34, so the new cases pin the width translation and the hub's
mouse delegation. The vendor copy is byte-identical to the source copy (`cmp` exit 0).

### Item 2 — short hidden commands in `/` (`faea4f3`)

```text
git checkout 8b5bc41 -- packages/extensions/src/control-center/command-menu.ts
npm run smoke:command-menu
  FAIL: a hidden command shorter than four characters reappears at its full name
    AssertionError [ERR_ASSERTION]: three-character /kit is revealed once typed in full
  [command-menu-smoke] 1/12 FAILED
```

At HEAD the same suite passes 12/12. The case asserts `kit` is in the hidden set, absent at
`/ki`, and present at `/kit`; the existing four-character `auto` cases still pass.

## Checks (all exit 0)

| check | result |
| --- | --- |
| `smoke:control-center` | all 34 checks passed |
| `smoke:workflow-panel` | all 14 checks passed |
| `smoke:command-menu` | all 12 checks passed |
| `smoke:update-notice` | all 8 checks passed |
| `smoke:launch-screen` | all 11 checks passed |
| `smoke:docs` | OK: 14 documented commands, 62 relative links, 23 external lines skipped |
| `test:typecheck` | exit 0 |
| `test:lint` | exit 0 |

## Review verdicts

- Item 1 reviewer: PASS, including a manual read of the pi-tui 1.4 mouse contract and the
  coordinator's negative run.
- Item 2 reviewer: PASS, including confirmation that `kit` is not in `PINNED_KIT_COMMANDS` and
  that the reveal arithmetic is right.
- A whole-diff reviewer was launched after both items and returned no output, the same
  compaction/interruption failure recorded in cycle 10; no verdict was obtained. The per-item
  reviewers and the negative runs above are the evidence used instead. This gap is recorded
  rather than papered over.

## Scope

`git diff --no-renames 7647d1b2f347..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-ux-01/" ":(exclude)autonomy/runs/luna-ux-01/" | wc -c` →
**18718** characters including this cycle's records, under the 30000 stop line and the 60000
review budget. No `package.json` `scripts`, `autonomy/CHARTER.md`, control path, credential or
release change.
