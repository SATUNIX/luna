# An invalid or unsafe `hubKey` is injected raw into the launch screen and `/menu` description

Status: **implemented** in cycle 20, commit `631ca51` (validate in `readHubKey`, tests in
`tests/control-center-smoke.ts` and `tests/launch-screen-smoke.ts`, `docs/control-center.md`).
Found during cycle 19 by a scout; not in that cycle's scope.

## Problem

`readHubKey()` in `packages/extensions/src/control-center/index.ts:31-35` accepts any non-empty
trimmed string from `<agent dir>/pi-kit/ui.json`:

```ts
const key = readUiFile()?.hubKey;
if (typeof key === "string" && key.trim() !== "") return key.trim();
```

That value is then:

- interpolated into the launch screen (`launch-screen.ts:77` compact line, `:83` action row) and
  clipped with `truncateToWidth` (`:97-102`), which does not strip terminal escapes;
- interpolated into the `/menu` command description (`index.ts:210`);
- passed to `pi.registerShortcut` (`index.ts:226`).

A value such as `"alt+m\u001b[2J\u001b]0;pwned\u0007"` reaches the header verbatim (clear-screen
and title-set execute), and a newline breaks the one-line header. A value the shortcut matcher
cannot produce silently never fires, while the launch screen and Help page still advertise it.
The rest of the extension already treats file-derived display text as untrusted (`hub.ts`
`headerLine`/`informationalPage` run `stripTerminalSequences`); the launch screen, the command
description and the shortcut are the exception.

## Suggested fix

Validate once in `readHubKey()`: strip terminal sequences, reject any value containing whitespace,
control characters or a newline (`/[\u0000-\u001f\u007f\s]/`), and reject anything that does not
match a simple modifier+key shape (`alt+m`, `ctrl+shift+k`). On rejection, warn once (the
`warnOnce` pattern in `command-menu.ts`) and return `alt+m`. One choke point covers the launch
screen, `/menu` description, Help page and shortcut registration.

## Evidence to pin

- `tests/launch-screen-smoke.ts`: `launchLines` with a `hubKey` containing `\x1b[2J` or `\n`
  contains no ESC and no newline.
- `tests/control-center-smoke.ts`: `readHubKey()` with `{"hubKey":"alt m\n"}` returns `alt+m`, and
  the registered shortcut is `alt+m`.

Both fail on the pre-fix source (raw value registered; ESC emitted).

## Docs

`docs/control-center.md:20-27` (the `hubKey` paragraph): add that an invalid `hubKey` is ignored
with a warning and `alt+m` is used.
