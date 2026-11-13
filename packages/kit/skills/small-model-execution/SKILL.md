---
name: small-model-execution
category: context-and-small-models
description: Execute reliably on a small/local model with limited context. Use when running on a local model — favours short plans, tiny reads, narrow patches, exact paths, and distilled state over open-ended reasoning.
disable-model-invocation: true
triggers: ["small model", "local model", "ollama", "llama.cpp", "lm studio", "lmstudio", "limited context window", "small context window"]
---

# Small Model Execution

Small models fail by drifting, over-reading, and looping. Counter each with structure and
brevity.

## When to use
- Any session on a small or local model (limited context, weaker long-range reasoning).

## Rules
1. **Short plans.** A 2–5 step checklist, one active step (`task-decomposition`).
2. **Tiny reads.** Locate by search, read ranges not whole files, never re-read
   (`codebase-navigation`). `/trace` shows if you're repeating.
3. **Narrow patches.** Smallest diff, intended files only (`patch-hygiene`).
4. **Exact over vague.** Prefer concrete paths, symbols, and commands to broad prose
   reasoning — small models execute specifics far better than open reasoning.
5. **Distill output.** After any large tool result, keep the 1–2 facts you need; drop the
   rest so it doesn't crowd context.
6. **Checkpoint often** so a compaction or reset loses nothing
   (`context-management`).
7. **Verify each step** with the smallest check (`verification-loop`).

## Continuation / state
- Keep continuation state in a **stable, labelled block** (not narrative prose) so it's
  cheap to re-parse after compaction.
- If the engagement-governance domain is loaded, use `pi_system_governance.state_summary`
  (`max_items` ≤ 5) as the durable-state index before asking for more context. Without
  that domain, use a plain checkpoint block (see `context-management`).

## Anti-patterns
- Long reasoning chains instead of a concrete next command.
- Reading whole files / re-reading.
- Repeating a command with tiny variations (loop) — stop and act or delegate
  (`self-reflection-and-recovery`).

## Done
The step advanced with minimal reads and a small verified diff, and state is captured in a
stable block for the next turn.
