---
name: endpoint-inventory
category: engagement
description: Build an endpoint inventory from normalized evidence during an API/web assessment. Use when cataloguing observed endpoints with method, auth state, source evidence, and scope status — without expanding scope.
disable-model-invocation: true
triggers: ["endpoint inventory", "enumerate endpoints", "list the endpoints", "catalogue endpoints", "catalog endpoints"]
---

# Endpoint Inventory

A clean inventory of what was actually observed — the backbone for `api-testing` and
coverage — built only from normalized evidence.

## When to use
- Assembling or updating the set of endpoints seen during a web/API assessment.

## Record per endpoint
- Path/route and **method** (keep method differences distinct — `GET /x` ≠ `POST /x`).
- **Auth state(s)** observed (anonymous, authenticated, per-role).
- **Source evidence IDs** it was derived from.
- **Scope status** (in-scope / candidate / out) per `scope-roe-governance`.

## Rules
- Build only from **normalized evidence** (`evidence-review` / `burp-web-triage`), not from
  guesses.
- **Do not add discovered hosts/endpoints to scope** — record them as candidates.
- Preserve differences; don't collapse distinct methods or auth states into one row.

## Done
The inventory reflects observed endpoints with method, auth, evidence, and scope status —
and adds nothing to scope.
