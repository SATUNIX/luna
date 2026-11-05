# Luna — Capability Docs

Deployable pi coding agent with governed kit profiles installed from Luna.

Use `capability/compose/compose.yaml` as the canonical Luna compose entrypoint. The root `docker-compose.yml` is a compatibility entrypoint and must stay behaviorally equivalent except for build context relativity.

Environment defaults live in `capability/env/defaults.env`; Luna overlays may override non-secret values such as `APP_PORT`, `PI_AGENT_DATA_ROOT`, `PI_AGENT_IMAGE`, and `PI_KIT_PROFILE`. Runtime state is stored below `/srv/data/pi-system`.

Rollback: redeploy the previous image tag or environment overlay. Runtime state lives in the data root, not in the container.

| Document | Purpose |
|---|---|
| `OPERATOR_GUIDE.md` | Day-to-day operations: start, attach, kit choice, model configuration, MCP/governance |
| `RUNBOOK.md` | Troubleshooting and incident procedures |
| `SECURITY_MODEL.md` | Trust boundaries, capability drop, data paths |
| `PI_AGENT_GOLDEN_PATH.md` | Recommended agent operating patterns |
| `BURP_MCP.md` | Connecting Burp Suite via MCP |

For extension building, profiles, the status bar and searchable user docs, use `docs/index.md` at the repository root.
