---
argument-hint: "[findings]"
---

# Report Export Review

Review report readiness.

Scope: ${@:-every finding in the current report}

Return:

- Findings ready for export
- Findings blocked and why
- Missing evidence IDs
- Sensitive data to redact
- Unsupported claims to remove
- ROE or data-handling concerns
- Operator decisions needed
