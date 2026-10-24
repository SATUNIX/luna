# pi-console

A self-hosted web console for the **Pi coding agent**: list, create, run, and interact with
Pi sessions and the agents defined in your Pi installation — from one browser tab.

- **No runtime dependencies.** Plain Node.js (`node:http`) backend; `package.json` lists no
  `dependencies`. The browser code is TypeScript in `src/`, compiled by `npm run build:web` into
  the committed `public/js/` and `mobile/` `.js` files (`internal/docs/adr/0002`). Edit `src/`,
  never the generated `.js`: `npm run smoke:web-build` fails when they differ. Serving the console
  compiles nothing.
- **Real Pi sessions.** Each open session is backed by a real `pi --mode rpc` child process;
  the console proxies Pi's JSONL protocol and streams events to the browser over SSE.
- **Live sync with the CLI.** Sessions you run in the terminal show up live in the console:
  the server tails their session file and streams the same messages, tool calls and results.
- **Pi owns persistence.** The console only reads Pi's own session files; it never writes them.

## Design

IBM Carbon design language: flat, square corners (no `border-radius` anywhere), 1px borders,
no shadows, no gradients, dense data-forward layout. Scrollbars are hidden throughout
(scrolling still works). Panels collapse with animated, non-snapping transitions.

**Typography**

| Role | Font |
| --- | --- |
| All information (headings, labels, body) | **Helvetica** / **Arial** (system stack) |
| Technical readouts, code, tool output | **JetBrains Mono** |

Sans-serif text uses the system Helvetica Neue / Helvetica / Arial stack, falling back to the
metric-compatible Liberation Sans / Nimbus Sans when absent, so Arial rendering stays consistent
on Linux with no webfont. JetBrains Mono is referenced by family name; install it system-wide or
drop `JetBrainsMono-Regular.woff2` into `public/fonts/` for the intended look.

**Palette (code-marathon-3, expanded)**

| Token | Value | Role |
| --- | --- | --- |
| lime | `#c2fe0c` | primary / interactive |
| violet | `#5200ff` | success · the prompt input border |
| magenta | `#ea027e` | danger / error |
| blue | `#3601fb` | info |
| orange | `#ff5500` | warning · externally-active sessions |
| white | `#ffffff` | text |

Surfaces are **monotone black** (`#000000`) with neutral borders (`#303030`, soft `#101010`);
hover/selection use translucent white overlays so feedback survives on black.

The prompt composer's border is violet `#5200ff` by design.

**Chat messages render markdown** — headings, lists, tables, blockquotes, inline code and
fenced code blocks, with syntax colouring (keywords magenta, strings lime, numbers orange,
comments dim, functions violet). Rendering is done by `src/public/js/markdown.ts` (served as
`public/js/markdown.js`), which builds DOM
nodes directly and never parses HTML from a message, so agent output cannot inject markup;
links are scheme-checked.

**Information lives in exactly one place** (minimalism): session activity is reported only by
the activity wheel in the chat header; server health only in the status bar; the model only by
the chat-header selector (and the Config view); token/cost/context detail only in the inspector.
The three triangles in the top bar toggle the sessions panel, the inspector and the input bar.

## Requirements

- Node.js ≥ 22.19 (pi's own minimum)
- The `pi` CLI on `PATH`
- A configured provider/model in `<pi home>/models.json`
  (defaults to `~/.pi/agent`, overridable with `PI_CODING_AGENT_DIR`). The New session picker
  lists only the providers in `models.json`; a provider you signed in to with `/login` and that
  has no `models.json` entry does not appear (`tests/web-ui-server-smoke.ts`).

## Run

From the repository root:

```bash
npm --prefix packages/web-ui start    # runs node packages/web-ui/server/server.ts
```

The server generates an access token for this run and prints a login link on the terminal:
`http://127.0.0.1:8123/#token=...`. Open that link (the page keeps the token for the tab and
removes it from the address bar). Started without a terminal (a service, `nohup`), the token is
written to `.runtime/console.token` (mode 0600) instead of the log; or set `PI_CONSOLE_TOKEN`.

### From pi (recommended)

The `web-console` extension registers the `/console` slash command (alias `/webui`). It launches
this server as a detached process and prints the login link:

```
/console                      # start (default) and print the login link
/console open                 # start and open the login link in a browser
/console status               # running? pid, root (the token is hidden)
/console status --show-token  # ...and print the login link
/console stop                 # stop the server /console started
```

Standalone setup, from the repo root:

```sh
npm run install:web   # checks prerequisites, registers the extension, prints how to start
```

With a kit already installed, it reinstalls the installed profile only when that profile (with
`<agent dir>/pi-kit/overrides.json` applied) includes `web-console`. For a profile that does not,
such as `quick` or `lite`, it changes nothing, names the profiles that include it, suggests
`--profile balanced`, and does not offer `/console`; if `overrides.json` also lists `web-console`
in `extensions.remove`, it says that entry must be removed too. For a profile that includes
`web-console` but whose `extensions.remove` drops it, it names that entry as the cause instead
(`tests/web-ui-install-smoke.ts`).

Environment overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_CONSOLE_HOST` | `127.0.0.1` | bind address; anything non-loopback is refused unless `PI_CONSOLE_ALLOW_REMOTE=1` |
| `PI_CONSOLE_PORT` | `8123` | listen port |
| `PI_CONSOLE_TOKEN` | generated per start | access token you choose: 32-256 characters of `A-Za-z0-9._~-` (`openssl rand -hex 32`) |
| `PI_CONSOLE_TOKEN_FILE` | unset | file holding the token (used when `PI_CONSOLE_TOKEN` is unset); keep it mode 0600 |
| `PI_CONSOLE_AUTH` | `token` | `off` disables authentication: loopback only, incompatible with remote mode, prints a loud warning. Never the default |
| `PI_CONSOLE_ALLOW_REMOTE` | unset | `1` allows a non-loopback bind; token authentication stays mandatory |
| `PI_CONSOLE_ALLOWED_HOSTS` | unset | comma-separated host names the server answers to (`Host` header allowlist); required for a wildcard bind or when a TLS proxy fronts it |
| `PI_CONSOLE_ACCESS_LOG` | unset | `1` logs every request line (path only, never the query, headers or token); denied requests are always logged |
| `PI_CONSOLE_RUNTIME_DIR` | `.runtime/` | scratch directory (temp agent prompts, a generated token file); mainly for tests |
| `PI_BIN` | `pi` | path to the pi executable |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi config dir (sessions, models, settings) |

## What you can do

- **Sessions** — browse every Pi session on disk (idle) plus live ones (running), filter them,
  open one, and send prompts. Sessions active in another process are flagged (orange, pulsing).
- **Live sync with the CLI** — run `pi` in a terminal and open the same session here: its
  messages, thinking, tool calls and results stream into the UI as they happen. Prompting such a
  session from the web is refused (409) while another process owns it, so two writers never clash.
- **New session** — choose working directory, agent, provider/model, and thinking level.
- **Agents** — browse, **create, edit, rename and delete** the agents discovered from
  the user directory `<agent dir>/agents` (`~/.pi/agent/agents` unless `PI_CODING_AGENT_DIR`
  moves it; the same directory the subagent tool reads user roles from) and the project
  directory, which is the kit's own `packages/kit/agents` unless `PI_CONSOLE_PROJECT_AGENTS`
  names another (`server/config.ts`; the tests point both at temporary directories,
  `tests/web-ui-api-smoke.ts`); start a session pre-bound to any of them.
  Agent GET/DELETE/PUT accept `?source=user|project` to disambiguate duplicate names
  (the same name can exist at both levels).
- **Live chat** — assistant replies rendered as **markdown** with coloured code blocks,
  collapsible thinking blocks, tool calls with live output, and tool results.
- **Session controls** — switch model and thinking level mid-session, fork, or reset in place.
- **Inspector** — per-session stats (tokens in/out/cache, cost, context-window usage), the
  session's own todo list, and pi-lens diagnostics for the files it touched.
- **Thinking wheel** — an animated activity readout that rotates through status phrases
  (`Working`, `Triangulating`, …) and switches to concrete labels (`Reading server.ts`,
  `Running \`ls\``,`Delegating to a subagent`) as the agent works, plus an elapsed timer.
- **Config view** — how this installation is set up: pi home, settings, models, paths, lens
  status, prompt templates and skills.
- **Panel toggles** — three triangle buttons (top right) show/hide the sessions panel, the
  inspector, and the input bar, with smooth animated transitions (state is remembered).
- **Abort / Stop** — abort the current run, or stop (kill) the session's child process.
- **Mobile friendly** — the sidebar and inspector become drawers on narrow screens.

## Architecture

```
Browser (public/)  ──HTTP──▶  server/server.ts  ──JSONL stdin/stdout──▶  pi --mode rpc
        ▲                      REST + SSE hub                                  │
        └────── SSE events ◀─────────── events ───────────────────────────────┘
```

| File | Responsibility |
| --- | --- |
| `server/config.ts` | paths, ports, runtime dir |
| `server/security.ts` | bind/token policy, Host / Origin / token / content-type gate, security headers |
| `server/validate.ts` | validation of session ids, spawn config and RPC arguments |
| `server/agents.ts` | discover + parse agent `.md` files (frontmatter + body) |
| `server/agentstore.ts` | create/update/delete agent files (path-safe, the only writer) |
| `server/models.ts` | providers/models from `models.json` only + default from `settings.json` |
| `server/sessions.ts` | read-only listing of Pi's session `.jsonl` files |
| `server/spawn.ts` | spawn/kill one `pi --mode rpc` child per session; JSONL framing; response correlation; event fan-out |
| `server/tailer.ts` | follow a session file written by another process (live CLI sync) |
| `server/stats.ts` | token/cost/context stats (live RPC, or computed from the session file) |
| `server/todos.ts` | read the kit's per-session todo file |
| `server/lens.ts` | pi-lens session diagnostics |
| `server/configinfo.ts` | installation config + prompt templates + skills |
| `server/routes.ts` | REST endpoints + SSE stream |
| `server/server.ts` | HTTP server, static files, shutdown |

The same modules also serve phones. `server/remote-host.ts` (started by `/remote`) offers this API
over HTTPS to phones linked with the pi remote Android app, and `server/remote/*` adds linking,
signed-challenge sign-in, terminal-session sharing and answers to dialogs; `server/remote-cli.ts`
manages it without a pi terminal. `mobile/` holds the app's screens, which reuse
`public/js/render.js` and `public/js/panels.js`. See `docs/remote-control.md`.

The disk readers tolerate malformed persisted entries: non-object JSONL lines in a session file, non-object provider values, and non-object `models` elements in `models.json` are skipped rather than failing the request.

### API

Every route below requires `Authorization: Bearer <token>` except `/api/health`, and every
`POST`/`PUT`/`DELETE` must send `Content-Type: application/json` (an empty `{}` body is fine).
Cross-origin requests and requests with a foreign `Host` are refused.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness + uptime + `auth` mode (open; reveals nothing else) |
| GET | `/api/auth` | 200 when the presented token is valid (used by the login prompt) |
| GET | `/api/config` | installation configuration (paths, settings, models, lens) |
| GET | `/api/prompts` | prompt templates shipped with the kit |
| GET | `/api/skills` | skills shipped with the kit |
| GET | `/api/agents` | discovered agents + the known tool list |
| GET | `/api/agents/:name` | one agent including its system-prompt body |
| POST | `/api/agents` | create an agent (`name`, `description`, `tools`, `model`, `body`, `source`) |
| PUT | `/api/agents/:name` | update / rename an agent |
| DELETE | `/api/agents/:name` | delete an agent file |
| GET | `/api/models` | providers, models, default |
| GET | `/api/cwds` | candidate working directories |
| GET | `/api/sessions` | disk sessions merged with live children (`status`: running/idle/external) |
| POST | `/api/sessions` | spawn a session (`cwd`, `agent`, `provider`, `model`, `thinking`) |
| GET | `/api/sessions/:id` | one session summary |
| GET | `/api/sessions/:id/stats` | tokens, cost, context usage, message counts |
| GET | `/api/sessions/:id/todos` | this session's todo list |
| GET | `/api/sessions/:id/lens` | pi-lens diagnostics for this session |
| POST | `/api/sessions/:id/prompt` | send a prompt (`message`, optional `streamingBehavior`) |
| POST | `/api/sessions/:id/abort` | abort the current run |
| POST | `/api/sessions/:id/model` | switch model (`provider`, `modelId`) |
| POST | `/api/sessions/:id/thinking` | set thinking level (`level`) |
| POST | `/api/sessions/:id/fork` | fork this session |
| POST | `/api/sessions/:id/new` | start a fresh session in place |
| DELETE | `/api/sessions/:id` | stop (kill) the child process |
| GET | `/api/sessions/:id/events` | SSE: live Pi events, or tailed events for external sessions |

`/api/sessions/:id/events` emits `event: lifecycle` (`running` / `watching` / `exited` / `error`)
plus `event: event` frames (live RPC child) and `event: observed` frames (a session being written
by another process, i.e. the CLI). Observed frames carry `observed_message`,
`observed_compaction`, `observed_model_change` and `observed_thinking_level` payloads.

Sending a prompt to an idle session resumes it by spawning a child bound to its session file.
If another process is actively writing that session, the request is refused with `409` instead
of attaching a second writer.

## Smoke test

```bash
scripts/smoke-test.sh [provider] [model]   # full end-to-end check (server + real pi child)
node scripts/ui-smoke.ts                  # offline frontend wiring check (no browser needed)
```

`smoke-test.sh` starts the server on an isolated port and an isolated session directory, then
checks: health, discovery endpoints, static serving, a real spawn → prompt → streamed-reply →
stop roundtrip, session stats/todos/lens, live-sync tailing of an externally-written session
file, the agent CRUD roundtrip (including a path-traversal attempt), and finally runs the
offline UI wiring check. It must not touch your real sessions or agents.

## Security

The console can start `pi` agents that have shell access, so anyone who can drive its HTTP API can
run commands as you. It is therefore locked down as a credential-bearing service.

- **Access token, always on.** Each start generates 256 random bits (`crypto.randomBytes`) unless
  you supply `PI_CONSOLE_TOKEN`. Every API and event-stream route requires it as an
  `Authorization: Bearer` header, compared in constant time (SHA-256 digests +
  `crypto.timingSafeEqual`). Only `/api/health` and the static page shell are open. The token is
  never accepted in a query string, never set as a cookie, never logged, and stripped from the
  environment of the `pi` children.
- **How the page gets the token.** You open `http://host:port/#token=...`. A URL fragment is not sent
  to the server or in a `Referer`; the page moves it into `sessionStorage` (this tab only) and removes
  it from the address bar. A tab without it shows a prompt to paste the token. There is no cookie:
  cookies are not port-isolated, so one would also be sent to other services on `127.0.0.1`.
  Event streams use `fetch()` rather than `EventSource` so they can carry the header.
- **Other sites and rebinding.** The `Host` header must name this server (defeats DNS rebinding);
  a cross-origin `Origin` or `Sec-Fetch-Site: cross-site` / `same-site` (which includes another
  localhost port) is refused on every API route, event streams included; every state-changing request
  must be `application/json`, which a foreign page cannot send without a CORS preflight, and no CORS
  headers are ever sent, so preflights fail.
- **Loopback by default.** A non-loopback `PI_CONSOLE_HOST` is refused unless
  `PI_CONSOLE_ALLOW_REMOTE=1`, and then only with token authentication (`PI_CONSOLE_AUTH=off` is refused
  for any non-loopback bind). The bound address is re-checked after `listen()`. Off loopback the server
  still speaks **plain HTTP**, so the token crosses the network in clear text unless TLS is terminated
  in front of it (an SSH tunnel, or a TLS proxy that preserves the `Host` header and is named in
  `PI_CONSOLE_ALLOWED_HOSTS`). A reverse proxy, a VPN or a CORS setting is not authentication.
- **What reaches `pi`.** Only eight RPC command types are ever sent to a child (`prompt`, `abort`,
  `set_model`, `set_thinking_level`, `fork`, `new_session`, `get_state`, `get_session_stats`), each with a
  fixed shape; pi's `bash`, `switch_session` and `export_html` commands cannot be reached. Spawn
  configuration, model ids, entry ids, `streamingBehavior` and session ids are validated before any child
  starts or any file is touched. Request bodies are capped at 1 MB.
- **Headers.** `Content-Security-Policy` (`default-src 'none'`, `script-src 'self'`, `style-src 'self'`,
  `frame-ancestors 'none'`; the page has no inline script or style and the UI sets styles through the
  CSSOM), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy: same-origin`, and `Cache-Control: no-store`
  on the API.
- The UI builds all session/tool/markdown content with DOM text nodes (no `innerHTML`); links are
  scheme-checked and open with `rel="noopener noreferrer"`.
- Static file serving rejects path traversal outside `public/` and dotfiles.
- The console never writes Pi session files — Pi alone owns their lifecycle. Its only writes are agent
  definitions (path-checked), a temp `--append-system-prompt` file and the token file, all under
  `.runtime/` or the agent directories.
- Shutdown (SIGINT/SIGTERM) closes event streams, stops the tailers and stops every `pi` child,
  escalating to SIGKILL for one that ignores SIGTERM.

Known limits: the token file (mode 0600) and the login link are as safe as the account that owns
them, and an agent's shell runs as that account. `/console open` passes the login link to the browser
launcher as an argument, which other local users of a shared host may glimpse in a process list.
The Windows file-mode bit is not enforced. The shipped tests (`tests/web-ui-*-smoke.mjs`) exercise the
real server over loopback; there is no browser in CI, so the CSP has not been exercised in a real
browser.

## Status

Early but functional: sessions, agents, live streaming chat, spawn/resume/abort/stop all work
against a real Pi installation.
