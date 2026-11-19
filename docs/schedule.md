# Scheduled runs

`luna schedule` runs Luna on a timetable: a headless [`luna exec`](headless.md) prompt, or an
authorised [autonomous run](autonomy.md). The operating system's scheduler does the timing:
a systemd user timer where `systemctl --user` works, otherwise a line in your crontab.

```sh
luna schedule add nightly --at "daily 02:00" --prompt "Summarise the open TODOs in src/" --max-turns 20
luna schedule add weekly-loop --at "weekly fri 18:00" --config ~/runs/improve.json
luna schedule list
luna schedule run-now nightly     # run it now, as the timer would
luna schedule remove nightly
```

| `--at` | Runs |
| --- | --- |
| `hourly` | At the top of every hour |
| `daily HH:MM` | Every day at that local time |
| `weekly <mon..sun> HH:MM` | Once a week |
| `every Nm` | Every N minutes, N from 5 to 59 |
| `every Nh` | Every N hours, N from 1 to 23 |

A name is lowercase letters, digits and `-`, at most 40 characters. A prompt schedule takes
`luna exec`'s `--max-turns`, `--max-cost` and `--timeout`; an autonomy schedule (`--config`, an
absolute path to an existing run config) runs `pi-autonomy up --config <file>`, which starts only an
authorised contract and takes its limits from it. `--cwd` sets the directory the job runs in
(default: the current one); `--backend systemd|cron` overrides the detection.

## What it writes

- The spec, `<state>/luna/schedules/<name>.json` (`$XDG_STATE_HOME`, default `~/.local/state`),
  mode 0600. It holds the prompt or config path, the limits, the directory and the backend.
- With systemd: `~/.config/systemd/user/luna-schedule-<name>.service` and `.timer`, then
  `systemctl --user daemon-reload` and `enable --now` of the timer. The service runs
  `luna schedule run-now <name>`; its output goes to the user journal
  (`journalctl --user -u luna-schedule-<name>`).
- With crontab: one line tagged `# luna-schedule:<name>`, added with `crontab -` beside your own
  lines, which stay as they were. Output is appended to `<state>/luna/schedules/<name>.log`.

The prompt is never written into a unit file or a crontab line: the job reads it from the spec.
A directory, node or luna path that a unit file or shell line could not carry safely (anything but
letters, digits, space and `_./@+-`) is refused. `remove` stops and deletes the timer or the tagged
line, then the spec.

## Who decides

Creating a schedule is the operator's decision. `luna schedule add` asks on a terminal, or takes
`--yes` on the command line; with neither it refuses and writes nothing. In pi, `/schedule add
<name> <when> -- <prompt>` asks through pi's confirm dialog and refuses in a session with no UI;
`/schedule list`, `remove` and `run-now` work as the CLI does. `/schedule` is a command, not a model
tool, and is not registered in a subagent. Each job is headless, so an action that needs the
operator is refused rather than waiting ([Headless](headless.md)).

The `schedule` extension that provides `/schedule` is in no profile and marked `experimental`: add
it under `extensions.add` in `<agent dir>/pi-kit/overrides.json` ([Profiles](profiles.md)).
`luna schedule` needs no extension.

Pinned by `tests/luna-cli-smoke.ts` (`tests/schedule-checks.ts`), which never calls the real
`systemctl` or `crontab`: the library takes an injected runner, and the CLI runs with only a fake
`systemctl` and `crontab` on `PATH`.

Not covered: the tool firewall does not yet treat `luna schedule add --yes`, unit files or crontab
writes as high-risk, so an agent with shell access and an approval for that command could create a
schedule; run with the firewall asking for shell commands. A timer's missed runs (the machine was
off) are not caught up. Windows has neither backend.
