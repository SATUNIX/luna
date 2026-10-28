#!/usr/bin/env node
// Workflow-script sandbox (packages/extensions/third_party/subagent/wf-sandbox.ts, docs/workflow-sandbox.md).
//   1. the evil suite: Function/eval escapes, Date, Math.random, frozen args and globals, VM realm.
//   2. the hooks: agent/parallel/pipeline/log/phase/workflow/args/budget mirror, the 4096-item and log caps, hook errors.
//   3. CPU: busy loops end at the slice deadline; a stalled script ends; prlimit --cpu and the idle watchdog kill the runner.
//   4. memory: an allocation loop ends with kind "memory".
//   5. 1 MiB caps on the result, on a call's arguments and on a hook's result; unserialisable hook results; malformed call payloads;
//      U+2028/U+2029 in hook results, args and source.
//   6. the jail itself: empty environment, ESRCH on kill (full mode), no file reads, writes, children, workers, WASI, addons or network.
//   7. a quickjs.wasm digest mismatch or another quickjs-wasi version is refused.
//   8. without bwrap: refused headless, refused on the first (No) option, reduced mode only after Yes, once per session.
//   9. abort, syntax errors, `export const meta` (scriptBody, including a linear-time check on `/*` + many `*//*`), and no node:vm in the sandbox sources.
// Full-mode checks run only where bwrap can create namespaces; reduced-mode checks run everywhere prlimit exists.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, isolateKitEnv, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import {
  EVIL_SUITE,
  DEFAULT_LIMITS,
  REDUCED_NO,
  REDUCED_YES,
  SandboxSession,
  detectSupport,
  jailCommand,
  locateQuickjs,
  runWorkflowScript,
  scriptBody,
  selfTest,
  type QuickjsLocation,
  type SandboxMode,
  type SandboxResult,
  type WorkflowHooks,
} from "../packages/extensions/third_party/subagent/wf-sandbox.ts";

const ws = tmpWorkspace("pi-kit-wf-sandbox-");
const restores = [isolateKitEnv(), setEnv("HOME", path.join(ws, "home")), setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent"))];
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

const support = detectSupport();
assert.ok(support.prlimit, "prlimit (util-linux) is required to run this smoke");
const modes: SandboxMode[] = support.bwrap ? ["full", "reduced"] : ["reduced"];
if (!support.bwrap) console.log(`  SKIP: full-mode checks (${support.reason ?? "bwrap unavailable"})`);

const echo: WorkflowHooks = { agent: (prompt) => Promise.resolve({ text: `did: ${prompt}` }) };
const run = (mode: SandboxMode, source: string, extra: Partial<Parameters<typeof runWorkflowScript>[0]> = {}): Promise<SandboxResult> =>
  runWorkflowScript({ mode, source, hooks: echo, ...extra });
const expectError = (r: SandboxResult, kind: string, pattern: RegExp, label: string): void => {
  assert.equal(r.ok, false, `${label}: expected a failure, got ${JSON.stringify(r)}`);
  if (r.ok) return;
  assert.equal(r.kind, kind, `${label}: kind (${r.error})`);
  assert.match(r.error, pattern, label);
};

try {
  for (const mode of modes) {
    // 1. Evil suite.
    const t0 = Date.now();
    const evil = await selfTest(mode);
    assert.deepEqual(evil.failures, [], `${mode}: evil suite`);
    ok(`${mode}: evil suite blocks every Function/eval escape, Date, Math.random and global tampering (${String(Date.now() - t0)} ms)`);
    const dateMsg = await run(mode, `try { Date.now() } catch (e) { return e.message }`);
    assert.ok(dateMsg.ok && typeof dateMsg.value === "string" && /not available in workflow scripts.*args/.test(dateMsg.value), JSON.stringify(dateMsg));
    const randomMsg = await run(mode, `try { Math.random() } catch (e) { return e.message }`);
    assert.ok(randomMsg.ok && typeof randomMsg.value === "string" && /^Math\.random is not available/.test(randomMsg.value), JSON.stringify(randomMsg));
    ok(`${mode}: Date and Math.random throw an explanatory message`);

    // 2. Hooks.
    const logs: string[] = [];
    const phases: string[] = [];
    let spent = 0;
    const seen: unknown[] = [];
    const hooks: WorkflowHooks = {
      agent: (prompt, opts) => {
        seen.push(opts);
        spent += 10;
        if (prompt === "boom") return Promise.reject(new Error("hook failed"));
        return Promise.resolve(prompt.toUpperCase());
      },
      log: (t) => logs.push(t),
      phase: (t) => phases.push(t),
    };
    const hooked = await run(mode, `export const meta = { name: "h", description: "hooks" };
      phase("Scan"); log("start " + args.items.length);
      const p = await parallel(args.items.map((x) => () => x === "boom" ? agent("boom") : agent(x, { label: x })));
      const q = await pipeline(["a", "b"], (v) => agent(v), (v, item, i) => v + item + i, () => { throw new Error("drop") });
      const r = await pipeline(["c"], (v, item, i) => agent(v + item + i));
      let threw = ""; try { await agent("boom") } catch (e) { threw = e.message }
      let capped = ""; try { await parallel(Array.from({ length: 4097 }, () => () => 1)) } catch (e) { capped = e.message }
      const before = budget.spent(); await agent("z");
      return { p, q, r, threw, capped, total: budget.total, before, after: budget.spent(), remaining: budget.remaining(), frozen: Object.isFrozen(args.items) };`,
      { hooks, args: { items: ["x", "boom", "y"] }, budget: { total: 1000, spent: () => spent } });
    assert.ok(hooked.ok, JSON.stringify(hooked));
    assert.deepEqual(hooked.value, { p: ["X", null, "Y"], q: [null, null], r: ["CC0"], threw: "hook failed", capped: "parallel(thunks): at most 4096 items, got 4097", total: 1000, before: 70, after: 80, remaining: 920, frozen: true });
    assert.deepEqual(logs, ["start 3"]);
    assert.deepEqual(phases, ["Scan"]);
    assert.deepEqual(seen.slice(0, 2), [{ label: "x" }, null]);
    ok(`${mode}: agent/parallel/pipeline/log/phase/args/budget behave as documented; 4096-item cap; hook errors reject`);
    const exhausted = await run(mode, `try { await agent("x"); return "ran" } catch (e) { return e.message }`, { budget: { total: 5, spent: () => 5 } });
    assert.ok(exhausted.ok && typeof exhausted.value === "string" && /^budget exhausted/.test(exhausted.value), JSON.stringify(exhausted));
    const noArgs = await run(mode, `return typeof args`);
    assert.deepEqual(noArgs, { ok: true, value: "undefined" });
    ok(`${mode}: agent() throws once the budget is spent; args is undefined when none are passed`);
    const lines: string[] = [];
    const logged = await run(mode, `log("x".repeat(5000)); for (let i = 0; i < 10005; i++) log("n" + i); return 1`, { hooks: { ...echo, log: (text) => lines.push(text) } });
    assert.deepEqual(logged, { ok: true, value: 1 });
    assert.equal(lines.length, 10000);
    assert.equal(lines[0]?.length, 4096);
    assert.match(lines[9999] ?? "", /log limit reached/);
    const nested = await run(mode, `const a = await workflow("child", { n: 1 }); const b = await workflow({ scriptPath: "s.js" }); return [a, b]`,
      { hooks: { ...echo, workflow: (ref, a) => Promise.resolve({ ref, a }) } });
    assert.deepEqual(nested, { ok: true, value: [{ ref: "child", a: { n: 1 } }, { ref: { scriptPath: "s.js" }, a: null }] });
    const noNested = await run(mode, `try { await workflow("child") } catch (e) { return e.message }`);
    assert.deepEqual(noNested, { ok: true, value: "workflow() is not available here" });
    ok(`${mode}: log() text is cut to 4096 characters and stops after 10,000 calls; workflow() reaches its hook, or rejects without one`);

    // 3. CPU and stalls.
    const fast = { sliceMs: 300 };
    let t = Date.now();
    expectError(await run(mode, `for (;;) {}`, { limits: fast }), "timeout", /more than 300 ms/, "sync loop");
    expectError(await run(mode, `await agent("x"); for (;;) {}`, { limits: fast }), "timeout", /more than 300 ms/, "async loop");
    expectError(await run(mode, `for (;;) await null;`, { limits: fast }), "timeout", /more than 300 ms/, "microtask loop");
    assert.ok(Date.now() - t < 10_000, "CPU loops end promptly");
    expectError(await run(mode, `await new Promise(() => {})`), "stalled", /nothing will settle/, "stalled script");
    expectError(await run(mode, `for (;;) {}`, { limits: { sliceMs: 60_000, cpuSeconds: 1 } }), "cpu", /more than 1 CPU seconds/, "prlimit --cpu backstop");
    expectError(await run(mode, `return 1`, { limits: { idleMs: 1 } }), "idle", /silent for 1 ms/, "host watchdog");
    ok(`${mode}: sync, async and microtask busy loops end at the slice deadline; a stalled script ends; the prlimit CPU backstop and the host watchdog kill the runner (${String(Date.now() - t)} ms)`);

    // 4. Memory.
    t = Date.now();
    expectError(await run(mode, `const a = []; for (;;) a.push("z".repeat(1e5) + a.length)`, { limits: { memoryBytes: 16 * 1024 * 1024 } }), "memory", /out of memory/, "OOM");
    ok(`${mode}: an allocation loop ends with an out-of-memory error (${String(Date.now() - t)} ms)`);

    // 5. 1 MiB caps.
    expectError(await run(mode, `return "x".repeat(1100000)`), "limit", /exceeds 1 MiB/, "result cap");
    const bigCall = await run(mode, `try { await agent("y".repeat(1100000)) } catch (e) { return e.message }`);
    assert.deepEqual(bigCall, { ok: true, value: "the call's arguments exceed 1 MiB" });
    const bigReply = await run(mode, `try { await agent("x") } catch (e) { return e.message }`, { hooks: { agent: () => Promise.resolve("r".repeat(1100000)) } });
    assert.deepEqual(bigReply, { ok: true, value: "the hook's result exceeds 1 MiB" });
    ok(`${mode}: results, call arguments and hook results over 1 MiB are refused`);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const badRejection = Object.defineProperty(new Error(), "message", { get: (): string => { throw new Error("no"); } });
    const unserialisable: Array<() => Promise<unknown>> = [() => Promise.resolve(1n), () => Promise.resolve(() => 1), () => Promise.resolve(circular)];
    for (const hook of unserialisable) {
      const r = await run(mode, `try { await agent("x"); return "resolved" } catch (e) { return e.message }`, { hooks: { agent: hook }, limits: { idleMs: 3000 } });
      assert.deepEqual(r, { ok: true, value: "the hook's result is not JSON-serialisable" });
    }
    const odd = await run(mode, `try { await agent("x"); return "resolved" } catch (e) { return e.message }`, { hooks: { agent: () => Promise.reject(badRejection) }, limits: { idleMs: 3000 } });
    assert.deepEqual(odd, { ok: true, value: "the hook failed with a value that cannot be shown" });
    ok(`${mode}: a hook result JSON cannot encode (BigInt, function, cycle) or a rejection whose message getter throws rejects agent() instead of hanging the run`);
    expectError(await run(mode, `await agent("x", { toJSON() { return undefined } }); return 1`), "protocol", /malformed agent\(\) call/, "opts dropped by toJSON");
    expectError(await run(mode, `await workflow("child", { toJSON() { return undefined } }); return 1`, { hooks: { ...echo, workflow: () => Promise.resolve(1) } }), "protocol", /malformed workflow\(\) call/, "workflow args dropped by toJSON");
    ok(`${mode}: an agent() or workflow() payload that a toJSON() reshapes past the prelude's checks ends the run with kind protocol`);

    // Host-to-runner lines carrying U+2028/U+2029 (readline splits on both).
    const sep = "a\u2028b\u2029c";
    const sepReply = await run(mode, `return await agent("x")`, { hooks: { agent: () => Promise.resolve(sep) }, limits: { idleMs: 3000 } });
    assert.deepEqual(sepReply, { ok: true, value: sep });
    const sepEcho = await run(mode, `return await agent(args.s)`, { args: { s: sep }, limits: { idleMs: 3000 } });
    assert.deepEqual(sepEcho, { ok: true, value: { text: `did: ${sep}` } });
    const sepSource = await run(mode, `return "${sep}"`, { limits: { idleMs: 3000 } });
    assert.deepEqual(sepSource, { ok: true, value: sep });
    ok(`${mode}: U+2028 and U+2029 in a hook result, in args and in the script source reach the script intact`);

    // 9. Abort, syntax, meta.
    const ac = new AbortController();
    const aborted = run(mode, `await agent("x"); return 1`, { signal: ac.signal, hooks: { agent: () => new Promise<unknown>(() => { ac.abort(); }) } });
    expectError(await aborted, "aborted", /aborted/, "abort");
    expectError(await run(mode, `return (`), "syntax", /SyntaxError/, "syntax error");
    const meta = await run(mode, `// leading comment\nexport const meta = { name: "m", description: "d" };\nreturn meta.name`);
    assert.deepEqual(meta, { ok: true, value: "m" });
    ok(`${mode}: abort kills the run; syntax errors are reported; a leading \`export const meta\` is accepted`);
  }

  // 6. The jail itself, probed with node code running where the runner runs.
  const probeDir = path.join(ws, "probe");
  fs.mkdirSync(probeDir);
  const probe = path.join(probeDir, "probe.mjs");
  fs.writeFileSync(probe, [
    'import fs from "node:fs"; import net from "node:net"; import cp from "node:child_process"; import wt from "node:worker_threads";',
    "const out = { env: Object.keys(process.env).join(',') };",
    "const t = async (k, f) => { try { out[k] = 'ALLOWED ' + String(await f()); } catch (e) { out[k] = 'blocked ' + String(e.code || e.message); } };",
    "await t('kill', () => process.kill(Number(process.argv[2]), 0));",
    "await t('read', () => fs.readFileSync('/etc/passwd', 'utf8').length);",
    "await t('write', () => fs.writeFileSync(process.argv[3], 'x'));",
    "await t('spawn', () => { const r = cp.spawnSync('/usr/bin/true'); if (r.error) throw r.error; return r.status; });",
    "await t('worker', () => new Promise((res, rej) => { const w = new wt.Worker('1', { eval: true }); w.on('error', rej); w.on('exit', () => res('ran')); }));",
    "await t('wasi', () => new (process.getBuiltinModule('node:wasi').WASI)({ version: 'preview1' }) && 'made');",
    "await t('addon', () => process.dlopen({ exports: {} }, '/usr/lib/libc.so.6'));",
    "await t('net', () => new Promise((res, rej) => { const s = net.connect(9, '127.0.0.1'); s.on('connect', () => res('connected')); s.on('error', rej); }));",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n"));
  const target = path.join(ws, "written.txt");
  for (const mode of modes) {
    const { command, args } = jailCommand({ mode, support, entry: probe, readDirs: [], entryArgs: () => [String(process.pid), target], limits: DEFAULT_LIMITS });
    // bwrap clears even a variable its spawner passes; reduced mode relies on the spawner's env {} (as runWorkflowScript does).
    const r = spawnSync(command, args, { env: mode === "full" ? { LUNA_CANARY: "canary" } : {}, encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 0, `${mode} probe: ${r.stderr}`);
    const out: unknown = JSON.parse(r.stdout);
    assert.ok(typeof out === "object" && out !== null);
    const field = (k: string): string => String(Reflect.get(out, k));
    assert.equal(field("env"), "", `${mode}: environment is empty`);
    for (const k of ["read", "write", "spawn", "worker", "wasi", "addon", "net"]) assert.match(field(k), /^blocked/, `${mode}: ${k} -> ${field(k)}`);
    assert.equal(fs.existsSync(target), false, `${mode}: no file written`);
    if (mode === "full") assert.equal(field("kill"), "blocked ESRCH", "full: the host's pid is not visible");
    ok(`${mode}: the jail has an empty environment and blocks file reads, writes, child processes, workers, WASI, addons and network${mode === "full" ? "; kill() gets ESRCH" : ` (kill: ${field("kill")})`}`);
  }
  // 7. quickjs-wasi integrity.
  const real = locateQuickjs();
  assert.ok(!("error" in real), "quickjs-wasi resolves from the subagent extension");
  const copy = (name: string, mutate: (dir: string) => void): QuickjsLocation => {
    const dir = path.join(ws, name);
    fs.cpSync(real.dir, dir, { recursive: true, dereference: true });
    mutate(dir);
    return { dir, entry: path.join(dir, "dist", "index.js"), wasm: path.join(dir, "quickjs.wasm") };
  };
  const tampered = copy("qjs-tampered", (dir) => { fs.appendFileSync(path.join(dir, "quickjs.wasm"), Buffer.from([0])); });
  expectError(await run("reduced", "return 1", { quickjs: tampered }), "integrity", /digest .* does not match the pinned/, "wasm digest mismatch");
  const newer = copy("qjs-newer", (dir) => {
    const file = path.join(dir, "package.json");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"version": "[^"]+"/, '"version": "3.7.0"'));
  });
  expectError(await run("reduced", "return 1", { quickjs: newer }), "integrity", /3\.7\.0 is not a supported version/, "version check");
  const failing = await new SandboxSession({ quickjs: tampered }).prepare({ hasUI: false });
  assert.equal(failing.ok, false);
  ok("a tampered quickjs.wasm or another quickjs-wasi version is refused, and the session's self-test fails closed");

  // 8. Without bwrap.
  const noBwrap = (): { bwrap: null; prlimit: string | null; node: string | null; reason: string } => ({ bwrap: null, prlimit: support.prlimit, node: support.node, reason: "bwrap (bubblewrap) is not installed" });
  const headless = await new SandboxSession({ detect: noBwrap }).prepare({ hasUI: false });
  assert.ok(!headless.ok && /needs an interactive yes/.test(headless.error), JSON.stringify(headless));
  const asked: string[][] = [];
  const answer = (pick: (options: string[]) => string | undefined) => ({
    hasUI: true,
    select: (_title: string, options: string[]) => {
      asked.push(options);
      return Promise.resolve(pick(options));
    },
  });
  const declined = new SandboxSession({ detect: noBwrap });
  const first = await declined.prepare(answer((o) => o[0]));
  assert.ok(!first.ok && /declined/.test(first.error));
  assert.deepEqual(asked[0], [REDUCED_NO, REDUCED_YES], "the first option is No");
  const dismissed = await new SandboxSession({ detect: noBwrap }).prepare(answer(() => undefined));
  assert.equal(dismissed.ok, false, "dismissing the select refuses");
  const again = await declined.prepare(answer((o) => o[1]));
  assert.equal(again.ok, false, "a declined session stays declined");
  const accepted = new SandboxSession({ detect: noBwrap });
  asked.length = 0;
  assert.deepEqual(await accepted.prepare(answer((o) => o[1])), { ok: true, mode: "reduced" });
  assert.deepEqual(await accepted.prepare(answer((o) => o[0])), { ok: true, mode: "reduced" });
  assert.equal(asked.length, 1, "asked once per session");
  const noPrlimit = await new SandboxSession({ detect: () => ({ bwrap: null, prlimit: null, node: support.node, reason: "x" }) }).prepare(answer((o) => o[1]));
  assert.ok(!noPrlimit.ok && /prlimit/.test(noPrlimit.error));
  expectError(await run("full", "return 1", { support: noBwrap() }), "unavailable", /full sandbox unavailable/, "full mode without bwrap");
  if (support.bwrap) {
    assert.deepEqual(await new SandboxSession().prepare({ hasUI: false }), { ok: true, mode: "full" });
  }
  ok("without bwrap: refused headless and on No (the first option); reduced mode after Yes, asked once per session; prlimit required");

  // 9. No node:vm anywhere in the sandbox, and the evil suite is what selfTest runs.
  for (const file of ["wf-sandbox.ts", "wf-runner.mjs"]) {
    const text = fs.readFileSync(path.join(ROOT, "packages/extensions/third_party/subagent", file), "utf8");
    assert.doesNotMatch(text, /from\s+["'](?:node:)?vm["']|require\(["'](?:node:)?vm["']\)/, `${file} must not use node:vm`);
  }
  assert.match(EVIL_SUITE, /^export const meta/);
  ok("the sandbox sources never import node:vm");

  // 9. scriptBody drops only a leading `export` before `const meta`, in linear time.
  const metaCases: [string, string][] = [
    ["export const meta = {}", "const meta = {}"],
    [" \n\t// a\n/* b */\n/* c\n d */export  const\nmeta = 1", " \n\t// a\n/* b */\n/* c\n d */const\nmeta = 1"],
    ["/**/export const meta=1", "/**/const meta=1"],
    ["// no newline export const meta = 1", "// no newline export const meta = 1"],
    ["/* unclosed export const meta = 1", "/* unclosed export const meta = 1"],
    ["x; export const meta = 1", "x; export const meta = 1"],
    ["export const metadata = 1", "export const metadata = 1"],
    ["export let meta = 1", "export let meta = 1"],
    ["/* a */ b */ export const meta = 1", "/* a */ b */ export const meta = 1"],
  ];
  for (const [input, expected] of metaCases) assert.equal(scriptBody(input), expected, JSON.stringify(input));
  const adversarial = `/*${"*//*".repeat(50_000)}*/!`;
  const started = performance.now();
  assert.equal(scriptBody(adversarial), adversarial);
  assert.equal(scriptBody(`${adversarial.slice(0, -1)}export const meta = 1`), `${adversarial.slice(0, -1)}const meta = 1`);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `scriptBody on '/*' + 50000 '*//*' repeats took ${elapsed.toFixed(0)} ms`);
  ok("scriptBody drops only a leading `export` before `const meta`, and '/*' + many '*//*' repeats take linear time");
} finally {
  for (const restore of restores.reverse()) restore();
  rmWorkspace(ws);
}
console.log(`[workflow-sandbox-smoke] OK (${String(checks)} checks)`);
