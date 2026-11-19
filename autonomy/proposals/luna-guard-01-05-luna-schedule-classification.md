# Proposal: classify `luna schedule` control verbs as high in every launch form

**Run/cycle:** luna-guard-01 / 05
**Board:** V5 15 (schedule-classification item)
**Status:** design + evidence, owner route. The change touches the firewall's classification table,
a control path (`packages/autonomy/lib/risk.ts` R3: "a guard … gate policy"), so an unattended cycle
must propose it rather than merge it. No patch is attached: the probe below is reproducible, but the
implemented rule still needs the corpus rows and a full check run.

## Evidence (probed at head `83594554acfd`)

Using `loadModule`/`isolateKitEnv` from `packages/core/eval/harness.ts` and
`effectiveTier(classifyCommand(cmd, env), false)` with `policy: "coding"`:

| command | tier | code |
| --- | --- | --- |
| `luna schedule add nightly daily 02:00 -- …` | medium | `unknown_exec` |
| `luna schedule remove nightly` | medium | `unknown_exec` |
| `luna schedule run-now nightly` | medium | `unknown_exec` |
| `node packages/core/luna.ts schedule add …` | **low** | `script_exec` |
| `npx luna schedule add …` | medium | `pm_exec_fetch` |
| `bash -c 'luna schedule add …'` | medium | `unknown_exec` |
| `echo x > ~/.local/state/luna/schedules/nightly.json` | medium | `outside_write` |
| `echo x > ~/.config/systemd/user/luna-schedule-nightly.timer` | high | `persistence_write` |
| `crontab -e` | high | `crontab_install` |

So a schedule that runs later (and a write the scheduler will read) is not high in the direct,
`node …/luna.ts`, `npx`/runner and `bash -c` forms. Only the systemd-user and crontab writes are
already high.

## Proposed rule

1. **Mutating verbs are persistence.** In `packages/extensions/src/tool-firewall/classify.ts`, add a
   broad matcher next to `autonomyBroad` (the same pre-identity scan shape) that finds a `luna`
   program followed by the `schedule` verb and one of `add` / `remove` / `run-now`, and emits a
   `high` / `persistence` / `scheduled_task` finding. The matcher must see through the launch forms
   the probe covers: bare `luna`, a path ending `/luna` or `/luna.ts` (the `package.json` bin), a
   package runner's operand (`npx luna`, `pnpm dlx luna`, `node …/luna.ts`), and an inline
   `bash -c` / `sh -c` payload (reuse the existing inline-command extraction that
   `AUTONOMY_INLINE` feeds).
2. **The spec directory is persistence.** Add the schedule spec directory
   (`<XDG_STATE_HOME or ~/.local/state>/luna/schedules/`, `packages/core/lib/schedule.ts`) to
   `PERSIST_HOME` so a write there classifies as `persistence` / high. Reading it can stay as it is;
   the directory only names schedules, so a read is not a control change.
3. **Read-only verbs stay lower.** `luna schedule list` and `luna schedule show` are not control
   changes; keep them below high. A bare `luna` with no `schedule` verb must not become high.

Do not touch `crontab_install` or `persistence_write`; the probe shows they already behave.

## Two-sided tests

`tests/firewall-shell-smoke.ts` (and one row per launch form in
`tests/firewall-must-block-corpus-smoke.ts`, family `privilege-escalation`):

- high for `schedule add`, `schedule remove`, `schedule run-now` in each of: bare `luna`,
  `node …/luna.ts`, `npx luna`, `bash -c 'luna …'`;
- high for a write to `…/luna/schedules/nightly.json` and to a systemd user unit;
- allowed/low for `luna schedule list`, `luna schedule show nightly`, and a bare `luna`-shaped
  string that is not a launch.

Fails before the change (the first six rows are medium or low today) and passes after.
