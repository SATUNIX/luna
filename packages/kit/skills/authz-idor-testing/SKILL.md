---
name: authz-idor-testing
category: engagement
description: Plan and run low-impact authorization / IDOR validation on an authorized engagement. Use when testing access controls or object-reference authorization — with test accounts, paired allowed/denied comparisons, and PoC-only data handling.
disable-model-invocation: true
triggers: ["idor", "authorization bypass", "broken access control", "access control testing", "object reference authorization"]
---

# Authz and IDOR Testing

Prove an access-control gap with the least intrusive evidence, using accounts you're
authorized to use — never real user data.

## When to use
- Testing authorization, privilege boundaries, or insecure direct object references (IDOR)
  on an in-scope, authorized target.

## Preconditions
- Scope + ROE loaded and the action approved (`scope-roe-governance`,
  `action-card-builder`).
- Approved **test accounts / fixtures** at each relevant privilege level.

## Procedure
1. **Establish the baseline.** Confirm what each test account is *allowed* to access.
2. **Paired comparison.** For each candidate object/endpoint, compare an **allowed** vs a
   **denied** identity performing the same request. A gap = the denied identity succeeds.
3. **Minimal proof.** Demonstrate access with a single object / one record — enough to
   prove the control fails. Do **not** enumerate or extract data at volume.
4. **Vary the reference, not the volume.** Change the object id/role, not the request rate.
5. **Record** the paired requests/responses as evidence (IDs/hashes), the accounts used,
   and the exact limitation (what you did and deliberately did not do).

## Constraints
- Test accounts and approved fixtures only — never live user data.
- No bulk extraction, no data exfiltration beyond a single proof-of-concept.
- Stay within rate limits and time windows in the ROE.

## Anti-patterns
- Scraping records to "show impact" — one object proves the gap.
- Testing with production user identities or real PII.
- Treating a discovered object as in-scope automatically.

## Done
The gap is shown by a clean allowed/denied pair with PoC-only data, evidence is recorded,
and limitations are stated. Promote via `hypothesis-lifecycle` → `finding-writing`.

## References
- `references/idor-test-matrix.md` — authorization dimensions, object-reference sources,
  predictability ladder, evidence bundle, and false positives to rule out.
