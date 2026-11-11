# Cycle 07 — Verify (run luna-ux-01, stream `ux`)

Base `629d99874c10` (head of `stream/ux` after cycle 06), branch `pi/luna-ux-01`, head `d1df582`
before the report commit. `npm test` and `npm run check:all` were not run, per the cycle rules.

## Targeted checks

| Command | Result | Proof line |
| --- | --- | --- |
| `npm run smoke:update-notice` | PASS | `[update-notice-smoke] all 7 checks passed` |
| `npm run smoke:kit-update` | PASS | `[kit-update-smoke] all 40 checks passed` |
| `npm run test:typecheck` | PASS | all `tsc -p …` projects complete, exit 0 |
| `npm run test:lint` | PASS | `eslint --max-warnings 0 .` exits 0 |
| `node packages/core/reference.ts --check` | PASS | `[reference] OK: docs/reference.md is up to date.` |
| `npm run smoke:docs` | PASS | `14 documented commands validated, 62 relative links resolved` |
| `npm run smoke:command-contract` | PASS (base) | `[command-contract-smoke] all 9 checks passed` |
| `npm run smoke:command-menu` | PASS (base) | `[command-menu-smoke] all 11 checks passed` |
| `npm run smoke:control-center` | PASS (base) | `[control-center-smoke] all 30 checks passed` |
| `npm run smoke:menu-settings` | PASS (base) | `[menu-settings-smoke] all 4 checks passed` |

## V-03 (already complete on the base — no change this cycle)

Re-read against the acceptance: `control-center/index.ts:169` registers `menu` with the full
description, `:178`/`:183` register `kit`/`helpers` on the same `open` handler with
`description: "Alias of /menu"`; `extension.json` `registers.commands` is `["menu","kit","helpers"]`;
`command-menu.ts:26` builds `moved → /menu ▸ All commands`; `model.ts` holds the `settings` page
(`parent: "main"`) and the `/settings` prefill row; the `hubKey` shortcut sends `/menu`. The
cycle-06 report and the four base smokes above agree. Nothing to change; V-03 is recorded done.

## PG-12 acceptance evidence

- `trunkNotice` is a pure export: `{channel:"trunk",ahead:19}` → `trunk is 19 commits ahead —
  /update channel trunk`; singular `1 commit`; `ahead <= 0`, empty channel and non-finite `ahead`
  → `null`.
- `checkForUpdates` computes the gap only in the `kit.kind === "git"` branch, after `ls-remote`,
  via the injected `git` seam `["-C", root, "rev-list", "--count", "HEAD..<main>"]`, parsed
  defensively. It never touches `available`/`hasUpdates`/`summaryLine`; in sync it stores `0`;
  offline it is absent.
- The notice names `next` at all three call sites (`TRUNK_CHANNEL`), the channel that follows the
  trunk `main`; a default `latest`/pinned install gets an actionable command.
- `session_start` fires the notice **before** the `!hasUpdates(report)` early return, inside the
  non-awaited `void check(cwd).then(...).catch(() => {})`; the "hang" smoke proves start-up
  resolves promptly with a git call that never returns (git pids killed afterwards). The bare
  interactive `/update` notifies the gap before its selector; `formatReport` appends it as its own
  line, so `/update status` shows it. `summaryLine` is byte-for-byte unchanged.
- The new smoke pins the `/update` path (`formatReport` line; bare-`/update` notify assertion) and
  the no-line-in-sync case, not only start-up. Each gap assertion fails without the change.

## Review

Two independent reviewers (neither wrote the change) ran on earlier heads and both returned
**FAIL**, and both findings were fixed:

1. The workflow reviewer: `fc6f1d4` was committed but never pushed; the remote was still at
   `ccf66fb`. Pushed in the next commit. It also warned the `trunkAhead` comment said "absent in
   sync" while the code stores `0`, and that `?? "next"` masked the empty-channel contract. Both
   corrected.
2. A standalone `reviewer` subagent: the notice named the install's own channel, so a default
   `latest`/pinned git install read `/update channel latest` (a command that cannot deliver the
   newer `main` commits). Fixed by introducing `TRUNK_CHANNEL = "next"` and using it at all three
   call sites, with the tests, docs and the alias proposal updated. The warnings about the
   throttled start-up wording, the proposal nuance and the non-finite guard were also fixed.

After those fixes the diff was re-checked with the host's independent `verify_completion` verifier
(the E3 child budget of three was already spent on the implementer and the two reviewers); its
verdict is recorded on the verifier board. `git status` is clean on every commit and each commit
was pushed (`git ls-remote origin refs/heads/pi/luna-ux-01` is at the cycle head).

## Gate / budget

Full diff `629d99874c10..HEAD` is **25,731** characters excluding the lockfile and records (under
the 30,000 stop-taking threshold and the 60,000 review threshold). Changed non-record files:
`packages/extensions/src/kit-update/index.ts`, `packages/extensions/src/kit-update/README.md`,
`docs/updates.md`, `tests/update-notice-smoke.ts`, and exactly one added `smoke:update-notice`
line in `package.json` scripts (the HANDOFF's one allowed `scripts` exception).

V-73 stays deferred: its reviewed commits (`384dcf4`, `00ff7c8`, ~33k chars on
`origin/attempts/luna-ux-01/cycle-05`) would cross the stop-taking threshold if added this cycle.
`smoke:firewall-gate` / `smoke:redaction-corpus` are host-load budgets owned by DE-95 (ops);
`smoke:env-isolation` / `smoke:workflow-resume` were not run this cycle — they are not touched
files' gates, and `tests/workflow-resume-smoke.ts:392` (if it reports) is a real assertion, to be
quoted, not treated as a flake.
