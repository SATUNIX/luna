---
name: context-management
category: context-and-small-models
description: Keep long work recoverable across compaction, resets and session boundaries — maintain a checkpoint, compress without losing the thread, and pick the right control (/compact, /fork, /clone, /new). Use for multi-step or multi-hour work, when context is getting heavy, or before any reset.
disable-model-invocation: true
triggers: ["running out of context", "context is getting full", "context is getting long", "context is heavy", "before compacting", "before /compact", "/fork", "/clone", "update the checkpoint", "write a checkpoint", "long-running task", "multi-hour", "multi-day"]
---

# Context Management

A checkpoint is what lets a fresh context — after compaction, recovery or a new session —
carry on as if nothing was lost. Resetting context is cheap. Losing your thread is expensive.

## The checkpoint (keep it current as you go)
Keep a compact, labelled block with:
- Objective and current status; constraints and non-negotiables
- Files inspected · files changed
- The plan, with **exactly one active step**
- Decisions and their reasons · failed attempts and their errors · verification already run
- Open questions and the **next command or action**

Rules:
- Update it as you work, not only at the end.
- Plain text, no secrets. Refer to sensitive values by reference.
- Use a stable format that a small model can parse cheaply.
- **On resume, read the checkpoint first**, before any raw files.

(The memory vault also writes a recap after every turn, and the first prompt of a new
session gets background history from earlier sessions, not a resume instruction. The
checkpoint is the in-session, step-level record.)

## Compressing
Keep: objective, constraints, files, decisions, failures, verification, next action.
Drop: repeated logs and raw output (keep a one-line distillation), superseded reasoning.
Never compress away the objective or the next action.

## Choosing a control
- Context heavy, thread still matters: **`/compact`** (or `/compress` for an instant,
  no-model version).
- Try approach B without losing A: **`/fork`**; `/tree` to switch branches.
- Duplicate the session here: **`/clone`**.
- New task or a genuine restart: **`/new`**, after updating the checkpoint or running
  `/handoff`.
- Auto-compaction is pi's own setting. `/compaction` shows and changes it.

## Anti-patterns
- `/new` mid-thread with no checkpoint.
- A stale checkpoint (worse than none: it misleads the resume).
- Keeping raw dumps "just in case", or narrative summaries a small model must re-reason.

## Done
A current, secret-free checkpoint exists. Any reset used the control that matched the
intent, and resuming needs no re-discovery.
