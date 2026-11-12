# Cycle 24 report — run `luna-core-01`, stream `core`

Outcome: successful
Mode: fix

No board items were assigned this cycle (per the task statement). Both items come from the
HANDOFF carry-over and a defect found during review; both are real, evidenced and scoped.

Tests changed, and why: `tests/memory-vault-smoke.ts` gains check 16 (exact stems plus a
`searchMemories` round trip), which fails on the base with `'fil' !== 'file'`;
`tests/orchestrate-commands-smoke.ts` keeps every assertion and only swaps its environment
reset. No assertion was weakened or deleted.

Board: (none assigned)

Item: memory-vault plural and singular forms could not meet in recall - 24e704d, 5f4426b -
`npm run smoke:memory-vault` (check 16) and `npm run smoke:memory-recall`.
`stem()` stripped `-es` unconditionally and collapsed doubled trailing consonants, so base
`files->fil`, `notes->not`, `values->valu`, `processes->proces`, `classes->clas`,
`addresses->addres`. Because documents and queries share `tokenize()`/`stem()` and BM25
matches exact tokens, a note saved with a plural was unreachable by a singular query and
vice versa — automatic first-prompt recall and `memory_search` alike. The fix keeps the
sibilant base (`processes->process`, `classes->class`), restores the silent `e` of a short
singular (`files->file`, `notes->note`, `values->value`) while keeping the stripped base for
longer ones (`responses->respons`), and leaves the existing `-ies/-ied/-ing/-ed` rules
alone. `docs/memory.md` states the now-common behaviour; `5f4426b` scopes that sentence so
it does not claim the heuristic is universal. Independent reviewer subagent: **PASS**.

Item: orchestrate-commands smoke was not environment-hermetic - 60cd2c6 -
`PI_KIT_INTERNAL_CHILD=1 npm run smoke:orchestrate-commands` (7/7; 3/7 on the base) and the
plain `npm run smoke:orchestrate-commands` (7/7).
The smoke cleared only `PI_KIT_ORCH_DISABLE` and never `PI_KIT_INTERNAL_CHILD`, so an
ambient kit-child environment changed what it measured: under `PI_KIT_INTERNAL_CHILD=1` it
failed three checks (E3 names a plan; no registry: one line; `ENOENT
.pi/task-classification.json`) while peer smokes (`tool-capture-smoke.ts`,
`memory-vault-smoke.ts`) call `isolateKitEnv()`. All six sites now use `isolateKitEnv()` and
the unused `setEnv` import is gone. HANDOFF carry-over #4 is closed.

Verification: `autonomy/cycles/luna-core-01/24/verify.md` lists every run. Targeted checks
only; `npm test` and `npm run check:all` were never run. Base-failure evidence for both
findings is recorded there.

Workflow: refused the workflow run could not be budgeted (plan-allowance): E3 allows 8
planned agents a request; after the three review scouts and the Item 1 plan the second
gated plan did not fit, and `subagent` then refused too (3/3 children spent). Item 2 was
implemented and reviewed directly, and the whole-diff review was done directly; see
`verify.md`.

Not done / next cycle: V-07/V-08 still need the operator's in-tree finding list; the
skill-router `re:` switch-off outliving the session (proposal 17), the firewall timing-noise
best-of-nine fix (proposal 11), and the CodeQL config name (proposal 19) remain operator
decisions. The stemmer stays a heuristic for s-ending singulars; a lexicon is out of scope.
