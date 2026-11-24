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

From inside pi (the `web-console` extension registers `/console` in the
`balanced`, `long-horizon`, `self-improving` and `engagement` profiles):

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
| Unauthenticated use | 401 on every route except `/api/health` and the static shell, the event stream and the read-only `/api/autonomy` included. The token is compared in constant time, is never accepted in a query string, never set as a cookie and never logged. |
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

## Autonomy view

The **Autonomy** tab shows the [autonomous runs](autonomy.md) on this host. It is read-only:
there is no way to start, pause, answer or cancel a run from the console. Use `/autonomy` or
`pi-autonomy` for that.

The tab reads `GET /api/autonomy`. It polls every 5 seconds while the tab is shown and the
browser tab is visible, one request at a time: a tick while a request is still pending is skipped,
and an answer that arrives after you left the tab is not shown. The route needs the token like every other route. It is not part of the
`/api/health` exemption. With the token, any method other than `GET` gets 405 with `Allow: GET`. The server reads the
autonomy state home on each request: `PI_AUTONOMY_HOME`, else `$XDG_STATE_HOME/pi-autonomy`,
else `~/.local/state/pi-autonomy`, resolved in the environment the console server was started
with. The answer is schema version 1:

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `at` | when the answer was built (ISO time) |
| `runs` | at most 200 runs, newest first by `updatedAt` (else `startedAt`); a run whose state records neither has no time and sorts last, then by run id. Each has `run`, `template`, `status`, `updatedAt`, `outcome` (`{status, reason}` or null), `spentUsd`, `budgetUsd`, `step`, `blocker` (`{kind, question, waiting?}` or null), `legacy` (only on a run the previous supervisor wrote) and `lastEventAt`. These are the fields `pi-autonomy status` lists. A figure the run did not record is `null` |
| `runsTotal` | how many runs there were before the cut at 200 |
| `events` | the newest 50 events of the [host event log](autonomy.md#host-event-log), oldest first, each line as written (`v`, `at`, `run`, `type` and that type's own fields) |
| `status` | the [reporting status file](autonomy.md#reporting-lines) `status.json` in the state home, when it is schema version 1, else `null`. `pi-autonomy report --out "$PI_AUTONOMY_HOME/status.json"` writes it there |
| `skipped` | `{runs, events, status}`: how many run states, event lines and status files could not be read or did not match, and were left out |

The tab shows one row per run with its id, template, status (with the blocker question or the
outcome reason), step, spend against budget and the age of its newest event. Below that it shows
the recent events, newest first, and the spend and open pull requests from the status file.

A malformed `state.json`, event line or status file is skipped and counted. It never fails the
whole answer. Blocker questions, reasons and branch names can carry text a worker wrote. Every
string the server sends from `state.json`, an event line or the status file (record keys
included) first passes through the kit's [redaction table](security.md#redaction), as the status
file and phone alerts do, and is then reduced to one visible line (control, bidirectional and
zero-width characters become spaces) and clipped. Redaction is best effort: a secret in a shape
the table does not know is sent as written. A FIFO or other non-regular file at any of these names
is skipped and counted without waiting on it. The page shows every string as text and never
parses it as HTML.

The console does not load the autonomy library. `packages/autonomy` is not in the published
package, so the server reads the files with its own parsers: `packages/web-ui/server/autonomy.ts`.
Type checks against the library's event, run and status types fail `npm run test:typecheck` if
the two drift apart. `tests/web-ui-api-smoke.ts` pins the shape against state written by the
library itself: every event type, a malformed run, line and status file, the cut at 50 events,
redaction and one-line strings in runs, events and the status file, a FIFO skipped, and 405 on
other methods. `tests/web-ui-security-smoke.ts` pins the 401 without a token and the
answer over real HTTP. `packages/web-ui/scripts/ui-smoke.ts` pins the rendering and that polls never overlap.

**Not covered:**

- The events come from the last 512 KiB of `events.jsonl` and its rotated generation. A run whose
  newest event is older than that shows no last-event age.
- A state home that is a link is followed, as the autonomy CLI follows it. `state.json`,
  `status.json` or an event log that is itself a link is not read and counts as skipped.
- A paired phone holds a console token, so it can read this route too.
- The console reads the state home of the account it runs as. A run that another account
  supervises, or one in another state home, is not shown.

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
- **Whoever holds the token, or a linked phone, starts sessions with your authority.** A new
  session runs `pi --mode rpc` as you, in a folder the caller names, with your installed profile,
  so the tool firewall and its approvals apply as they do at a terminal. The agents offered for a
  session come from your agent directory and Luna's (`PI_CONSOLE_PROJECT_AGENTS`), never from
  the folder the session starts in, and pi in RPC mode loads a folder's own project resources only
  if you trusted that folder. Continuing a saved session is accepted only for an absolute path to
  a `.jsonl` regular file inside pi's sessions directory, after symbolic links are resolved, that
  does not start with `-` (`tests/web-ui-spawn-validate-smoke.ts`).
- Nothing here was tested on Windows.

The test suites that pin this behaviour are `tests/web-ui-security-smoke.ts`,
`tests/web-ui-bind-policy-smoke.ts`, `tests/web-ui-rpc-smoke.ts`, `tests/web-ui-spawn-validate-smoke.ts` and
`packages/web-ui/scripts/ui-smoke.ts`, all run by `npm run check:all` (all but the last also by `npm run test:security`). See also
`packages/web-ui/README.md` for the design and features.
