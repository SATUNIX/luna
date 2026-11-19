import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./shared/redact.ts";

/**
 * A small herdr client behind the operator's `/herdr` command: list the agents, read one's recent
 * output, send one a prompt, and open a workspace. It runs the `herdr` CLI found on PATH, with an
 * argument array (no shell) and a timeout.
 *
 * It never answers another agent's dialog: `send` asks herdr for the target's state first and
 * refuses a `blocked` agent (one waiting on an approval or a question), and herdr itself rejects a
 * prompt to a blocked agent (`agent_blocked`). It never changes focus: `spawn` always passes
 * `--no-focus`, and there is no focus, keys or attach command. It is an operator command, not a
 * model tool. Pinned by tests/herdr-client-smoke.ts against a fake `herdr` on PATH.
 */

export type HerdrRun = (args: readonly string[]) => Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 1024 * 1024;
export const READ_LINES_DEFAULT = 40;
export const READ_LINES_MAX = 200;
export const READ_CHARS_MAX = 8000;
export const PROMPT_CHARS_MAX = 4000;
/** An agent or pane target: a name or herdr id, never something the CLI could read as an option. */
const TARGET = /^[A-Za-z0-9_][A-Za-z0-9:_.-]{0,63}$/;
const LABEL = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,59}$/;
const CONTROL = /(?![\n\t])\p{Cc}/gu;

/** Drop terminal escape sequences (CSI `ESC [ ... final`, OSC `ESC ] ... BEL or ESC \\`, and two-byte `ESC x`). One linear pass. */
export function stripEscapes(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 27) { out += text.charAt(i); continue; }
    const next = text[i + 1];
    if (next === "[") {
      i += 2;
      while (i < text.length && !(text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e)) i++;
    } else if (next === "]") {
      i += 2;
      while (i < text.length && text.charCodeAt(i) !== 7 && !(text.charCodeAt(i) === 27 && text[i + 1] === "\\")) i++;
      if (text.charCodeAt(i) === 27) i++;
    } else i++;
  }
  return out;
}

export const runHerdrCli: HerdrRun = (args) =>
  new Promise((resolve) => {
    execFile("herdr", [...args], { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout, stderr) => {
      if (error && !stdout) {
        const code = (error as NodeJS.ErrnoException).code;
        resolve({ ok: false, error: code === "ENOENT" ? "herdr is not installed or not on PATH" : `herdr failed: ${clean(stderr || error.message).slice(0, 300)}` });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });

const clean = (text: string): string => redact(stripEscapes(text).replace(CONTROL, ""));

/** The `result` of a herdr JSON answer, or the error it reports. */
function parseAnswer(stdout: string): { ok: true; result: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return { ok: false, error: "herdr answered with something other than JSON" }; }
  const rec = isRecord(parsed) ? parsed : {};
  if (isRecord(rec.error)) return { ok: false, error: `${str(rec.error.code) || "error"}: ${clean(str(rec.error.message))}`.slice(0, 300) };
  return isRecord(rec.result) ? { ok: true, result: rec.result } : { ok: false, error: "herdr answered without a result" };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

async function json(run: HerdrRun, args: readonly string[]): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }> {
  const r = await run(args);
  return r.ok ? parseAnswer(r.stdout) : r;
}

export async function listAgents(run: HerdrRun): Promise<string> {
  const r = await json(run, ["agent", "list"]);
  if (!r.ok) return `herdr: ${r.error}`;
  const agents = Array.isArray(r.result.agents) ? r.result.agents.filter(isRecord) : [];
  if (agents.length === 0) return "herdr: no agents";
  return ["herdr agents (name or pane, agent, state, directory):", ...agents.map((a) => `  ${clean(str(a.name) || str(a.pane_id))}  ${clean(str(a.agent))}  ${clean(str(a.agent_status) || "unknown")}  ${clean(str(a.cwd))}`)].join("\n");
}

export async function readAgent(run: HerdrRun, target: string, lines: number): Promise<string> {
  const r = await run(["agent", "read", target, "--source", "recent", "--lines", String(lines)]);
  if (!r.ok) return `herdr: ${r.error}`;
  if (r.stdout.trimStart().startsWith("{")) {
    const answer = parseAnswer(r.stdout);
    if (!answer.ok) return `herdr: ${answer.error}`;
  }
  const text = clean(r.stdout).trimEnd();
  const cut = text.length > READ_CHARS_MAX ? `[… ${text.length - READ_CHARS_MAX} earlier characters]\n${text.slice(-READ_CHARS_MAX)}` : text;
  return `herdr: last ${lines} lines of ${target}:\n${cut || "(empty)"}`;
}

export async function sendPrompt(run: HerdrRun, target: string, text: string): Promise<string> {
  const got = await json(run, ["agent", "get", target]);
  if (!got.ok) return `herdr: ${got.error}`;
  const agent = isRecord(got.result.agent) ? got.result.agent : {};
  const state = str(agent.agent_status);
  if (state === "blocked") return `herdr: ${target} is waiting on a dialog (blocked); Luna never answers another agent's dialog. Nothing was sent.`;
  const sent = await json(run, ["agent", "prompt", target, text]);
  if (!sent.ok) return `herdr: ${sent.error}. Nothing was sent.`;
  return `herdr: sent ${text.length} characters to ${target} (it was ${state || "unknown"}).`;
}

export async function spawnWorkspace(run: HerdrRun, label: string, cwd: string): Promise<string> {
  const r = await json(run, ["workspace", "create", "--no-focus", "--label", label, "--cwd", cwd]);
  if (!r.ok) return `herdr: ${r.error}`;
  const ws = isRecord(r.result.workspace) ? r.result.workspace : r.result;
  const id = str(ws.workspace_id);
  return `herdr: opened workspace ${label}${id ? ` (${id})` : ""} in ${cwd}, without focusing it.`;
}

export const HERDR_USAGE = [
  "usage: /herdr list",
  "       /herdr read <agent> [lines]   (1-200, default 40)",
  "       /herdr send <agent> <text>    (refused while the agent is blocked on a dialog)",
  "       /herdr spawn <label> [dir]    (opens a workspace without focusing it)",
].join("\n");

/** Run one `/herdr` command line. `cwd` is the default directory for `spawn`. */
export async function herdrCommand(args: string, cwd: string, run: HerdrRun = runHerdrCli): Promise<string> {
  const trimmed = args.trim();
  const [verb = "", ...rest] = trimmed.split(/\s+/);
  const target = rest[0] ?? "";
  switch (verb) {
    case "list":
      return rest.length ? HERDR_USAGE : listAgents(run);
    case "read": {
      if (!TARGET.test(target) || rest.length > 2) return HERDR_USAGE;
      const lines = rest[1] === undefined ? READ_LINES_DEFAULT : Number(rest[1]);
      if (!Number.isInteger(lines) || lines < 1 || lines > READ_LINES_MAX) return HERDR_USAGE;
      return readAgent(run, target, lines);
    }
    case "send": {
      if (!TARGET.test(target)) return HERDR_USAGE;
      // The text is everything after the target, as typed.
      const text = trimmed.slice(trimmed.indexOf(target, verb.length) + target.length).trim();
      if (!text) return HERDR_USAGE;
      if (text.length > PROMPT_CHARS_MAX) return `herdr: the prompt is ${text.length} characters; the limit is ${PROMPT_CHARS_MAX}. Nothing was sent.`;
      if (/(?![\n\t])\p{Cc}/u.test(text)) return "herdr: the prompt has control characters. Nothing was sent.";
      return sendPrompt(run, target, text);
    }
    case "spawn": {
      if (!LABEL.test(target) || rest.length > 2) return HERDR_USAGE;
      const dir = path.resolve(cwd, rest[1] ?? ".");
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { /* reported below */ }
      if (!isDir) return `herdr: ${dir} is not a directory.`;
      return spawnWorkspace(run, target, dir);
    }
    default:
      return HERDR_USAGE;
  }
}
