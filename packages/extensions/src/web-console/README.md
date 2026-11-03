# web-console

`/console` (alias `/webui`) — start, stop and check the bundled **Pi Console** web UI
that ships in [`packages/web-ui`](../../web-ui).

The command does one thing: launch the existing zero-dependency server
(`packages/web-ui/server/server.ts`) as a detached Node process and report its URL. It does
not proxy sessions itself, never writes Pi session files, and changes no other extension's
behaviour.

## Usage

```
/console                     # start (default) and print the login URL
/console open                # start if needed, then open the login URL in a browser
/console status              # report running/not reachable, pid and root (token hidden)
/console status --show-token # ...and print the login URL
/console stop                # stop the server this command started
```

The **login URL** is `http://127.0.0.1:8123/#token=<token>`. The page reads the token from the
URL fragment (a fragment is never sent to the server or in a `Referer`), keeps it for that tab and
removes it from the address bar. Treat the link like a password.

If the server refuses to start (for example a non-loopback `PI_CONSOLE_HOST` without
`PI_CONSOLE_ALLOW_REMOTE=1`), `/console` reports the tail of the server log instead of waiting.

`start` treats the health endpoint as the source of truth: a live pid file alone never makes it
report "already running". If the configured host/port does not answer `/api/health`, it spawns a
fresh server (overwriting the pid file), unless the pid file names a live console process that has
stopped responding; then it says so instead of starting a second server on the same port.

`stop` only signals the pid when it is the console. On Linux that is checked from the process
command line (`/proc/<pid>/cmdline` must name this web UI's `server/server.ts`), so a hung console
is stopped and a pid the OS has reused for an unrelated process is not. Where the command line
cannot be read, the console must answer its health endpoint.

## Resolution

`packages/web-ui` is located in this order:

1. `PI_KIT_WEBUI_ROOT` (explicit override)
2. relative to this extension (`<root>/packages/extensions/src/web-console` → `<root>/packages/web-ui`)
3. the `kitSource` checkout in the install marker (a project `.pi/.pi-kit.json`, else
   `~/.pi/agent/.pi-kit.json`), only when it is an absolute path that resolves, through any links,
   outside the workspace and whose `package.json` names the kit. A committed project marker is
   repository content, so any other `kitSource` is ignored with a warning and never chooses the
   server that runs (`packages/core/shared/kit-source.ts`, pinned by `tests/kit-root-trust-smoke.ts`).

Generated npm surfaces do not ship the web UI, so the command reports that clearly instead of
guessing.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_KIT_WEBUI_ROOT` | auto | explicit path to `packages/web-ui` |
| `PI_KIT_NODE` | pi's runtime when it is node or bun, else `node` on `PATH` | absolute path to the Node.js that runs the server; a compiled pi binary cannot, so without node `/console start` refuses before writing a token |
| `PI_CONSOLE_HOST` | `127.0.0.1` | server bind address; a non-loopback value is refused without `PI_CONSOLE_ALLOW_REMOTE=1` |
| `PI_CONSOLE_PORT` | `8123` | server port |
| `PI_CONSOLE_TOKEN` | generated per start | operator-supplied access token (32-256 characters of `A-Za-z0-9._~-`) |
| `PI_CONSOLE_TOKEN_FILE` | unset | path to a file holding the token (used when `PI_CONSOLE_TOKEN` is unset) |
| `PI_CONSOLE_AUTH` | `token` | `off` disables authentication; loopback only, prints a loud warning; never the default |
| `PI_CONSOLE_ALLOW_REMOTE` | unset | `1` permits a non-loopback bind (authentication stays mandatory) |
| `PI_CONSOLE_ALLOWED_HOSTS` | unset | comma-separated extra `Host` names (needed for a wildcard bind or a TLS proxy) |

## Security

The console can drive `pi` agents that have shell access, so it is treated as a credential-bearing
service, not a convenience page.

- **Access token.** Every start generates 256 random bits (or uses `PI_CONSOLE_TOKEN`). `/console`
  writes a generated token to `packages/web-ui/.runtime/console.token` (mode 0600) and passes only
  the *path* to the server; it is not on a command line, in the environment or in the server log.
  The token is required, as an `Authorization: Bearer` header, on every API and event-stream route
  (only `/api/health` and the static page are open).
- **Not printed by default.** `/console` prints the login URL because you asked to start it;
  `/console status` does not print the token unless you add `--show-token`.
- **Other browser tabs, other sites.** The server checks the `Host` header (DNS rebinding), rejects
  cross-origin requests, and requires `application/json` on every state-changing request.
- **Loopback by default.** A non-loopback `PI_CONSOLE_HOST` is refused unless
  `PI_CONSOLE_ALLOW_REMOTE=1`, and remote mode never runs without the token. The server speaks plain
  HTTP, so off-loopback the token crosses the network in clear text unless you terminate TLS in front
  (SSH tunnel or a TLS proxy that keeps the `Host` header). A reverse proxy or CORS setting is not
  authentication.
- **Limits.** `/console open` passes the login URL to the browser launcher as an argument, which
  other local users on a shared host may see briefly in a process listing; on a shared host, copy
  the link from `/console` instead. The token file is readable by your account (any process of yours,
  including an agent's shell, can read it), which is the same trust boundary as your other files.

The server's own runtime state (pid file, log, token file) lives in `packages/web-ui/.runtime/`.
