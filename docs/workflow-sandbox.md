# Workflow-script sandbox

The workflow-script sandbox runs one untrusted JavaScript workflow script and passes its hook calls
(`agent()`, `workflow()`, `log()`, `phase()`) to the host, which decides what happens. It lives in
the `subagent` extension as `wf-sandbox.ts` (the host side) and `wf-runner.mjs` (the runner inside
the sandbox).

The [`workflow` tool](script-workflows.md) runs scripts through it; the YAML
[workflows](workflows.md) do not use it.

Every behaviour on this page is pinned by `tests/workflow-sandbox-smoke.ts`
(`npm run smoke:workflow-sandbox`), unless the page says otherwise.

## Layers

The host spawns the runner with an empty environment and three pipes. The script, its arguments
and the budget mirror travel over stdin. Nothing goes on the command line or into a file.

| Layer | What it does |
| --- | --- |
| `bwrap` | New user, pid, network, IPC, UTS and cgroup namespaces; read-only `/usr` and the system library links; only the node binary, `prlimit`, the runner and quickjs-wasi mounted under `/sandbox`; `--die-with-parent`, `--new-session`, `--cap-drop ALL`. `env -i` runs inside it, because bwrap always sets `PWD`. |
| `prlimit` | CPU seconds (soft limit, then a hard limit 5 seconds later), address space, `--fsize=0` (no file writes), `--core=0`, at most 64 descriptors. |
| `node --permission` | Can read only the runner and the quickjs-wasi directory. No child processes, worker threads, network, addons or WASI. `--disallow-code-generation-from-strings`, a 64 MB heap. |
| QuickJS (`quickjs-wasi`) | The script runs in raw QuickJS. There is no `Date`, `performance`, `WeakRef`, `FinalizationRegistry` or `eval`/`Function` constructor. A separate VM, which never runs code, compiles the script to bytecode first. |

The test probes the jail itself by running node code where the runner runs. The environment is
empty. File reads, file writes, child processes and network connections are all blocked. In full
mode, `process.kill` on the host's pid gets `ESRCH`. Worker threads, WASI and addons are refused
too.

`node:vm` is not used anywhere, and no fallback to it exists. The lint gate bans importing it.

## What the script sees

The script body runs as a strict-mode async function, so it can `await` at the top level. A
leading `export const meta = {...}` is accepted: the `export` keyword is dropped when only
whitespace, `//` line comments and `/* */` block comments come before it, and an `export`
anywhere else is left for the parser to reject. The source is scanned once, left to right
(`tests/workflow-sandbox-smoke.ts`, including a timing check on `/*` followed by 50,000 `*//*`
repeats). The VM's globals are the standard built-ins plus:

| Global | Behaviour |
| --- | --- |
| `agent(prompt, opts?)` | Calls the host's `agent` hook with `{prompt, opts}` and resolves to its result. It rejects with the hook's error message. Once `budget.total` is set and `budget.spent()` has reached it, it throws `budget exhausted`. |
| `parallel(thunks)` | Runs every thunk; a thunk that throws resolves to `null`. At most 4096 thunks. |
| `pipeline(items, ...stages)` | Each item goes through every stage on its own, with no barrier between stages. Each stage gets `(previous, item, index)`, and a stage that throws turns that item into `null`. At most 4096 items. |
| `log(text)`, `phase(title)` | Passed to the host's `log` and `phase` hooks, cut to 4096 characters. After 10,000 calls, further calls are dropped. |
| `workflow(nameOrRef, args?)` | Calls the host's `workflow` hook. Without one it rejects with `workflow() is not available here`. |
| `budget` | A frozen `{total, spent(), remaining()}`: a mirror of the host's budget, updated before each hook result arrives. |
| `args` | The run's arguments, deep-frozen, or `undefined` if none were passed. |

`Date` (including `Date.now()` and `new Date(x)`) and `Math.random()` throw an error that explains
they would make resume non-deterministic. `Math` is frozen, and the hook globals cannot be
reassigned or redefined.

Only strings cross between the host and the VM. The VM's own `JSON.parse` reads every result, so
no object from the host realm reaches the script. Each message from the runner is checked against
a TypeBox schema, and the `agent()` and `workflow()` payloads against their own schemas. Anything
else ends the run with kind `protocol`. A script can reach the payload checks through the shipped
runner: an `agent()` options object or a `workflow()` argument whose `toJSON()` returns `undefined`
drops that field from the payload, and the run ends with kind `protocol`. The smoke
`tests/workflow-sandbox-smoke.ts` tests both. No test sends a malformed runner line to the
message schema.

A hook result that `JSON.stringify` cannot encode (a BigInt, a function, a cycle) makes that
`agent()` or `workflow()` call reject with "the hook's result is not JSON-serialisable". A hook
rejection whose message cannot be read (its getter or `String()` throws) rejects with a fixed
message. Neither leaves the run waiting. `tests/workflow-sandbox-smoke.ts` tests the three
unencodable `agent()` results and a rejection whose `message` getter throws.

## Limits

| Limit | Default | Ends the run with kind |
| --- | --- | --- |
| Running without yielding (one slice of VM jobs, sync or async) | 2 s | `timeout` |
| QuickJS heap | 64 MiB | `memory` |
| A script waiting on a promise nothing can settle | — | `stalled` |
| Host watchdog: the runner silent while no hook call is outstanding | 10 s | `idle` |
| CPU time for the whole run (`prlimit --cpu`, a backstop) | 300 s | `cpu` |
| Script source, `args`, the result | 1 MiB each | `limit` |

There is no wall-clock limit on a run, because a long run spends most of its time waiting for
agents. A call whose arguments exceed 1 MiB, or a hook result over 1 MiB, rejects inside the script
instead of ending the run. A syntax error ends the run with kind `syntax`, an uncaught error with
kind `script`, and an abort signal kills the runner with kind `aborted`.

## Integrity and first use

`quickjs-wasi@3.6.3` is an explicit dependency of the kit. Before every run the host checks that
the installed package is version 3.6.x and that the sha256 of its `quickjs.wasm` matches the pinned
digest. A mismatch ends the run with kind `integrity`. The runner checks the digest again on the
bytes it compiles; the test pins only the host's check.

`SandboxSession.prepare()` runs an evil-suite self-test the first time a session uses each mode.
The suite tries Function-constructor escapes through hook promises and results, `eval`, `Date`,
`Math.random`, reassigning globals, mutating `args` and `budget`, and looks for `process`, `require`,
`fetch`, `setTimeout`, `WebAssembly` and similar host globals. If any probe gets through, the
session refuses to run scripts.

## The node binary

The runner needs Node.js itself, for its permission model. The sandbox uses pi's own runtime when
that is node, otherwise `PI_KIT_NODE` (an absolute path) or the first `node` on `PATH` whose real
file is node: a compiled pi binary, bun, or a version-manager shim that resolves to another program
is never bound into the jail. Without such a binary both modes refuse with the reason
(`tests/node-runtime-smoke.ts`).

## Hosts without bwrap

If bwrap is missing or cannot create namespaces, which happens where unprivileged user namespaces
are disabled, the sandbox refuses by default. Reduced mode (`prlimit`, `node --permission` and
QuickJS, without bwrap) runs only after a No-first select: "No, don't run workflow scripts without
bwrap" / "Yes, run them in reduced mode for this session". Without a UI, the sandbox refuses. The
answer holds for the rest of the session, and a declined session stays declined. Reduced mode also
needs `prlimit`.

## Not covered

- Reduced mode has no namespaces. In the test, its runner can signal host processes with
  `process.kill`; the script itself never sees node's `process`. Network access is blocked there
  only by node's permission model.
- The jail mounts `/usr` and the system library links read-only. A node binary that needs shared
  libraries from elsewhere will not start in full mode.
- Linux only. On other platforms, full mode is unavailable and reduced mode needs `prlimit`.
- The sandbox does not cap how many `agent()` calls run at once or in total, ask permission to
  run a script, or journal and resume runs. Its host decides those.
