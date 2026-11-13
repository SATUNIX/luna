import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseDuration } from "./shared/ceiling.ts";

// /away: a bounded walk-away. It is automatic approvals plus a ceiling (turns, money, wall time, the
// object in shared by goal-core's ceiling guard, sent over the `luna:ceiling` bus channel), and it
// answers "an action needs a card" with a refusal that carries the reason, since nobody is there to
// answer. When the ceiling is reached goal-core parks the run and announces `luna:parked`, which ends
// away mode here. There is no queue, no approve-and-retry and no webhook: the operator comes back to
// a parked run, its outcome and whatever was refused.
//
// Like turning on /auto, it lowers oversight, so it is chosen at the terminal of an interactive root
// session and refused under strict security, which pins approvals to the operator.

export interface AwayDeps {
  atRootTerminal: (ctx: ExtensionContext) => boolean;
  choose: (ui: ExtensionUIContext, title: string, keep: string, change: string, timeout: number) => Promise<boolean>;
  say: (ctx: ExtensionContext, text: string, level?: "info" | "warning" | "error") => void;
  strict: (ctx: ExtensionContext) => boolean;
  timeoutMs: () => number;
  now?: () => number;
}

export const DEFAULT_AWAY_SECONDS = 2 * 3600;
const HELP = "/away [--for 2h] [--budget 5] | off | status. Automatic approvals for a bounded time and budget; anything that would need your approval is refused with the reason. Needs the terminal of an interactive session.";

export interface AwayRequest { seconds: number; costUsd?: number }

/** The request in `/away` arguments, or the reason it cannot be read. */
export function parseAway(args: string): AwayRequest | { error: string } {
  const words = args.trim().split(/\s+/).filter(Boolean);
  let seconds = DEFAULT_AWAY_SECONDS;
  let costUsd: number | undefined;
  for (let i = 0; i < words.length; i++) {
    const flag = words[i];
    const value = words[i + 1];
    if (flag === "--for" || flag === "--budget") {
      if (value === undefined) return { error: `${flag} needs a value` };
      if (flag === "--for") {
        const s = parseDuration(value);
        if (s === undefined) return { error: `--for ${value}: use a time such as 90m, 2h or 1h30m` };
        seconds = s;
      } else {
        const n = Number(value.replace(/^\$/, ""));
        if (!Number.isFinite(n) || n <= 0) return { error: `--budget ${value}: use a number of dollars, such as 5` };
        costUsd = n;
      }
      i++;
    } else return { error: `unknown argument ${flag ?? ""}` };
  }
  return { seconds, ...(costUsd !== undefined ? { costUsd } : {}) };
}

export interface Away {
  /** True while away mode is on and its time has not run out. */
  active(): boolean;
  /** Why a card was refused, for the message the agent sees. */
  reason(): string;
}

export function registerAway(pi: ExtensionAPI, deps: AwayDeps): Away {
  const now = deps.now ?? Date.now;
  let until = 0;
  const active = (): boolean => until > now();

  // A host without an event bus cannot park /away, but must still load.
  try { pi.events?.on("luna:parked", () => { until = 0; }); } catch { /* no bus */ }

  pi.registerCommand("away", {
    description: HELP,
    getArgumentCompletions: (prefix: string) => ["--for", "--budget", "off", "status"].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "status" || arg === "help") {
        deps.say(ctx, active() ? `away: on for another ${Math.max(1, Math.round((until - now()) / 60_000))} minute(s). Approvals are automatic; anything needing a card is refused.` : `away: off. ${HELP}`);
        return;
      }
      if (arg === "off") {
        until = 0;
        try { pi.events?.emit("luna:ceiling", { clear: true }); } catch { /* observers only */ }
        deps.say(ctx, "away: off.");
        return;
      }
      const request = parseAway(args);
      if ("error" in request) { deps.say(ctx, `away: ${request.error}. ${HELP}`, "warning"); return; }
      if (deps.strict(ctx)) { deps.say(ctx, "away: refused: strict security pins approvals to the operator. Use /security to change the level.", "warning"); return; }
      if (!deps.atRootTerminal(ctx)) { deps.say(ctx, "away: needs a choice at the terminal of an interactive root session; refused in headless, RPC and delegated sessions. A scripted run sets PI_KIT_AUTO_MODE=1 and PI_KIT_CEILING_SECONDS, PI_KIT_CEILING_USD or PI_KIT_CEILING_TURNS.", "warning"); return; }
      // The ceiling is enforced by goal-core, not here. With goal-core switched off the budget would never
      // be enforced while /away still approved everything, so refuse rather than promise a limit.
      let enforced = false;
      try { pi.events?.emit("luna:ceiling-probe", { ack: () => { enforced = true; } }); } catch { /* no bus: nothing enforces */ }
      if (!enforced) { deps.say(ctx, "away: refused: nothing enforces the time and budget limit because goal-core is switched off (overrides.json extensions.remove). Enable goal-core, or stay and keep approving.", "warning"); return; }
      const hours = (request.seconds / 3600).toFixed(request.seconds % 3600 === 0 ? 0 : 1);
      if (!await deps.choose(ctx.ui, `Go away for ${hours}h${request.costUsd !== undefined ? ` with $${request.costUsd} to spend` : ""}? Tool calls will be approved automatically; anything needing your approval is refused. Subagent spend is not counted against the budget.`, "stay and keep asking", "go away", deps.timeoutMs())) {
        deps.say(ctx, "away: unchanged.");
        return;
      }
      until = now() + request.seconds * 1000;
      try { pi.events?.emit("luna:ceiling", { seconds: request.seconds, ...(request.costUsd !== undefined ? { costUsd: request.costUsd } : {}) }); } catch { /* observers only */ }
      deps.say(ctx, `away: on for ${hours}h${request.costUsd !== undefined ? `, up to $${request.costUsd}` : ""}. The run parks at the first limit. /away off to come back.`);
    },
  });

  return { active, reason: () => "the operator is away (/away), so nothing can approve it" };
}
