# Cycle 01 — Review (run luna-guard-01, stream `guard`)

Base: `5f2fad2a7bb8` (head of `stream/guard`, cycle start). Branch `pi/luna-guard-01`.

## Charter and stream

`autonomy/CHARTER.md` read in full. Objective: find and fix real, evidenced problems; accept only
tested, documented, scoped changes. No board file: the assigned items are in the cycle prompt.
This is improvement cycle 1 of 200; no earlier cycle of this run exists, and
`autonomy/runs/luna-guard-01/HANDOFF.md` does not exist yet. `git log 5f2fad2a7bb8..HEAD` is empty
(the working tree was clean at session start), so this cycle starts from the cycle start commit.

Assigned:
- **F-12** [P0, rank 1] edit tool: a null-valued extra key beside the real operation is rated
  HIGH `incomplete_adapter` and stalls the agent.
- **PG-23** [P0, rank 23] benign-command corpus: encode the 12 % manager refusal baseline as
  commands that must be allowed, with a reason per command. Measurement only; no rule change.

## Findings with evidence

### F-12 — null-valued adapter key is treated as an operation

`packages/extensions/src/tool-firewall/classify.ts:2658` `coveredEdit` decides whether an edit
input is fully covered. `Object.keys(value)` (line 2660) counts *every* key, and
`Object.keys(value).length !== 1` (line 2661) then rejects an entry that carries one real
operation plus a null-valued sibling. `adapterCovered` (line 2623) turns that into the finding at
line 2719-2720:

```
{ tier: "high", effect: "opaque", code: "incomplete_adapter", ... }
```

`needsOperator` (line 2675) includes `incomplete_adapter`, so an `allow` policy entry cannot lower
it and the agent waits on an approval card. The steward recorded 24 s and 121 s waits
(session actions `ea0de672`, `0f041f48`) from DeepSeek emitting
`{"replace": {...}, "replace_2": null}`. The live install carries a local hot patch until the fix
ships.

The correct semantics: a null/undefined-valued key names no operation. Two real operations, an
unknown operation, an entry with only a null key, and an explicit null operation value must stay
incomplete. A scout probe showed the same bug in two code paths: a nested `replace_2: null` hit
`coveredEdit` line 2661, and a **top-level** `replace_2: null` hit `adapterCovered` line 2639
(`!Object.hasOwn(shape, k)`); both are high and `needsOperator`. Top-level pruning must ignore a
null/undefined key only when it is **not** a known shape field: a known field with a null value
(`postEditVerify: null`, `edits: null`) is malformed and must stay high.

`tests/firewall-shell-smoke.ts:626-655` already owns this contract: the first loop asserts fully
covered inputs stay low, the second asserts incomplete inputs stay high. The five new cases belong
there. Docs that state the contract: `docs/security.md:47-51` ("unknown fields ... is high").

### PG-23 — benign commands across observer, secret-guard and protected-paths

The baseline is the steward's manager metric: 40 refused or failed of 333 calls (12 %) at 05:20Z
(secret-guard 16, other_error 10, edit-tool 6, protected-paths 4). The refuter rewrite of the item
notes `ls packages/extensions/src/secret-guard` is allowed today and two of the three named
commands reproduce.

Reproduction in this checkout: a throwaway harness (deleted) loaded
`extensions/tool-firewall`, `extensions/secret-guard` and `vendor/protected-paths` in turn,
coding profile, headless, temporary workspace/home, and sent the three named commands as `bash`
tool calls. All three returned `undefined` (allowed). The same harness sent 40 representative
benign commands from this repository's work (git status/log/diff, ls/find/rg/grep/sed/cat,
`npm run smoke:*`, `npm run test:typecheck`, `node packages/core/check-all.ts --list`, etc.):
all 40 were allowed. So the false-positive baseline is not reproducible from the shipped
handlers in this environment; it depends on the live operator configuration/session that the
steward measured.

What the code shows: `SECRET_PATH_PATTERNS` in `packages/extensions/src/secret-guard/index.ts`
(line ~20) is a deliberately broad write-side list including `/secret/i` and `/credentials/i`;
the read-side list is narrower (`SECRET_READ_BASENAME_PATTERNS`, line ~170) and the comment says
the broad list would make ordinary source such as `extensions/secret-guard/index.ts` unreadable.
The broad list is reused to scan whole `bash` command lines only together with a transfer verb
(`commandReferencesSecret`, line ~238), which is why `ls`/`rg`/`find` pass.

A 40-command corpus that must be allowed is therefore still worth having: it is the measurement
PG-26 needs, and it pins the precision side of the guard so a future pattern change that starts
refusing harmless work fails a test. Evidence of need is the measured 12 % baseline. The scout
also reproduced the false-positive class the manager hit when a **transfer verb** is present:

```
cat packages/extensions/src/secret-guard/index.ts        -> secret-guard BLOCK
head -5 packages/extensions/src/secret-guard/index.ts   -> secret-guard BLOCK
rg -n "secret-guard" packages/extensions/src | head -3 -> secret-guard BLOCK
cp packages/extensions/src/secret-guard/index.ts /tmp/x -> secret-guard BLOCK
```

Cause: `TRANSFER_VERB` (`secret-guard/index.ts:88`) plus `commandReferencesSecret` (line ~238)
applies the broad write-side `/secret/i`, `/credentials/i` patterns to the whole command line, so
the *directory* `secret-guard` is read as a secret file. The narrow read-side list
(`SECRET_READ_BASENAME_PATTERNS`, line ~179) exists for exactly this reason. `rg <pattern> | head`
is the same class: the quoted search pattern is scanned as if it were a path.

Also found, not taken this cycle: `glob` is in `ADAPTER_TOOLS` but absent from the `shapes` table
at `classify.ts:2626-2636`, so every `glob` call is `incomplete_adapter` high even though the
shipped policy allows it read-only. Same incomplete-adapter family as F-12; recorded as a
proposal for the next cycle (PG-26 territory).

### Constraint that shapes PG-23's implementation

`tests/*-smoke.ts` files must be named by a `package.json` script to run in the gate
(`packages/core/lib/wiring.ts:94` `findWiringProblems`, `unwired`). This cycle may not change the
`scripts` of any `package.json`: the cycle prompt makes such a change a merge refusal before
review, and `/package.json` is a CODEOWNERS path. So the corpus ships as a helper module
`tests/firewall-benign-corpus.ts` (not a suite: no `-smoke` suffix) imported and invoked by the
already-wired `tests/tool-firewall-smoke.ts`, and a proposal asks the operator to register the
standalone `firewall-benign-corpus-smoke.ts` script. No rule changes; the SUT is unchanged.

## Mode

**Fix mode** for F-12 (reproduced guard false positive with a hot-patched production workaround).
PG-23 is an assigned improvement/measurement; it is taken in the same cycle as board work.
