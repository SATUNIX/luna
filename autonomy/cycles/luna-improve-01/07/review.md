# Cycle 07 review — luna-improve-01

Base: `7c27fa965e06af77cda731d25310fdf955f48430` ("docs(autonomy): record cycle 06 — list every
commit and the true diff stat"), which is the pushed head of `pi/luna-improve-01` and stands in for
`integration/luna` in this clone (no `integration/luna` ref exists; every prior cycle names
`a385401` as the seed and this cycle's base is the previous cycle's tip).

Previous cycle (06) was **records-only**: it changed nothing under `packages/`, `tests/` or `docs/`.
Its report and `HANDOFF.md` therefore carry no unfinished code work; the handoff asks for a
consolidation pass over the carried test-harness code, then the next evidenced fix.

## Method

Read `autonomy/CHARTER.md`, `autonomy/BACKLOG.md`, `autonomy/HANDOFF.md`, cycle 06's `report.md`
and `git log`. One `scout` subagent (read-only) checked every open backlog item against the actual
code, ran the individual smokes for the carried test-harness files, and hunted for new evidenced
problems. The scout's findings were then re-checked at `file:line` before being accepted.

## Findings

### 1. `.github/workflows/release.yml` still returns `undefined` from `require("./pack.json")[0]` (B-007) — confirmed, out of bounds to edit

`.github/workflows/release.yml:136` and `:138` both do `const p=require("./pack.json")[0]`. Under
npm 12.2.1 `npm pack --json` prints an object keyed by package name, so `[0]` is `undefined`:

```text
$ npm pack --dry-run --json --ignore-scripts | head -c 40
{
  "@satunix/pi-system": {
$ npm pack --dry-run --json --ignore-scripts > /tmp/pack.json
$ node -e 'console.log(require("/tmp/pack.json")[0].filename)'
TypeError: Cannot read properties of undefined (reading 'filename')
```

The `plan` job throws before writing `tarball=`/`integrity=`, so the release/publish jobs get no
inputs. `tests/release-workflow-smoke.ts` only pattern-matches the workflow text, so no check
catches it. The charter puts release and publish pipelines **out of bounds**; the in-bounds action
is a proposal to the operator under `autonomy/proposals/` (charter item 8), which this cycle adds.
`packReports()` in `packages/core/build-npm.ts` is the in-repo helper for both shapes.

### 2. `runtimeLock()` closes only `dependencies`, and its closure path is never exercised (B-008) — confirmed, latent today

`tests/clean-install-smoke.ts:52-68` copies the artefact's runtime dependency entries from the root
`package-lock.json` and follows only `entry.dependencies`; `optionalDependencies` and
`peerDependencies` of a copied entry are dropped. The current artefact depends on exactly
`quickjs-wasi` (asserted at `tests/clean-install-smoke.ts:181`), and its lock entry has no edge
lists at all:

```text
$ node -e 'const e=require("./package-lock.json").packages["node_modules/quickjs-wasi"]; console.log("deps",!!e.dependencies,"opt",!!e.optionalDependencies,"peer",!!e.peerDependencies)'
deps false opt false peer false
```

So nothing breaks today, but the "closed transitively" loop body (line 64) never runs and the
optional/peer gap is real the moment the runtime dependency tree grows. The smoke itself passes
(11 checks). This is the handoff's consolidation item: an incomplete, untested helper.

### 3. No test pins `installDelegation()`'s environment restoration — confirmed, missing test

`packages/core/eval/delegation.ts:47-82` captures `isolateKitEnv()`, sets `PI_CODING_AGENT_DIR` and
`PI_KIT_EFFORT` for the extensions it loads, and `cleanup()` deletes those two and calls the closure
to restore the caller's environment. `tests/env-isolation-smoke.ts:70-95` proves `isolateKitEnv()`'s
own closure, but no test calls `installDelegation()` and asserts the environment it was handed is
returned exactly. The carrying commit `fe8a128` was verified only indirectly (later checks in the
same process did not break), and every consumer registers `cleanup` on `process.on("exit")`, so a
regression in the delete/restore order would pass unnoticed.

## Backlog hypotheses checked

- **B-001 (web-ui version), B-002 (detached double log), B-003 (npm 12 pack shape), B-004 (offline
  clean-install), B-005 (ambient kit env), B-006 (rootless firewall smoke):** all `done` and
  re-confirmed by the scout running their smokes green. Not re-diagnosed.
- **B-007:** confirmed; handled by a proposal this cycle (finding 1).
- **B-008:** confirmed, latent-only (finding 2); taken this cycle.

## Checked and clean (not re-diagnosed)

- `tests/clean-install-smoke.ts`, `tests/firewall-unattended-smoke.ts`, `tests/autonomy-cli-smoke.ts`,
  `tests/web-ui-api-smoke.ts` — run green by the scout (11, 15, 15 checks, web-ui all).
- `packages/core/build-npm.ts` / `packages/core/pack-check.ts` — `smoke:package` green;
  `packReports()` reads both npm shapes.
- `packages/extensions/src/tool-firewall/unattended.ts` — namespace/provenance logic matches the
  docs; no reachable wrong security branch found.
- `packages/web-ui/server/routes.ts`, `configinfo.ts` — version resolution correct; no other
  hard-coded `0.1.0` in web-ui source.
- Docs: `npm run docs:check` exit 0; no `0.1.0` drift in `docs/`/`README.md`;
  `docs/supply-chain.md`, `docs/autonomy.md`, `docs/autonomy-gate.md`, `docs/security.md`,
  `docs/beta.md`, `docs/future-work.md` match the code.
- `npm run test:typecheck`, `npm run test:lint`, `npm run verify`, the wiring check — all exit 0.

## Mode

**Fix mode.** Priority 2 (finish the carried consolidation the handoff names) and priority 5
(tests for untested behaviour), with priority-8 proposal handling for the out-of-bounds B-007.
No failing acceptance check and no higher-priority correctness/security bug was found.
