# Web console

`packages/web-ui` is a self-hosted web console for pi: list, open and drive pi sessions from a
browser tab. It has no runtime dependencies. Its browser code is TypeScript under
`packages/web-ui/src/`, compiled by `npm run build:web` into committed `.js` files that the server
serves as they are (`npm run smoke:web-build` fails when they are stale). Each open session is
backed by a real `pi --mode rpc` child process; sessions you run in a terminal show up live
because the server tails their session files. pi owns persistence: the console reads pi's session files and never
writes them.

A console can start and prompt agent sessions, so **unauthenticated access would be remote
control of your agent.** It is therefore authenticated by default, bound to loopback, and refuses
requests from other origins. This page states exactly what is enforced.

## Starting it

From inside pi (the `web-console` extension registers `/console`, alias `/webui`, in the
`balanced`, `long-horizon`, `autonomous`, `self-improving` and `pentest` profiles):

```
/console                      start and print the login link
/console open                 start and open the login link in a browser
/console status               running? pid, root (the token is hidden)
/console status --show-token  ...and print the login link
/console stop                 stop the server /console started
```

Standalone: `npm run install:web`, then `npm start` in `packages/web-ui`.

The server generates a fresh 256-bit token at every start and prints a login link,
`http://127.0.0.1:8123/#token=...`. Open that link: the page moves the token from the address bar
into the tab's session storage and removes it from the URL. Started without a terminal (a
service, `nohup`), the token is written to `.runtime/console.token` (mode 0600) instead of the
log. `/console stop` removes that file.

## What is enforced

| Threat | Control |
|---|---|
| A web page you visit sends requests to the console (CSRF) | Every state-changing request needs the bearer token in the `Authorization` header, which a foreign page cannot set. Cross-origin and cross-port requests, and `Sec-Fetch-Site` values other than same-origin, get 403 before any handler runs. No CORS headers are ever sent. State-changing requests must be `application/json` (415 otherwise). |
| DNS rebinding | The `Host` header must be on an allowlist (loopback names and the bound port, plus `PI_CONSOLE_ALLOWED_HOSTS`) for every route, static files included. |
| Reaching the console from the network | The bind address must be loopback. Anything else is refused unless `PI_CONSOLE_ALLOW_REMOTE=1`, and a wildcard bind additionally needs `PI_CONSOLE_ALLOWED_HOSTS`. Remote mode always requires the token. |
| Unauthenticated use | 401 on every route except `/api/health` and the static shell, the event stream included. The token is compared in constant time, is never accepted in a query string, never set as a cookie and never logged. |
| Driving pi beyond a chat | Only eight RPC command types can reach a child. pi's `bash`, `switch_session` and `export_html` cannot. Request bodies are capped at 1 MB, and ids and session-spawn settings are validated before anything is started. The token is removed from the child's environment. |
| Script injection through agent output | Markdown is rendered by building DOM text nodes, never by parsing HTML. A Content-Security-Policy forbids inline script and style; `nosniff`, `no-referrer`, frame denial and `no-store` on the API are set. |
| Stuck children on shutdown | SIGTERM closes event streams and tailers and kills a child that ignores SIGTERM, within about six seconds. |

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_CONSOLE_HOST` | `127.0.0.1` | Bind address; a non-loopback value is refused unless `PI_CONSOLE_ALLOW_REMOTE=1` |
| `PI_CONSOLE_PORT` | `8123` | Listen port |
| `PI_CONSOLE_TOKEN` | generated | A token you choose: 32 to 256 characters of `A-Za-z0-9._~-` (`openssl rand -hex 32`) |
| `PI_CONSOLE_TOKEN_FILE` | unset | A file holding the token, used when `PI_CONSOLE_TOKEN` is unset; keep it mode 0600 |
| `PI_CONSOLE_AUTH` | `token` | `off` disables authentication: loopback only, incompatible with remote mode, prints a loud warning. Host, origin and content-type checks still apply. Never the default |
| `PI_CONSOLE_ALLOW_REMOTE` | unset | `1` allows a non-loopback bind; the token stays mandatory |
| `PI_CONSOLE_ALLOWED_HOSTS` | unset | Comma-separated host names the server answers to |
| `PI_CONSOLE_ACCESS_LOG` | unset | `1` logs every request line (path only, never the query, headers or token) |
| `PI_CONSOLE_RUNTIME_DIR` | `.runtime/` | Scratch directory, mainly for tests |

## Limits and residual risks

- **Off loopback the server speaks plain HTTP**, so the token travels in the clear. Use an SSH
  tunnel, or terminate TLS in front of it and list the public name in
  `PI_CONSOLE_ALLOWED_HOSTS`. A reverse proxy or a CORS setting is not authentication.
- The token file and pi's own shell run as the same account, so an agent running as you can read
  the file. The tool firewall classifies reading it (any file named `console.token`, or the file
  `PI_CONSOLE_TOKEN_FILE` names) as a credential read, so it asks you and feeds the
  secret-then-send rules; that is a guard rail, not a lock. The console protects against the
  network and other web pages, not against the agent it is driving.
- `/console open` passes the tokenised URL to `xdg-open` (or the platform's opener) as an argument.
  Other local users on a shared host might glimpse it in a process listing, and a browser the
  opener starts can keep it in its own command line. On a shared host use `/console` and paste the
  printed URL instead.
- The Content-Security-Policy and the browser behaviour have not been exercised in a real browser
  in this release; if `style-src` proves stricter than assumed, only the progress-bar widths break.
- Nothing here was tested on Windows.

The test suites that pin this behaviour are `tests/web-ui-security-smoke.ts`,
`tests/web-ui-bind-policy-smoke.ts`, `tests/web-ui-rpc-smoke.ts` and
`packages/web-ui/scripts/ui-smoke.ts`, all run by `npm run check:all` (the first three also by `npm run test:security`). See also
`packages/web-ui/README.md` for the design and features.
