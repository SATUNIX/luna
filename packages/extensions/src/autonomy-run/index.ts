import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeRuntime } from "./shared/node-runtime.ts";

// Self-containment rule: only node:* builtins, the pi peer and the generated ./shared/ copy. The extension does not import the
// autonomy package: it runs its operator CLI (packages/autonomy/cli.ts) as a child process and
// speaks its `--json` protocol, exactly as an operator at a shell would.
//
// /autonomy is the operator's way to start and manage autonomous runs from inside pi. It is a
// COMMAND, not a tool: the model has no tool that starts, steers, authorises or promotes a run,
// because an autonomous run spends money and acts without prompts inside its boundary, and only a
// person may decide that. Every decision that matters is confirmed on screen with the boundary in
// front of the person, and without a screen the CLI's own rule applies: a run starts only from a
// contract that already carries an authorisation for exactly this boundary.
//
// What this does not prevent: a model with a shell tool can run the same CLI itself, and the CLI's
// `--yes` is consent by whoever holds the terminal. The tool firewall therefore classifies the CLI's
// control commands (start, plan --authorise, promote, resume, reconfigure, ...) as high and never
// learned (each one asks the operator, and an unattended worker is refused). That is a guard rail:
// the authorisation record is a consent and integrity record, not a signature (docs/autonomy.md).

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The CLI's JSON is outside data: `unknown` until these guards narrow it.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** A field of a JSON value that may not be an object (a primitive or null reads as undefined). */
function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function cliPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_AUTONOMY_CLI?.trim();
  return override || path.resolve(HERE, "..", "..", "..", "autonomy", "cli.ts");
}

export interface CliResult {
  code: number | null;
  /** The parsed `--json` object, or null when the CLI printed none. */
  json: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI once. Always resolves (a missing CLI or a crash is a result, not an exception). */
export function runCli(args: string[], { json = true, cwd, timeoutMs = 120_000, env = process.env }: { json?: boolean; cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<CliResult> {
  const cli = cliPath(env);
  return new Promise((resolve) => {
    if (!fs.existsSync(cli)) {
      resolve({ code: null, json: null, stdout: "", stderr: `the autonomy CLI is not installed at ${cli} (a git install of the kit includes packages/autonomy; the npm package does not ship the runner)` });
      return;
    }
    // The CLI is a Node script. Under a compiled pi, process.execPath is pi itself, and
    // `pi cli.ts list` would run an agent turn with the path as its prompt (./shared/node-runtime.ts).
    const runtime = nodeRuntime({ env });
    if (!runtime.ok) {
      resolve({ code: null, json: null, stdout: "", stderr: `the autonomy CLI needs Node.js to run: ${runtime.reason}` });
      return;
    }
    const child = spawn(runtime.command, [cli, ...args, ...(json ? ["--json"] : [])], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let parsed: Record<string, unknown> | null = null;
      if (json) {
        try {
          const value: unknown = JSON.parse(stdout);
          if (isRecord(value) && !Array.isArray(value)) parsed = value;
        } catch { /* the CLI printed no JSON object */ }
      }
      resolve({ code, json: parsed, stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); stderr += `\ntimed out after ${timeoutMs / 1000}s`; finish(null); }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); if (stdout.length > 8_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000); });
    child.on("error", (error) => { stderr += `\n${error.message}`; finish(null); });
    child.on("close", (code) => finish(code));
  });
}

/** Split a command line into words, honouring single and double quotes. No shell is involved anywhere. */
export function splitArgs(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) { words.push(current); current = ""; started = false; }
    } else current += ch;
  }
  if (started || current) words.push(current);
  return words;
}

const RUN_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;

const USAGE = [
  "Autonomous runs: /autonomy <command>",
  "  templates                              what kinds of run exist",
  "  init <template> [flags]                write a run contract (flags as `pi-autonomy init`), e.g. --out run.json --spec \"...\" --check unit=\"npm test\"",
  "  plan <run.json>                        validate it and show the boundary and its digest",
  "  start <run.json> [--foreground]        show the boundary, ask you to confirm it, then start (in the background unless --foreground)",
  "  status [run]                           one run, or all of them; for one run with generations, also the footer status line",
  "  pause <run> | cancel <run>             stop a run's worker (the work is kept)",
  "  resume <run> [answer text | --approve | --deny]",
  "  steer <run> <message>                  send the worker one message",
  "  promote <run>                          carry out an approval-gated promotion",
  "  export <run> [dir]                     results, evidence, usage, decisions and the work",
  "  boundary <run.json> | boundary --run <run>",
  "  reconfigure <run> [--effort E4 --budget-usd n ...]   the only way effort or budgets change for a run",
  "Nothing starts without you confirming the boundary. Runs need a container engine; see docs/autonomy.md.",
].join("\n");

function say(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else process.stderr.write(`[autonomy] ${text}\n`);
}

const problemLine = (p: unknown): string => {
  const level: unknown = field(p, "level") ?? "error";
  const where: unknown = field(p, "path") ?? "";
  const message: unknown = field(p, "message") ?? p;
  return `  ${String(level)} ${String(where)}: ${String(message)}`;
};

const errorText = (r: CliResult): string => {
  const j = r.json;
  if (j?.ok === false) {
    const problems = isArray(j.problems) ? `\n${j.problems.map(problemLine).join("\n")}` : "";
    const error: unknown = j.error ?? "the command failed";
    return `${String(error)}${problems}`;
  }
  return (r.stderr || r.stdout || "the command failed").trim().slice(0, 4000);
};

const templateLine = (t: unknown): string => {
  const requires = field(t, "requires") ?? [];
  return `${String(field(t, "id"))} (${field(t, "finite") ? "finite" : "cycling"}): ${String(field(t, "title"))}\n  ${String(field(t, "summary"))}\n  needs: ${(isArray(requires) ? requires : []).join("; ")}`;
};

/** The footer key the generations status line is shown under. */
export const STATUS_KEY = "autonomy";

const ROTATION_BOX: Record<string, string> = { minutes: "time box", usd: "dollar box" };

/**
 * The footer status line for one run's `status --json` report: its generation n/N, the run's status
 * and why the last generation rotated. Undefined (the line is cleared) when the report is not a run
 * with generations (Memento mode) enabled. The report is the CLI's JSON, so every field is narrowed.
 */
export function generationStatusLine(report: unknown): string | undefined {
  const g = field(report, "generations");
  if (!isRecord(g)) return undefined;
  const run = field(report, "run");
  const status = field(report, "status");
  const current = field(g, "current");
  const max = field(g, "max");
  if (typeof run !== "string" || !RUN_ID.test(run) || typeof max !== "number") return undefined;
  const gen = typeof current === "number" && current > 0 ? `gen ${current}/${max}` : `gen -/${max}`;
  const last = field(g, "lastRotation");
  const box = field(last, "box");
  const why = isRecord(last) ? `; last rotation: ${typeof box === "string" && Object.hasOwn(ROTATION_BOX, box) ? ROTATION_BOX[box] : "box"}${field(last, "notebook") === true ? "" : ", no notebook"}` : "";
  return `memento ${run}: ${gen}${typeof status === "string" && /^[a-z_]{1,32}$/.test(status) ? `, ${status}` : ""}${why}`;
}

export default function autonomyRun(pi: ExtensionAPI) {
  const resolveFile = (ctx: ExtensionCommandContext, file: string): string => path.resolve(ctx.cwd ?? process.cwd(), file);

  async function show(ctx: ExtensionCommandContext, args: string[]): Promise<CliResult> {
    const r = await runCli(args, { json: false, cwd: ctx.cwd });
    say(ctx, (r.stdout || r.stderr).trim() || "(no output)", r.code === 0 ? "info" : "error");
    return r;
  }

  /** Run a command through the CLI's JSON protocol, and report its text output or its failure. */
  async function run(ctx: ExtensionCommandContext, args: string[]): Promise<CliResult> {
    const text = await runCli(args, { json: false, cwd: ctx.cwd });
    say(ctx, (text.stdout || text.stderr).trim() || "(no output)", text.code === 0 ? "info" : "error");
    return text;
  }

  async function start(ctx: ExtensionCommandContext, words: string[]): Promise<void> {
    const foreground = words.includes("--foreground");
    const file = words.find((w) => !w.startsWith("--"));
    if (!file) { say(ctx, "usage: /autonomy start <run.json> [--foreground]", "error"); return; }
    const config = resolveFile(ctx, file);
    const planned = await runCli(["plan", "--config", config], { cwd: ctx.cwd });
    if (planned.json?.ok !== true) { say(ctx, `cannot start: ${errorText(planned)}`, "error"); return; }
    const plan = planned.json;
    const text = await runCli(["plan", "--config", config], { json: false, cwd: ctx.cwd });
    const boundary = (text.stdout || "").trim();
    const planDigest: unknown = plan.digest ?? "";
    const digest = String(planDigest);
    // The text on screen and the digest that will be authorised come from two reads of the file: they must agree.
    if (!/^[a-f0-9]{64}$/.test(digest) || new RegExp(`^digest ${digest}$`, "m").exec(boundary) === null) { say(ctx, `not started: ${file} changed while its boundary was being read. Run /autonomy plan ${file} and try again.`, "error"); return; }
    const detach = !foreground;

    if (ctx.hasUI) {
      const who = os.userInfo().username;
      const ok = await ctx.ui.confirm(
        `Authorise this boundary and start run ${String(plan.run)}?`,
        `${boundary}\n\nThis run acts without approval prompts inside the boundary above and spends money up to its budget. Only you can authorise it (digest ${digest.slice(0, 12)}).`,
      );
      if (!ok) { say(ctx, "Not authorised. Nothing was started.", "info"); return; }
      if (field(plan.authorisation, "status") !== "authorised") {
        // --digest: authorise exactly the boundary that was on screen, even if the file changed since.
        const auth = await runCli(["plan", "--config", config, "--authorise", "--yes", "--by", who, "--digest", digest], { cwd: ctx.cwd });
        if (auth.json?.ok !== true) { say(ctx, `could not record the authorisation: ${errorText(auth)}`, "error"); return; }
      }
    } else if (field(plan.authorisation, "status") !== "authorised") {
      say(ctx, `not started: there is no screen to confirm the boundary on, and ${file} does not carry an authorisation for it (digest ${digest.slice(0, 12)}). Authorise it once at a terminal with \`pi-autonomy plan --config ${file} --authorise\`.`, "error");
      return;
    }

    const started = await runCli(["start", "--config", config, "--yes", ...(detach ? ["--detach"] : [])], { cwd: ctx.cwd, timeoutMs: detach ? 120_000 : 24 * 60 * 60 * 1000 });
    if (started.json?.ok !== true) { say(ctx, `not started: ${errorText(started)}`, "error"); return; }
    const s = started.json;
    const run = String(s.run);
    say(ctx, detach
      ? `Run ${run} started (supervisor pid ${String(s.pid)}). Follow it with /autonomy status ${run}; results with /autonomy export ${run}. Logs: ${String(s.log)}`
      : `Run ${run} ended: ${String(s.status)}${s.outcome ? ` (${String(field(s.outcome, "reason"))})` : ""}. Results: /autonomy export ${run}`);
  }

  /** Commands that change a run and first show the CLI's own account of what would change, then ask. */
  async function confirmed(ctx: ExtensionCommandContext, args: string[], title: string): Promise<void> {
    const first = await runCli(args, { cwd: ctx.cwd });
    const json = first.json;
    if (json?.ok === true) { say(ctx, (await runCli(args, { json: false, cwd: ctx.cwd })).stdout.trim() || "done"); return; }
    // A refusal that says it needs approval carries the description of what would happen.
    const error: unknown = json?.error ?? "";
    const needs = json?.ok === false && json.code === "refused" && /needs your (approval|confirmation)|--yes/.test(String(error));
    if (!needs) { say(ctx, errorText(first), "error"); return; }
    if (!ctx.hasUI) { say(ctx, `${errorText(first)}\n(no screen to confirm on; run the command at a terminal)`, "error"); return; }
    const ok = await ctx.ui.confirm(title, String(json.error));
    if (!ok) { say(ctx, "Not confirmed. Nothing changed.", "info"); return; }
    const done = await runCli([...args, "--yes"], { json: false, cwd: ctx.cwd });
    say(ctx, (done.stdout || done.stderr).trim() || "done", done.code === 0 ? "info" : "error");
  }

  pi.registerCommand("autonomy", {
    description: "Start and manage autonomous runs in a hardened container: /autonomy templates|init|plan|start|status|pause|resume|steer|cancel|promote|export|boundary|reconfigure. A run only starts after you confirm its boundary.",
    getArgumentCompletions: (prefix: string) =>
      ["templates", "init", "plan", "start", "status", "pause", "resume", "steer", "cancel", "promote", "export", "boundary", "reconfigure", "help"]
        .filter((v) => v.startsWith(prefix.trim().toLowerCase()))
        .map((v) => ({ value: v, label: v })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const words = splitArgs(args);
      const cmd = (words.shift() ?? "help").toLowerCase();
      const runId = (): string | null => {
        const id = words[0];
        if (!id || !RUN_ID.test(id)) { say(ctx, `usage: /autonomy ${cmd} <run>  (a run id such as todo-api-1; \`/autonomy status\` lists them)`, "error"); return null; }
        return id;
      };
      switch (cmd) {
        case "help":
        case "?":
          say(ctx, USAGE);
          return;
        case "templates": {
          const r = await runCli(["templates"], { cwd: ctx.cwd });
          const templates = r.json?.ok === true ? r.json.templates : undefined;
          if (!isArray(templates)) { say(ctx, errorText(r), "error"); return; }
          say(ctx, templates.map(templateLine).join("\n\n"));
          return;
        }
        case "init": {
          const template = words.shift();
          if (!template || template.startsWith("-")) { say(ctx, "usage: /autonomy init <template> [--out run.json] [--spec \"...\"] [--check id=command] ...  (see /autonomy templates)", "error"); return; }
          const out = words.includes("--out") ? [] : ["--out", "run.json"];
          const r = await runCli(["init", "--template", template, ...out, ...words], { cwd: ctx.cwd });
          if (r.json?.ok !== true) { say(ctx, `init failed: ${errorText(r)}`, "error"); return; }
          const problems = isArray(r.json.problems) ? r.json.problems : [];
          say(ctx, `Wrote ${String(r.json.path)}${problems.length ? `\n${problems.map((p) => `  ${String(field(p, "level"))} ${String(field(p, "path"))}: ${String(field(p, "message"))}`).join("\n")}` : ""}\nNext: /autonomy plan ${path.basename(String(r.json.path))}`);
          return;
        }
        case "plan": {
          if (!words[0]) { say(ctx, "usage: /autonomy plan <run.json>", "error"); return; }
          await show(ctx, ["plan", "--config", resolveFile(ctx, words[0])]);
          return;
        }
        case "boundary": {
          if (words[0] === "--run" && words[1]) { await show(ctx, ["boundary", "--run", words[1]]); return; }
          if (!words[0]) { say(ctx, "usage: /autonomy boundary <run.json> | boundary --run <run>", "error"); return; }
          await show(ctx, ["boundary", "--config", resolveFile(ctx, words[0])]);
          return;
        }
        case "start":
          return start(ctx, words);
        case "status": {
          if (words[0] && !RUN_ID.test(words[0])) { say(ctx, "usage: /autonomy status [run]", "error"); return; }
          await run(ctx, ["status", ...(words[0] ? ["--run", words[0]] : [])]);
          // One run: its generations, if any, become the footer status line (cleared otherwise).
          if (words[0] && ctx.hasUI) {
            const report = await runCli(["status", "--run", words[0]], { cwd: ctx.cwd });
            ctx.ui.setStatus(STATUS_KEY, report.json?.ok === true ? generationStatusLine(report.json) : undefined);
          }
          return;
        }
        case "pause": {
          const id = runId();
          if (id) await run(ctx, ["pause", "--run", id]);
          return;
        }
        case "cancel": {
          const id = runId();
          if (!id) return;
          if (ctx.hasUI && !(await ctx.ui.confirm(`Cancel run ${id}?`, "The worker is stopped and the run ends as cancelled. The work is kept and can still be exported."))) { say(ctx, "Not cancelled."); return; }
          await run(ctx, ["cancel", "--run", id]);
          return;
        }
        case "resume": {
          const id = runId();
          if (!id) return;
          const rest = words.slice(1);
          const approve = rest.includes("--approve");
          const deny = rest.includes("--deny");
          const answer = rest.filter((w) => w !== "--approve" && w !== "--deny").join(" ").trim();
          if (approve && ctx.hasUI && !(await ctx.ui.confirm(`Approve for run ${id}?`, "You are answering the run's pending approval with yes. Check `/autonomy status` for what it is asking."))) { say(ctx, "Not approved."); return; }
          if (approve && !ctx.hasUI) { say(ctx, "approving a run's request needs a screen to confirm on", "error"); return; }
          await run(ctx, ["resume", "--run", id, "--detach", ...(approve ? ["--approve"] : []), ...(deny ? ["--deny"] : []), ...(answer ? ["--answer", answer] : [])]);
          return;
        }
        case "steer": {
          const id = runId();
          if (!id) return;
          const message = words.slice(1).join(" ").trim();
          if (!message) { say(ctx, "usage: /autonomy steer <run> <message>", "error"); return; }
          await run(ctx, ["steer", "--run", id, "--message", message]);
          return;
        }
        case "promote": {
          const id = runId();
          if (id) await confirmed(ctx, ["promote", "--run", id], `Promote the result of run ${id}?`);
          return;
        }
        case "export": {
          const id = runId();
          if (!id) return;
          await run(ctx, ["export", "--run", id, ...(words[1] ? ["--out", resolveFile(ctx, words[1])] : [])]);
          return;
        }
        case "reconfigure": {
          const id = runId();
          if (id) await confirmed(ctx, ["reconfigure", "--run", id, ...words.slice(1)], `Change run ${id}'s limits?`);
          return;
        }
        default:
          say(ctx, `unknown command "${cmd}".\n${USAGE}`, "error");
          return;
      }
    },
  });
}
