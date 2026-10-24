import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
// A compiled `pi` binary is its own process.execPath; only a JS runtime (node/bun/deno) needs
// the cli.js entry prepended. Prepending it unconditionally made a compiled pi read the script
// path as the child's first prompt (the WU-15 failure, fixed in subagent but copied here).
const PI_JS_RUNTIMES = new Set(["node", "nodejs", "bun", "deno"]);
function piChildArgv(cli: string, args: string[], execPath: string = process.execPath): string[] {
  const runtime = execPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "") ?? "";
  return PI_JS_RUNTIMES.has(runtime) ? [cli, ...args] : [...args];
}


const DUAL_REVIEW_MODEL = process.env.DUAL_REVIEW_MODEL ?? "";
const REVIEW_TIMEOUT_MS = 45000;

export default function (pi: ExtensionAPI, spawnChild: typeof spawn = spawn, runExecFile: typeof execFile = execFile) {
  let epoch = 0;
  const pending = new Set<() => void>();
  const invalidate = () => { epoch++; for (const stop of pending) stop(); };
  pi.on("input", async (event) => { if (event.source !== "extension") invalidate(); });
  pi.on("session_shutdown", async () => invalidate());
  pi.on("session_before_switch", async () => invalidate());
  if (!DUAL_REVIEW_MODEL) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "dual-review: DUAL_REVIEW_MODEL not set. Set it to a model name to enable second-model review. Extension loaded but /review will use the primary model.",
        "info",
      );
    });
  }

  // The reviewer reads the repository (and, given a prompt injection in the diff, could read anything the parent can),
  // so it runs under the parent's boundary like every other child: delegation-guard supplies the mandatory protections
  // (firewall, secret-guard, protected-paths), the child checks that they loaded and exits 78 otherwise, and the launch
  // is charged to the effort ledger. A launch the guard refuses, or a session without the guard, starts nothing.
  // `kind` is "user" for /review (the operator asked) and "discretionary" for the model-callable tool.
  function launchReviewer(diff: string, cwd: string, kind: "user" | "discretionary", signal?: AbortSignal): { ok: true } | { ok: false; reason: string } {
    if (signal?.aborted) return { ok: true };
    const guard = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-kit.delegation")] as { prepareChild(request: Record<string, unknown>): { ok: true; args: string[]; env: Record<string, string | undefined>; slot: { attach(pid: number | undefined): void; settle(outcome: string): void } } | { ok: false; reason: string } } | undefined;
    if (!guard) return { ok: false, reason: "the delegation-guard extension is not loaded, so the reviewer cannot be given the mandatory protections" };
    const prepared = guard.prepareChild({ cwd, kind, role: "reviewer", readOnly: true, baseEnv: { ...process.env } });
    if (!prepared.ok) return { ok: false, reason: prepared.reason };
    const reviewEpoch = epoch;
    const prompt = `You are a code reviewer. Review the following diff for correctness, security, and style. Be concise.\n\n${diff.slice(0, 8000)}`;
    const args = DUAL_REVIEW_MODEL
      ? ["--print", "--no-session", "--model", DUAL_REVIEW_MODEL]
      : ["--print", "--no-session"];
    const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    // A plain read-only model call: the guard's arguments load only the governance extensions (no formatters,
    // steering or memory), and the tools are the read-only four.
    const child = spawnChild(process.execPath, piChildArgv(cli, [...prepared.args, "--tools", "read,grep,find,ls", ...args]), { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...prepared.env, PI_KIT_INTERNAL_CHILD: "1" } });
    // The prompt (the diff) goes over stdin, which print mode reads as the prompt, never argv: argv
    // is readable by any local user through ps. An early exit's EPIPE is reported through close.
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
    prepared.slot.attach(child.pid);
    let out = "";
    let exited = false;
    let cancelled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (exited || cancelled) return;
      cancelled = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5000);
      escalation.unref();
    };
    pending.add(stop);
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => {
      stop();
      out += "\n[reviewer timed out after 45s]";
    }, REVIEW_TIMEOUT_MS);
    const collect = (d: Buffer) => { out += d.toString(); if (out.length > 100_000) { out = out.slice(0, 100_000) + "\n[review output limit reached]"; stop(); } };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const cleanup = () => {
      if (!exited) prepared.slot.settle(cancelled ? "cancelled" : "closed");
      exited = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      pending.delete(stop);
      signal?.removeEventListener("abort", stop);
    };
    // Report a result at most once. Our own stop() (timeout/output cap) is not cancellation:
    // only an external abort or an epoch bump suppresses the report. Guarding on `reported`
    // keeps a spawn `error` followed by `close` from sending twice.
    let reported = false;
    const report = (content: string) => {
      if (reported || signal?.aborted || epoch !== reviewEpoch) return;
      reported = true;
      cleanup();
      pi.sendMessage({ customType: "dual-review-result", content, display: true }, { triggerTurn: false });
    };
    child.once("error", (error: Error) => {
      cleanup();
      report(`## Code Review (failed)\n\nReviewer failed to start: ${error.message}`);
    });
    child.on("close", (code) => {
      cleanup();
      report(`## Code Review (${code === 0 ? "completed" : "failed"})\n\n${out.trim() || "(no output)"}`);
    });
    return { ok: true };
  }

  function getGitDiff(args: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const gitArgs = args.trim() ? ["diff", "--", args.trim()] : ["diff"];
      runExecFile("git", gitArgs, { cwd, shell: false, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
          return;
        }
        resolve(stdout);
      });
    });
  }

  pi.registerCommand("review", {
    description: "Spawn a reviewer agent on the current git diff. Optionally pass a path argument.",
    handler: async (args, ctx) => {
      ctx.ui.notify("dual-review: running git diff…", "info");
      let diff: string;
      try {
        diff = await getGitDiff(args, ctx.cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`dual-review: git diff failed: ${message}`, "error");
        return;
      }
      if (!diff.trim()) {
        ctx.ui.notify("dual-review: no diff to review.", "info");
        return;
      }
      const started = launchReviewer(diff, ctx.cwd, "user");
      if (!started.ok) {
        ctx.ui.notify(`dual-review: reviewer not started: ${started.reason}`, "error");
        return;
      }
      ctx.ui.notify("dual-review: reviewer launched. Result will follow.", "info");
    },
  });

  pi.registerTool({
    name: "dual_review",
    label: "Dual review",
    description: "Run a second-agent review on a diff or file. Returns immediately; review arrives as a displayed result without starting another turn.",
    parameters: Type.Object({
      content: Type.String({ description: "Diff or code to review" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const started = launchReviewer(params.content, ctx.cwd, "discretionary", signal);
      return {
        content: [{ type: "text" as const, text: started.ok ? "Review running… result will be displayed without starting another turn." : `Review not started: ${started.reason}` }],
        details: undefined,
      };
    },
  });
}
