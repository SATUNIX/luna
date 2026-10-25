# Operator Guide

## Start

Before starting Pi, run the offline readiness gate:

```sh
python3 scripts/validate-runtime-readiness.py
```

Expected output is a series of `OK:` lines and either `Runtime readiness checks passed` or `Runtime readiness passed with ... warning(s)`. A missing host `/srv/data/pi-system` warning is acceptable for local repo validation when Pi System or the container will create the data root.

```sh
docker compose -f capability/compose/compose.yaml --env-file capability/env/defaults.env up -d --build
docker exec -it pi-system-pi-agent-1 pi-agent
```

## Kit Package

This capability installs behavior from `pi-system`.

Use the full kit profiles by setting `PI_KIT_PROFILE`:

```sh
PI_KIT_PROFILE=balanced docker compose -f capability/compose/compose.yaml --env-file capability/env/defaults.env up -d --build
```

`quick` is the smallest general profile and `balanced` is the default. `long-horizon`, `autonomous`, and `self-improving` are for longer or more advanced sessions. `lite` is for small local models and tight context limits.

Profiles, extension building, status bar costs, and searchable docs live in `docs/index.md` of the kit repository.

## Model Configuration

Run Ollama on the host with an OpenAI-compatible endpoint at:

```text
http://host.docker.internal:11434/v1
```

The default model id is `gemma4:latest` in `overlays/pi/models.json`. Override provider settings with `OLLAMA_BASE_URL`, `overlays/pi/settings.json`, and `overlays/pi/models.json`.

Local model cost is `0` by default. The kit GitOps status bar can display non-zero pricing when configured through `.pi-kit/costs.json`, `~/.pi/agent/pi-kit/costs.json`, or `PI_KIT_COST_*_PER_MTOK`.

Start with an alternate model:

```sh
PI_PROVIDER=ollama-local PI_MODEL=your-model docker exec -it <container> pi-agent
```

To check Ollama before an interactive session:

```sh
python3 scripts/validate-runtime-readiness.py --check-model-endpoint
```

An unreachable endpoint is a warning by default. For deployment gates that must prove local model reachability, add `--require-model-endpoint`; failures then need Ollama started, `OLLAMA_BASE_URL` corrected, or the Pi System model overlay fixed before launch.

## Engagement Files

Put the live versions of these files in a host directory, `PI_ENGAGEMENT_DIR`
(`/srv/data/pi-system-engagement` by default, outside the data root):

```text
scope.yaml
roe.yaml
tool-policy.json
```

The compose files mount that directory **read-only** at `/workspace/engagement`, where
`pentest-governance-domain` reads it, so the agent cannot widen its own scope or tool policy from
inside the container; edit the files on the host. An empty directory means no engagement. The
mount is checked by `tests/compose-policy-smoke.ts`. The committed `*.example.yaml` files are
examples only.

Validate overlay shape before a session:

```sh
python3 scripts/validate-scope-roe.py
```

The command validates live `engagement/scope.yaml` and `engagement/roe.yaml` when present, otherwise the committed examples. Target-facing MCP actions are blocked before approval when scope or ROE cannot be parsed, the target is outside `allowed_assets`, the target matches `denied_assets`, the current time is outside `testing_windows`, the HTTP method is not allowed, or the action matches an `always_denied` ROE class.

## Pi Commands

Useful Pi commands:

```text
/mcp
/mcp setup
/footer status
/pentest:status
/pentest:actions
/model
/compact
```

Prompt templates are available as slash commands from `.pi/prompts/`.

## MCP and Governance

The default `pi-agent` launcher exposes:

```text
mcp
```

Evidence, notes, checkpoints, task state, memory, verification, and compact state summaries are available through the local `pi_system_governance` MCP server behind the proxy tool. Keep its tools classified in `engagement/tool-policy.json`.

Direct Pi tools such as `bash`, `write`, `edit`, `read`, `grep`, `find`, and `ls` are blocked unless the operator starts an explicit break-glass session with `PI_ALLOW_DIRECT_TOOLS=1`.

For coding work, configure MCP servers that provide repository, filesystem, search, shell, and test capabilities. Keep those servers behind the MCP proxy and classify their tools in the engagement policy before use.

Coding and documentation MCP tools should use non-target action types such as repository, filesystem, or test execution. The scope/ROE gate is intentionally applied to target-facing action types and inputs so long-horizon coding work can still proceed through policy and approval without pretending local repo operations are pentest target activity.

## Small Context Profile

For small local models or tight context limits, use `.pi/settings.small-context.json` and `engagement/model.small.example.json` as overlay templates. The workflow should checkpoint before compaction and keep exactly one active step.

Start recovery or continuation by calling `pi_system_governance.state_summary` with `max_items` no higher than 5. Use `.pi/prompts/code-compact.md`, `.pi/prompts/pentest-compact.md`, or `.pi/prompts/agent-checkpoint.md` so handoffs stay in stable `task_state` or `pentest_state` blocks.

For the kit's `lite` profile, see `docs/profiles.md` in the kit repository.

## Troubleshooting

Start with:

```sh
python3 scripts/validate-runtime-readiness.py
python3 scripts/validate-scope-roe.py
python3 scripts/validate-engagement-overlays.py
```

If runtime readiness warns that `/srv/data/pi-system` is missing on a Windows or local checkout, treat it as host-only when Docker/Pi System will create the bind path before runtime. Container health and ledger validation are the deployment checks.

For deeper incident steps, use `RUNBOOK.md`.

## Security

The normal mode is MCP-only. Direct Pi tools are disabled unless an operator starts a break-glass session with `PI_ALLOW_DIRECT_TOOLS=1`.

Security boundaries and ledger integrity are documented in `SECURITY_MODEL.md`.

## Workflow

1. Confirm scope and ROE.
2. Inspect MCP status.
3. Classify tools in local policy.
4. Generate hypotheses.
5. Prepare action cards.
6. Approve or deny non-read-only actions.
7. Capture evidence through `pi_system_governance.evidence_append`.
8. Verify evidence.
9. Checkpoint or recover through `pi_system_governance.state_summary`.
10. Draft findings only from evidence.
11. Export reports from validated findings.
