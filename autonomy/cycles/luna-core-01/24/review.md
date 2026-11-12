# Cycle 24 review — `luna-core-01`, stream `core`

Mode: **fix**. Base `ae24f89` (head of `stream/core`, cycle 23 merged). HEAD is clean and the
pre-cycle diff is 0 bytes, so priority 0 (red gate) and priority 1 (upstream conflict) are clear.
No board items were assigned. Prior-cycle report and `HANDOFF.md` were read.

Review method: one parallel scout plan (three scouts) plus a follow-up `subagent` scout for
memory recall. Treat audit/roadmap prose as hypotheses and checked each against code.

## Finding A — memory-vault stemmer drops plurals, so saved memories are unrecallable (real defect)

`packages/extensions/src/memory-vault/search.ts:24-34` strips suffixes, then in the `-es`/`-s`
branches collapses a doubled final consonant (`base.replace(/(.)\1$/, "$1")`) and strips `-es`
unconditionally. Verified by running the pure function:

```
file -> file          files -> fil
note -> note          notes -> not
value -> value        values -> valu
process -> process    processes -> proces
class -> class        classes -> clas
address -> address    addresses -> addres
```

Both documents and queries run through the same `stem()` (`tokenize()`, `search.ts:36-41`), and
BM25 matches exact tokens (`search.ts:65-86`, called from `vault.ts:557-575`). So a memory whose
text uses the plural is invisible to a singular query and vice versa. This hits automatic recall
(`index.ts:146`, `gate: true`) and `memory_search` (`index.ts:289`). `docs/memory.md:57`
documents recall as "BM25 with stopwords and stemming"; the comment at `search.ts:22-23` says
inflections are meant to meet. `tests/memory-vault-smoke.ts` has no plural/singular assertion.
Matching singulars whose length > 5 and end in silent `e` (e.g. `response`/`responses` both
`respons`) already work, so the fix must not regress them.

## Finding B — `orchestrate-commands-smoke` is not environment-hermetic (HANDOFF carry-over #4)

`tests/orchestrate-commands-smoke.ts` clears only `PI_KIT_ORCH_DISABLE` (lines 27, 50, 72, 93,
150, 175) and never `PI_KIT_INTERNAL_CHILD`, unlike peer smokes (`tool-capture-smoke.ts:36`,
`memory-vault-smoke.ts:47`, `firewall-preauth-smoke.ts:145`) which call `isolateKitEnv()`.
`orchestrator/index.ts:55` reads the variable through `isInternalChild()` (guards at lines 364,
419). Reproduced on the base:

```
$ PI_KIT_INTERNAL_CHILD=1 node tests/orchestrate-commands-smoke.ts
  FAIL: the delegation directive comes from the policy, in at most 600 chars, without chain
    AssertionError: E3 names a plan
  FAIL: without the policy the directive is one line and nothing throws
    AssertionError: no registry: one line
  FAIL: strategy.delegateScore is the one threshold
    Error: ENOENT .../.pi/task-classification.json
  [orchestrate-commands-smoke] 3/7 FAILED
```

An ambient `PI_KIT_INTERNAL_CHILD=1` (e.g. the smoke run from a kit child) makes the suite lie.
Minimal fix: use `isolateKitEnv()` in place of `setEnv("PI_KIT_ORCH_DISABLE", undefined)`.

## Audited and clean (no change this cycle)

- `context-sieve` cycle-23 budget fix (`2ef965a`): `MESSAGE_HEADER.length + 2` reserved, the
  `still-current` line dropped on overflow, `message.tokens` from final injected text;
  `smoke:context-budget` 16/16. No residual over/under-count found.
- Effort tier limits in `docs/effort.md` match `packages/extensions/src/effort/policy/effort.json`;
  `withEffortBlock` replaces rather than stacks.
- `skill-router` `re:` switch-off outliving the session (`match.ts:82,116-117`; `index.ts:47-53`)
  is a real process-lifetime defect against three "for the session" docs, but proposal
  `luna-core-01-17-skill-trigger-session-lifetime.md` frames the trade-off as the operator's
  decision. Left unimplemented; recorded in the handoff.

## Open proposals read

`.../17-skill-trigger-session-lifetime.md` (operator decision, above); `.../11-load-guard-firewall-noise.md`
(firewall-gate test harness, out of this stream); `.../17-context-sieve-message-framing.md` and
`.../17-doc-drift-64-token-and-guidelines.md` implemented in cycle 23; the rest are operator
decisions or closed.

## Chosen work (see `plan.md`)

1. Fix the `-es`/`-s` stemming so plurals meet their singulars (Finding A), with a regression
   check in `tests/memory-vault-smoke.ts` and a docs line.
2. Make `tests/orchestrate-commands-smoke.ts` hermetic with `isolateKitEnv()` (Finding B).
