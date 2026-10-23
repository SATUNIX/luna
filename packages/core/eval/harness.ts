// Shared eval harness helpers. Deterministic and fully offline — extensions are transpiled
// with the TypeScript compiler and driven with a fake pi API. No model, no network.
import fs from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type {
  AgentBeforeSettleEventResult,
  AgentToolResult,
  BeforeAgentStartEventResult,
  ContextEventResult,
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  InputEventResult,
  MessageEndEventResult,
  RegisteredCommand,
  ResourcesDiscoverResult,
  SessionBeforeCompactResult,
  SessionBeforeForkResult,
  SessionBeforeSwitchResult,
  SessionBeforeTreeResult,
  SlashCommandInfo,
  ToolCallEventResult,
  ToolDefinition,
  ToolResultEventResult,
  TurnEndEventResult,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { WORKSPACE_ROOT } from "../lib/paths.ts";

export const ROOT = WORKSPACE_ROOT;
const CACHE_DIR = path.join(ROOT, "node_modules", ".cache", "pi-kit-eval");

const TS_COMPILER_OPTIONS = {
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
};

const flatName = (relPath: string): string => relPath.replace(/[\\/:]/g, "_").replace(/\.ts$/, ".mjs");

// Transpile a single .ts module into CACHE_DIR, recursing into sibling ".ts" imports.
// Returns the compiled file path. Every module is rewritten on each call (no
// `existsSync` short-circuit): a stale sibling cache previously survived an edit to
// that sibling, so tests could silently run against old code. Sibling output names are
// derived from their repo-relative path (not `path.basename`), so two different
// extensions that each own a same-named sibling (e.g. several `todo-read.ts` copies)
// can no longer overwrite/reuse each other's compiled module.
const compiledThisRun = new Set<string>();
function compileModule(absSource: string): string {
  const relToRoot = path.relative(ROOT, absSource).split(path.sep).join("/");
  const outPath = path.join(CACHE_DIR, flatName(relToRoot));
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (compiledThisRun.has(absSource)) return outPath;
  compiledThisRun.add(absSource);

  const srcDir = path.dirname(absSource);
  let out = ts.transpileModule(fs.readFileSync(absSource, "utf8"), { compilerOptions: TS_COMPILER_OPTIONS }).outputText;

  // Sibling .ts modules imported with an explicit ".ts" specifier (e.g. vendor/subagent/
  // index.ts's `from "./agents.ts"`) must also be transpiled, not merely copied: Node
  // refuses native type-stripping for anything under node_modules (CACHE_DIR lives under
  // node_modules/.cache), so an un-transpiled .ts sibling would fail to load there even
  // though it loads fine from the real source tree. Rewrite the specifier to the
  // compiled sibling's flat filename and transpile it into CACHE_DIR too.
  out = out.replace(/from\s+(["'])(\.[^"']*)\.ts\1/g, (match: string, quote: string, specifier: string) => {
    const siblingSource = path.resolve(srcDir, `${specifier}.ts`);
    if (!fs.existsSync(siblingSource)) return match;
    compileModule(siblingSource);
    const siblingRel = path.relative(ROOT, siblingSource).split(path.sep).join("/");
    return `from ${quote}./${flatName(siblingRel)}${quote}`;
  });

  // Resolve import.meta.url to the *source* file, not the cache copy: extensions locate kit
  // resources relative to themselves (e.g. subagent -> packages/kit/agents), which only exist
  // relative to the real tree. Sibling assets are still copied below for older call sites.
  out = out.replace(/\bimport\.meta\.url\b/g, JSON.stringify(pathToFileURL(absSource).href));

  fs.writeFileSync(outPath, out);
  return outPath;
}

function compile(relativePath: string): string {
  // Logical paths used by tests/profile-check ("extensions/<name>/...", "vendor/<name>/...")
  // map onto the monorepo's package layout; real relative paths pass through.
  const normalized = relativePath.startsWith("extensions/")
    ? `packages/extensions/src/${relativePath.slice("extensions/".length)}`
    : relativePath.startsWith("vendor/")
      ? `packages/extensions/third_party/${relativePath.slice("vendor/".length)}`
      : relativePath;
  const sourcePath = path.join(ROOT, normalized);
  const outPath = compileModule(sourcePath);
  const srcDir = path.dirname(sourcePath);
  // Copy sibling assets so relative filesystem access based on import.meta.url resolves
  // from CACHE_DIR the same way it does from the real source directory: non-.ts files
  // (e.g. tool-firewall/default-policy.json), and sibling data DIRECTORIES (e.g.
  // orchestrator/agents/*.md, static templates read via fs.readdirSync at runtime, not
  // imported as modules).
  for (const f of fs.readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, f);
    if (f.endsWith(".json") && f !== "extension.json") {
      fs.copyFileSync(srcPath, path.join(CACHE_DIR, f));
    } else if (fs.statSync(srcPath).isDirectory()) {
      fs.cpSync(srcPath, path.join(CACHE_DIR, f), { recursive: true });
    }
  }
  return outPath;
}

/**
 * Load a module through the transpile cache and return it whole (default + named exports).
 *
 * The caller states the module's shape as `T` (typically `typeof M` for an `import type * as M`
 * of the same source file): a loaded module cannot be validated against its own type at run time,
 * so this is where the test takes responsibility for it.
 */
export async function loadModule<T>(relativePath: string): Promise<T> {
  const compiled = compile(relativePath);
  // The one sanctioned dynamic import of a computed specifier (typescript-quality-plan.md,
  // "Dynamic code"): this function is the eval module loader. The specifier is always a file
  // this harness just wrote into CACHE_DIR from a repository path; the query string defeats
  // Node's module cache so each load sees the current source.
  const loaded: unknown = await import(`${pathToFileURL(compiled).href}?v=${Date.now()}-${Math.random()}`);
  return loaded as T;
}

/**
 * An extension's default export as the harness sees it: a function a test calls with a pi API
 * (usually `fakePi().api`, sometimes a test's own stand-in) and any extra dependencies the
 * extension takes. Which API members it uses is the extension's business, so `api` is unknown.
 */
export type ExtensionFactory = (api: unknown, ...deps: unknown[]) => unknown;

/** The default export of an extension module (`F` when the test states a different shape). */
export async function loadExtension<F = ExtensionFactory>(relativePath: string): Promise<F> {
  return (await loadModule<{ default: F }>(relativePath)).default;
}

/**
 * What a handler returns, per pi event, in pi's own types. Other events (pi's result-less ones
 * and any custom event) are `unknown`: the harness makes no claim about them.
 */
export interface PiEventResults {
  resources_discover: ResourcesDiscoverResult;
  session_before_switch: SessionBeforeSwitchResult;
  session_before_fork: SessionBeforeForkResult;
  session_before_compact: SessionBeforeCompactResult;
  session_before_tree: SessionBeforeTreeResult;
  context: ContextEventResult;
  context_with_system: ContextEventResult;
  before_agent_start: BeforeAgentStartEventResult;
  turn_end: TurnEndEventResult;
  agent_before_settle: AgentBeforeSettleEventResult;
  message_end: MessageEndEventResult;
  tool_call: ToolCallEventResult;
  tool_result: ToolResultEventResult;
  user_bash: UserBashEventResult;
  input: InputEventResult;
}

export type EventResult<K extends string> = K extends keyof PiEventResults ? PiEventResults[K] : unknown;

/**
 * An event handler as a test invokes it. Tests pass hand-built partial events and contexts, so
 * both are `unknown` here; the result is pi's result type for the event.
 */
export type FakeHandler<K extends string> = (event?: unknown, ctx?: unknown) => EventResult<K> | undefined | Promise<EventResult<K> | undefined>;

/** Any handler an extension registered with `pi.on`. */
export type RegisteredHandler = (event?: unknown, ctx?: unknown) => unknown;

/** A tool result as kit tools return it: pi's shape plus the `isError` flag pi passes through. */
export type FakeToolResult = AgentToolResult<unknown> & { isError?: boolean };

/** A tool an extension registered, with `execute` widened to accept the tests' fake contexts (and a null signal). */
export type FakeTool = Omit<ToolDefinition, "execute"> & {
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal | null, onUpdate?: unknown, ctx?: unknown) => Promise<FakeToolResult>;
};

/**
 * The text of a tool result's content item (the first by default). Throws when that item is
 * missing or is not text, so a test reads text only where the tool produced it.
 */
export function textOf(result: Pick<AgentToolResult<unknown>, "content">, index = 0): string {
  const item = result.content[index];
  if (item?.type !== "text") throw new Error(`tool result content[${index}] is ${item ? item.type : "missing"}, not text`);
  return item.text;
}

/**
 * A command an extension registered, with `handler` widened to accept the tests' fake contexts.
 * `args` may also be a word array: older pi versions passed one, and kit commands accept both.
 */
export type FakeCommand = Omit<RegisteredCommand, "name" | "sourceInfo" | "handler"> & {
  handler: (args: string | string[], ctx?: unknown) => Promise<void>;
};

/**
 * A registry keyed by name whose `get` returns the registered value or throws: a test that looks
 * up something the extension never registered fails with the name instead of "not a function".
 * `find` is the lookup that tolerates absence (undefined), for code where registration is optional.
 */
export class Registry<V> extends Map<string, V> {
  readonly kind: string;
  constructor(kind: string) {
    super();
    this.kind = kind;
  }

  override get(name: string): V {
    const value = super.get(name);
    if (value === undefined) throw new Error(`no ${this.kind} registered as "${name}"`);
    return value;
  }

  find(name: string): V | undefined {
    return super.get(name);
  }
}

/** Handlers by event name; `get` returns the handler typed by the event's pi result type. */
export class HandlerRegistry extends Registry<RegisteredHandler> {
  constructor() {
    super("handler");
  }

  override get<K extends string>(event: K): FakeHandler<K> {
    // pi's contract for a handler registered on `event` is that it returns EventResult<event>.
    return super.get(event) as FakeHandler<K>;
  }

  override find<K extends string>(event: K): FakeHandler<K> | undefined {
    return super.find(event) as FakeHandler<K> | undefined;
  }
}

export type SteerMessage = Parameters<ExtensionAPI["sendUserMessage"]>[0] | Parameters<ExtensionAPI["sendMessage"]>[0];
/** The options of either call, merged: each key belongs to one of them, and absent keys read as undefined. */
export interface SteerOptions {
  deliverAs?: "steer" | "followUp" | "nextTurn";
  expandPromptTemplates?: boolean;
  triggerTurn?: boolean;
}

/** A message an extension sent with `sendUserMessage` or `sendMessage`. */
export interface Steer {
  message: SteerMessage;
  opts: SteerOptions | undefined;
}

export type FlagOptions = Parameters<ExtensionAPI["registerFlag"]>[1];

/** A model handed to `setModel`. `_setModelResult: false` simulates a model with no auth configured. */
export type SelectedModel = Parameters<ExtensionAPI["setModel"]>[0] & { _setModelResult?: boolean };

/** `pi.exec`'s result as the fake produces it (it never reports `killed`). */
export type FakeExecResult = Omit<ExecResult, "killed">;

/** A shortcut an extension registered, with the context handler pi would call. */
export interface FakeShortcut {
  description?: string;
  handler: (ctx: unknown) => unknown;
}

/** The subset of pi's ExtensionAPI the fake implements. */
export interface FakePiApi {
  on: (name: string, handler: RegisteredHandler) => unknown;
  registerTool: (tool: FakeTool) => unknown;
  registerCommand: (name: string, cmd: FakeCommand) => unknown;
  registerShortcut: (shortcut: string, options: FakeShortcut) => unknown;
  getCommands: () => Pick<SlashCommandInfo, "name">[];
  getActiveTools: () => string[];
  registerFlag: (name: string, opts?: FlagOptions) => unknown;
  getFlag: (name: string) => boolean | string | undefined;
  sendUserMessage: (message: SteerMessage, opts?: SteerOptions) => Promise<unknown>;
  sendMessage: (message: SteerMessage, opts?: SteerOptions) => unknown;
  exec: (command: string, args: string[], execOptions?: ExecOptions) => Promise<FakeExecResult>;
  setModel: (model: SelectedModel) => Promise<boolean>;
}

/** A fake pi API and everything extensions registered or sent through it. */
export interface FakePi {
  api: FakePiApi;
  handlers: HandlerRegistry;
  flags: Map<string, boolean | string | undefined>;
  tools: Registry<FakeTool>;
  commands: Registry<FakeCommand>;
  shortcuts: Map<string, FakeShortcut>;
  steers: Steer[];
  modelSelections: SelectedModel[];
}

export interface FakePiOptions {
  /** Working directory for `pi.exec` when the call does not pass one. */
  cwd?: string;
}

export function fakePi(options: FakePiOptions = {}): FakePi {
  const handlers = new HandlerRegistry();
  const tools = new Registry<FakeTool>("tool");
  const commands = new Registry<FakeCommand>("command");
  const shortcuts = new Map<string, FakeShortcut>();
  const steers: Steer[] = [];
  const flags = new Map<string, boolean | string | undefined>();
  const modelSelections: SelectedModel[] = [];
  return {
    api: {
      on: (name, handler) => handlers.set(name, handler),
      registerTool: (tool) => tools.set(tool.name, tool),
      registerCommand: (name, cmd) => commands.set(name, cmd),
      registerShortcut: (shortcut, opts) => shortcuts.set(shortcut, opts),
      getCommands: () => [...commands.keys()].map((name) => ({ name })),
      getActiveTools: () => ["read", "bash", "write", "edit", "subagent"],
      registerFlag: (name, opts) => flags.set(name, opts?.default),
      getFlag: (name) => flags.get(name),
      sendUserMessage: async (message, opts) => steers.push({ message, opts }),
      sendMessage: (message, opts) => steers.push({ message, opts }),
      exec: (command, args, execOptions = {}) => new Promise((resolve) => {
        execFile(command, args, {
          cwd: execOptions.cwd ?? options.cwd ?? process.cwd(),
          shell: false,
          windowsHide: true,
        }, (error, stdout, stderr) => resolve({
          stdout,
          stderr,
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        }));
      }),
      // Matches the real pi.setModel(model): Promise<boolean> contract - returns false
      // if no auth is configured. Tests can inject a `_setModelResult: false` on a fake
      // model to simulate that path.
      setModel: async (model) => {
        modelSelections.push(model);
        return model?._setModelResult !== false;
      },
    },
    handlers,
    flags,
    tools,
    commands,
    shortcuts,
    steers,
    modelSelections,
  };
}

/** The identity a fake registry model needs; tests add whatever else the code under test reads. */
export interface ModelKey {
  provider: string;
  id: string;
}

// A minimal ctx.modelRegistry stand-in (find/getAll only - the documented public
// surface extensions are expected to use). `models` is an array of
// { provider, id, ...extra }.
export function fakeModelRegistry<M extends ModelKey>(models: M[]): { find: (provider: string, id: string) => M | undefined; getAll: () => M[] } {
  return {
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    getAll: () => models,
  };
}

export function setEnv(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
  return () => {
    if (previous === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = previous;
  };
}

// Ambient kit configuration must not leak into a test: the autonomy runtime and a developer's
// shell set PI_KIT_AUTO_MODE, PI_KIT_FIREWALL_POLICY, PI_CODING_AGENT_DIR and friends, all of
// which change firewall decisions and state paths. Tests call isolateKitEnv() before loading the
// extension under test, then setEnv() only what that test needs. The returned closure restores
// exactly the variables that were present. Matching by prefix (not a fixed list) so new kit
// variables are covered automatically.
export function isolateKitEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (key === "PI_CODING_AGENT_DIR" || key.startsWith("PI_KIT_") || key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_")) {
      saved.set(key, process.env[key]);
      Reflect.deleteProperty(process.env, key);
    }
  }
  return () => {
    for (const [key, value] of saved) process.env[key] = value;
  };
}

export function tmpWorkspace(prefix = "pi-kit-eval-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Remove a scratch directory, best effort (an absent `dir` is a no-op, as a failed removal is). */
export function rmWorkspace(dir: string | undefined): void {
  if (dir === undefined) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function assert(cond: unknown, message?: string): asserts cond {
  if (!cond) throw new Error(message || "assertion failed");
}
