#!/usr/bin/env node
/**
 * Under a compiled pi, a kit script runs under node, never under pi itself.
 *
 * Extensions run inside the pi process. A compiled pi (a single executable) is its own
 * process.execPath, so `spawn(process.execPath, [script])` ran `pi <script>`: pi read the path as
 * a prompt and ran an agent turn, and /remote's host, /console's server and the autonomy CLI never
 * started. The workflow sandbox bound the same binary into its jail as `node`.
 *
 * Every such site now asks packages/core/shared/node-runtime.ts (through its generated copies).
 * This smoke pins the resolver's order and refusals, then simulates a compiled pi by pointing
 * process.execPath at a fake `pi` that only records that it ran (with process.versions.bun set,
 * as inside the shipped bun-compiled binary), and drives the real /console,
 * remote host start, autonomy CLI runner and sandbox command line. The real pi is never run.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadExtension, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import { NODE_OVERRIDE_ENV, nodeRuntime, runtimeName } from "../packages/core/shared/node-runtime.ts";
import type * as AutonomyRunModule from "../packages/extensions/src/autonomy-run/index.ts";
import type * as RemoteHostModule from "../packages/extensions/src/remote-control/host.ts";
import * as sandbox from "../packages/extensions/third_party/subagent/wf-sandbox.ts";

const restoreKitEnv = isolateKitEnv();
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

const REAL_NODE = fs.realpathSync(process.execPath);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-node-runtime-"));
const dir = (name: string): string => {
  const d = path.join(scratch, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const executable = (file: string, text: string): string => {
  fs.writeFileSync(file, text, { mode: 0o755 });
  return file;
};

// Fixtures: a fake compiled pi that records every run, a PATH entry holding the real node, a
// version-manager style shim (`node` -> a binary called `mise`), and a directory where `node` is
// a link to pi itself.
const PI_MARKER = path.join(scratch, "ran-as-pi.log");
const piDir = dir("pi-bin");
const FAKE_PI = executable(path.join(piDir, "pi"), `#!/bin/sh\necho "RAN-AS-PI $*" >> '${PI_MARKER}'\nexit 1\n`);
const nodeDir = dir("node-bin");
fs.symlinkSync(REAL_NODE, path.join(nodeDir, "node"));
const shimDir = dir("shim-bin");
const MISE = executable(path.join(dir("mise-install"), "mise"), "#!/bin/sh\nexit 0\n");
fs.symlinkSync(MISE, path.join(shimDir, "node"));
const selfDir = dir("self-bin");
fs.symlinkSync(FAKE_PI, path.join(selfDir, "node"));
const emptyDir = dir("empty-bin");
const bunDir = dir("bun-bin");
const FAKE_BUN = executable(path.join(bunDir, "bun"), "#!/bin/sh\nexit 0\n");
const DENO = executable(path.join(dir("deno-bin"), "deno"), "#!/bin/sh\nexit 0\n");

// The shipped pi is bun-compiled, so inside it process.versions.bun is set while execPath is pi.
// Simulating a compiled pi sets both; the extensions call nodeRuntime() with the live defaults.
const asCompiledPi = (): (() => void) => {
  const savedExecPath = process.execPath;
  process.execPath = FAKE_PI;
  Object.defineProperty(process.versions, "bun", { value: "1.3.14", configurable: true, enumerable: true, writable: false });
  return () => {
    process.execPath = savedExecPath;
    delete (process.versions as Record<string, string | undefined>).bun;
  };
};

const piRan = (): string => (fs.existsSync(PI_MARKER) ? fs.readFileSync(PI_MARKER, "utf8") : "");
const PATH_ONLY = (...dirs: string[]): NodeJS.ProcessEnv => ({ PATH: dirs.join(path.delimiter) });
const none: readonly string[] = [];

try {
  // ---------------------------------------------------------------------------------------------
  // 1. The resolver.
  for (const [file, name] of [
    ["/usr/bin/node", "node"],
    ["/opt/node/nodejs", "nodejs"],
    ["C:\\Program Files\\nodejs\\node.exe", "node"],
    ["C:\\pi\\pi.exe", "pi"],
    ["/usr/local/bin/pi", "pi"],
    ["C:\\tools\\Node.CMD", "node"],
    ["/usr/bin/bun", "bun"],
  ] as const) assert.equal(runtimeName(file), name, file);
  ok("runtimeName strips the directory, case and a Windows .exe/.cmd/.bat suffix");

  assert.deepEqual(nodeRuntime({ execPath: REAL_NODE, env: {}, systemDirs: none }), { ok: true, command: REAL_NODE, source: "execPath" });
  const fromPath = nodeRuntime({ execPath: FAKE_PI, env: PATH_ONLY(emptyDir, nodeDir), systemDirs: none });
  assert.deepEqual(fromPath, { ok: true, command: path.join(nodeDir, "node"), source: "path" });
  ok("node host: execPath; compiled pi host: the node on PATH, never execPath");

  const missing = nodeRuntime({ execPath: FAKE_PI, env: PATH_ONLY(emptyDir), systemDirs: none });
  assert.ok(!missing.ok && missing.reason.includes(FAKE_PI) && missing.reason.includes(NODE_OVERRIDE_ENV) && /not a JavaScript runtime/.test(missing.reason), JSON.stringify(missing));
  const self = nodeRuntime({ execPath: FAKE_PI, env: PATH_ONLY(selfDir), systemDirs: none });
  assert.equal(self.ok, false, "a `node` on PATH that is a link to the running pi is not node");
  for (const execPath of ["C:\\pi\\pi.exe", "/x/luna", "/x/pi-1.4.0", "/x/node22"]) {
    const r = nodeRuntime({ execPath, env: { PATH: "" }, platform: execPath.startsWith("C:") ? "win32" : "linux", systemDirs: none });
    assert.equal(r.ok, false, `${execPath} is not a runtime: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(nodeRuntime({ execPath: "C:\\Program Files\\nodejs\\node.exe", env: {}, platform: "win32", versions: {} }), { ok: true, command: "C:\\Program Files\\nodejs\\node.exe", source: "execPath" });
  ok("no node anywhere fails with an actionable reason; pi.exe, renamed pi binaries and a link back to pi are never used");

  const relative = nodeRuntime({ execPath: FAKE_PI, env: { PATH: `${path.relative(process.cwd(), nodeDir)}${path.delimiter}${emptyDir}` }, systemDirs: none });
  assert.equal(relative.ok, false, "a relative PATH entry is ignored");
  assert.deepEqual(nodeRuntime({ execPath: FAKE_PI, env: PATH_ONLY(emptyDir), systemDirs: [nodeDir] }), { ok: true, command: path.join(nodeDir, "node"), source: "path" });
  ok("relative PATH entries are skipped; the system directories are searched after PATH");

  assert.deepEqual(nodeRuntime({ execPath: FAKE_PI, env: { [NODE_OVERRIDE_ENV]: REAL_NODE, PATH: "" }, systemDirs: none }), { ok: true, command: REAL_NODE, source: "override" });
  assert.deepEqual(nodeRuntime({ execPath: REAL_NODE, env: { [NODE_OVERRIDE_ENV]: path.join(nodeDir, "node") }, systemDirs: none }), { ok: true, command: path.join(nodeDir, "node"), source: "override" }, "the override wins over execPath");
  for (const [value, why] of [
    ["node", /not an absolute path/],
    [path.join(emptyDir, "node"), /not an executable file/],
    [FAKE_PI, /is pi itself/],
  ] as const) {
    const r = nodeRuntime({ execPath: FAKE_PI, env: { [NODE_OVERRIDE_ENV]: value, PATH: nodeDir }, systemDirs: none });
    assert.ok(!r.ok && why.test(r.reason), `${value}: ${JSON.stringify(r)}`);
  }
  ok(`${NODE_OVERRIDE_ENV} wins; when unusable it fails with the reason instead of falling through`);

  assert.deepEqual(nodeRuntime({ execPath: FAKE_BUN, env: PATH_ONLY(nodeDir), systemDirs: none }), { ok: true, command: FAKE_BUN, source: "execPath" });
  assert.deepEqual(nodeRuntime({ execPath: FAKE_BUN, env: PATH_ONLY(nodeDir), systemDirs: none, require: "node" }), { ok: true, command: REAL_NODE, source: "path" });
  assert.deepEqual(nodeRuntime({ execPath: "/x/node", versions: { bun: "1.2.0" }, env: PATH_ONLY(nodeDir), systemDirs: none, require: "node" }), { ok: true, command: REAL_NODE, source: "path" }, "bun's node shim is bun");
  assert.deepEqual(nodeRuntime({ execPath: DENO, env: PATH_ONLY(nodeDir), systemDirs: none }), { ok: true, command: path.join(nodeDir, "node"), source: "path" }, "deno is not used");
  ok("bun runs a plain script; the sandbox's Node-only mode takes real node instead, also from bun's node shim; deno falls through to PATH");

  // The shipped pi is `bun build --compile` output: inside it process.versions.bun is set, yet
  // execPath is pi and `pi <script>` is a prompt. bun's version must not make pi a runtime.
  const BUN_VERSIONS = { bun: "1.3.14", node: "24.3.0" };
  for (const require of ["script", "node"] as const) {
    assert.deepEqual(nodeRuntime({ execPath: FAKE_PI, versions: BUN_VERSIONS, env: PATH_ONLY(emptyDir, nodeDir), systemDirs: none, require }), { ok: true, command: require === "node" ? REAL_NODE : path.join(nodeDir, "node"), source: "path" }, `bun-compiled pi, require ${require}`);
    const linkBack = nodeRuntime({ execPath: FAKE_PI, versions: BUN_VERSIONS, env: PATH_ONLY(selfDir), systemDirs: none, require });
    assert.equal(linkBack.ok, false, `bun-compiled pi keeps the self guard (${require}): ${JSON.stringify(linkBack)}`);
    const overrideSelf = nodeRuntime({ execPath: FAKE_PI, versions: BUN_VERSIONS, env: { [NODE_OVERRIDE_ENV]: FAKE_PI }, systemDirs: none, require });
    assert.ok(!overrideSelf.ok && /is pi itself/.test(overrideSelf.reason), JSON.stringify(overrideSelf));
  }
  const compiledMissing = nodeRuntime({ execPath: FAKE_PI, versions: BUN_VERSIONS, env: PATH_ONLY(emptyDir), systemDirs: none });
  assert.ok(!compiledMissing.ok && /not a JavaScript runtime/.test(compiledMissing.reason), JSON.stringify(compiledMissing));
  for (const execPath of ["/x/pi", "C:\\pi\\pi.exe", "/x/luna"]) {
    const r = nodeRuntime({ execPath, versions: BUN_VERSIONS, env: { PATH: "" }, platform: execPath.startsWith("C:") ? "win32" : "linux", systemDirs: none });
    assert.equal(r.ok, false, `${execPath} with versions.bun is a compiled pi, not bun: ${JSON.stringify(r)}`);
  }
  ok("a bun-compiled pi (versions.bun set, execPath pi) is never bun: node from PATH, self guard kept");

  assert.deepEqual(nodeRuntime({ execPath: FAKE_PI, env: PATH_ONLY(shimDir, nodeDir), systemDirs: none }), { ok: true, command: path.join(shimDir, "node"), source: "path" });
  assert.deepEqual(nodeRuntime({ execPath: FAKE_PI, env: PATH_ONLY(shimDir, nodeDir), systemDirs: none, require: "node" }), { ok: true, command: REAL_NODE, source: "path" });
  const shimOnly = nodeRuntime({ execPath: FAKE_PI, env: PATH_ONLY(shimDir), systemDirs: none, require: "node" });
  assert.ok(!shimOnly.ok && /real node binary/.test(shimOnly.reason), JSON.stringify(shimOnly));
  const shimOverride = nodeRuntime({ execPath: FAKE_PI, env: { [NODE_OVERRIDE_ENV]: path.join(shimDir, "node") }, systemDirs: none, require: "node" });
  assert.ok(!shimOverride.ok && /not a node binary/.test(shimOverride.reason), JSON.stringify(shimOverride));
  ok("a version-manager shim runs plain scripts, but the Node-only mode skips it for the real binary behind the next PATH entry");

  // ---------------------------------------------------------------------------------------------
  // 2. The workflow sandbox binds and runs the resolved node, never execPath.
  const spec = (support: sandbox.SandboxSupport, mode: sandbox.SandboxMode): sandbox.JailSpec => ({
    mode,
    support,
    entry: "/kit/wf-runner.mjs",
    readDirs: [{ host: "/kit/quickjs", name: "quickjs-wasi" }],
    entryArgs: () => [],
    limits: sandbox.DEFAULT_LIMITS,
  });
  const support: sandbox.SandboxSupport = { bwrap: "/usr/bin/bwrap", prlimit: "/usr/bin/prlimit", node: "/fake/node" };
  let leaveCompiledPi = asCompiledPi();
  try {
    const reduced = sandbox.jailCommand(spec(support, "reduced"));
    assert.equal(reduced.args[reduced.args.indexOf("--") + 1], "/fake/node", reduced.args.join(" "));
    const full = sandbox.jailCommand(spec(support, "full"));
    const bind = full.args.findIndex((a, i) => a === "--ro-bind" && full.args[i + 2] === "/sandbox/bin/node");
    assert.ok(bind >= 0 && full.args[bind + 1] === "/fake/node", full.args.join(" "));
    for (const cmd of [reduced, full]) assert.ok(!cmd.args.includes(FAKE_PI), "execPath never reaches the jail");
    assert.throws(() => sandbox.jailCommand(spec({ ...support, node: null, nodeReason: "none here" }, "reduced")), /node binary is required: none here/);
  } finally {
    leaveCompiledPi();
  }
  assert.equal(process.versions.bun, undefined, "the simulated bun version is removed again");
  const noNode: sandbox.SandboxSupport = { bwrap: "/usr/bin/bwrap", prlimit: "/usr/bin/prlimit", node: null, nodeReason: "no node here" };
  const refused = await new sandbox.SandboxSession({ detect: () => noNode }).prepare({ hasUI: true, select: () => Promise.resolve(sandbox.REDUCED_YES) });
  assert.ok(!refused.ok && /permission model, and no node here/.test(refused.error), JSON.stringify(refused));
  const run = await sandbox.runWorkflowScript({ source: "return 1", hooks: { agent: () => Promise.resolve(null) }, mode: "reduced", support: noNode });
  assert.ok(!run.ok && run.kind === "unavailable" && /no node here/.test(run.error), JSON.stringify(run));
  const detected = sandbox.detectSupport();
  assert.ok(detected.node && ["node", "nodejs"].includes(runtimeName(detected.node)), `detectSupport finds this node: ${String(detected.node)}`);
  ok("jailCommand binds and runs support.node in both modes; without node, the session and runWorkflowScript refuse");

  // ---------------------------------------------------------------------------------------------
  // 3. A simulated compiled pi: /console, the remote host and the autonomy CLI.
  const webUi = dir("web-ui");
  const SCRIPT_MARKER = path.join(scratch, "ran-as-script.log");
  fs.mkdirSync(path.join(webUi, "server"));
  for (const entry of ["server", "remote-host"]) {
    fs.writeFileSync(path.join(webUi, "server", `${entry}.ts`), `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(SCRIPT_MARKER)}, "${entry} " + process.versions.node + "\\n");\nprocess.exit(7);\n`);
  }
  const fakeCli = path.join(scratch, "fake-cli.mjs");
  fs.writeFileSync(fakeCli, 'console.log(JSON.stringify({ ran: true, args: process.argv.slice(2), node: process.versions.node }));\n');
  const scriptRan = (): string => (fs.existsSync(SCRIPT_MARKER) ? fs.readFileSync(SCRIPT_MARKER, "utf8") : "");
  const port = await new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

  const restore = [
    setEnv("PI_KIT_WEBUI_ROOT", webUi),
    setEnv("PI_CODING_AGENT_DIR", dir("agent")),
    setEnv("PI_REMOTE_STATE_DIR", dir("remote-state")),
    setEnv("PI_CONSOLE_HOST", "127.0.0.1"),
    setEnv("PI_CONSOLE_PORT", String(port)),
    setEnv("PATH", nodeDir),
    setEnv(NODE_OVERRIDE_ENV, undefined),
  ];
  leaveCompiledPi = asCompiledPi();
  try {
    assert.equal(process.versions.bun, "1.3.14", "the simulated compiled pi reports bun, as the shipped binary does");
    const notes: { message: string; level: string }[] = [];
    const ctx = { hasUI: true, cwd: scratch, ui: { notify: (message: string, level: string) => notes.push({ message, level }), setStatus: () => {} } };
    const pi = fakePi();
    (await loadExtension("extensions/web-console/index.ts"))(pi.api);
    const consoleCmd = pi.commands.get("console");
    assert.ok(consoleCmd);
    await consoleCmd.handler("start", ctx);
    assert.match(notes.at(-1)?.message ?? "", /exited while starting \(code 7\)/);
    assert.match(scriptRan(), /^server \d+\./m, "server.ts ran under node");
    assert.equal(piRan(), "", "pi was never run");
    ok("/console start runs server.ts with the node on PATH, not the compiled pi");

    const host = await loadModule<typeof RemoteHostModule>("extensions/remote-control/host.ts");
    await assert.rejects(host.ensureHost(), (e: unknown) => e instanceof host.HostError && e.code === "start_failed" && /exited \(code 7\)/.test(e.message));
    assert.match(scriptRan(), /^remote-host \d+\./m, "remote-host.ts ran under node");
    assert.equal(piRan(), "", "pi was never run");
    ok("the remote host start runs remote-host.ts with the node on PATH, not the compiled pi");

    const autonomy = await loadModule<typeof AutonomyRunModule>("extensions/autonomy-run/index.ts");
    const cliEnv = { ...process.env, PI_AUTONOMY_CLI: fakeCli };
    const listed = await autonomy.runCli(["list"], { cwd: scratch, env: cliEnv });
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(listed.json?.args, ["list", "--json"]);
    assert.equal(piRan(), "", "pi was never run");
    ok("the autonomy CLI runs under the node on PATH, not the compiled pi");

    // No usable node: each refuses with the reason before starting anything.
    restore.push(setEnv(NODE_OVERRIDE_ENV, "relative/node"));
    const before = scriptRan();
    notes.length = 0;
    await consoleCmd.handler("start", ctx);
    assert.equal(notes.at(-1)?.level, "error");
    assert.match(notes.at(-1)?.message ?? "", /web UI server needs Node\.js to run: PI_KIT_NODE=relative\/node is not an absolute path/);
    assert.ok(!fs.existsSync(path.join(webUi, ".runtime", "console.token")), "no token file is left behind");
    assert.ok(!fs.existsSync(path.join(webUi, ".runtime", "server.pid")), "no pid file is left behind");
    await assert.rejects(host.ensureHost(), (e: unknown) => e instanceof host.HostError && e.code === "start_failed" && /remote host needs Node\.js to run: PI_KIT_NODE/.test(e.message));
    const refusedCli = await autonomy.runCli(["list"], { cwd: scratch, env: { ...cliEnv, [NODE_OVERRIDE_ENV]: "relative/node" } });
    assert.ok(refusedCli.code === null && /autonomy CLI needs Node\.js to run: PI_KIT_NODE/.test(refusedCli.stderr), JSON.stringify(refusedCli));
    assert.equal(scriptRan(), before, "nothing ran");
    assert.equal(piRan(), "", "pi was never run");
    ok("with no usable node, /console, the remote host and the autonomy CLI refuse with the reason; no token or pid file is left");
  } finally {
    leaveCompiledPi();
    for (const r of restore.reverse()) r();
  }
} finally {
  restoreKitEnv();
  rmWorkspace(scratch);
}
console.log(`node-runtime smoke: ${checks} checks passed`);
