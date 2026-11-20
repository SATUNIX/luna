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

A name is lowercase letters, digits and `-`, at most 40 characters. `--at` is normalised (case and
spacing) and stored that way. `--cwd` sets the directory the job runs in (default: the current one);
`--backend systemd|cron` overrides the detection.

A prompt schedule always runs with `luna exec`'s three caps. Any you leave out get the default; a
value over the maximum is refused at `add`, and again at run time:

| Cap | Default | Maximum |
| --- | --- | --- |
| `--max-turns` | 50 | 500 |
| `--max-cost` | $2 | $50 |
| `--timeout` | 30m | 12h |

The prompt is passed after `--`, so a prompt such as `--help` is a prompt. A prompt schedule needs
`pi` on your `PATH` when you add it. An autonomy schedule (`--config`, an absolute path to an
existing run config) runs `pi-autonomy up --config <file>`, which starts only an authorised contract
and takes its limits from it.

## The spec is checked at every run

`add` writes the spec, `<state>/luna/schedules/<name>.json` (`$XDG_STATE_HOME`, default
`~/.local/state`), created exclusively with mode 0600. At that moment it resolves everything that
decides what runs: the absolute paths of `pi`, node and the luna entry, the directory, the kind, the
prompt or config, and the caps. The SHA-256 of that spec is written into the unit file or crontab
line, which run `luna schedule run-now <name> --digest <sha256>`.

`run-now` recomputes the digest and refuses to run a spec that no longer matches: any edit to the
spec after `add` (a different prompt, directory, cap or program path) stops the schedule, with a
message that it was changed and must be removed and added again. A manual `run-now` without
`--digest` reads the digest from the installed unit file or crontab line, and refuses when there is
none. `pi` is started by the absolute path recorded at `add`; nothing is looked up through a `PATH`
that the spec supplies, and the job keeps the scheduler's own environment.

## What it writes

- With systemd: `~/.config/systemd/user/luna-schedule-<name>.service` and `.timer`, then
  `systemctl --user daemon-reload` and `enable --now` of the timer. The service runs `run-now` with
  the digest; its output goes to the user journal (`journalctl --user -u luna-schedule-<name>`).
- With crontab: one line tagged `# luna-schedule:<name>`, added with `crontab -` beside your own
  lines, which stay as they were. Output is appended to `<state>/luna/schedules/<name>.log`.

A unit file or crontab line carries only the name, the normalised time, the digest and paths; the
prompt stays in the spec. A directory, node, luna or state path that a unit file or shell line could
not carry safely is refused: letters and digits of any script, space and `_./@+-` are allowed, so a
non-ASCII home directory works, while a newline, `%`, a quote, `$`, a backslash or a backtick is
refused. `remove` stops and deletes the timer or the tagged line, then the spec.

## How a job runs

- **At most one at a time.** `run-now` holds a lock for the schedule while the job runs: a
  listening socket file in the operator-only state directory (mode 0600), which the kernel releases
  when the process exits, so a crashed or killed run never leaves a live lock; a socket file nothing
  answers on is taken over. A file rather than the abstract namespace keeps another local user from
  binding or connecting to it. A run that finds the lock held exits 75 and is skipped.
- **Stopped when it overruns.** The systemd service has `TimeoutStartSec` and `RuntimeMaxSec` of the
  job's `--timeout` plus five minutes (ten minutes for an autonomy schedule, whose `up` returns once
  the run has started). Under crontab the job's own `--timeout` ends it.
- **Headless.** Each job is headless, so an action the firewall rates ask is refused rather than
  waiting for an operator ([Headless](headless.md)).
- **Marked.** A job runs with `LUNA_SCHEDULE_JOB=<name>`, and under that variable `luna schedule
  add`, `remove` and `run-now`, and `/schedule` except `list`, refuse. This is a guard against
  accident, not enforcement: a process can unset the variable.

## Who decides

What confirms a schedule today: `luna schedule add` asks on a terminal, or takes `--yes` on the
command line; with neither it refuses and writes nothing. Whoever can run that command with `--yes`
can create a schedule, which includes an agent with shell access and an approval for that command.
In pi, `/schedule add <name> <when> -- <prompt>` asks through pi's confirm dialog and refuses in a
session with no UI; `/schedule list` and `remove` work as the CLI does, and `/schedule run-now`
starts the job detached and returns at once. `/schedule` is a command, not a model tool, and is not
registered in a subagent.

The `schedule` extension that provides `/schedule` is in no profile and marked `experimental`: add
it under `extensions.add` in `<agent dir>/pi-kit/overrides.json` ([Profiles](profiles.md)).
`luna schedule` needs no extension.

Pinned by `tests/luna-cli-smoke.ts` (`tests/schedule-checks.ts`), which never calls the real
`systemctl` or `crontab`: the library takes an injected runner, and the CLI runs with only a fake
`systemctl` and `crontab` on `PATH`.

## Not covered

- **Agents with shell access.** The tool firewall does not yet rate `luna schedule add`, unit-file
  or crontab writes, or the spec directory as operator-only (V5-15). Until it does, an agent allowed
  to run `luna schedule add --yes` can create a schedule, and a scheduled job that is allowed to run
  shell commands could do the same after unsetting `LUNA_SCHEDULE_JOB`. The digest stops an edited
  spec from running; it does not stop a new schedule from being added. Run with the firewall asking
  for shell commands.
- **Same-user writes.** Every file involved belongs to you. A process running as you can rewrite a
  unit file or crontab line, digest included; the digest protects against an edited spec, not
  against a rewritten unit.
- **Missed runs.** A timer's runs missed while the machine was off are not caught up.
- **Other systems.** Windows has neither backend. The lock is a socket file on every platform; two
  runs that both find a stale one at the same moment can both take it.
