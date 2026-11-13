---
name: api-testing
category: engagement
description: Plan and review authorized API security tests. Use when assessing an API's auth, authorization, input validation, rate limits, and error behavior — with controlled, low-volume, evidence-backed requests.
disable-model-invocation: true
triggers: ["api security", "api engagement", "api security test", "test the api's auth", "rate limit testing", "api authorization test"]
---

# API Testing

Assess API security with controlled, low-volume requests and explicit evidence. Discovery
never silently expands scope.

## When to use
- Authorized security testing of an API (REST/GraphQL/RPC) in scope.

## Focus areas
- **Schema mismatches** — undocumented params/fields, type confusion, mass assignment.
- **Authentication** — missing/weak auth, token handling, session fixation.
- **Authorization** — per-object and per-function access control (`authz-idor-testing`).
- **Input validation** — injection classes, boundary/΅malformed input, content-type abuse.
- **Rate limits & resource use** — presence and enforcement (test gently).
- **Error behaviour** — information leakage, stack traces, inconsistent status codes.

## Procedure
1. Confirm scope/ROE and get approval for active requests (`scope-roe-governance`,
   `action-card-builder`).
2. Inventory endpoints from **normalized evidence** (`endpoint-inventory`); preserve method
   and auth-state differences.
3. Test one hypothesis at a time with **controlled, low-volume** requests. Prefer a single
   crafted request over fuzzing at volume.
4. Capture request/response pairs as evidence (IDs/hashes); note the account/auth state.
5. Track findings through `hypothesis-lifecycle`.

## Constraints
- Low volume; respect rate limits and time windows.
- **Discovery ≠ scope.** A newly found endpoint/host is a candidate until the operator or
  overlay adds it (`scope-roe-governance`).
- No destructive or high-impact payloads without explicit approval.

## Anti-patterns
- Mass fuzzing when one targeted request would prove the point.
- Assuming a discovered endpoint is in scope.
- Reporting a response anomaly without validated impact.

## Done
Each issue is shown with a controlled request, backed by recorded evidence, kept within
rate/scope limits, and tracked toward `finding-writing`.
