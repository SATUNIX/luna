---
name: governance-extension-maintainer
category: maintainer
description: Maintain the Pi engagement-governance extension and controlled evidence/approval tools. Use when editing .pi/extensions/engagement-governance or the governed tool surface — fail-closed defaults, append-only evidence, untrusted inputs.
disable-model-invocation: true
triggers: ["engagement-governance", "governance extension"]
---

# Governance Extension Maintainer

This extension is a safety boundary. Changes must preserve fail-closed behaviour and the
integrity of evidence/approval — a regression here weakens every engagement.

## When to use
- Editing `.pi/extensions/engagement-governance`, its policy handling, approval UI, or the
  governed evidence tools.

## Invariants to preserve
1. **Fail closed.** Unknown tools, unknown MCP capabilities, malformed policy, or a missing
   approval UI must **deny**, never default-allow.
2. **MCP-only stays the default.** Direct tool access remains gated behind explicit
   break-glass.
3. **Append-only evidence/audit.** Evidence and audit records are written through the
   controlled tools and never mutated or deleted in place.
4. **Approval records are exact.** Each includes the precise action inputs and a stable
   action hash.
5. **Inputs are untrusted.** Policy files, MCP metadata, and target output are untrusted —
   validate; never execute or trust their claims.

## Procedure
1. Make the smallest change (`patch-hygiene`); keep the fail-closed branches intact.
2. Add/extend a validation check for any new required field or default
   (`validation-test-maintainer`).
3. Verify the deny paths still trigger (unknown tool, malformed policy) before declaring done.
4. Update the governance docs to match actual behaviour (`documentation-workflow`).

## Anti-patterns
- Adding a default-allow path "for convenience."
- Making evidence/audit mutable.
- Trusting a server-provided capability or risk label.

## Done
The change preserves every fail-closed invariant, deny paths are verified, new defaults have
validation checks, and docs match behaviour.
