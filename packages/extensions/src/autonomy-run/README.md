# autonomy-run

`/autonomy` starts and manages autonomous runs from inside pi. It is a thin operator interface over
the `packages/autonomy` CLI (`pi-autonomy`): it runs that CLI as a child process and speaks its
`--json` protocol, so everything it can do, you can also do from a shell.

```
/autonomy templates                              what kinds of run exist
/autonomy init implement --spec "..." --check unit="npm test"    write run.json
/autonomy plan run.json                          validate it; show the boundary and its digest
/autonomy start run.json                         show the boundary, confirm, then start in the background
/autonomy status [run]                           one run, or all of them
/autonomy pause|cancel <run>                     stop the worker; the work is kept
/autonomy resume <run> [answer | --approve | --deny]
/autonomy steer <run> <message>
/autonomy promote <run>                          approval-gated promotion of the result
/autonomy export <run> [dir]                     results, evidence, usage, decisions, the work
/autonomy reconfigure <run> --effort E4 ...      the only way effort or budgets change for a run
```

For a run with generations (Memento mode), `/autonomy status <run>` also shows generation n/N, the
last rotation reason and the latest notebook (redacted), and sets the footer status line to
`memento <run>: gen n/N, <status>; last rotation: ...`. The line changes only when you run that
command (docs/autonomy.md, "Generations"; `tests/autonomy-command-smoke.ts`).

## Why it is a command and not a tool

A run spends money and acts without approval prompts inside its container boundary. Only a person
may decide that, so the extension registers **no tool**: the model cannot start, authorise, steer,
promote or reconfigure a run. Every decision that matters is confirmed on screen:

- `start` shows the resolved boundary (what the worker may write, reach and spend, whether it runs
  unattended, what may leave the run) with its digest, and asks. Confirming records an authorisation
  bound to that digest in the contract file, then starts the run. Changing anything security-relevant
  changes the digest and invalidates the authorisation.
- Without a screen (`pi -p`, RPC without UI), `start` refuses unless the contract already carries an
  authorisation for exactly this boundary, made earlier at a terminal with
  `pi-autonomy plan --config run.json --authorise`.
- `cancel`, `promote`, `reconfigure` and `resume --approve` ask first. `promote` and `reconfigure`
  show the CLI's own description of what would change.

## Requirements

A container engine (Podman or Docker) for the runs, the image built with
`packages/autonomy/build-image.sh`, and a model provider key for the relay. The command itself needs
none of them for `templates`, `init` and `plan`. Details: `docs/autonomy.md`.

`PI_AUTONOMY_CLI` overrides the CLI path (tests); `PI_AUTONOMY_HOME` is the CLI's state directory
(default `~/.local/state/pi-autonomy`).

A git install of the kit includes `packages/autonomy`; the npm package deliberately does not ship the
runner (`packages/core/pack-check.ts` forbids it), so under npm delivery `/autonomy` says the CLI is
not installed.

Ships in the `autonomous` profile only.
