// Workflow-script runner. Spawned by wf-sandbox.ts as the innermost layer of the sandbox
// (bwrap -> prlimit -> node --permission -> this file) with an empty environment. It stays
// JavaScript because it runs under plain node, including from node_modules, where Node will not
// strip types; tests/typescript-coverage-smoke.ts lists it with that reason.
//
// It runs one script inside raw QuickJS (quickjs-wasi) and speaks JSON lines with the host:
//   host -> runner (stdin):  start, result, budget
//   runner -> host (stdout): call, log, phase, done
// Only strings cross into the VM. The VM's own JSON.parse reads every value, so nothing from this
// realm (objects, prototypes, constructors) is reachable from the script.
//
// argv: <quickjs-wasi dist/index.js> <quickjs.wasm>
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const LINE_CAP = 1024 * 1024;
const LOG_CAP = 10000;
const TEXT_CAP = 4096;

// Runs inside the VM. Receives the host bridge H as an argument, so H is never a global.
const PRELUDE = String.raw`(function (H, total, argsJson) {
  "use strict";
  const parse = JSON.parse, stringify = JSON.stringify, freeze = Object.freeze, define = Object.defineProperty;
  const keys = Object.keys, isArray = Array.isArray, all = Promise.all.bind(Promise), then = Promise.prototype.then;
  const MAX_ITEMS = 4096;
  const disabled = (what) => function () {
    throw new Error(what + " is not available in workflow scripts: it would make resume non-deterministic. Pass timestamps in through args and vary prompts by index instead.");
  };
  const D = function Date() { return disabled("Date")(); };
  D.now = disabled("Date.now"); D.parse = disabled("Date.parse"); D.UTC = disabled("Date.UTC");
  define(globalThis, "Date", { value: freeze(D), writable: false, enumerable: false, configurable: false });
  define(Math, "random", { value: disabled("Math.random"), writable: false, enumerable: false, configurable: false });
  freeze(Math);
  const deepFreeze = (v) => { if (v !== null && typeof v === "object") { for (const k of keys(v)) deepFreeze(v[k]); freeze(v); } return v; };
  const message = (e) => {
    try {
      if (e !== null && typeof e === "object" && typeof e.message === "string") return (typeof e.name === "string" && e.name ? e.name + ": " : "") + e.message;
      return String(e);
    } catch (_) { return "unprintable error"; }
  };
  const call = (op, payload) => then.call(H.call(op, stringify(payload)), (s) => parse(s));
  const budget = freeze({
    total,
    spent: () => H.spent(),
    remaining: () => (total === null ? Infinity : Math.max(0, total - H.spent())),
  });
  const agent = async (prompt, opts) => {
    if (typeof prompt !== "string") throw new TypeError("agent(prompt, opts): prompt must be a string");
    if (opts !== undefined && opts !== null && (typeof opts !== "object" || isArray(opts))) throw new TypeError("agent(prompt, opts): opts must be an object");
    if (total !== null && H.spent() >= total) throw new Error("budget exhausted: " + H.spent() + " of " + total + " output tokens spent");
    return call("agent", { prompt, opts: opts === undefined ? null : opts });
  };
  const items = (name, list) => {
    if (!isArray(list)) throw new TypeError(name + ": expected an array");
    if (list.length > MAX_ITEMS) throw new RangeError(name + ": at most " + MAX_ITEMS + " items, got " + list.length);
    return list;
  };
  const settle = async (fn) => { try { return await fn(); } catch (_) { return null; } };
  const parallel = (thunks) => {
    items("parallel(thunks)", thunks);
    for (const t of thunks) if (typeof t !== "function") throw new TypeError("parallel(thunks): every entry must be a function");
    return all(thunks.map((t) => settle(t)));
  };
  const pipeline = (list, ...stages) => {
    items("pipeline(items, ...stages)", list);
    for (const s of stages) if (typeof s !== "function") throw new TypeError("pipeline(items, ...stages): every stage must be a function");
    return all(list.map((item, index) => settle(async () => {
      let prev = item;
      for (const stage of stages) prev = await stage(prev, item, index);
      return prev;
    })));
  };
  const log = (text) => { H.emit("log", String(text)); };
  const phase = (title) => { H.emit("phase", String(title)); };
  const workflow = async (ref, childArgs) => {
    const ok = typeof ref === "string" || (ref !== null && typeof ref === "object" && typeof ref.scriptPath === "string");
    if (!ok) throw new TypeError("workflow(nameOrRef, args): expected a name or {scriptPath}");
    return call("workflow", { ref: typeof ref === "string" ? ref : { scriptPath: ref.scriptPath }, args: childArgs === undefined ? null : childArgs });
  };
  const args = argsJson === undefined ? undefined : deepFreeze(parse(argsJson));
  const globals = { agent, parallel, pipeline, log, phase, workflow, budget, args };
  for (const k of keys(globals)) define(globalThis, k, { value: globals[k], writable: false, enumerable: false, configurable: false });
  return (p) => {
    then.call(p, (v) => {
      let text;
      try { text = v === undefined ? "null" : stringify(v); } catch (e) { H.done(false, "the result is not JSON-serialisable: " + message(e)); return; }
      H.done(true, text === undefined ? "null" : text);
    }, (e) => { H.done(false, message(e)); });
  };
})`;

const [qjsEntry, wasmPath] = process.argv.slice(2);
let sent = false;
const send = (msg) => {
  const line = JSON.stringify(msg);
  process.stdout.write(line + "\n");
  return line.length;
};
const finish = (msg) => {
  if (sent) return;
  sent = true;
  let line = JSON.stringify(msg);
  if (line.length > LINE_CAP) line = JSON.stringify({ t: "done", ok: false, kind: "limit", error: "the script's result exceeds 1 MiB" });
  process.stdout.write(line + "\n", () => process.exit(0));
};

const input = createInterface({ input: process.stdin });
const queue = [];
let onLine = (line) => { queue.push(line); };
input.on("line", (line) => onLine(line));
input.on("close", () => process.exit(0));

const first = await new Promise((resolve) => {
  onLine = (line) => {
    onLine = (later) => { queue.push(later); };
    resolve(line);
  };
});
const start = JSON.parse(first);
const timeout = () => ({ t: "done", ok: false, kind: "timeout", error: `the script ran for more than ${start.sliceMs} ms without yielding` });
const kindOf = (text) => (/out of memory/i.test(text) ? "memory" : /stack overflow/i.test(text) ? "stack" : "script");
const quiet = () => ({ fd_write: () => 8 }); // QuickJS's own diagnostics must not reach stdout, the protocol channel.

async function run() {
  if (start.t !== "start") return finish({ t: "done", ok: false, kind: "protocol", error: "expected a start message" });
  const wasm = readFileSync(wasmPath);
  const digest = createHash("sha256").update(wasm).digest("hex");
  if (digest !== start.wasmSha256) return finish({ t: "done", ok: false, kind: "integrity", error: `quickjs.wasm digest ${digest} does not match the pinned ${start.wasmSha256}` });
  const { QuickJS, Intrinsics } = await import(pathToFileURL(qjsEntry).href);
  const module = new WebAssembly.Module(wasm);
  const restricted = (Intrinsics.ALL & ~Intrinsics.DATE & ~Intrinsics.PERFORMANCE & ~Intrinsics.WEAK_REF & ~Intrinsics.EVAL) >>> 0;

  // The script VM has no EVAL intrinsic, which also removes its parser, so a separate VM that
  // never runs anything compiles the prelude and the script to bytecode first.
  let compiled;
  try {
    const compiler = await QuickJS.create({ wasm: module, memoryLimit: start.memoryLimit, intrinsics: (restricted | Intrinsics.EVAL) >>> 0, wasi: quiet });
    try {
      compiled = {
        prelude: compiler.compile(PRELUDE, "luna-prelude.js"),
        main: compiler.compile(`"use strict";(async () => {\n${start.source}\n})()`, "workflow.js"),
      };
    } finally {
      compiler.dispose();
    }
  } catch (e) {
    const text = String(e?.message).replace(/^Compilation error: /, "");
    return finish({ t: "done", ok: false, kind: /^SyntaxError/.test(text) ? "syntax" : "script", error: text });
  }

  let deadline = Infinity;
  let interrupted = false;
  let ticks = 0;
  const vm = await QuickJS.create({
    wasm: module,
    memoryLimit: start.memoryLimit,
    intrinsics: restricted,
    wasi: quiet,
    interruptHandler: () => {
      if ((++ticks & 1023) !== 0) return false;
      if (Date.now() <= deadline) return false;
      interrupted = true;
      return true;
    },
  });

  let spent = typeof start.spent === "number" ? start.spent : 0;
  let seq = 0;
  let logs = 0;
  let result = null;
  const pending = new Map();

  const host = vm.newObject();
  const fn = (name, impl) => { const f = vm.newFunction(name, impl); host.setProp(name, f); f.dispose(); };
  fn("call", (op, payload) => {
    const text = payload.toString();
    const d = vm.newPromise();
    if (text.length > LINE_CAP) {
      const e = vm.newError("the call's arguments exceed 1 MiB");
      d.reject(e);
      e.dispose();
      return d.handle;
    }
    const id = ++seq;
    pending.set(id, d);
    send({ t: "call", id, op: op.toString(), payload: text });
    return d.handle;
  });
  fn("emit", (kind, text) => {
    logs += 1;
    if (logs <= LOG_CAP) send({ t: kind.toString() === "phase" ? "phase" : "log", text: logs === LOG_CAP ? "log limit reached: further log() calls are dropped" : text.toString().slice(0, TEXT_CAP) });
    return vm.getUndefined();
  });
  fn("spent", () => vm.newNumber(spent));
  fn("done", (ok, text) => {
    if (!result) result = ok.toBoolean() ? { t: "done", ok: true, value: text.toString() } : { t: "done", ok: false, kind: "script", error: text.toString() };
    return vm.getUndefined();
  });

  // Runs the VM's queued jobs as one slice under the slice deadline, then decides whether the run is over.
  const slice = (work) => {
    deadline = Date.now() + start.sliceMs;
    try {
      work();
      vm.executePendingJobs();
    } catch (e) {
      const name = String(e?.name);
      const text = String(e?.message);
      if (!result) result = { t: "done", ok: false, kind: name === "SyntaxError" ? "syntax" : "script", error: name === "SyntaxError" ? `SyntaxError: ${text}` : text };
    }
    deadline = Infinity;
    if (interrupted) finish(timeout());
    else if (result) finish(result.ok || result.kind !== "script" ? result : { ...result, kind: kindOf(result.error) });
    else if (pending.size === 0) finish({ t: "done", ok: false, kind: "stalled", error: "the script is waiting on a promise that nothing will settle" });
  };

  onLine = (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.t === "budget" && typeof msg.spent === "number") { spent = msg.spent; return; }
    if (msg.t !== "result") return;
    const d = pending.get(msg.id);
    if (!d) return;
    pending.delete(msg.id);
    slice(() => {
      const h = msg.ok ? vm.newString(String(msg.value)) : vm.newError(String(msg.error));
      if (msg.ok) d.resolve(h); else d.reject(h);
      h.dispose();
    });
  };

  slice(() => {
    const prelude = vm.evalBytecode(compiled.prelude);
    const total = start.total === null ? vm.getNull() : vm.newNumber(start.total);
    const argsHandle = typeof start.args === "string" ? vm.newString(start.args) : vm.getUndefined();
    const watch = vm.callFunction(prelude, vm.getUndefined(), host, total, argsHandle);
    const main = vm.evalBytecode(compiled.main);
    vm.callFunction(watch, vm.getUndefined(), main).dispose();
  });
  for (const line of queue.splice(0)) onLine(line);
}

await run();
