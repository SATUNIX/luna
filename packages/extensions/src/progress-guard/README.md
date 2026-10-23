# progress-guard

The auto-boost / anti-loop layer. It watches for cheap "stuck" signals and helps the agent
break out — by prompting a self-reflection and, on autonomous runs, nudging it to delegate
the stuck work to a fresh sub-agent. It is **assistance, not bug-fixing**.

## What it detects

From the tool calls it observes (it maintains its own small window; it also complements the
`trace-ledger` facts on disk):

- **Repetition** — the same action (tool + args) repeats `PI_KIT_GUARD_REPEAT` times
  (default 3) in the recent window (nothing pins this signal).
- **Oscillation** — a strictly alternating A→B→A run since the last write
  (`PI_KIT_GUARD_OSC`, default 3; nothing pins this signal).
- **Read-without-progress** — `PI_KIT_GUARD_STALL` reads (default 10) since the last edit.
  The threshold is 10, not 6: a fresh session often opens with 6–9 orienting reads, and firing
  there was a false positive. Repeated stalls escalate (`tests/progress-guard-agsix-smoke.ts`;
  nothing pins the default of 10). In a session with **no
  write-capable tool active** (a read-only role) the read-stall signal is suppressed entirely —
  there is no edit the agent could make, so "reads since last edit" is not a stall
  (`tests/liveness-containment-smoke.ts`).

A write/edit that actually **succeeds** resets the stall counter and stands down any active
nudge — progress clears the signal. A failed write/edit attempt does not (AG-06): otherwise
a loop that repeatedly attempts the same failing edit would silently reset its own
detection on every attempt, before the result was even known
(`tests/progress-guard-agsix-smoke.ts`).

## What it does (the autonomy dial)

`PI_KIT_GUARD_MODE` (overridable per session with `/boost`):

- **`auto`** — inject a guidance nudge **and** notify. The nudge reaches the model inside the
  run that is looping: `turn_end` returns it as a hidden `custom_message` entry, which pi appends
  after that turn's tool results, so the next model request of the same run sees it
  (`tests/progress-guard-agsix-smoke.ts`). It is also written as a `context-sieve` contribution
  for the next prompt.
  The autonomous profile should set `PI_KIT_GUARD_MODE=auto`.
- **`suggest`** (default) — notify a suggestion only for the first firings; never inject the
  light nudge.

Nothing pins the difference between the two modes; `tests/liveness-containment-smoke.ts` runs
in `suggest`.

### Automatic review / delegate escalation

Once the **same signature keeps recurring** (`PI_KIT_GUARD_ESCALATE`, default 2 firings), the
stronger **review/delegate checkpoint** is injected **unconditionally** — in either mode and
with no `/reflect` or `/boost` needed. It is written as a `context-sieve` contribution *and*
as a `.pi/recovery/sessions/<session id>/escalation.json` marker (`.pi/recovery/escalation.json`
for a session without an id) so this session's `recovery-orchestrator`, and no other session's,
can act on it (`tests/recovery-grounding-smoke.ts`). It is also delivered inside the looping run
the same way as the light nudge, on the episode's first escalation and then at most once per
cooldown (`tests/progress-guard-agsix-smoke.ts`). This is the
automatic replacement for the manual `/reflect` step. Escalation counts every firing turn, not
just the ones the cooldown let a nudge through, so a slowly-repeating stall can still escalate,
and the marker is written once per stuck episode (`tests/progress-guard-agsix-smoke.ts`).

It **never blocks a tool** and **never emits a system prompt** — guidance goes into the running
loop as a hidden `custom_message` entry and into later prompts through a `context-sieve`
ctx-contribution. The light nudge is debounced per signal (`COOLDOWN_TURNS`). Nothing pins the
no-block and no-system-prompt claims beyond the handlers returning nothing in the smokes above.

## Commands

Nothing pins these commands.

| Command | Effect |
| --- | --- |
| `/reflect` | Optional manual checkpoint. The recurring-loop checkpoint is injected automatically; use this only when you want one on demand. |
| `/boost on` | Auto-nudge on detected loops for this session. |
| `/boost off` | Suggest-only; clears any active nudge. |
| `/boost status` | Show mode, reads-since-edit, window size, and thresholds. |

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `PI_KIT_GUARD_MODE` | `suggest` | `auto` or `suggest`. |
| `PI_KIT_GUARD_REPEAT` | `3` | Repeat count that trips the loop signal. |
| `PI_KIT_GUARD_STALL` | `10` | Reads since last edit that trip the stall signal. |
| `PI_KIT_GUARD_OSC` | `3` | Minimum alternating A→B→A run that trips the oscillation signal. |
| `PI_KIT_GUARD_ESCALATE` | `2` | Firings of one signature before the automatic review/delegate checkpoint. |

## Relationship to other pieces

```
trace-ledger (facts)  ─┐
progress-guard         ─┼─ detect → reflect → (auto) nudge → delegate
self-reflection-and-recovery (skill the nudge points to)
      │ still stuck after delegating
      ▼
docs/recovery-orchestration-mode.md  (deep multi-agent root-cause; design)
```
