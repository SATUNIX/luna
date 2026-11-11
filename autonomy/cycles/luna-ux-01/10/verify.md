# Cycle 10 — Verify (run `luna-ux-01`, stream `ux`)

Base `aad264ed68f1` (head of `stream/ux`), branch `pi/luna-ux-01`, code head `9e4e345` before
the record commit. `npm test` and `npm run check:all` were not run, per the cycle rules.

## Assigned items

- **PG-59** — `npm run -s smoke:update-notice` → exit 0, `[update-notice-smoke] all 8 checks
  passed`, including the pi-0.99.2-against-1.4.0 case. Already green at the base; no change.
- **V-05** — `npm run -s smoke:launch-screen` → exit 0, `[launch-screen-smoke] all 11 checks
  passed`. Already green at the base; no change.

## Carried-over fixes

Each new case was run against a throwaway clone (`/tmp/rev10`, `git clone --shared` of HEAD,
`node_modules` symlinked) with the two source files reverted to the base:

```text
git checkout aad264ed68f1 -- packages/extensions/src/control-center/index.ts \
    packages/extensions/src/control-center/hub.ts
node tests/control-center-smoke.ts
  FAIL: All commands lists a built-in extension command once, not again from getCommands()
  FAIL: a cancelled RPC value dialog closes the hub instead of reopening the parent page
  FAIL: the hub overlay fits a short terminal and keeps its 15-row default when no size is known
```

The three cases pass at HEAD (`34/34`), so each pins the behaviour its fix adds. The clone and
symlink were removed afterwards; `/work` was not modified.

- `29a410b` — `allCommands()` keeps built-ins first and skips a `getCommands()` name already
  listed; `docs/control-center.md` row updated; RPC `/menu all-commands` case asserts `mcp`,
  `llama`, `auto` appear once.
- `1ef8e7d` — a cancelled/timed-out second (value) `select` returns `undefined`, closing the
  hub, as `docs/control-center.md` promises; scripted two-dialog RPC case.
- `8b024ec` — hardening: a built-in `/settings` is still listed once and the cancelled dialog
  dispatches nothing.
- `9e4e345` — `SettingsList`'s `maxVisible` is derived from `tui.terminal.rows` at render time
  (default 15, floor 1), so the framed overlay stays inside a 24-row terminal; docs sentence.

## Checks (all exit 0)

| check | result |
| --- | --- |
| `smoke:control-center` | all 34 checks passed |
| `smoke:command-menu` | all 11 checks passed |
| `smoke:update-notice` | all 8 checks passed |
| `smoke:launch-screen` | all 11 checks passed |
| `smoke:docs` | OK: 14 documented commands, 62 relative links, 23 external lines skipped |
| `test:typecheck` | exit 0 |
| `test:lint` | exit 0 |

## Scope

`git diff --no-renames aad264ed68f1..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-ux-01/" ":(exclude)autonomy/runs/luna-ux-01/" | wc -c` →
**17695** characters including this cycle's proposal, journal line and records (12854 at code head
`9e4e345` before them), under the 30000 stop line and the 60000 review budget. No `package.json`
`scripts`, `autonomy/CHARTER.md`, control path, credential or release change.

## Notes

- An independent reviewer subagent was started twice for the whole diff; both runs were cut off
  by context compaction before writing a verdict (`/tmp/cycle10-review.md` absent, run status
  `toolUse`). The per-item gated reviewer steps in the implementation workflows did pass, and the
  negative run above is the independent evidence for the test changes. The missing whole-diff
  verdict is recorded here rather than claimed.
- `overlay-frame.ts` mouse-forwarding and inner-width defects found during review are written up
  in `autonomy/proposals/luna-ux-01-10-hub-overlay-mouse-and-width.md`, not taken.
