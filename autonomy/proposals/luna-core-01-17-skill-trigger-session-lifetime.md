# Proposal — the skill-router `re:` switch-off outlives the session

Status: proposed (not implemented). Author: cycle 17, run `luna-core-01`. Stream: `core`.

## Problem

`packages/extensions/src/skill-router/match.ts` disables an untrusted project `re:` trigger that
exceeds its CPU budget by mutating **module-level** state:

```ts
const compiled = new Map<string, RegExp | null>();      // :82
...
compiled.set(t, null);                                  // :116
refusedTriggers.set(t, `used more than ${TRIGGER_TEST_MS} ms of CPU on a prompt; switched off for this session`); // :117
```

`packages/extensions/src/skill-router/index.ts:47-53` resets only `catalog` and `seen` on
`session_start`; nothing ever clears `compiled` or `refusedTriggers`:

```
$ grep -rn "refusedTriggers.clear\|compiled.clear" packages/ tests/   # no matches
```

Because the module lives for the whole pi process, the trigger stays off across `/new` (a new
session, same process) and even after the operator switches to a different repository. The comment
(`match.ts:38`), `docs/architecture/workflows-and-skills.md:119` and `docs/security.md:502` all say
"switched off **for the session**", so the code is stricter than documented and a benign trigger
that tripped once on a loaded host is never retried in that process.

## Why it is a decision, not an automatic fix

The guard screens untrusted repository content. Re-enabling a refused trigger at each `session_start`
restores the documented per-session semantics (still safe-regex screened, still CPU-budgeted, still
switched off after one breach within that session) but it does mean a hostile repository gets one
budget-test per session instead of one per process. That is a deliberate trade-off between
discoverability/efficacy and a marginally larger CPU-burn surface, so it belongs to the operator.

## Options

1. **Align the code to the docs (recommended):** export a `resetTriggerState()` from `match.ts` that
   clears `compiled` and `refusedTriggers`, and call it in `skill-router`'s `session_start` handler.
   Add a smoke check that a switched-off trigger is re-enabled at the next `session_start`.
2. **Align the docs to the code:** change the comment and the two docs to say "for the rest of the
   process". No behaviour change.

Either way `tests/skill-routing-smoke.ts` currently only asserts the switch-off takes effect and
never exercises a new session, so it should gain that check.
