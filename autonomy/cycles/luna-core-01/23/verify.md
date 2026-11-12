# Cycle 23 verify — `luna-core-01`, stream `core`

Base `cc7f37d2aa6f`. Diff reviewed: `947f272` (Item A) + `2ef965a` (Item B), records in `267b96e`.
`git diff --no-renames cc7f37d2aa6f..HEAD` excluding lockfile and `autonomy/` records is 15,883
bytes, under the 30,000/60,000 caps.

## Test runs
- `npm run smoke:context-budget` — **PASS** — `all 16 checks passed` (was 14); the two additions
  are "the message header is charged against the message budget" and "the still-current line is
  dropped when it would overflow the message budget".
- `npm run smoke:extensions-catalogue` — **PASS** — `extensions-catalogue smoke: OK`; the new
  assertion fails on the pre-fix tree for `guidelines` and `spec-plan` (verified by the reviewer
  against the base).
- `npm run smoke:docs` — **PASS** — 14 commands, 62 links, journal gate green (line added before
  the run).
- `npm run smoke:brand` — **PASS** — `all 18 checks passed`.
- `npx tsc -p tests/tsconfig.json --noEmit` — **PASS** — exit 0.
- targeted `eslint` on the four changed source/test files — **PASS** — exit 0, no `any`, no
  `eslint-disable`.

## Independent review
Reviewer subagent that did not write the change (run `2026-11-12T00-49-10-247Z-reviewer-ba71db`):
**VERDICT: PASS**, no must-fix. It confirmed the reserved-budget arithmetic cannot go negative
(`Math.max(0, messageChars - header - 2)`), that `message.tokens` reports injected content, that
both new tests fail pre-fix and pass now, that the catalogue regex only matches an exact
`^Included in:` line, that the `guidelines` source confirms `AGENTS.md` is deliberately not a
candidate, and that no control path changed.

## Acceptance
- V-10: `smoke:brand` green over the whole repo; `mkdocs.yml` / README / `AGENTS.md` / `CLAUDE.md`
  say Luna; `package.json` name still `@satunix/pi-system`; `docs/branding.md` present in nav with
  the rename proposal. Already true on the base; no rebrand commit this cycle.
- No `package.json` scripts, `package-lock.json`, `.github/**` or `autonomy/CHARTER.md` touched.
- `node packages/core/check-all.ts` is left to the host gate on a clean checkout per cycle rules.
