# Security Model

## Authority Boundaries

- The model is not an authority for scope, ROE, or tool safety.
- MCP server metadata is untrusted.
- Target output is untrusted.
- Local policy and operator approval are the control plane.

## Container Defaults

- Non-root runtime user.
- Read-only root filesystem.
- No Docker socket mount by default.
- Host access uses `host.docker.internal`.
- Persistent state is scoped to `/srv/data/pi-system`.

## Tool Governance

The Pi governance extension installed from `pi-system` intercepts `tool_call` events.

It:

- Blocks direct Pi tools by default under MCP-only mode.
- Blocks protected path edits.
- Blocks obvious destructive shell commands.
- Denies unknown MCP actions by default.
- Enforces scope and ROE before target-facing MCP actions can reach the approval prompt.
- Requires interactive approval for non-read-only actions.
- Writes approval envelopes that bind exact inputs to policy, scope, ROE, MCP config, and tool-schema hashes.
- Logs attempted, blocked, approved, and executed-control events to audit JSONL.
- Allows only classified local `pi_system_governance` MCP state tools to run without an extra UI prompt.

Scope/ROE enforcement is deterministic and local. The extension parses the committed or overlaid scope and ROE files, rejects unknown or denied targets, rejects actions outside the testing window, rejects disallowed HTTP methods, and blocks inputs matching `always_denied` ROE classes. Local coding, documentation, and governed state actions are not treated as target-facing unless their action type or inputs identify a target.

## Evidence Integrity

Evidence is written through the local `pi_system_governance.evidence_append` MCP tool into:

```text
/srv/data/pi-system/evidence/ledger.jsonl
/srv/data/pi-system/evidence/artifacts/
```

The agent is instructed not to edit evidence directly, and the governance extension blocks model write/edit access to evidence and audit paths. Notes, checkpoints, task state, memory, and verification records are also written through the local `pi_system_governance` MCP server under the durable data root.

The local governance MCP server bounds text fields and uses lock-protected append paths for JSONL writes. Its `state_summary` tool returns compact counts, latest hashes, and recent IDs so small models can recover context without reading raw ledgers.

Target-derived evidence must include a source action ID so findings can be traced back to the approved action and audit trail.

Audit and evidence ledgers use monotonic sequence numbers and hash-chain fields:

```text
sequence
previous_hash
record_hash
```

Use `scripts/validate-ledgers.py` to verify ledger continuity before export or report finalization.

The chain detects accidental damage (a lost, reordered or edited line), not deliberate tampering:
anything that can write the data root, the agent included, can rewrite a record and recompute every
later hash, and the chain check still passes. To detect that, record the ledgers' heads from the
host in a file outside the data root, and check against it later:

```sh
python3 scripts/validate-ledgers.py --data-root "$DATA_ROOT" --write-anchor "$ANCHOR_FILE"
python3 scripts/validate-ledgers.py --data-root "$DATA_ROOT" --anchor "$ANCHOR_FILE"
```

A rewrite, truncation or deletion of anchored records then fails; an anchor path inside the data
root is refused. Records appended after the last anchor are protected only by the chain, so write a
new anchor at each checkpoint (before an export, at the end of a session).
`tests/ledger-anchor-smoke.ts` pins this behaviour.

## Residual Risk

Pi packages and extensions execute code with the container user's permissions. Package versions should be reviewed and pinned. MCP servers should be treated as external tools with their own trust and supply-chain risk.

Break-glass direct tool sessions require `PI_ALLOW_DIRECT_TOOLS=1` and should be treated as exceptional operator-controlled maintenance, not the normal agent mode.
