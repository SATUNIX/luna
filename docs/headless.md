# Headless runs and safe mode

`luna` is the command Luna adds in front of pi. It has two jobs beyond starting pi: running one
prompt from a script (`luna exec`), and starting pi with none of Luna's extensions (`luna --bare`).
Everything else on its command line is pi's own and is passed through untouched.

`luna` is installed by the npm package (`npm install -g @satunix/pi-system`). A kit registered in pi
from git or from a checkout does not put it on your `PATH`; run `node packages/core/luna.ts` from the
checkout instead. pi must be on `PATH` either way.

## `luna exec`

```bash
luna exec "Summarise the open TODOs in src/"
git diff | luna exec --max-turns 20 --max-cost 2 --timeout 30m -   # the prompt is read from stdin
```

It runs `pi --mode json` and reads the event stream, so:

- **stdout** is the final assistant answer and nothing else, so it can be piped or captured.
- **stderr** carries progress lines (`luna: tool <name>`, `luna: turn finished`) and pi's own
  diagnostics.
- **Exit code** is pi's own, with two additions: `13` when a ceiling parked the run, and `1` when the
  last assistant message ended in an error or an abort. `2` is a bad command line, `127` pi was not found.

| Option | Effect |
|---|---|
| `--json` | Write pi's JSON event stream to stdout unchanged (below). No progress lines, no answer extraction. |
| `--ephemeral` | Do not save a session (`pi --no-session`). |
| `--max-turns <n>`, `--max-cost <usd>`, `--timeout <time>` | The ceiling: the first limit reached parks the run. They set `PI_KIT_CEILING_TURNS`, `PI_KIT_CEILING_USD` and `PI_KIT_CEILING_SECONDS`, the same object `/away` uses (see [Autonomy](autonomy.md)). A value that is not a positive number is refused, never read as no limit. The same variables set in the environment of a plain `pi -p` run take the same durations; a malformed one parks a headless run at once with the reason (`tests/away-ceiling-smoke.ts`). |
| `--model <pattern>` | The model for this run (`pi --model`). |

The run uses the profile you have installed, so its protections apply as they do interactively. A
headless session cannot answer an approval card: a tool call that would ask is denied, and a
`/away`-style ceiling is the only budget. `exec` sets `PI_KIT_AUTO_PROFILE=0` so a script never
rewrites settings. See [Autonomy gate](autonomy-gate.md) for how headless sessions are gated.

### The `--json` event stream

`--json` is pi's JSON mode: one JSON object per line (strict LF framing), starting with a `session`
header and followed by session events such as `agent_start`, `message_end`, `tool_execution_start`,
`tool_execution_end`, `turn_end` and `agent_settled`. The schema is pi's, documented in pi's own
`docs/json.md`; Luna does not add or rename fields. The final answer is the `message` of the last
`message_end` whose `role` is `assistant`.

`luna exec` applies the `overrides.json` disable list as `luna` does, and exits 2 when a ceiling is requested but
the list switches off `goal-core`, the extension that enforces it.

### Not covered

- **No `--output-schema`.** Validating the answer against a JSON Schema would need the validator the
  subagent extension vendors, and an extension's TypeScript cannot be loaded by a Node-run npm command
  (Node refuses to strip types under `node_modules`). Validate the answer in your script, or use a
  subagent role with a result schema ([Structured output](structured-output.md)).
- **No per-run `--profile`.** A profile is applied to pi's settings at install time (`/profile`, or
  `install.ts --profile`); a run uses what is installed. Use a separate agent directory
  (`PI_CODING_AGENT_DIR`) for a different profile.
- **No GitHub Actions example.** One that is safe on untrusted pull requests needs a split-privilege
  design that nothing here tests yet.

`tests/luna-cli-smoke.ts` pins the arguments pi receives, the stdout and stderr split, `--json`
passthrough, the ceiling environment, exit code 13 and the refusal of a bad limit, against a fake pi.

## `luna --bare`

```bash
luna --bare            # pi with no Luna extensions, skills, prompt templates or themes
```

If a session misbehaves, `luna --bare` answers the first question: is it Luna? It starts pi with
`--no-extensions --no-skills --no-prompt-templates --no-themes`, so no Luna extension (and no
companion package) loads and no Luna context is injected. Your own `AGENTS.md` still loads. Because
the tool firewall is an extension, a bare session has none of Luna's protections: use it to diagnose,
not to work on anything you would not run in plain pi. It needs no ceiling or approval setting and
`luna exec` has no `--bare`, by design.

## Switching one extension off

`extensions.remove` in `<agent dir>/pi-kit/overrides.json` is the per-extension kill switch
([Profiles](profiles.md)). It is applied on top of every profile, `tool-firewall`, `secret-guard` and
`protected-paths` cannot be removed, and a name this kit does not ship is dropped with a warning.

```json
{ "extensions": { "remove": ["herdr"] } }
```

Plain `pi` reads the settings the installer wrote, so an edit to the file takes effect when the
installer next runs (`/profile`). `luna` closes that gap: before it starts pi it compares the file
with the install marker and, if an extension you removed is still loaded, applies the change with the
installer's settings-only path. The Doctor page (`/menu`, System, Updates & health) lists the removed extensions and flags any the marker still
loads. `tests/luna-cli-smoke.ts` pins the pending-removal check and `tests/control-center-smoke.ts`
the Doctor line. Applying the change has no test of its own beyond the installer's.
