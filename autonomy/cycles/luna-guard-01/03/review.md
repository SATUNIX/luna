# Cycle 03 review — luna-guard-01 (guard stream)

## Inputs read

- `autonomy/CHARTER.md` (current stream charter).
- Cycle 01 `report.md` and `verify.md` on this branch.
- Cycle 02 `report.md`, `verify.md` and `HANDOFF.md` from
  `origin/attempts/luna-guard-01/cycle-02` (not merged: acceptance red, review REJECT).
- Proposals `autonomy/proposals/luna-guard-01-01-*.md` and
  `luna-guard-01-02-register-refusal-record-script.md`.
- `git log --oneline e52f4362f991..origin/attempts/luna-guard-01/cycle-02`.

## Mode

**Fix mode.** Priority 0 (red gate) plus the carried-over PG-24 board item.

## Findings

### 0. Red gate: `smoke:extension-manifest-hooks` fails after the cycle-02 refusal records

Reproduced on this branch after cherry-picking the cycle-02 code commits:

```
$ npm run smoke:extension-manifest-hooks
AssertionError: secret-guard: packages/extensions/src/secret-guard/shared/refusal-record.ts
  imports "node:crypto" but runtime.nodeBuiltins declares [node:fs, node:path]
exit 1
```

Root cause: cycle 02 added `shared/refusal-record.ts` (imports `node:crypto`) and
`shared/safe-fs.ts` to `packages/extensions/src/secret-guard/`, but did not add `node:crypto` to
`packages/extensions/src/secret-guard/extension.json` → `runtime.nodeBuiltins`. The manifest-hooks
smoke walks every `.ts` file under the extension (including generated shared copies), so the
generated copy made the manifest under-declare a builtin. This is exactly the failure the cycle-02
host gate reported and the cycle never diagnosed. Evidence: `extension-manifest-hooks-smoke.ts:328`
(the nodeBuiltins assertion) and the assertion text above.

### 1. PG-24 carry-over is sound but has one untested guarantee

Cycle 02 implemented one structured `tool_refused` record per refusal in both guards
(`packages/core/shared/refusal-record.ts`: digest, session id, best-effort append with rotation;
`tool-firewall/index.ts` `blocked()`; `secret-guard/index.ts` `blocked()`). Reviewer rejection
concerns:

- **Gate red** (finding 0) — fix in this cycle.
- **Acceptance filename** `tests/firewall-refusal-record-smoke.ts` — cannot be used: `wiring.ts`
  (`SUITE` regex, line 33) treats every `*-smoke.ts` as a suite requiring a `package.json` script,
  and a manifest `scripts` change is refused before review. The existing workaround
  (`tests/firewall-refusal-record.ts`, imported by the wired `tests/firewall-outcomes-smoke.ts`) is
  kept and recorded in the report. Proposal
  `luna-guard-01-02-register-refusal-record-script.md` asks the operator to register it.
- **Secret-content refusal record** — `detectSecretContent()` returns a pattern *label*
  (`secret-guard/index.ts:766-771`, labels at `:72-81`), not the matched text, so the record is
  safe by construction, but no test pins it. The suite covers a path refusal and a transfer
  refusal only. Add a content-refusal case asserting the cause, the label in `matched`, and that
  the secret value and full content never appear in the record.

### 2. Not taken this cycle (recorded, not a defect in scope)

- `luna-ops/luna-metrics.py` still scrapes session JSONL; consuming `tool_refused` there is a
  follow-up for the next cycle (it is not the PG-24 acceptance test).
- Cycle 01 proposals (quoted search token, `glob` adapter, standalone corpus script) remain open
  and are control-path/behaviour work outside this cycle's grant.
