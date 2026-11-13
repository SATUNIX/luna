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
import { globalAgentDir } from "./settings.ts";
import { readOverrides } from "./profiles.ts";
import { parseDuration } from "../shared/ceiling.ts";
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
  const stdinPrompt = prompt === "-";
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

/** Reads pi's JSON event stream: progress lines for stderr and the final answer. */
export class EventReader {
  answer = "";
  failed = false;
  private rest = "";
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
  }

  private line(raw: string): void {
    if (!raw.trim()) return;
    let event: unknown;
    try { event = parseJson(raw); } catch { return; }
    if (!isRecord(event)) return;
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") this.progress(`luna: tool ${event.toolName}`);
    else if (event.type === "turn_end") this.progress("luna: turn finished");
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
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) text += String(chunk);
  return text;
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
  const ceilingRequested = Object.keys(plan.env).some((k) => k.startsWith("PI_KIT_CEILING_"));
  if (ceilingRequested && readOverrides(path.join(globalAgentDir(), "pi-kit", "overrides.json")).extensions.remove.includes("goal-core")) {
    err.write("luna exec: a ceiling was requested but overrides.json switches off goal-core, which enforces it; remove it from extensions.remove or drop the limits\n");
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
