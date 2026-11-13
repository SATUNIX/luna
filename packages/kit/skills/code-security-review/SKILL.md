---
name: code-security-review
category: engagement
description: Review source code for security issues on an authorized, source-assisted assessment. Use when auditing a repo for vulnerabilities — trace inputs to dangerous sinks, produce reproducible findings with file:line and evidence.
disable-model-invocation: true
triggers: ["security review", "security audit", "audit the code for", "vulnerability", "vulnerabilities", "sql injection", "command injection", "xss", "ssrf", "sast"]
---

# Code Security Review

Find real, reproducible security issues by reasoning from untrusted input to dangerous
sink, backed by exact code references.

## When to use
- Authorized source-assisted security assessment of a repository.

## Preconditions
- Confirm **repository scope** and the exact **branch/revision** under review.

## Procedure
1. **Map the attack surface.** Entry points (routes, handlers, message consumers, CLI),
   trust boundaries, and where external input enters.
2. **Follow the data.** Trace untrusted input toward dangerous sinks: injection
   (SQL/command/template), deserialization, path traversal, SSRF, authz checks, unsafe
   reflection/eval.
3. **Check the cross-cutting areas.** Authentication/authorization, secrets handling,
   crypto usage, error handling/information leakage, dependency risk
   (`supply-chain-review`).
4. **Confirm reachability.** A sink is only a finding if untrusted input can actually reach
   it — verify the path, don't assume.
5. **Record reproducibly.** File path + line references + evidence IDs; a concrete
   input→sink trace, not a vague concern.

## Efficiency
- Locate by search/structural map, read the relevant spans, don't tour the repo
  (`codebase-navigation`).

## Governance
- Do not run build/test/scanner actions that mutate state or contact external systems
  without local classification and approval (`mcp-tool-use`, `action-card-builder`).

## Anti-patterns
- Flagging a sink without proving input can reach it.
- Grepping for patterns and reporting matches as findings.
- Reading the whole codebase before narrowing to the surface.

## Done
Each issue has a verified input→sink path, file:line references, and evidence IDs; promote
via `hypothesis-lifecycle` → `finding-writing`.

## References
- `references/source-sink-catalogue.md` — taint sources, sink families → bug classes,
  sanitizers that work vs common fakes, second-order/chain notes, and the review pass order.
