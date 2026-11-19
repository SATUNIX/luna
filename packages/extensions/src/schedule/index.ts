import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `/schedule`: the pi side of `luna schedule` (packages/core/lib/schedule.ts). It runs the luna CLI
 * with an argument list (no shell) and shows what it printed.
 *
 *   /schedule list
 *   /schedule add <name> <when> -- <prompt>     e.g. /schedule add nightly daily 02:00 -- Summarise the open TODOs
 *   /schedule remove <name>
 *   /schedule run-now <name>
 *
 * `add` asks through pi's confirm dialog and refuses without a UI, and only then passes `--yes` to
 * the CLI. Inside a scheduled job (LUNA_SCHEDULE_JOB) only `list` works. It is a command, not a model
 * tool, and it is not registered in a subagent or internal child session. The CLI runs under a real
 * node binary: pi's own executable when it is node, otherwise `node` from PATH (a compiled pi is not
 * node). Pinned by tests/luna-cli-smoke.ts (tests/schedule-checks.ts).
 */

export type RunLuna = (args: readonly string[], cwd: string) => Promise<{ code: number; out: string }>;

/** A node binary for the luna CLI: this process when it is node, else `node` from PATH. */
export function nodeBinary(execPath: string = process.execPath): string {
  return /^node(?:\.exe)?$/i.test(path.basename(execPath)) ? execPath : "node";
}

const LUNA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "core", "luna.ts");

export const runLuna: RunLuna = (args, cwd) =>
  new Promise((resolve) => {
    execFile(nodeBinary(), [LUNA, "schedule", ...args], { cwd, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });

export const SCHEDULE_HELP = [
  "usage: /schedule list",
  "       /schedule add <name> <when> -- <prompt>",
  "       /schedule remove <name>",
  "       /schedule run-now <name>",
  "<when>: hourly | daily HH:MM | weekly <mon..sun> HH:MM | every Nm | every Nh",
].join("\n");

/** The luna CLI arguments for a /schedule line, or null for usage. */
export function scheduleArgs(line: string, cwd: string): { args: string[]; confirm?: string } | null {
  const trimmed = line.trim();
  const [verb = "", ...words] = trimmed.split(/\s+/);
  if (verb === "list") return words.length ? null : { args: ["list"] };
  if (verb === "remove" || verb === "run-now") return words.length === 1 ? { args: [verb, words[0] ?? ""] } : null;
  if (verb !== "add") return null;
  const sep = trimmed.indexOf(" -- ");
  if (sep < 0) return null;
  const head = trimmed.slice(0, sep).split(/\s+/).slice(1);
  const prompt = trimmed.slice(sep + 4).trim();
  const [name, ...when] = head;
  if (!name || when.length === 0 || !prompt) return null;
  return { args: ["add", name, "--at", when.join(" "), "--prompt", prompt, "--cwd", cwd], confirm: `Schedule ${name} (${when.join(" ")}) in ${cwd} to run luna exec "${prompt.slice(0, 120)}"?` };
}

export default function (pi: ExtensionAPI, run: RunLuna = runLuna) {
  if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_KIT_INTERNAL_CHILD === "1") return;
  pi.registerCommand("schedule", {
    description: "Scheduled Luna runs: list, add (asks first), remove, run-now (systemd user timers or crontab)",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd || process.cwd();
      const plan = scheduleArgs(typeof args === "string" ? args : "", cwd);
      if (!plan) { ctx.ui.notify(SCHEDULE_HELP, "info"); return; }
      if (process.env.LUNA_SCHEDULE_JOB && plan.args[0] !== "list") { ctx.ui.notify("This session is a scheduled job: it cannot add, remove or start schedules.", "warning"); return; }
      if (plan.confirm !== undefined) {
        // The operator decides: no UI, no schedule.
        if (!ctx.hasUI) { ctx.ui.notify("/schedule add needs the operator to confirm in the terminal; nothing was created.", "warning"); return; }
        const ok = await ctx.ui.confirm("Create a schedule", plan.confirm);
        if (!ok) { ctx.ui.notify("Not created.", "info"); return; }
        plan.args.push("--yes");
      }
      const r = await run(plan.args, cwd);
      ctx.ui.notify(r.out || (r.code === 0 ? "done" : `luna schedule exited ${r.code}`), r.code === 0 ? "info" : "warning");
    },
  });
}
