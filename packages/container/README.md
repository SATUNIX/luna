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
warning. The entrypoint seeds `settings.json` and `models.json` into `PI_CODING_AGENT_DIR`, the
directory pi reads, only when they are missing, so your edits to them are kept. `mcp-adapter.json`
is a security control, so the entrypoint replaces it with the image's copy at **every** start: an
edit made in the writable agent directory is moved aside to `mcp-adapter.json.replaced`, with a
warning, and never becomes the next session's baseline. `scripts/validate-runtime-readiness.py`
fails while the live copy differs from the image's (`tests/container-static-smoke.ts` pins both).

## MCP adapter

The image runs `pi-mcp-adapter@6.0.0` and pi 1.4.0, both installed at build time with
`npm ci --omit=dev --ignore-scripts` from the committed `tools/package-lock.json` (exact versions
and sha512 integrity for every package in the tree), owned by root. The build fails when the
installed versions differ from the `PI_CODING_AGENT_VERSION` and `PI_MCP_ADAPTER_VERSION` build
arguments. `overlays/pi/settings.json` registers the adapter by its path in the image,
`/opt/pi-agent/tools/node_modules/pi-mcp-adapter`, so pi never fetches it from npm at start. The
adapter replaces Pi's built-in MCP client; the overlay's `"-builtin:mcp"` entry keeps the built-in
off, so the adapter does not rewrite `settings.json` itself.

The adapter reads its servers and settings from `mcp-adapter.json` in `PI_CODING_AGENT_DIR`, and
from nothing else: the image sets `PI_MCP_CONFIG_MODE=exclusive`, so Pi's own `mcp.json`,
`~/.config/mcp/mcp.json`, `~/.agents/mcp.json` and a project's `.mcp.json` or `.pi/` MCP files are
not read. Add a server, such as the Burp bridge in `capability/docs/BURP_MCP.md`, to that file.
The image also sets `MCP_DIRECT_TOOLS=__none__`, and `mcp-adapter.json` sets
`namespaceProxyTools: false`, so the model sees one MCP tool, `mcp`, and every MCP call reaches
`pentest-governance-domain` under that name. Without them, 6.0.0 registers an `mcp__<server>` proxy
per server and a deferred `mcp__<server>__<tool>` tool per server tool, and runs each `mcp` call as
a nested call to that tool, which MCP-only mode blocks. `allowInstall`, `allowScriptToolSave` and
`jev` are off, so the model cannot add servers or script tools, and tool search never calls the
remote Jev service.

`scripts/validate-pentest-env.sh` (run by `tests/container-static-smoke.ts`) fails when a pin
drifts between the Dockerfile, `tools/package.json` and its lockfile, when the overlay registers the
adapter from npm, or when one of these settings or one of the two environment variables changes. No
automated test loads the adapter into pi: the tool surface above was checked by hand in a built
image.

A data root seeded by an earlier image registers the adapter from npm (`npm:pi-mcp-adapter@...`)
in its `settings.json`. At start the entrypoint replaces that entry with the image's path and adds
`"-builtin:mcp"`, keeping every other setting. An earlier `mcp.json` is ignored by 6.0.0; add any
server you need to `overlays/pi/mcp-adapter.json` and rebuild, since the live copy is replaced at
every start.

The agent can still write `settings.json` in the agent directory (at the firewall's medium tier),
for example to add a package that pi would install at the next start; only the adapter entry and
`-builtin:mcp` are restored.

## CI

The root [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs the kit verify gate and
test suite. Container builds are exercised by `docker build --build-arg BUILD_MODE=dev .` plus the
governance MCP smoke test.

## Kit resources

Extensions, skills, and prompts are installed from the monorepo.

- **Dev**: mount a local clone via `PI_KIT_PATH` or `/opt/pi-system`
- **Release**: baked in at `PI_KIT_REF` during `docker build`; the build fails unless the clone is exactly `PI_KIT_SHA` (`scripts/build.sh --release --ref <tag> --sha <commit>`)

Kit documentation:

- [`docs/index.md`](../../docs/index.md)
- [`docs/profiles.md`](../../docs/profiles.md)
- [`docs/building-extensions.md`](../../docs/building-extensions.md)
- [`docs/roadmap.md`](../../docs/roadmap.md)

Security reporting and repository-wide rules are in the repository root's `SECURITY.md` and `CONTRIBUTING.md`.

## Engagement setup

Put the engagement authority files (`scope.yaml`, `roe.yaml`, `tool-policy.json`) in the host
directory `PI_ENGAGEMENT_DIR` (default `/srv/data/pi-system-engagement`, outside the data root). The
compose files mount it read-only at `/workspace/engagement`, so the agent cannot rewrite its own scope;
change the files on the host. See `engagement/*.example.*` for templates.

### Scope enforcement and its limits

- **Scope files are read-only to the agent.** `PI_ENGAGEMENT_DIR` is mounted read-only at
  `/workspace/engagement`, from outside the data root (`tests/compose-policy-smoke.ts`).
  `pentest-governance-domain` also refuses tool calls that name the scope and policy files, by
  matching paths and command text; that check is a second layer, not the boundary.
- **The network is not scope-limited.** The container runs on the default bridge with ordinary
  egress and a route to the host (for a local model). Scope and rules of
  engagement are enforced on the tool calls the governance extension sees, not at the network
  layer, so a command it does not recognise as target-facing can reach hosts outside the scope.
  Run engagements from a host or network segment whose own firewall limits what it can reach.
- **Published ports bind loopback.** The health port is published on `127.0.0.1` only, and every
  compose file's ports, credentials and hardening options are checked by
  `tests/compose-policy-smoke.ts`.

## Validation

```sh
sh scripts/preflight.sh
python3 scripts/validate-runtime-readiness.py
sh capability/tests/validate-compose.sh
sh capability/tests/smoke.sh
```

## Architecture

```
Dockerfile              ← installs pi and pi-mcp-adapter from tools/package-lock.json
tools/                  ← the image's pi and pi-mcp-adapter: package.json and lockfile
capability/compose/     ← canonical compose files
capability/env/         ← non-secret defaults
mcp-servers/governance/ ← pi_system_governance MCP server (evidence, notes, state)
mcp-servers/memory-mcp/ ← durable memory MCP server (SQLite and JSONL)
overlays/pi/            ← settings.json, mcp-adapter.json, models.json seeded at startup
engagement/             ← example scope/ROE/tool-policy templates
scripts/                ← entrypoint, pi-agent launcher, healthcheck, validation
capability/docs/        ← operator guide, runbook, security model, golden path
```

The governance ledger read path used by `state_summary` skips malformed or non-object JSONL records and task snapshots instead of failing the summary.
The memory-mcp ledger read path used by `trace_tail` and `state_summary` skips malformed or non-object JSONL records instead of failing the call. Read-only tools create no data directories, and `--call` rejects malformed or non-object params with a clean error.

See `capability/docs/OPERATOR_GUIDE.md` for the full operational reference.
