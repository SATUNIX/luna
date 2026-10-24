# recovery-orchestrator

The deep root-cause recovery layer (`docs/recovery-orchestration-mode.md`, §2). It is the
escalation target for `progress-guard`: when assistance (nudging) hasn't broken a loop,
`progress-guard` writes `.pi/recovery/sessions/<session id>/escalation.json`, and on the next
`turn_end` this extension enters recovery **once** for that signature. It reads, consumes and
clears (on `session_start`) only its own session's marker, so a child or a second session in the
same cwd cannot erase or act on it; a session without an id uses the flat
`.pi/recovery/escalation.json`, and a marker that names another session is ignored
(`tests/recovery-grounding-smoke.ts`).

## What it does

1. Writes a **recovery report scaffold** to `.pi/recovery/<n>-<signature>.md`, where `<n>` is the
   first free number from the attempt number up, so each entry gets a fresh report (scout
   findings, incumbent top-10, ranked synthesis, primary + backup plan, outcome;
   `tests/recovery-grounding-smoke.ts`). Its "recorded action history" section summarises the last
   30 entries of `.pi/trace.jsonl`, read from at most the final 256 KiB of the file and, when the
   live file holds fewer than 30, from the end of the rotated `.pi/trace.jsonl.1`
   (`tests/recovery-grounding-smoke.ts`). A field of the wrong type in a line (a non-string tool or
   target) is dropped rather than printed (`tests/recovery-grounding-smoke.ts`).
2. Drops a high-priority **`context-sieve` contribution** steering the §2 flow with the tools the
   model can call: fresh scouts through the `subagent` tool, one more `subagent` task given a
   digest of the history for the top-10 causes, synthesis, a primary + backup plan (it notes that
   `git-checkpoint` snapshots each turn on its own), the repair delegated to an `implementer`,
   then the `verify_completion` tool. It names no slash command; forking the session is left to
   the operator (`tests/recovery-grounding-smoke.ts`).
3. Bounds attempts per signature within one stuck episode (`PI_KIT_RECOVERY_MAX_ATTEMPTS`,
   default 2). A successful write or edit tool result whose path names a file outside `.pi/` ends
   the episode and resets the count for every signature, so resolved episodes do not add up to
   the cap. Writes under `.pi/` (such as filling in the recovery report) and writes naming no
   path do not reset it, so following the steer still reaches the cap
   (`tests/recovery-grounding-smoke.ts`). Past the cap it does not enter recovery again: it
   notifies the operator to escalate (dual-review) instead of spawning more (nothing pins the
   wording), emits `pi-kit:recovery-blocked` on the event bus, which stops this session's
   `/loop` (`autonomous-loop`) before it queues another turn, and records the disposition in
   `.pi/recovery/blocked-<session id>.json`. A `pi-kit:recovery-blocked` event naming another
   session does not stop the loop (`tests/liveness-containment-smoke.ts`).

## What it does NOT do

Nothing pins the three limits below; they describe what the code has no path to do.

- It never edits code or reverts changes — it plans and steers. Repairs happen through the
  delegated `implementer` after a `git-checkpoint`.
- It never emits a system prompt — `context-sieve` is the sole injection authority.
- It does not spawn sub-agents itself; the model calls the `subagent` tool per the steer.

## Trigger

- **Automatic:** `progress-guard` escalation marker (a repeat/oscillation/stall signature
  nudged `PI_KIT_GUARD_ESCALATE` times).
- **Manual:** `/recover [signature]` (`tests/liveness-containment-smoke.ts`).

## Env

- `PI_KIT_RECOVERY_MAX_ATTEMPTS` (default 2) — recovery attempts per signature, between
  successful writes outside `.pi/`, before giving up to the operator.
- `PI_KIT_RECOVERY_SCOUTS` (default 3) — how many fresh scouts the steer asks for (nothing
  pins the default).

Ships in `long-horizon`, `autonomous`, and `self-improving` (the recovery-heavy tiers).
