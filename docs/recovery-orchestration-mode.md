# Recovery Orchestration Mode

> The `recovery-orchestrator` extension implements this mode (see §8).
> `progress-guard` detects loops, stalls and oscillation and, after `PI_KIT_GUARD_ESCALATE` nudges
> on the same signature, writes the session's `.pi/recovery/sessions/<session id>/escalation.json`
> (`tests/recovery-grounding-smoke.ts`); that session's `recovery-orchestrator` then
> enters this deep mode once per signature: it writes a recovery report scaffold and steers the
> §2 flow via a `context-sieve` contribution (never a system prompt). It is non-destructive
> (plans and steers; the repair is a delegated `implementer` after a checkpoint) and bounded to
> `PI_KIT_RECOVERY_MAX_ATTEMPTS` per signature; a successful write or edit to a named file outside
> `.pi/` resets the count, and writes to the recovery report do not (`tests/recovery-grounding-smoke.ts`). The
> steer names only tools the model can call: `subagent` stands in for the `/fork` of step 2 (a task
> given a digest of the history) and the `verify_completion` tool for re-verifying, since `/fork`
> and `/verify` are operator commands (`tests/recovery-grounding-smoke.ts`). Manual trigger:
> `/recover`. While recovery is active it opens the separate recovery budget in the [effort ledger](effort.md#how-delegation-is-budgeted)
> (two read-only scouts), so a session at the lowest effort can still get help when stuck. The
> `npm run eval` recovery fixtures cover it. This document is the specification of the method the
> extension drives.

## 1. Problem

Autonomous coding runs get *stuck*: the agent tries a fix, it doesn't work (or makes
things worse), it tries a variation, and it burns context looping on the same wrong
mental model. A single context that has already failed N times is the worst possible
place to diagnose the failure — it is anchored on its own bad hypothesis.

The fix is to **break context anchoring**: pull in fresh, independent investigators,
force the incumbent context to enumerate causes explicitly, then synthesise and
delegate the actual repair. This mode automates a method the operator already runs by
hand.

## 2. The method

1. **Fan out fresh scouts.** Spawn 2–3 sub-agents with *fresh context* (no memory of the
   failed attempts) to independently investigate the code and report suspected bugs /
   issues. Independence is the point — they must not see each other's or the main
   agent's conclusions.
2. **Interrogate the incumbent (in a fork).** `/fork` the main chat so the loaded
   context is preserved but the branch is disposable. Ask the forked main agent, which
   *does* have the full history: "What problems have we observed? What are we actually
   struggling with? List the **top 10 most likely causes.**"
3. **Synthesise in the fork.** Feed the 2–3 scout reports *plus* the forked main agent's
   top-10 into the fork. Now one context holds every angle: fresh outside views and the
   history-aware inside view.
4. **Plan primary + backup.** From the combined evidence, write a plan to fix the single
   **most likely** cause, plus a **backup plan** to run if the primary fix fails or
   regresses.
5. **Delegate the repair.** Hand the fix to specialist sub-agents, each given *just the
   right amount of context* — the target files, the chosen hypothesis, the acceptance
   check — and nothing else.

## 3. Trigger conditions

### Automatic
- **No progress after a few nudges.** `progress-guard` detects a repeat, stall or oscillation
  signature and nudges the agent. After `PI_KIT_GUARD_ESCALATE` nudges (default `2`) on the same
  signature it writes the session's escalation marker, and on the next `turn_end`
  `recovery-orchestrator` enters recovery for that signature (`tests/progress-guard-agsix-smoke.ts`,
  `tests/recovery-grounding-smoke.ts`).

Nothing else triggers it. A verification that still fails after an edit, or a check that
regresses, is not detected as a trigger; see [Future work](future-work.md#delegation-and-recovery).

### Manual
- `/recover [signature]` enters the same flow on demand (signature `manual` when none is
  given), writing the report scaffold and the steering contribution
  (`tests/ctx-contributions-smoke.ts`). It is the only recovery command.

### Anti-trigger / debounce
- It enters recovery at most once per escalation marker: the marker is consumed on entry, and a
  marker that names another session is ignored (`tests/recovery-grounding-smoke.ts`).
- Attempts per signature are capped at `PI_KIT_RECOVERY_MAX_ATTEMPTS` (default `2`) until a
  successful write or edit to a named file outside `.pi/`; past the cap it tells the operator to
  escalate instead of entering again (`tests/recovery-grounding-smoke.ts`).

## 4. Mapping onto existing kit primitives

This mode is an *orchestration* over pieces the kit already ships; it should not
reinvent them.

| Method step | Existing primitive |
|---|---|
| Fresh independent scouts | `subagent` tool + the `scout` role agent (`packages/kit/agents/scout.md`), fanned out 2–3× with `agentScope` isolating context |
| Fork the incumbent | pi built-in `/fork` (preserves loaded context on a disposable branch) |
| Enumerate top-10 causes | a recovery prompt (extend `packages/kit/prompts/code-recover.md`) run in the forked branch |
| Detect "fix failed / worse" | `verify-gate` + `verifier-board` verdicts; `git-checkpoint` diff vs last green checkpoint |
| Count attempts | `trace-ledger` (already records the action history) |
| Plan primary + backup | `spec-plan` / `plan-mode` for the plan artifact |
| Delegate repair | `orchestrator` → `implementer` role agent, one specialist per sub-task |
| Context assembly / injection | `context-sieve` is the **sole** injection authority — recovery drops a `ctx-contribution`, it does not inject a system prompt itself (follow the orchestrator's pattern) |
| Non-destructive rollback | `git-checkpoint` + `protected-paths` |

## 5. Context budgeting ("just the right amount")

The whole value is *who knows what*:

- **Scouts** get: the repo, the failing symptom, the acceptance check. **Not** the main
  agent's hypotheses or the attempt history — that would re-anchor them.
- **Forked incumbent** gets: everything it already has (that is the point of the fork).
- **Synthesis step** gets: scout reports + the top-10, and produces a *ranked* cause
  list with a single chosen primary.
- **Repair specialists** get: the chosen hypothesis, the specific target files, the
  acceptance check, and the backup trigger — not the full transcript, not the other
  candidate causes.

Keeping these context boundaries crisp is what makes the multi-agent approach beat a
single big context; blur them and you just pay more tokens for the same anchored answer.

## 6. Outputs / artifacts

- A **recovery report** scaffold at `.pi/recovery/<n>-<signature>.md`, where `<n>` is the first
  free number from the attempt number up, with sections for the failing signature, the scout
  findings, the incumbent's top-10, the ranked synthesis, the primary plan, the backup plan and
  the outcome (`tests/recovery-grounding-smoke.ts`). The model fills it in.
- The steering contribution for `context-sieve` (`tests/ctx-contributions-smoke.ts`).
- It writes no `trace-ledger` entry of its own and takes no checkpoint itself; the steer relies
  on `git-checkpoint`'s per-turn snapshots.

### Lifetime of the steering contribution

The recovery-orchestrator's steering contribution is intentionally session-scoped. It is written
when recovery is entered or the attempt cap is hit (`writeContribution` in
`recovery-orchestrator/index.ts`, from the `turn_end` hook and the `/recover` command) and is
cleared only on `session_start`, so it can persist for the rest of the session. It does not
repeat verbatim within a session because `context-sieve`'s message dedup suppresses an unchanged
contribution until compaction, comparing each contribution on its own
(`tests/context-budget-smoke.ts`). It is not cleared when recovery succeeds: there is no
completion signal, and the `boardPassing` check in `planRecovery` has no effect on the plan. No
test pins the lifetime.

## 7. Safety & autonomy fit

- **Non-destructive by default.** Recovery investigates and plans; it checkpoints before
  any repair and never reverts unrelated changes (same rule as `code-recover`).
- **Bounded fan-out.** Cap scouts (2–3) and cap total recovery attempts per signature to
  avoid a spawn storm on a genuinely hard bug — escalate to the operator instead.
- **Fits the autonomous profile.** It is a natural companion to `autonomous-loop`: the
  loop keeps working, and recovery is what the loop *does* when it detects it is stuck,
  rather than grinding. On non-autonomous profiles it should prefer to surface the plan
  and wait.
- **One injection authority.** Drop a `ctx-contribution` for `context-sieve`; do not
  emit a `systemPrompt`.

## 8. Shape

`recovery-orchestrator` is an extension: it hooks `session_start`, `tool_result` and `turn_end`,
keeps the per-signature attempt count, and on entry writes a priority-90 `ctx-contribution`
steering the main agent through §2 (`tests/ctx-contributions-smoke.ts`). It registers `/recover`.
The steer names the `recovery-debugging` skill, which covers recovering from a broken state by
hand. Open design questions (signature definition, a "worse" metric, scout independence, fork
automation, a budget ceiling) are listed in [Future work](future-work.md#delegation-and-recovery).

## 9. Related

- `packages/kit/skills/recovery-debugging/SKILL.md` — the current, minimal recover behaviour.
- `packages/kit/prompts/code-recover.md` — the recover prompt.
- `packages/extensions/src/orchestrator/` — the delegation pattern to mirror.
- `packages/extensions/src/autonomous-loop/` — the loop this mode defends.
- `docs/agent-orchestration.md`, `docs/capability-research-workflow.md`.
