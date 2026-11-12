# Proposal: tool-firewall refuses unattended mode on every worker session (PG-53)

Status: open — operator/security decision, not taken in cycle 09.
Scope: ops stream, but the fix crosses a security control, so it is filed rather than changed.

## Finding

Every worker session starts with the same firewall line:

```
tool-firewall: WARNING — unattended mode was requested (PI_KIT_UNATTENDED) but is NOT active:
this process is not in the initial user namespace, so it may be in one this user made (with
unshare, or a rootless container engine), where a read-only mount or another owner of the
contract /run/contract.json proves nothing; unattended mode needs a worker in the initial user
namespace. Failing closed: the normal interactive/headless approval rules apply, so anything
above the routine tier needs an operator.
```

Evidence: `autonomy/runs/luna-ops-01/steps/08/agent-11..14.log` and
`autonomy/runs/luna-ux-01/steps/10/agent-12.log` (first line of each). The check lives in the
tool-firewall extension's unattended proof.

## Consequence

The run contract says `unattended`, the firewall says interactive, so the two disagree and every
non-routine call escalates to a person. That defeats the point of an autonomous run:

- luna-ops-01 cycle 08 asked a person twice (09:41Z leak-scan, 10:47Z published-history ids). Each
  answer ends the session and starts a fresh one that re-derives state: about 30 model calls, 4
  sessions, 88 minutes, $0.555 for that cycle.
- The manager firewall line for the same period shows 10 operator prompts, 2,319 s of waiting and
  one timeout.

## Why cycle 09 did not change it

The namespace check is a fail-closed control. The standing rule is that the fail-closed harness
must not be loosened into warn-and-continue, and an independent reviewer rejects that as weakening
a control. Removing or relaxing the check without a replacement proof is out of scope for a normal
cycle; it needs a security review. The check must not be deleted.

## The two honest paths (pick one, with security review)

1. **Run the worker in the initial user namespace.** Container configuration owned by the operator:
   make the run worker start in the host (initial) user namespace so the existing read-only-mount /
   contract-owner proof is sound. No firewall code change.
2. **Make the namespace proof exact and two-sided.** Add a second, independent provenance check so
   a genuine container worker (initial namespace, correct mount/owner) is admitted while a process
   in a user namespace this user created (via `unshare` or a rootless engine) is still refused.
   This is a code change in the tool-firewall extension and must be flagged for security review.

## Acceptance test either path must add

In `packages/extensions` (tool-firewall tests): a process in a non-initial user namespace with the
contract mounted is still refused unattended mode (today's behaviour kept), AND the documented
container path (initial user namespace, or the exact proof option 2 defines) is admitted. Plus a
run-level test that a worker session in the run image reports unattended active, or that the run
fails closed at start with a named reason instead of warning per call.

Measure after the fix: operator prompts per pass (baseline 10), escalations per cycle, cycle wall
time.
