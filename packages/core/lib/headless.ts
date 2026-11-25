/**
 * The `luna` command's two thin modes over pi, kept apart from the entry point so they can be tested.
 *
 *   luna --bare [pi args]     pi with none of Luna's extensions, skills, prompts or themes
 *   luna exec [options] <prompt|->   one headless run: the final answer on stdout, progress on stderr
 *
 * Both start `pi` (an argument vector; on Windows `exec` starts pi's node entry rather than the `.cmd` shim, so a prompt is never split). Nothing here reimplements pi: `exec` is
 * `pi --mode json` plus a reader that prints the last assistant message, and the ceiling is the one
 * object the unattended runs already share (PI_KIT_CEILING_*, enforced by goal-core, exit code 13).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, parseJson } from "./guard.ts";
import { findPackageEntry, globalAgentDir, readKitMarker, readSettings } from "./settings.ts";
import { readOverrides } from "./profiles.ts";
import { parseDuration } from "../shared/ceiling.ts";
import { redact } from "../shared/redact.ts";
import { piSpawnPlan, type PiSpawnDeps } from "./pi-cli.ts";

/** pi's flags for a session with no Luna: no extension discovery (so no companions either), skills, prompt templates or themes. */
export const BARE_ARGS: readonly string[] = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"];

export const PARKED_EXIT_CODE = 13;

export const EXEC_USAGE = `Usage: luna exec [options] <prompt | ->

Run one prompt headless. The final answer goes to stdout, progress to stderr.
A prompt of "-" is read from stdin. Exit code: pi's own, 13 when a ceiling parked the run.

Options:
  --json               write pi's JSON event stream to stdout unchanged (see docs/headless.md)
  --ephemeral          do not save a session
  --max-turns <n>      ceiling: assistant turns (PI_KIT_CEILING_TURNS)
  --max-cost <usd>     ceiling: money (PI_KIT_CEILING_USD)
  --timeout <time>     ceiling: wall time, e.g. 90, 30m, 1h30m (PI_KIT_CEILING_SECONDS)
  --model <pattern>    model for this run (pi --model)
`;

export interface ExecPlan {
  /** Arguments for pi, prompt last. */
  piArgs: string[];
  /** Variables added to the environment. */
  env: Record<string, string>;
  json: boolean;
  /** "-": the prompt comes from stdin. */
  stdinPrompt: boolean;
}

/** Parse `luna exec` arguments, or return the reason they are unusable. A bad limit is refused: a typo must not mean no limit. */
export function planExec(argv: readonly string[]): ExecPlan | string {
  const piArgs: string[] = ["--mode", "json"];
  const env: Record<string, string> = {};
  let json = false;
  let prompt: string | undefined;
  // After `--` the one remaining word is the prompt, read literally (even one that looks like an option, or "-").
  let literal = false;
  const value = (i: number): string | undefined => {
    const v = argv[i + 1];
    return v === undefined || (v.startsWith("--") && v.length > 2) ? undefined : v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--json": json = true; break;
      case "--ephemeral": piArgs.push("--no-session"); break;
      case "--max-turns": case "--max-cost": case "--timeout": case "--model": {
        const v = value(i);
        if (v === undefined) return `${arg} needs a value`;
        i++;
        if (arg === "--model") piArgs.push("--model", v);
        else if (arg === "--max-turns") {
          if (!/^[1-9]\d*$/.test(v)) return `--max-turns needs a whole number above zero, got "${v}"`;
          env.PI_KIT_CEILING_TURNS = v;
        } else if (arg === "--max-cost") {
          if (!(Number(v) > 0) || !Number.isFinite(Number(v))) return `--max-cost needs a dollar amount above zero, got "${v}"`;
          env.PI_KIT_CEILING_USD = v;
        } else {
          const s = parseDuration(v);
          
          if (s === undefined) return `--timeout needs seconds or a duration like 30m or 1h30m, got "${v}"`;
          env.PI_KIT_CEILING_SECONDS = String(s);
        }
        break;
      }
      case "--":
        if (prompt !== undefined || i + 2 !== argv.length) return "give exactly one prompt after --";
        prompt = argv[i + 1] ?? "";
        literal = true;
        i = argv.length;
        break;
      case "--help": case "-h": return "help";
      default:
        if (arg.startsWith("--") && arg.length > 2) return `unknown option ${arg}`;
        if (prompt !== undefined) return "give one prompt (quote it), or - to read it from stdin";
        prompt = arg;
    }
  }
  if (prompt === undefined) return "no prompt given";
  // A headless run is a script: never ask for a login or a reload, and keep startup network work off.
  env.PI_KIT_AUTO_PROFILE = "0";
  const stdinPrompt = !literal && prompt === "-";
  if (!stdinPrompt) piArgs.push("--", prompt);
  return { piArgs, env, json, stdinPrompt };
}

/** The text of an assistant message record, or null when the record is not one. */
function assistantText(message: unknown): { text: string; failed: boolean } | null {
  if (!isRecord(message) || message.role !== "assistant") return null;
  const content = message.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? content.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("") : "";
  return { text, failed: message.stopReason === "error" || message.stopReason === "aborted" };
}

/** The text a tool execution result carries, when it carries any. */
function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!isRecord(result)) return "";
  const content = result.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("")
    : "";
}

/** The first non-empty line of a tool result, clipped so a status line stays one line. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/**
 * A run launched by a tool (the autonomy CLI): name it and the state it reports, rather than a
 * bare command outcome. Accepts the CLI's human line and its `--json` record. `up --json` returns
 * `{runId, pid, status, ...}` with no `started` field, while `start --json` adds `started: true`;
 * a bare `{run, status}` (status/query output) is not a start and stays a tool outcome.
 */
function autonomyStart(text: string): string | null {
  const started = /\brun\s+([^\s;,(]+)\s+started\b[^\n]*?\b(?:status|state)\s*[:=]?\s*([A-Za-z][\w-]*)/i.exec(text);
  if (started !== null) return `Run ${started[1]} started; state: ${started[2]}.`;
  for (const raw of text.split(/\r?\n/)) {
    let record: unknown;
    try { record = parseJson(raw.trim()); } catch { continue; }
    if (!isRecord(record)) continue;
    const up = typeof record.runId === "string" && typeof record.status === "string";
    const start = record.started === true && typeof record.run === "string" && typeof record.status === "string";
    if (up || start) return `Run ${String(record.runId ?? record.run)} started; state: ${String(record.status)}.`;
  }
  return null;
}

/** The status line printed when tools ran but the model's final message carried no text. */
/**
 * The status line printed when tools ran but the model's final message carried no text. The tool
 * text is raw tool output, so the whole synthesised line goes through the one redaction table: a
 * bash result whose first line holds a key must not echo it to stdout (DE-124).
 */
function toolStatus(last: { name: string; text: string; failed: boolean } | null, startedName: string | null): string {
  if (last === null) return redact(`Tool ${startedName ?? "unknown"} did not finish before the session ended.`);
  const run = autonomyStart(last.text);
  if (run !== null) return redact(run);
  const detail = firstLine(last.text) || (last.failed ? "no error text" : "no output");
  return redact(`Tool ${last.name} ${last.failed ? "failed" : "finished"}: ${detail}`);
}

/** Reads pi's JSON event stream: progress lines for stderr and the final answer. */
export class EventReader {
  answer = "";
  failed = false;
  private rest = "";
  private sawTool = false;
  private startedTool: string | null = null;
  private lastTool: { name: string; text: string; failed: boolean } | null = null;
  private readonly progress: (line: string) => void;
  constructor(progress: (line: string) => void) {
    this.progress = progress;
  }

  push(chunk: string): void {
    this.rest += chunk;
    let at: number;
    while ((at = this.rest.indexOf("\n")) >= 0) {
      this.line(this.rest.slice(0, at).replace(/\r$/, ""));
      this.rest = this.rest.slice(at + 1);
    }
  }

  end(): void {
    if (this.rest.trim()) this.line(this.rest);
    this.rest = "";
    // A model can end a tool-using session with an empty message. Printing nothing made success
    // indistinguishable from silence, so report the last tool outcome instead (PG-41).
    if (!this.failed && this.answer.trim() === "" && this.sawTool) this.answer = toolStatus(this.lastTool, this.startedTool);
  }

  private line(raw: string): void {
    if (!raw.trim()) return;
    let event: unknown;
    try { event = parseJson(raw); } catch { return; }
    if (!isRecord(event)) return;
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
      this.sawTool = true;
      this.startedTool = event.toolName;
      this.progress(`luna: tool ${event.toolName}`);
    } else if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
      this.sawTool = true;
      this.lastTool = { name: event.toolName, text: toolResultText(event.result), failed: event.isError === true };
    } else if (event.type === "turn_end") this.progress("luna: turn finished");
    else if (event.type === "message_end") {
      const a = assistantText(event.message);
      if (a !== null) { this.answer = a.text; this.failed = a.failed; }
    }
  }
}

export interface RunOptions {
  /** The pi executable; "pi" looks it up on PATH. */
  piBin?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: { write(text: string): unknown };
  stderr?: { write(text: string): unknown };
  env?: NodeJS.ProcessEnv;
  /** Injected for tests: the platform and shim reader that decide how pi is started. */
  spawnDeps?: PiSpawnDeps;
  /** Injected for tests; defaults to `spawn`. */
  spawn?: typeof spawn;
  /** The directory whose project install (.pi/.pi-kit.json) counts; defaults to process.cwd(). */
  cwd?: string;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) text += String(chunk);
  return text;
}

/**
 * Whether the Luna install in force loads goal-core, the extension that enforces the ceiling, or why
 * that cannot be shown. The install is the project's when `<cwd>/.pi/.pi-kit.json` exists, else the
 * global one; its kit entry in settings.json is what pi loads, so a profile, an override, a user
 * profile or a hand edit that drops goal-core all count. A kit entry with no extension filter loads
 * everything. tests/luna-cli-smoke.ts pins it.
 */
export function goalCoreProblem(cwd: string, agentDir: string): string | null {
  const projectMarker = path.join(cwd, ".pi", ".pi-kit.json");
  const project = fs.existsSync(projectMarker);
  const markerFile = project ? projectMarker : path.join(agentDir, ".pi-kit.json");
  const settingsFile = project ? path.join(cwd, ".pi", "settings.json") : path.join(agentDir, "settings.json");
  const marker = readKitMarker(markerFile);
  if (!marker?.kitSource) return `no Luna install was found (${markerFile}), so nothing would enforce it`;
  let settings: ReturnType<typeof readSettings>;
  try { settings = readSettings(settingsFile); } catch { return `${settingsFile} cannot be read, so it cannot be shown that goal-core, which enforces it, is loaded`; }
  const at = findPackageEntry(settings, marker.kitSource, settingsFile);
  const entry = at >= 0 ? settings.packages?.[at] : undefined;
  if (entry === undefined) return `${settingsFile} has no Luna package entry, so goal-core, which enforces it, is not loaded`;
  if (typeof entry === "string" || entry.extensions === undefined) return null;
  const loaded = goalCoreSelected(entry.extensions);
  return loaded ? null : `the installed profile does not load goal-core, which enforces it (${settingsFile}); switch to a profile that loads it or drop the limits`;
}

/**
 * Whether pi's filter (package-manager.js applyPatterns: plain includes, then `!` excludes, then `+`
 * exact force-includes, then `-` exact force-excludes) leaves goal-core's entry file loaded. A pattern
 * with a glob character that could reach it cannot be decided without pi's matcher, so it counts
 * against: the answer is true only when goal-core is provably in the resolved set.
 */
export function goalCoreSelected(patterns: readonly string[]): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const glob = (p: string) => /[*?[\]{}]/.test(p);
  // A plain or `!` pattern also matches by base name (minimatch(name, pattern) in pi).
  const hits = (p: string) => /(?:^|\/)goal-core\/index\.(?:ts|js)$/.test(p) || /^index\.(?:ts|js)$/.test(p);
  const exact = (p: string) => /(?:^|\/)goal-core\/index\.(?:ts|js)$/.test(p);
  const of = (prefix: string) => patterns.filter((p) => p.startsWith(prefix)).map((p) => norm(p.slice(1)));
  const includes = patterns.filter((p) => !/^[!+-]/.test(p)).map(norm);
  let selected: boolean | "unknown" = includes.length === 0 ? true : includes.some(hits) ? true : includes.some(glob) ? "unknown" : false;
  const excludes = of("!");
  if (excludes.some(hits)) selected = false;
  else if (selected === true && excludes.some(glob)) selected = "unknown";
  if (of("+").some(exact)) selected = true;
  if (of("-").some(exact)) selected = false;
  return selected === true;
}

/** Run `luna exec`. Resolves to the process exit code. */
export async function runExec(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  const plan = planExec(argv);
  if (typeof plan === "string") {
    if (plan === "help") { out.write(`${EXEC_USAGE}\n`); return 0; }
    err.write(`luna exec: ${plan}\n${EXEC_USAGE}\n`);
    return 2;
  }
  // A ceiling from the flags or already in the environment (PI_KIT_CEILING_* set by the caller):
  // goal-core enforces both, so both need it loaded.
  const inherited = options.env ?? process.env;
  const ceilingRequested = Object.keys(plan.env).some((k) => k.startsWith("PI_KIT_CEILING_"))
    || Object.keys(inherited).some((k) => k.startsWith("PI_KIT_CEILING_") && (inherited[k] ?? "").trim() !== "");
  if (ceilingRequested && readOverrides(path.join(globalAgentDir(), "pi-kit", "overrides.json")).extensions.remove.includes("goal-core")) {
    err.write("luna exec: a ceiling was requested but overrides.json switches off goal-core, which enforces it; remove it from extensions.remove or drop the limits\n");
    return 2;
  }
  const unenforced = ceilingRequested ? goalCoreProblem(options.cwd ?? process.cwd(), globalAgentDir()) : null;
  if (unenforced) {
    err.write(`luna exec: a ceiling was requested but ${unenforced}\n`);
    return 2;
  }
  const args = [...plan.piArgs];
  if (plan.stdinPrompt) {
    const prompt = (await readAll(options.stdin ?? process.stdin)).trim();
    if (!prompt) { err.write("luna exec: the prompt read from stdin is empty\n"); return 2; }
    args.push("--", prompt);
  }
  const childEnv = { ...(options.env ?? process.env), ...plan.env };
  const how = piSpawnPlan(options.piBin ?? "pi", args, { env: childEnv, ...options.spawnDeps });
  if (typeof how === "string") { err.write(`luna exec: ${how}\n`); return 2; }
  const child = (options.spawn ?? spawn)(how.command, how.args, { stdio: ["ignore", "pipe", "inherit"], env: childEnv, windowsHide: true });
  const reader = new EventReader((line) => err.write(`${line}\n`));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { if (plan.json) out.write(chunk); else reader.push(chunk); });
  const code = await new Promise<number>((resolve) => {
    child.once("error", (e) => { err.write(`luna exec: could not start pi: ${e.message}\n`); resolve(127); });
    child.once("close", (status, signal) => resolve(status ?? (signal ? 128 : 1)));
  });
  if (plan.json) return code;
  reader.end();
  if (reader.answer) out.write(reader.answer.endsWith("\n") ? reader.answer : `${reader.answer}\n`);
  if (code === 0 && reader.failed) { err.write("luna exec: the run ended with an error before an answer\n"); return 1; }
  return code;
}

/** Extension names in overrides.json `extensions.remove` that the install marker still lists as loaded. */
export function pendingDisables(agentDir: string = globalAgentDir()): { profile: string; names: string[] } | null {
  const removed = readOverrides(path.join(agentDir, "pi-kit", "overrides.json")).extensions.remove;
  if (removed.length === 0) return null;
  let marker: unknown;
  try { marker = parseJson(fs.readFileSync(path.join(agentDir, ".pi-kit.json"), "utf8")); } catch { return null; }
  if (!isRecord(marker) || typeof marker.profile !== "string" || marker.scope === "project") return null;
  const loaded = Array.isArray(marker.extensions) ? marker.extensions : [];
  const names = removed.filter((name) => loaded.includes(name));
  return names.length > 0 ? { profile: marker.profile, names } : null;
}

/**
 * Honour overrides.json before pi loads: when an extension was switched off by hand, rewrite the kit's
 * settings entry with the installer's settings-only path (what /profile uses), so it is not loaded.
 * A failure is reported and the start goes on; the Doctor shows what is still loaded.
 */
export function applyPendingDisables(log: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): void {
  const pending = pendingDisables();
  if (pending === null) return;
  log(`luna: applying your overrides.json (off: ${pending.names.join(", ")})`);
  const installer = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "install.mjs");
  const r = spawnSync(process.execPath, [installer, "--profile", pending.profile, "--yes", "--settings-only", "--scope", "global", "--no-migrate"], { stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) log("luna: could not apply overrides.json; the extensions stay loaded (see the Doctor page in /menu)");
}
