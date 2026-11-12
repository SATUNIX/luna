# Proposal — skill-router `re:` switch-off lifetime is a security trade-off

Status: proposed (operator decision). Author: cycle 31, run `luna-core-01`, stream `core`.

## Finding (confirmed this cycle)

`packages/extensions/src/skill-router/match.ts:82` holds `compiled` as module-level state; a slow
untrusted `re:` trigger caches `null` and a `refusedTriggers` reason (`:116-117`), and
`triggerRegex` returns the cached `null` forever (`:84-85`). `session_start`
(`packages/extensions/src/skill-router/index.ts:47-53`) clears only `catalog` and `seen`, so a
trigger switched off once is off for the whole pi process, across `/new` and repository changes.
The comment (`match.ts:38`), `docs/security.md:502` and
`docs/architecture/workflows-and-skills.md:119` all say "switched off for the session".

## Why it is not an autonomous fix

Option 1 (export `resetTriggerState()` and call it in `session_start`) restores the documented
per-session semantics but gives a hostile trigger one ~50 ms-CPU probe per session instead of per
process. That relaxes a containment control (`C-18`, `docs/security-standard.md:41`), so it needs an
operator decision and a row in `docs/security.md`'s decisions table, not a silent change. Option 2
(align the three wordings to "for the life of the process") changes no behaviour and is safe.

## Ask

Choose option 1 or option 2. Either way `tests/skill-routing-smoke.ts` currently only asserts the
switch-off within one load; it should gain a new-session check (option 1) or the docs should be
corrected (option 2). Related: `autonomy/proposals/luna-core-01-17-skill-trigger-session-lifetime.md`.
