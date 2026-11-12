# Cycle 20 review — `luna-core-01`, stream `core`

Base `a5b6d4ec1fb1`; charter read in full; V-10 [P1] sub-items 1–2 landed, sub-item 3 open.

## Findings
1. **Sub-item 3 does not fit the review cap.** `07a89e0` (whole-repo rebrand, reverted by `6c46845`) re-applied onto `a5b6d4ec1fb1` measures **63,268** chars, over the 60,000 review cap (scratch `git revert --no-commit 6c46845`, then the excluded-path `git diff --no-renames … | wc -c`).
2. **A green split exists.** Its 28 non-scope files (excluding `tests/brand-smoke.ts`, `docs/branding.md`, `CHANGELOG.md`) measure **52,997** chars and keep `smoke:brand` 17/17 plus the kit/install/profile/docs/distribution smokes green; the remaining ~10.3k is the whole-repo walk, `docs/branding.md` scope text and the CHANGELOG bullet.
3. **V-10's other acceptance already holds.** `mkdocs.yml` `site_name: Luna`; `README.md` heading `# Luna`; AGENTS/CLAUDE name Luna; root `package.json` name `@satunix/pi-system`; `smoke:brand` wired. Only the scope widening is unfinished.
4. HANDOFF #10 (context-sieve framing) and #11 (doc drifts) remain proposals; #4 is test-robustness; #1 is out of stream; V-07/V-08 need the operator's list; no upstream ref, so priority 1 is moot.

## Decision
Improve mode, **partial**: land the prose renames now at a reviewable diff, keeping the current smoke scope; defer the whole-repo scope widening, its `docs/branding.md` text and its CHANGELOG bullet to the next cycle. The CodeQL rename stays in `autonomy/proposals/luna-core-01-19-codeql-config-name.md`.
