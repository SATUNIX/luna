# guidelines

Publishes project-specific guidelines from a `GUIDELINES.md` file for `context-sieve` to assemble into the agent system prompt.

## How it works

On `session_start`, scans the project's working directory for a guidelines file and writes a context contribution. `context-sieve` is the only extension that injects the final system prompt.

## Search order

1. `PI_KIT_GUIDELINES_PATH` env var (absolute path to any file)
2. `GUIDELINES.md` in the project root
3. `.pi/GUIDELINES.md` in the project root

`AGENTS.md` is deliberately not read: pi loads it already, so including it here would inject the same text twice.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PI_KIT_GUIDELINES_PATH` | (none) | Override the guidelines file location |

## Profiles

Profiles: see `docs/EXTENSIONS.md` (generated from `packages/kit/profiles/*.json`).
