# Capability Runbook

## Compose Render Verification

Run:

```sh
docker compose -f capability/compose/compose.yaml --env-file capability/env/defaults.env config
docker compose -f docker-compose.yml --env-file capability/env/defaults.env config
```

Expected result: both render successfully, use compose name `pi-system`, mount `/srv/data/pi-system`, set `PI_KIT_PROFILE`, and run `healthcheck.py --check` as the container health check.

Verify root and canonical compose parity:

```sh
python3 scripts/validate-compose-parity.py
```

Expected result: root `docker-compose.yml` matches `capability/compose/compose.yaml` except for the expected build context relativity.

## Preflight Verification

Run readiness validation before starting an interactive Pi loop:

```sh
python3 scripts/validate-runtime-readiness.py
```

Expected result: required Pi profile files are readable, `.pi/mcp-adapter.json` remains MCP proxy-only, `pi_system_governance` has exact local tool-policy mappings, committed MCP/engagement overlays do not contain secret-looking values, and root/canonical compose parity passes. On a host checkout where `/srv/data/pi-system` does not exist, the validator may warn that data directory creation is deferred to container/Pi System runtime.

Optionally probe local Ollama:

```sh
python3 scripts/validate-runtime-readiness.py --check-model-endpoint
```

Expected result: reachable Ollama reports `OK`. Unreachable Ollama reports `WARN` and does not fail the command. Use `--require-model-endpoint` only when model reachability is required for the gate; unreachable Ollama then returns a non-zero exit.

Validate deterministic scope and ROE parsing:

```sh
python3 scripts/validate-scope-roe.py
```

Expected result: the live overlays, when present, otherwise the committed examples, deny unknown assets, include required ROE denial classes, have valid testing windows, accept an in-scope fixture URL, and reject denied or unknown targets. Use `--scope` and `--roe` to validate specific files.

Run the full local preflight before committing or deploying runtime changes:

```sh
sh scripts/preflight.sh
```

Expected result: readiness, template, pentest environment, governance MCP static checks, overlay, compose parity, ledger integrity, and compose render checks pass.

## Health Verification

Start the workload:

```sh
docker compose -f capability/compose/compose.yaml --env-file capability/env/defaults.env up -d --build
docker inspect --format '{{.State.Health.Status}}' pi-system-pi-agent-1
docker exec pi-system-pi-agent-1 python3 /opt/pi-agent/healthcheck.py --check
```

Expected result: health status `healthy`, and `--check` exits 0. `--check` is a local probe that
the data root is writable and needs no server. The `/health` JSON endpoint is served only after
`python3 /opt/pi-agent/healthcheck.py --serve` is started explicitly, and binds `127.0.0.1` unless
`PI_AGENT_HEALTH_HOST` is set (`tests/container-static-smoke.ts`).

## Interactive Operation

Start Pi inside the running container:

```sh
docker exec -it pi-system-pi-agent-1 pi-agent
```

The container also supports attach because compose keeps stdin and TTY open:

```sh
docker attach pi-system-pi-agent-1
pi-agent
```

`docker exec -it` is operationally cleaner because detaching from `docker attach` can stop the shell if used incorrectly.

## Data Verification

After starting `pi-agent`, verify these paths exist on the host:

```text
/srv/data/pi-system/audit
/srv/data/pi-system/checkpoints
/srv/data/pi-system/evidence
/srv/data/pi-system/memory
/srv/data/pi-system/sessions
/srv/data/pi-system/tasks
/srv/data/pi-system/verification
/srv/data/pi-system/pi-agent
```

Evidence and audit records are append-only in normal operation and should be exported manually from `/srv/data` when required.

Verify ledger integrity when audit or evidence records exist:

```sh
python3 scripts/validate-ledgers.py --data-root /srv/data/pi-system
```

Expected result: sequence numbers, `previous_hash`, and `record_hash` fields validate for audit and evidence ledgers.

For compact recovery state, call the local governance MCP `state_summary` tool with a small `max_items` value. It returns counts, latest ledger hashes, recent task snapshots, and recent evidence/verification IDs without dumping raw ledgers.

## MCP-Only Verification

Inspect the launcher default:

```sh
grep 'PI_TOOLS:-mcp' scripts/pi-agent
```

Inspect the MCP adapter settings:

```sh
jq '.settings.directTools, .settings.samplingAutoApprove, .settings.autoAuth, .settings.elicitationAutoOpenUrls, .mcpServers.pi_system_governance.directTools' .pi/mcp-adapter.json
```

Expected result: direct tools are not in the default launcher profile, the local `pi_system_governance` server is configured behind MCP proxy mode, `directTools` is `false`, `samplingAutoApprove` is `false`, `autoAuth` is `false`, and URL auto-open elicitation is disabled. Local append tools use bounded text fields and lock-protected writes.

Target-facing MCP tools are checked against normalized scope and ROE before the approval prompt is shown. If a target is missing, denied, outside the allowed URL/host set, outside the testing window, uses a disallowed method, or matches an `always_denied` ROE class, the governance extension blocks the call and records `scope_roe_enforcement` in the audit ledger.

Run the optional governance MCP stdio smoke test after dependencies are installed:

```sh
cd .pi/mcp-servers/governance
npm ci --ignore-scripts --omit=dev
cd ../../..
RUN_GOVERNANCE_MCP_SMOKE=1 sh scripts/validate-governance-mcp-server.sh
```

## Validation

Run:

```sh
python3 scripts/validate-runtime-readiness.py
python3 scripts/validate-runtime-readiness.py --check-model-endpoint
sh scripts/preflight.sh
sh scripts/check_template_contract.sh
sh scripts/validate-pentest-env.sh
python3 scripts/validate-scope-roe.py
sh scripts/validate-governance-mcp-server.sh
sh capability/tests/validate-compose.sh
sh capability/tests/smoke.sh
```

## Rollback

Roll back by redeploying the previous image tag or environment overlay. Do not patch files directly inside the running container.

## Operator Notes

- Keep Docker socket disabled unless a future tool workflow explicitly requires it and the risk is accepted.
- Keep MCP direct tools disabled by default.
- Keep live scope, ROE, and tool policy in Pi System overlays.
- Keep root and canonical compose files aligned.
