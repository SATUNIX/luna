# Cycle 07 review — luna-fleet-01

Base: `c8b2179bb698` (head of `stream/fleet`, cycle start). Mode candidate: **improve**.
Evidence is from the working tree at the base commit; two scouts validated A-92 against the
code and returned file:line locations.

## Assigned items

### O-01 (P0, rank 0) — owner visibility without a Claude session

Status: **partly delivered, still open**. Cycle 06 handed over PG-06–PG-09 (host event log, live
`/autonomy` widget, web console panel, owner inbox) plus a recorded non-Claude walkthrough.
None of those four surfaces exists in the tree:

- No owner inbox, host event log or console autonomy panel. `grep -rn "owner inbox|ownerInbox|event log|events.jsonl"`
  over `packages/extensions/src`, `packages/web-ui/server` and `packages/autonomy/lib` finds only
  the step-local `events.jsonl` (`packages/autonomy/lib/store.ts:99`, exported by
  `packages/autonomy/lib/export.ts:113`), not a host-level event feed.
- `/autonomy` still exposes only command passthrough and a generation footer
  (`packages/extensions/src/autonomy-run/index.ts:262`, `:310`); there is no live run widget.

O-01 cannot be completed inside this cycle's remaining budget: it needs four owner-facing
surfaces and an end-to-end walkthrough. It stays open and is handed to the next cycle. Taking a
single surface now would leave the item's acceptance unmet and would consume the diff budget
before a self-contained item lands.

### A-92 (P0, rank 92) — dispatch run template and atomic board claim

Confirmed absent, as the briefing states:

- `packages/autonomy/lib/templates/index.ts:10` registers only
  `{ implement, deploy, "self-improve": selfImprove }`; there is no `dispatch.ts`.
- The contract template enum is `["implement", "deploy", "self-improve"]`
  (`packages/autonomy/schema/run-contract.schema.json:12`), and `Inputs`
  (`packages/autonomy/lib/contract.ts:274`) has only `repository` and `references`: no board file
  and no stream list.
- A board item accepts only `id,title,detail,priority,acceptance,status`
  (`packages/autonomy/lib/board.ts:37`); `assignee`, `claimedAt`, `submittedAt`, `sha`, `rounds`,
  `verdict`, `verdictBy` and `findings` are rejected as unknown keys.
- `board` is a replace/read command only (`packages/autonomy/cli.ts:553`); there is no
  `board claim`, so two workers cannot atomically claim one item. `assignedItems`
  (`packages/autonomy/lib/board.ts:70`) also ignores ownership and always shows the top two
  nonblocked items.
- Because there is no claim, a dispatch cycle cannot be handed exactly one item, and its prompt
  cannot carry that item's title, detail and acceptance as a claim.

Acceptance for A-92 is therefore entirely unmet and the item is actionable now.

## New problems found

- **Board replacement races a claim unless both use the same lock.** The existing
  `board --file` write (`packages/autonomy/cli.ts:562`) is an unlocked read-modify-replace. A
  steward upload racing a claim could erase the claim. The fix must lock both paths, not only
  the new `claim` branch.
- **`assignedItems()` shows items regardless of `assignee`.** After claims exist, a prompt built
  from it can show an item already claimed by another worker. Dispatch must build its prompt from
  the claim snapshot, and the claim selector must skip owned items.
- **Resume must not re-claim.** A resumed cycle has to keep the item it started with. The claim
  must be snapshotted in run state before the prompt is built and reused on resume.

Both are in-area: they are required for A-92 to meet its acceptance.

## Out-of-area proposals

- `/workflows` control completions still offer autonomy run ids that `workflow_control` cannot
  act on (`autonomy/proposals/luna-fleet-01-04-autonomy-control-ids.md`). Small and unstarted;
  not this cycle's item.

## Cycle choice

Take **A-92** in two small, separately committed changes:

1. Atomic `board claim <id> --by <agent>` under a real board lock, with the extended item
   metadata and a concurrency test.
2. A `dispatch` template that claims the top ready item for its stream, snapshots that one item,
   and carries its title/detail/acceptance into the cycle prompt, with contract/schema/docs and a
   fake-runtime test.

If the first change is not green, the second is not started. O-01 is reported blocked with the
PG-06–PG-09 carry-over, not silently dropped.
