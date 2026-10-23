# session-helpers

Session-control helpers layered on top of the kit's autonomous behaviour: the `/profile` switch, the
`/compaction` view, a cheatsheet, and the one hook that keeps the effective compaction state visible.
It is in every profile, so every profile can see and fix its own configuration.

## Why

The kit is designed to run autonomously. Operators still need to see and change what is loaded and
whether pi will keep the context under control, and `pi` ships no `/clear` and no one-stop command list.
This extension fills those gaps. It changes nothing on its own except publishing state and warning once.

## Commands

| Command | What it does |
| --- | --- |
| `/clear` | **Guidance only — does not clear anything.** Explains `/compact` (shrink context, keep thread), `/new` (fresh session), and `/fork` (branch). |
| `/kit`, `/helpers` | The cheatsheet of pi built-ins plus the kit helpers. |
| `/profile` | Switch the profile, all-or-nothing (below). `/profile` picker, `/profile <name>`, `/profile list`, `/profile status`. |
| `/compaction` | `status` (default without a UI) shows whether pi auto-compaction is really on, at what token count it triggers, the kit trigger, and why it is degraded. `on` / `off` write pi's global `compaction.enabled` and reload; `trigger on\|off` toggles the kit's fixed-budget trigger. |

## Compaction: effective state, published, warned once

`computeCompactionState` reads the real settings the way pi does (global `settings.json`, deep-merged
field by field with the project's `.pi/settings.json`, an untrusted project's file ignored; `enabled`
is `?? true`, `reserveTokens` 16384, `keepRecentTokens` 20000; trigger = context window − reserve) and
adds what only the live session knows: the model's context window and whether `trigger-compact` is loaded.

It reports `enabled`, the earliest automatic trigger, and — when compaction is off or cannot work — a
reason: `disabled` (pi then also stops recovering from a context overflow), `window-unknown` (the model
reports no context window; usage is unknown, never 0), or `reserve-exceeds-window` (a reserve that leaves
a trigger below the kept-recent size, so pi would compact almost every turn).

The state is published for other extensions (the footer reads it) on `session_start`, `model_select`,
before each agent run, and after any `/compaction` change:

```ts
globalThis[Symbol.for("pi-kit.compaction")] // { enabled: boolean | null, thresholdTokens: number | null, reason: string | null }
```

`enabled` is `null` until the first `session_start` (and after `session_shutdown`); `thresholdTokens` is
the first automatic trigger (the kit trigger when it is below pi's own) or `null` when unknown or off;
`reason` is `null` when healthy. A non-null reason is warned **once per session** — through the UI when
there is one, on stderr otherwise — not per turn and not again after a reload.

## Switching profiles with `/profile`

`/profile` is the in-session front-end to `packages/core/install.ts --settings-only`; it does not
reimplement install logic. Kit-root resolution: `PI_KIT_ROOT` → the `kitSource` in the install marker (when
it is a path) → this module's own location. Two layouts are supported: the monorepo
(`packages/core/install.ts` + `packages/kit/profiles`) and a legacy flat kit.

**The switch is transactional** (`profile-switch.ts`):

1. Arguments are validated first: one word, a known profile; anything else changes nothing. A cancelled
   picker changes nothing. A profile naming an unknown firewall policy or mode is refused before the installer runs.
2. Every file the switch can change (`settings.json`, the install marker, `pi-kit/firewall.json`,
   `pi-kit/overrides.json`, the `.env` scaffold, both scopes) is snapshotted, bytes and mode.
3. The installer runs. `pi.exec` reports a signal-killed child as exit code `0`, so success is not judged by
   the code: the marker (the installer's last write) must be newer than the switch and name the requested
   profile, the settings entry must list exactly the profile's extensions (with overrides) and each must
   exist, and `firewall.json` must hold a known policy and the mode the profile requires.
4. Any failure — exception, kill, timeout, non-zero exit, missing completion line, corrupt or mismatching
   result, or a failed reload — restores every snapshot byte-for-byte, removes stray lock/tmp files and says
   what happened. If a restore itself fails, the original bytes are saved to a temp directory and named.
   The snapshots cover files only: a `pi install` the installer already ran (a companion, or the kit when
   it was not registered) is not undone, so the message names each one instead of saying nothing was
   changed (`tests/profile-transaction-smoke.ts`, `tests/profile-safety-smoke.ts`). `/profile` passes
   `--no-migrate`, so a switch never moves the kit off a retired or previous source: the installer stops
   before any change and names `/update kit` and the Migration guide instead, and no `pi remove` can
   delete a clone that this rollback would point settings back at (`tests/profile-transaction-smoke.ts`,
   `tests/distribution-smoke.ts`).
5. Only then does it reload.

Installer warnings (for example a stale name in `overrides.json`) are shown after a successful switch.
Without a UI every message goes to stderr. A bare `pi install git:…@<tag>` / `npm:@satunix/pi-system`
registers the package unfiltered; the first interactive session applies the `balanced` profile (or
`PI_KIT_AUTO_PROFILE=<name>`; `0` disables) through the same transaction and asks for `/reload`.

`/profile status` prints the effective configuration: profile (and drift against the closest one),
install mode / channel / source / scope, how many extensions are loaded and the notable ones, warnings when
`tool-firewall` or `protected-paths` is not loaded, the firewall policy and mode, the compaction state,
the overrides in force, and the companion packages (with whether each is still registered).

## Built-ins worth knowing (provided by pi, not this extension)

`/new` (new session · the real "clear"), `/compact` (compact context), `/fork`, `/clone`, `/tree`,
`/resume`, `/session`, `/model`, `/settings`, `/hotkeys`. Compaction is pi's own (`compaction.*` in
settings); `context-sieve` does not compact anything — it assembles injected context.

## Limits

- Package payloads that `pi install` fetched during a switch (a companion's files) are not rolled back;
  the settings entries that register them are.
- A rollback cannot un-write settings pi itself saved in the middle of a switch (a concurrent settings
  change in another window); the switch is short and runs with the agent idle, but it is not a lock.
