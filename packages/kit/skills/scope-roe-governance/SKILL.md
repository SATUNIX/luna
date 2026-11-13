---
name: scope-roe-governance
category: mcp-governance
description: Enforce deterministic scope and rules-of-engagement checks before any engagement action. Use whenever planning or reviewing tool use on an engagement — scope/ROE files are the authority, deny overrides allow, unknown is out.
disable-model-invocation: true
triggers: ["rules of engagement", "roe", "scope file", "out of scope", "in-scope target", "in scope target"]
---

# Scope and ROE Governance

Scope and ROE are the authority for what may be touched and how. Model judgement never
overrides them.

## When to use
- Before proposing, planning, or reviewing any tool use on an engagement.

## Rules (deterministic)
1. **Files are authority.** The scope files and ROE files decide; your reasoning does not.
2. **Deny overrides allow.** If any deny rule matches, the action is denied — full stop.
3. **Unknown is out.** An asset not covered by an allow rule is **not** in scope.
4. **Discovered ≠ in scope.** A newly found host/endpoint/object is a *candidate* until the
   operator or an overlay explicitly adds it.
5. **Check the operational limits** before active testing: time windows, rate limits, and
   data-handling rules.
6. **Missing scope/ROE = stop.** If scope or ROE isn't loaded, ask the operator to load it
   before proposing any active action.

## Procedure
1. Resolve the target asset(s) against scope (allow), then against deny — deny wins.
2. Confirm the action's classification is permitted for that asset
   (`tool-policy-classifier`).
3. Confirm time window / rate / data-handling constraints for active actions.
4. If allowed, proceed to an action card (`action-card-builder`); if not, stop and report why.

## Anti-patterns
- Treating a discovered asset as in-scope.
- Letting an allow rule override a matching deny.
- Proceeding when scope/ROE is absent "to save time."

## Done
The action is provably within scope, passes deny checks, respects operational limits, or is
cleanly refused with the reason — no reliance on judgement over the files.
