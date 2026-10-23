---
name: validation-test-maintainer
category: maintainer
description: Keep the kit's validation checks aligned with required profile and runtime contracts. Use when adding required files, prompts, skills, policy fields, or runtime behavior — add deterministic, offline-runnable checks so contracts can't silently drift.
disable-model-invocation: true
triggers: ["add a smoke test", "smoke test for", "check:all", "verify.ts", "validation check"]
---

# Validation Test Maintainer

A required resource without a check is a contract that will silently break. When you add a
requirement, add the check that enforces it.

## When to use
- Adding or changing required files, prompts, skills, policy fields, or runtime behaviour
  that something else depends on.

## Rules
1. **Presence checks** for required profile/surface resources (the file/skill/prompt exists
   where the contract says).
2. **Content checks** (string or schema) for high-value safety defaults — not just that a
   file exists, but that the critical field/default is right.
3. **Runnable in CI and local Git Bash** — the checks the kit already uses
   (`packages/core/verify.ts`, `tests/epic*-smoke.mjs`) are the model; extend them.
4. **Deterministic and offline.** No dependency on a live target or network.
5. **Document** any verification that genuinely cannot run offline, and why.

## Procedure
1. Identify the new contract (what must be true).
2. Add the narrowest deterministic check that fails when it's violated.
3. Run `node packages/core/verify.ts` and the smoke tests; confirm the check catches a deliberately
   broken case.
4. Keep checks fast and independent of engagement data.

## Anti-patterns
- Adding a required resource with no check.
- A check that needs network/live targets to pass.
- Asserting on volatile output that flaps in CI.

## Done
The new contract has a deterministic, offline check that's wired into verify/smoke and
proven to fail on violation.
