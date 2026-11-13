---
name: burp-web-triage
category: engagement
description: Triage Burp-derived web evidence into endpoint observations and hypotheses. Use when normalizing Burp MCP history/sitemap output into evidence records during a web/API assessment.
disable-model-invocation: true
triggers: ["burp"]
---

# Burp Web Triage

Use Burp MCP as an evidence source, not as the workflow authority.

- Read history and sitemap only when classified as read-only.
- Normalize requests and responses into generic evidence records.
- Identify endpoints, auth states, parameters, and candidate vulnerability classes.
- Do not replay or modify requests without an approved action card.
