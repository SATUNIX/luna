# Cycle 09 plan — luna-ops-01

**Mode:** Fix (default). One assigned item implemented and tested; the other recorded as a
decision.

**Goal:** Bound concurrent acceptance gates on one host (PG-50) so sibling runs stop flaking on
gate contention, without changing anything inside the gate container; record the PG-53
tool-firewall unattended decision with its two honest options.

## Board items

### PG-50 [P0, rank 1] — cap concurrent gate containers

- **Charter fit:** real evidenced problem (no host-wide bound; `runlock.ts` is per-run, gate
  spawns are unserialized), tested, documented, scoped to the ops stream, changes no operator
  control path and no `package.json` scripts.
- **Intended change, host-side only:**
  - New `packages/autonomy/lib/gate-slots.ts`: an `flock`-based host-wide slot set under
    `stateHome()/gate-slots/`. `resolveGateSlots()` reads `PI_AUTONOMY_GATE_SLOTS` (default `2`,
    `0` = unbounded, invalid → 2). `acquireGateSlot()` takes a slot, polling until free; release
    by closing the fd / killing the holder's `flock` child (auto-release on death).
  - `lifecycle.ts`: add `"gate-wait"` to the `RunState.phase` union.
  - `engine.ts`: optional `EngineOptions.gateSlots`, `gateSlotsHome`, `gateSlotAcquire`
    (test seam); default limit `resolveGateSlots()`, default home `stateHome()`. New
    `withGateSlot(fn)` sets `gate-wait`, pauses wall-clock accrual (`clockPaused`), heartbeats
    while waiting, then sets `acceptance` and runs `fn`, releasing in `finally`. Wrap the four
    acceptance call sites: `evaluateStep` (engine), `salvageReport`, `closeCycle` and `finalize`
    (self-improve).
  - `tests/autonomy-harness.ts` and the two direct `new Engine` sites in
    `tests/autonomy-run-smoke.ts` pass `gateSlots: 0` so existing suites stay unbounded.
  - Docs: `packages/autonomy/README.md`, `docs/autonomy.md`.
- **Not changed:** the gate container, its args, any check, the per-run lock.
- **Proving checks:**
  - `npm run -s smoke:autonomy-lifecycle` — new tests: `resolveGateSlots` parsing; N=2 overlaps at
    most two with a third waiting then running; a SIGKILL-ed holder frees its slot; N=0 is
    unbounded; `withGateSlot` shows `gate-wait`, heartbeats it, does not accrue minutes, and runs
    `fn` after acquiring.
  - `npm run -s smoke:autonomy-run`, `npm run -s smoke:autonomy-selfimprove` — no regressions.
  - `npm run test:typecheck`, `npm run test:lint`.

### PG-53 [P0, rank 53] — tool-firewall unattended namespace

- **Decision:** not implemented this cycle; it is a security-review decision.
- **Why:** deleting or loosening the check weakens a fail-closed control (standing preference).
  The two honest paths (worker in the initial user namespace, or a two-sided namespace proof
  admitting a real container worker) are an operator/security decision, outside the ops stream.
- **Deliverable:** `autonomy/proposals/luna-ops-01-09-tool-firewall-unattended-namespace.md` with
  the evidence, the two options, and the acceptance test each needs.

## Proving the cycle

- Targeted smokes only (never `npm test` / `npm run check:all`).
- Independent review of the diff against the charter and the assigned items, gated on `PASS`.
- Diff measured against `83a3ad8` excluding lockfiles and `autonomy/cycles|luna-ops-01`,
  `autonomy/runs|luna-ops-01`; stop taking items past 30,000 chars.

## Task graph

1. Implement PG-50 (implementer).
2. Independent review of PG-50 (reviewer, gated).
3. Verify: targeted smokes, typecheck, lint (main).
4. Record PG-53 proposal and cycle records (main).
