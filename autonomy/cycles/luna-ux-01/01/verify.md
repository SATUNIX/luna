# Cycle 01 — Verify (run luna-ux-01, stream `ux`)

- Cycle base `5fda5d526514`, verified head `c638796`.
- Cycle diff excluding records, runs and lockfile: **35,617 chars** (above the 30,000 stop-new-work line, below the 60,000 review cap).
- Targeted check set derived with `node packages/core/check-all.ts --for-changed` over every changed path.

## Targeted checks (all exit 0 at the verified head)

| Check | Result |
|---|---|
| `npm run -s docs:check` | nav and internal links OK |
| `npm run -s smoke:autonomy` | 32/32 |
| `npm run -s smoke:autonomy-inbox` | 7/7 |
| `npm run -s smoke:autonomy-run` | 15/15 |
| `npm run -s smoke:autonomy-selfimprove` | 55/55 |
| `npm run -s smoke:control-center` | 45/45 |
| `npm run -s smoke:docs` | OK, journal in step |
| `npm run -s smoke:new-extension` | OK |
| `npm run -s smoke:remote-control` | 16/16 |
| `npm run -s smoke:tui-layout` | 4/4 |
| `npm run -s test:lint` | OK |
| `npm run -s test:typecheck` | OK |
| `npm run -s verify` | all checks passed |

Never ran `npm test` or `npm run check:all`; the host gate owns the full suite on a clean checkout.

## Base-failure evidence

- Restoring the base `hub.ts`, `inbox.ts`, `board.ts`, `cli.ts` and `remote-control/index.ts` while keeping the new tests makes `smoke:autonomy-inbox` fail on the offset-less deadline assertion and `smoke:tui-layout` fail at `remote.wrap is not a function`; the base files were restored afterwards and `git status` was clean before the commits.
- The control-centre cases fail on the base source because `stripTerminalSequences` leaves the ESC in `\u001b[?1049h`, leaves C1 `\u009b` and leaves `\u202e`, and imposes no length bound.
- At base `--answer` on a settled card exits 0, an uploaded card may carry `answer`/`outcome`, and the listing prints raw card text and `outcome.at`.
- `wrap("abc🚀", 2, 1)` reaches `rest = ""; break` at base and drops the `🚀`; at HEAD it renders three lines that measure at most 2 columns and together keep `abc🚀`.

## DE-98

Verified at the cycle base, no source change: `CHANGELOG.md` Unreleased already has entries for the `/workflows` cursor/tail, effective Security level, `/remote` pairing wrap, footer `toolPhrase`/ASCII and status-bar/todo truncation, and `tests/tui-layout-smoke.ts` already declares `const size = 25`. The earlier board item was therefore satisfied; the cycle spent its budget on DE-101 instead.

## Independent review

A read-only `reviewer` subagent reviewed the complete non-record diff, the charter, the plan and the review, and ran the targeted checks itself. First verdict **FAIL** for missing/stale documentation and two unfiltered interpolations; all findings were fixed in `834963d` and `c638796`. Second verdict **PASS**, no critical findings. Its remaining warnings are addressed: both offset signs are documented and the page-parent filter has its own assertion.

The reviewer's base-failure note about `wrap` being newly exported is accurate: the base proof is the missing export plus the old `rest = ""; break` branch, while the behavioural assertion at HEAD proves the remainder is kept.
