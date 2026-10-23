/**
 * Workflow-script sandbox: runs one untrusted workflow script and brokers its hook calls.
 *
 * Layers, outermost first (docs/workflow-sandbox.md):
 *   bwrap (no network, own pid/ipc/uts namespaces, read-only /usr, empty environment via `env -i`)
 *   -> prlimit (CPU seconds, address space, no file writes, few descriptors)
 *   -> node --permission (reads only the runner and quickjs-wasi; no child processes, workers or addons)
 *   -> raw QuickJS (quickjs-wasi) without Date, performance, WeakRef or eval.
 *
 * The script and its arguments travel over stdin; every hook call is a JSON line the host checks
 * against a schema before it acts. `node:vm` is never used. Without bwrap the sandbox refuses
 * unless the operator picks reduced mode (the last three layers) in a No-first select.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

/** sha256 of quickjs-wasi 3.6.2's `quickjs.wasm`. A different binary is refused. */
export const QUICKJS_WASM_SHA256 = "d4c9375f2b1ca4dc95f72c8aa2982a7a9951ac8011490d79c6582df732b4bbd9";
/** quickjs-wasi versions the runner is written against. */
export const QUICKJS_VERSION = /^3\.6\.\d+$/;
/** Longest protocol line, script source, argument set or hook result, in characters. */
export const LINE_CAP = 1024 * 1024;
/** Longest raw protocol line: a 1 MiB payload grows when JSON-escaped inside its message. */
const PROTOCOL_LINE_CAP = 8 * LINE_CAP;

const RUNNER = fileURLToPath(new URL("./wf-runner.mjs", import.meta.url));
const JAIL = "/sandbox";

export type SandboxMode = "full" | "reduced";
export type SandboxErrorKind =
  | "syntax" | "script" | "timeout" | "memory" | "stack" | "stalled" | "limit" | "integrity"
  | "idle" | "cpu" | "crash" | "aborted" | "protocol" | "unavailable";
export type SandboxResult = { ok: true; value: unknown } | { ok: false; kind: SandboxErrorKind; error: string };

export interface SandboxLimits {
  /** QuickJS heap limit in bytes. */
  memoryBytes: number;
  /** Longest the script may run without yielding (one slice of VM jobs), in ms. */
  sliceMs: number;
  /** Host watchdog: longest the runner may stay silent while no hook call is outstanding, in ms. */
  idleMs: number;
  /** prlimit --cpu backstop, in CPU seconds for the whole run. */
  cpuSeconds: number;
  /** prlimit --as, in bytes. WebAssembly reserves address space well beyond what it uses. */
  addressSpaceBytes: number;
}
export const DEFAULT_LIMITS: SandboxLimits = {
  memoryBytes: 64 * 1024 * 1024,
  sliceMs: 2000,
  idleMs: 10_000,
  cpuSeconds: 300,
  addressSpaceBytes: 16 * 1024 * 1024 * 1024,
};

export interface WorkflowHooks {
  agent(prompt: string, opts: Record<string, unknown> | null, signal: AbortSignal): Promise<unknown>;
  workflow?(ref: string | { scriptPath: string }, args: unknown, signal: AbortSignal): Promise<unknown>;
  log?(text: string): void;
  phase?(title: string): void;
}

export interface QuickjsLocation {
  dir: string;
  entry: string;
  wasm: string;
}

export interface SandboxSupport {
  bwrap: string | null;
  prlimit: string | null;
  /** Why full mode is unavailable, when it is. */
  reason?: string;
}

// ---------------------------------------------------------------------------------------------
// quickjs-wasi: location and integrity

/** Where quickjs-wasi is installed (the kit's own pinned dependency), or why it cannot be found. */
export function locateQuickjs(dir?: string): QuickjsLocation | { error: string } {
  let root = dir;
  if (root === undefined) {
    try {
      root = path.dirname(createRequire(import.meta.url).resolve("quickjs-wasi/package.json"));
    } catch (e) {
      return { error: `quickjs-wasi is not installed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { dir: root, entry: path.join(root, "dist", "index.js"), wasm: path.join(root, "quickjs.wasm") };
}

/** Checks the package version and the wasm digest; returns an error message or null. */
export function verifyQuickjs(loc: QuickjsLocation): string | null {
  let version: unknown;
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(loc.dir, "package.json"), "utf8"));
    version = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "version") : undefined;
  } catch (e) {
    return `cannot read quickjs-wasi's package.json: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (typeof version !== "string" || !QUICKJS_VERSION.test(version)) return `quickjs-wasi ${String(version)} is not a supported version (3.6.x)`;
  let digest: string;
  try {
    digest = createHash("sha256").update(fs.readFileSync(loc.wasm)).digest("hex");
  } catch (e) {
    return `cannot read quickjs.wasm: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (digest !== QUICKJS_WASM_SHA256) return `quickjs.wasm digest ${digest} does not match the pinned ${QUICKJS_WASM_SHA256}`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Host support and the jail command line

/** Finds an executable on PATH (or the usual system directories). */
export function findExecutable(name: string): string | null {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), "/usr/bin", "/bin", "/usr/local/bin"].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {
      /* not here */
    }
  }
  return null;
}

/** Whether this host can run the full sandbox: bwrap that can create namespaces, and prlimit. */
export function detectSupport(): SandboxSupport {
  const prlimit = findExecutable("prlimit");
  const bwrap = findExecutable("bwrap");
  if (process.platform !== "linux") return { bwrap: null, prlimit, reason: "the sandbox needs Linux" };
  if (!bwrap) return { bwrap: null, prlimit, reason: "bwrap (bubblewrap) is not installed" };
  if (!prlimit) return { bwrap: null, prlimit, reason: "prlimit (util-linux) is not installed" };
  const probe = spawnSync(bwrap, ["--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "--", prlimit, "--version"], { env: {}, encoding: "utf8", timeout: 5000 });
  if (probe.status !== 0) {
    const why = (probe.stderr || probe.error?.message || `exit ${String(probe.status)}`).trim().split("\n")[0] ?? "";
    return { bwrap: null, prlimit, reason: `bwrap cannot create a sandbox here (${why})` };
  }
  return { bwrap, prlimit };
}

export interface JailSpec {
  mode: SandboxMode;
  support: SandboxSupport;
  /** The JavaScript file node runs. */
  entry: string;
  /** Directories node may read besides the entry, each mounted read-only. */
  readDirs: readonly { host: string; name: string }[];
  /** Arguments after the entry, as functions of where a read directory is visible. */
  entryArgs: (visible: (name: string) => string) => string[];
  limits: SandboxLimits;
}

/** The command line for one jailed node process. Exported so the smoke test can probe the jail itself. */
export function jailCommand(spec: JailSpec): { command: string; args: string[] } {
  const { support, limits } = spec;
  if (!support.prlimit) throw new Error("prlimit is required");
  const prlimitArgs = [
    // Soft limit sends SIGXCPU (reported as kind "cpu"); the hard limit 5 s later is SIGKILL.
    `--cpu=${String(limits.cpuSeconds)}:${String(limits.cpuSeconds + 5)}`,
    `--as=${String(limits.addressSpaceBytes)}`,
    "--fsize=0",
    "--core=0",
    "--nofile=64",
    "--",
  ];
  const nodeFlags = (entry: string, dirs: readonly string[]): string[] => [
    "--permission",
    `--allow-fs-read=${entry}`,
    ...dirs.map((d) => `--allow-fs-read=${d}`),
    "--max-old-space-size=64",
    "--disallow-code-generation-from-strings",
    "--no-addons",
    entry,
  ];
  if (spec.mode === "reduced") {
    const visible = (name: string): string => spec.readDirs.find((d) => d.name === name)?.host ?? name;
    return {
      command: support.prlimit,
      args: [...prlimitArgs, process.execPath, ...nodeFlags(spec.entry, spec.readDirs.map((d) => d.host)), ...spec.entryArgs(visible)],
    };
  }
  if (!support.bwrap) throw new Error("bwrap is required for the full sandbox");
  const binds: string[] = ["--ro-bind", "/usr", "/usr"];
  for (const top of ["/bin", "/sbin", "/lib", "/lib64", "/lib32"]) {
    try {
      const st = fs.lstatSync(top);
      if (st.isSymbolicLink()) binds.push("--symlink", fs.readlinkSync(top), top);
      else if (st.isDirectory()) binds.push("--ro-bind", top, top);
    } catch {
      /* absent on this host */
    }
  }
  if (fs.existsSync("/etc/ld.so.cache")) binds.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
  const inside = (name: string): string => `${JAIL}/${name}`;
  const entry = `${JAIL}/${path.basename(spec.entry)}`;
  binds.push("--ro-bind", process.execPath, `${JAIL}/bin/node`, "--ro-bind", support.prlimit, `${JAIL}/bin/prlimit`, "--ro-bind", spec.entry, entry);
  // bwrap always sets PWD, even after --clearenv; `env -i` inside the jail starts prlimit with nothing.
  const env = findExecutable("env");
  if (env) binds.push("--ro-bind", env, `${JAIL}/bin/env`);
  for (const d of spec.readDirs) binds.push("--ro-bind", d.host, inside(d.name));
  return {
    command: support.bwrap,
    args: [
      ...binds,
      "--proc", "/proc",
      "--dev", "/dev",
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--cap-drop", "ALL",
      "--chdir", JAIL,
      "--",
      ...(env ? [`${JAIL}/bin/env`, "-i"] : []),
      `${JAIL}/bin/prlimit`,
      ...prlimitArgs,
      `${JAIL}/bin/node`,
      ...nodeFlags(entry, spec.readDirs.map((d) => inside(d.name))),
      ...spec.entryArgs(inside),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Protocol

const RunnerMessage = Type.Union([
  Type.Object({ t: Type.Literal("call"), id: Type.Integer({ minimum: 1 }), op: Type.Union([Type.Literal("agent"), Type.Literal("workflow")]), payload: Type.String() }, { additionalProperties: false }),
  Type.Object({ t: Type.Union([Type.Literal("log"), Type.Literal("phase")]), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ t: Type.Literal("done"), ok: Type.Literal(true), value: Type.String() }, { additionalProperties: false }),
  Type.Object({ t: Type.Literal("done"), ok: Type.Literal(false), kind: Type.String(), error: Type.String() }, { additionalProperties: false }),
]);
type RunnerMessage = Static<typeof RunnerMessage>;
const AgentPayload = Type.Object({ prompt: Type.String(), opts: Type.Union([Type.Null(), Type.Record(Type.String(), Type.Unknown())]) }, { additionalProperties: false });
const WorkflowPayload = Type.Object({
  ref: Type.Union([Type.String(), Type.Object({ scriptPath: Type.String() }, { additionalProperties: false })]),
  args: Type.Unknown(),
}, { additionalProperties: false });
const runnerKind = (kind: string): SandboxErrorKind => {
  switch (kind) {
    case "syntax": case "script": case "timeout": case "memory": case "stack": case "stalled": case "limit": case "integrity": case "protocol":
      return kind;
    default:
      return "protocol";
  }
};

/** Claude Code scripts start with `export const meta = {...}`; the body runs as a function, so the export keyword goes. */
export function scriptBody(source: string): string {
  return source.replace(/^((?:\s|\/\/[^\n]*\n|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)*)export\s+(const\s+meta\b)/, "$1$2");
}

const message = (e: unknown): string => {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return "the hook failed with a value that cannot be shown";
  }
};
/** A hook's settled value as the `result` line's fields; never throws. */
const encodeResult = (value: unknown): { ok: true; value: string } | { ok: false; error: string } => {
  let text: string | undefined;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    text = undefined;
  }
  if (typeof text !== "string") return { ok: false, error: "the hook's result is not JSON-serialisable" };
  return text.length > LINE_CAP ? { ok: false, error: "the hook's result exceeds 1 MiB" } : { ok: true, value: text };
};

export interface RunOptions {
  source: string;
  args?: unknown;
  hooks: WorkflowHooks;
  mode: SandboxMode;
  /** The shared token budget; the script sees a read-only mirror of it. */
  budget?: { total: number | null; spent(): number };
  limits?: Partial<SandboxLimits>;
  signal?: AbortSignal;
  /** Defaults to the installed quickjs-wasi; tests point it elsewhere. */
  quickjs?: QuickjsLocation;
  /** Defaults to detectSupport(). */
  support?: SandboxSupport;
}

/** Runs one workflow script to completion in the sandbox. Never throws; failures come back as `{ok:false}`. */
export async function runWorkflowScript(opts: RunOptions): Promise<SandboxResult> {
  const limits: SandboxLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const fail = (kind: SandboxErrorKind, error: string): SandboxResult => ({ ok: false, kind, error });
  if (opts.source.length > LINE_CAP) return fail("limit", "the script exceeds 1 MiB");
  let argsJson: string | null = null;
  if (opts.args !== undefined) {
    try {
      argsJson = JSON.stringify(opts.args);
    } catch (e) {
      return fail("limit", `args are not JSON-serialisable: ${message(e)}`);
    }
    if (argsJson.length > LINE_CAP) return fail("limit", "args exceed 1 MiB");
  }
  const located = opts.quickjs ?? locateQuickjs();
  if ("error" in located) return fail("unavailable", located.error);
  const bad = verifyQuickjs(located);
  if (bad) return fail("integrity", bad);
  const support = opts.support ?? detectSupport();
  if (opts.mode === "full" && !support.bwrap) return fail("unavailable", `full sandbox unavailable: ${support.reason ?? "bwrap missing"}`);
  if (!support.prlimit) return fail("unavailable", "prlimit (util-linux) is not installed");

  const { command, args } = jailCommand({
    mode: opts.mode,
    support,
    entry: RUNNER,
    readDirs: [{ host: located.dir, name: "quickjs-wasi" }],
    entryArgs: (visible) => [path.join(visible("quickjs-wasi"), "dist", "index.js"), path.join(visible("quickjs-wasi"), "quickjs.wasm")],
    limits,
  });
  if (opts.signal?.aborted) return fail("aborted", "the run was aborted before it started");

  return new Promise<SandboxResult>((resolve) => {
    const child = spawn(command, args, { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    const controller = new AbortController();
    let settled: SandboxResult | null = null;
    let outstanding = 0;
    let idle: NodeJS.Timeout | undefined;
    let stderr = "";
    let buffer = "";

    const end = (result: SandboxResult): void => {
      if (settled) return;
      settled = result;
      clearTimeout(idle);
      controller.abort();
      opts.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
    };
    const onAbort = (): void => { end(fail("aborted", "the run was aborted")); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const arm = (): void => {
      clearTimeout(idle);
      if (outstanding === 0 && !settled) idle = setTimeout(() => { end(fail("idle", `the runner was silent for ${String(limits.idleMs)} ms with no hook call outstanding`)); }, limits.idleMs);
    };
    // The runner splits stdin with node:readline, which also ends a line at U+2028 and U+2029;
    // JSON.stringify leaves both raw, so they are escaped here (only ever inside a JSON string).
    const write = (msg: Record<string, unknown>): void => {
      if (!settled) child.stdin.write(`${JSON.stringify(msg).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`);
    };
    const reply = (id: number, work: Promise<unknown>): void => {
      outstanding += 1;
      arm();
      work.then(encodeResult, (e: unknown) => ({ ok: false, error: message(e) })).then((r) => {
        outstanding -= 1;
        if (opts.budget) write({ t: "budget", spent: opts.budget.spent() });
        write({ t: "result", id, ...r });
        arm();
      }).catch((e: unknown) => { end(fail("protocol", `the host could not deliver a hook result: ${message(e)}`)); });
    };
    const handle = (msg: RunnerMessage): void => {
      switch (msg.t) {
        case "log":
          opts.hooks.log?.(msg.text);
          return;
        case "phase":
          opts.hooks.phase?.(msg.text);
          return;
        case "done":
          end(msg.ok ? parseValue(msg.value) : fail(runnerKind(msg.kind), msg.error));
          return;
        case "call": {
          let payload: unknown;
          try {
            payload = JSON.parse(msg.payload);
          } catch {
            end(fail("protocol", "the runner sent a call whose payload is not JSON"));
            return;
          }
          if (msg.op === "agent") {
            if (!Check(AgentPayload, payload)) {
              end(fail("protocol", "the runner sent a malformed agent() call"));
              return;
            }
            reply(msg.id, Promise.resolve().then(() => opts.hooks.agent(payload.prompt, payload.opts, controller.signal)));
          } else {
            if (!Check(WorkflowPayload, payload)) {
              end(fail("protocol", "the runner sent a malformed workflow() call"));
              return;
            }
            const { hooks } = opts;
            reply(msg.id, hooks.workflow
              ? Promise.resolve().then(() => hooks.workflow?.(payload.ref, payload.args, controller.signal))
              : Promise.reject(new Error("workflow() is not available here")));
          }
        }
      }
    };
    const parseValue = (text: string): SandboxResult => {
      try {
        const value: unknown = JSON.parse(text);
        return { ok: true, value };
      } catch {
        return fail("protocol", "the runner's result is not JSON");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0 && !settled) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          end(fail("protocol", "the runner wrote a line that is not JSON"));
          return;
        }
        if (!Check(RunnerMessage, parsed)) {
          end(fail("protocol", "the runner wrote a message outside the protocol"));
          return;
        }
        handle(parsed);
        nl = buffer.indexOf("\n");
      }
      if (buffer.length > PROTOCOL_LINE_CAP) end(fail("limit", "the runner wrote a protocol line longer than 8 MiB"));
      else arm();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (e) => {
      end(fail("crash", `the sandbox did not start: ${e.message}`));
      if (settled) resolve(settled);
    });
    child.on("close", (code, sig) => {
      if (!settled) {
        const xcpu = sig === "SIGXCPU" || code === 128 + 24;
        end(xcpu
          ? fail("cpu", `the run used more than ${String(limits.cpuSeconds)} CPU seconds`)
          : fail("crash", `the runner exited (${sig ?? `code ${String(code)}`}) without a result${stderr ? `: ${stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}`));
      }
      if (settled) resolve(settled);
    });

    write({
      t: "start",
      source: scriptBody(opts.source),
      args: argsJson,
      total: opts.budget?.total ?? null,
      spent: opts.budget?.spent() ?? 0,
      wasmSha256: QUICKJS_WASM_SHA256,
      memoryLimit: limits.memoryBytes,
      sliceMs: limits.sliceMs,
    });
    arm();
  });
}

// ---------------------------------------------------------------------------------------------
// Self-test and the per-session mode decision

/** Escape and determinism probes. Every entry must come back "blocked" (or the listed value). */
export const EVIL_SUITE = String.raw`export const meta = { name: "sandbox-self-test", description: "escape probes" };
const R = {};
const probe = async (k, f) => { try { R[k] = "ALLOWED " + String(await f()); } catch (e) { R[k] = "blocked"; } };
await probe("Function via agent() promise", () => agent("x").constructor.constructor("return 1")());
await probe("Function via agent() result", async () => (await agent("x")).constructor.constructor("return 1")());
await probe("Function via a hook", () => agent.constructor("return 1")());
await probe("AsyncFunction constructor", () => (async () => {}).constructor("return 1")());
await probe("GeneratorFunction constructor", () => (function* () {}).constructor("return 1")().next());
await probe("eval", () => eval("1"));
await probe("indirect eval", () => (0, globalThis.eval)("1"));
await probe("Date.now", () => Date.now());
await probe("new Date()", () => new Date());
await probe("Date()", () => Date());
await probe("new Date(0)", () => new Date(0));
await probe("agent redefined", () => { Object.defineProperty(globalThis, "agent", { value: 1 }); return typeof agent; });
await probe("Math.random", () => Math.random());
await probe("Math.random reassigned", () => { Math.random = () => 4; return Math.random(); });
await probe("Date redefined", () => { Object.defineProperty(globalThis, "Date", { value: 1 }); return Date; });
await probe("args mutated", () => { args.task = "x"; return args.task; });
await probe("agent replaced", () => { globalThis.agent = 1; return typeof agent; });
await probe("budget mutated", () => { budget.total = 1; return budget.total; });
R.realm = [agent("x") instanceof Promise, (await agent("x")) instanceof Object].join(",");
R.globals = [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof WebAssembly, typeof std, typeof os,
  typeof performance, typeof WeakRef, typeof FinalizationRegistry, typeof console, typeof globalThis.H].join(",");
return R;`;
const EVIL_EXPECT: Readonly<Record<string, string>> = {
  realm: "true,true",
  globals: Array(12).fill("undefined").join(","),
};

export interface SelfTestResult { ok: boolean; failures: string[] }

/** Runs EVIL_SUITE in `mode` against a stub agent hook. */
export async function selfTest(mode: SandboxMode, extra: Pick<RunOptions, "support" | "quickjs" | "limits"> = {}): Promise<SelfTestResult> {
  const result = await runWorkflowScript({ ...extra, mode, source: EVIL_SUITE, args: { task: "t" }, hooks: { agent: () => Promise.resolve({ text: "stub" }) } });
  if (!result.ok) return { ok: false, failures: [`the self-test did not complete (${result.kind}): ${result.error}`] };
  const value = result.value;
  if (typeof value !== "object" || value === null) return { ok: false, failures: ["the self-test returned no report"] };
  const failures: string[] = [];
  for (const [key, got] of Object.entries(value)) {
    const want = EVIL_EXPECT[key] ?? "blocked";
    if (got !== want) failures.push(`${key}: expected ${want}, got ${String(got)}`);
  }
  if (Object.keys(value).length < 20) failures.push("the self-test report is missing probes");
  return { ok: failures.length === 0, failures };
}

export interface ModeUi {
  hasUI: boolean;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
}
export type ModeDecision = { ok: true; mode: SandboxMode } | { ok: false; error: string };

export const REDUCED_NO = "No, don't run workflow scripts without bwrap";
export const REDUCED_YES = "Yes, run them in reduced mode for this session";

/**
 * One session's sandbox state: the reduced-mode answer and the self-test result, each settled at
 * most once. The engine keeps one per pi session.
 */
export class SandboxSession {
  readonly #detect: () => SandboxSupport;
  readonly #extra: Pick<RunOptions, "quickjs" | "limits">;
  #support: SandboxSupport | undefined;
  #reduced: boolean | undefined;
  readonly #tests = new Map<SandboxMode, Promise<SelfTestResult>>();

  constructor(options: { detect?: () => SandboxSupport; quickjs?: QuickjsLocation; limits?: Partial<SandboxLimits> } = {}) {
    this.#detect = options.detect ?? detectSupport;
    this.#extra = { ...(options.quickjs ? { quickjs: options.quickjs } : {}), ...(options.limits ? { limits: options.limits } : {}) };
  }

  get support(): SandboxSupport {
    this.#support ??= this.#detect();
    return this.#support;
  }

  /** Full mode when bwrap works; otherwise reduced mode only after the operator says yes, once per session. */
  async mode(ui: ModeUi): Promise<ModeDecision> {
    const support = this.support;
    if (support.bwrap) return { ok: true, mode: "full" };
    const refused = `Refused: workflow scripts need the bwrap sandbox, and ${support.reason ?? "bwrap is unavailable"}.`;
    if (!support.prlimit) return { ok: false, error: `${refused} Reduced mode also needs prlimit (util-linux).` };
    if (this.#reduced === undefined) {
      if (!ui.hasUI || !ui.select) return { ok: false, error: `${refused} Reduced mode needs an interactive yes.` };
      const pick = await ui.select(
        `Workflow sandbox: ${support.reason ?? "bwrap is unavailable"}. Reduced mode keeps node's permission model, QuickJS and prlimit, but has no namespaces: no network or pid isolation.`,
        [REDUCED_NO, REDUCED_YES],
      );
      this.#reduced = pick === REDUCED_YES;
    }
    return this.#reduced ? { ok: true, mode: "reduced" } : { ok: false, error: `${refused} Reduced mode was declined for this session.` };
  }

  /** Mode decision plus the evil-suite self-test on first use in that mode. */
  async prepare(ui: ModeUi): Promise<ModeDecision> {
    const decision = await this.mode(ui);
    if (!decision.ok) return decision;
    const mode = decision.mode;
    let test = this.#tests.get(mode);
    if (!test) {
      test = selfTest(mode, { ...this.#extra, support: this.support });
      this.#tests.set(mode, test);
    }
    const result = await test;
    return result.ok ? decision : { ok: false, error: `Refused: the workflow sandbox failed its self-test: ${result.failures.join("; ")}` };
  }
}
