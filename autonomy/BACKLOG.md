# Backlog

Carried across cycles. Each item has an ID, a status (`open`, `in-progress`, `done`,
`dropped`, `proposal`) and its evidence. Items come from the operator's brief, audits and
reviews. Treat them as **hypotheses**: check each one against the code first, and record the
result (confirmed, already fixed, or wrong) before you work on it. Add new items with evidence
as you find them. Never delete an item: close it with a reason.

| ID | Status | Priority | Item | Source / evidence |
|----|--------|----------|------|-------------------|
| B-001 | done | high | Web console reported a hard-coded version `0.1.0` from `/api/health` and `configInfo().app.version` while the package is `0.2.4-beta.11` | `packages/web-ui/server/routes.ts` and `configinfo.ts` each declared `const VERSION = "0.1.0"`. Fixed in cycle 02 (`19e0758`) and re-applied in cycle 04 (`f766593`); pinned by `tests/web-ui-api-smoke.ts` under `npm run smoke:web-ui-api`. |
| B-002 | done | high | Detached supervisor wrote every log line twice into `supervisor.log` | `engine.ts` default log called both `store.log` and `rt.log`, while `spawnSupervisor` redirects child stdout into the same file. Fixed in cycle 02 (`a553328`) and re-applied in cycle 04 (`3f8ab1b`); pinned by `tests/autonomy-cli-smoke.ts` under `npm run smoke:autonomy-cli`. |
