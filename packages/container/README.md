# pi-system container

Deployable Pi coding agent. A minimal Alpine container that runs
`@earendil-works/pi-coding-agent` with the `pi_system_governance` MCP server, seeded pi config,
and engagement scaffolding. Behaviour and skills are installed from the `pi-system` monorepo.

## Runtime shape

- Canonical compose: `capability/compose/compose.yaml`
- Compatibility compose: `docker-compose.yml`
- Capability id: `pi-system`
- Persistent data root: `/srv/data/pi-system`
- Health check: `healthcheck.py --check` is a local probe (the data root is writable) and needs
  no server. The `/health` HTTP endpoint is served only when `healthcheck.py --serve` is run
  explicitly, and binds `127.0.0.1` unless `PI_AGENT_HEALTH_HOST` is set
  (`tests/container-static-smoke.ts`).
- Interactive entry: `docker exec -it <container> pi-agent`

## Quick start

```sh
docker compose -f capability/compose/compose.yaml \
  --env-file capability/env/defaults.env \
  up -d --build

docker exec -it pi-system-pi-agent-1 pi-agent
```

Use `PI_KIT_PROFILE=balanced` for the full kit default, `PI_KIT_PROFILE=quick` for a smaller
profile, or `PI_KIT_PROFILE=lite` for small local models.

## Model default

Ollama at `http://host.docker.internal:11434/v1`, model `gemma4:latest`.
Override via `OLLAMA_BASE_URL` and edit `overlays/pi/models.json`. Local-model costs default to
zero; kit pricing and the status bar are documented in
[`docs/status-bar-and-costs.md`](../../docs/status-bar-and-costs.md).

## Build modes

The image has two build modes controlled by the `BUILD_MODE` ARG.

### Dev mode (default)

The kit is mounted from a local clone and installed at container start. Edits to the kit are
applied on the next `pi-agent` launch without rebuilding.

```sh
# Build
sh scripts/build.sh --dev

# Run with local kit mount
PI_KIT_PATH=/path/to/pi-system \
docker compose -f capability/compose/compose.yaml \
               -f capability/compose/compose.dev.yaml \
               --env-file capability/env/defaults.env \
               up -d
```

### Release mode

The kit is baked into the image at a pinned git ref. No runtime mount needed.

```sh
# Build with default ref (main)
sh scripts/build.sh --release

# Build with a specific tag (PI_SYSTEM_GIT_SOURCE overrides the clone URL)
sh scripts/build.sh --release --ref v1.1.0

# Run (no kit mount needed)
docker compose -f capability/compose/compose.yaml \
               --env-file capability/env/defaults.env \
               up -d
```

Release builds require `PI_KIT_REPO` and fail if the baked kit cannot be verified with `pi list`.
Dev runtime installs from `PI_KIT_PATH` without interactive flags and applies `PI_KIT_PROFILE`,
which defaults to `balanced`.

`pi-agent` fails closed: if no kit is found (neither `PI_KIT_PATH` nor `/opt/pi-system` holds
`packages/core/install.mjs`), or `pi install` or the profile apply fails, it prints the error,
does not start pi, and exits non-zero. `PI_AGENT_ALLOW_UNGOVERNED=1` starts pi anyway with a
warning. The entrypoint seeds `settings.json`, `mcp.json` and `models.json` into
`PI_CODING_AGENT_DIR`, the directory pi reads (`tests/container-static-smoke.ts`).

## CI

The root [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs the kit verify gate and
test suite. Container builds are exercised by `docker build --build-arg BUILD_MODE=dev .` plus the
governance MCP smoke test.

## Kit resources

Extensions, skills, and prompts are installed from the monorepo.

- **Dev**: mount a local clone via `PI_KIT_PATH` or `/opt/pi-system`
- **Release**: baked in at `PI_KIT_REF` during `docker build`

Kit documentation:

- [`docs/index.md`](../../docs/index.md)
- [`docs/profiles.md`](../../docs/profiles.md)
- [`docs/building-extensions.md`](../../docs/building-extensions.md)
- [`docs/roadmap.md`](../../docs/roadmap.md)

Security reporting and repository-wide rules are in the repository root's `SECURITY.md` and `CONTRIBUTING.md`.

## Engagement setup

Copy engagement authority files into the running container's workspace:

```
engagement/scope.yaml
engagement/roe.yaml
engagement/tool-policy.json
```

See `engagement/*.example.*` for templates.

## Validation

```sh
sh scripts/preflight.sh
python3 scripts/validate-runtime-readiness.py
sh capability/tests/validate-compose.sh
sh capability/tests/smoke.sh
```

## Architecture

```
Dockerfile              ← pins pi-coding-agent; installs the monorepo
capability/compose/     ← canonical compose files
capability/env/         ← non-secret defaults
mcp-servers/governance/ ← pi_system_governance MCP server (evidence, notes, state)
mcp-servers/memory-mcp/ ← durable memory MCP server (Qdrant-backed)
overlays/pi/            ← settings.json, mcp.json, models.json seeded at startup
engagement/             ← example scope/ROE/tool-policy templates
scripts/                ← entrypoint, pi-agent launcher, healthcheck, validation
capability/docs/        ← operator guide, runbook, security model, golden path
```

The governance ledger read path used by `state_summary` skips malformed or non-object JSONL records and task snapshots instead of failing the summary.
The memory-mcp ledger read path used by `trace_tail` and `state_summary` skips malformed or non-object JSONL records instead of failing the call. Read-only tools create no data directories, and `--call` rejects malformed or non-object params with a clean error.

See `capability/docs/OPERATOR_GUIDE.md` for the full operational reference.
