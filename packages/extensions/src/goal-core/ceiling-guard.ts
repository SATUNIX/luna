import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ceilingBreach, ceilingEnvProblems, ceilingFromEnv, describeBreach, isEmptyCeiling, normaliseCeiling, type Ceiling } from "./shared/ceiling.ts";

// The unattended ceiling and its notification. A scripted run sets PI_KIT_CEILING_TURNS,
// PI_KIT_CEILING_USD and PI_KIT_CEILING_SECONDS; `/away` (tool-firewall) sends the same object on
// the `luna:ceiling` bus channel. The first limit reached parks the run: the turn is aborted, further
// tool calls are refused, `luna:parked` tells the listeners (herdr, `/away`) and a headless run exits
// with code 13, the code `pi-autonomy` uses for a parked run. The environment ceiling is a floor:
// a ceiling from the bus (`/away`) is checked beside it, from its own arming time, so it can only
// tighten the run, and `/away off` drops only the bus part. Spend is what the provider reported
// for this session's own requests; a kit child's spend is not counted here.
//
// Notification is a terminal bell plus OSC 9, only when a person is likely away: an approval card
// still open after 60 seconds, a run of 60 seconds or longer ending, and a park.

const NOTIFY_AFTER_MS = 60_000;
export const PARKED_EXIT_CODE = 13;

/** The bell and the OSC 9 desktop notification, written only to a real terminal. */
export function ring(message: string, out: { isTTY?: boolean; write(text: string): unknown } = process.stdout): void {
  if (!out.isTTY) return;
  const text = message.replace(/\p{Cc}/gu, " ").slice(0, 120);
  try { out.write(`\x1b]9;${text}\x07\x07`); } catch { /* a notification is never worth a failure */ }
}

export interface GuardOptions {
  now?: () => number;
  ring?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  /** How long a card or a run must last before it rings (default 60 seconds). */
  notifyAfterMs?: number;
}

/** True when a turn_end carries an assistant message that asked for no tool and stopped normally. Anything unclear is not final. */
function isFinalAnswer(event: unknown): boolean {
  const message: unknown = event !== null && typeof event === "object" ? Reflect.get(event, "message") : undefined;
  if (message === null || typeof message !== "object" || Reflect.get(message, "role") !== "assistant") return false;
  if (Reflect.get(message, "stopReason") !== "stop") return false;
  const content: unknown = Reflect.get(message, "content");
  return Array.isArray(content) && !content.some((part) => part !== null && typeof part === "object" && Reflect.get(part, "type") === "toolCall");
}

export function guardCeiling(pi: ExtensionAPI, options: GuardOptions = {}): void {
  const now = options.now ?? Date.now;
  const after = options.notifyAfterMs ?? NOTIFY_AFTER_MS;
  const notify = options.ring ?? ((m: string) => ring(m));
  // The floor (environment) is measured from session start; the bus ceiling from the moment it was sent.
  let floor: Ceiling = {};
  let ceiling: Ceiling = {};
  let startedAt = now();
  let armedAt = 0;
  let turns = 0;
  let costUsd = 0;
  let armTurns = 0;
  let armCost = 0;
  let parked: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let cardTimer: NodeJS.Timeout | undefined;
  let runStartedAt = 0;
  let last: ExtensionContext | undefined;

  const floorUsage = () => ({ turns, costUsd, seconds: (now() - startedAt) / 1000 });
  const busUsage = () => ({ turns: turns - armTurns, costUsd: costUsd - armCost, seconds: (now() - armedAt) / 1000 });
  const floorBreached = (): boolean => !isEmptyCeiling(floor) && ceilingBreach(floor, floorUsage()) !== null;
  const resumeHint = (): string => (isEmptyCeiling(floor) ? "Send /away off to carry on, or /away to set a new limit." : "The environment ceiling (PI_KIT_CEILING_*) was reached: restart the session to continue.");

  const park = (ctx: ExtensionContext, text: string): void => {
    if (parked) return;
    parked = text;
    if (timer) clearTimeout(timer);
    try { pi.events?.emit("luna:parked", { reason: text }); } catch { /* observers only */ }
    notify(`Luna parked: ${text}`);
    if (ctx.hasUI) ctx.ui.notify(`Parked: ${text}. Nothing further runs. ${resumeHint()}`, "warning");
    else { process.stderr.write(`luna: parked: ${text}\n`); process.exitCode = PARKED_EXIT_CODE; }
    try { ctx.abort(); } catch { /* already stopped */ }
  };

  const check = (ctx: ExtensionContext): void => {
    if (parked) return;
    const fu = floorUsage();
    const fb = isEmptyCeiling(floor) ? null : ceilingBreach(floor, fu);
    if (fb) { park(ctx, describeBreach(floor, fu, fb)); return; }
    const bu = busUsage();
    const bb = isEmptyCeiling(ceiling) ? null : ceilingBreach(ceiling, bu);
    if (bb) park(ctx, describeBreach(ceiling, bu, bb));
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const waits: number[] = [];
    if (floor.seconds !== undefined) waits.push(startedAt + floor.seconds * 1000 - now());
    if (ceiling.seconds !== undefined) waits.push(armedAt + ceiling.seconds * 1000 - now());
    if (!waits.length) return;
    timer = setTimeout(() => { if (last) check(last); }, Math.max(0, Math.min(...waits)) + 50);
    timer.unref?.();
  };

  // A bus ceiling replaces only the earlier bus ceiling and never the floor. A park by the floor
  // stays; a park by the bus ceiling ends, because the operator has just set or removed that limit.
  const arm = (next: Ceiling): void => {
    ceiling = next;
    armedAt = now();
    armTurns = turns;
    armCost = costUsd;
    if (parked && !floorBreached()) parked = null;
    schedule();
  };

  pi.on("session_start", async (_event, ctx) => {
    last = ctx;
    const fromEnv = ceilingFromEnv(options.env);
    if (!isEmptyCeiling(fromEnv)) { floor = fromEnv; startedAt = now(); schedule(); }
    // A malformed value would otherwise mean no limit at all. A headless run is parked at once (it
    // cannot be asked); a person at the terminal is told, loudly, and the rest of the ceiling stands.
    const problems = ceilingEnvProblems(options.env);
    if (problems.length > 0) {
      const text = `${problems.join(", ")} ${problems.length === 1 ? "is" : "are"} not a valid ceiling (use a number of turns, dollars, or seconds such as 90m), so that limit is not enforced`;
      if (ctx.hasUI) ctx.ui.notify(`Ceiling: ${text}.`, "warning");
      else park(ctx, text);
    }
  });

  // A host without an event bus cannot receive /away, but must still load.
  const listen = (channel: string, handler: (data: unknown) => void): void => { try { pi.events?.on(channel, handler); } catch { /* no bus */ } };

  // /away asks whether anything enforces a ceiling before it promises one: the probe is answered here.
  listen("luna:ceiling-probe", (data) => {
    const ack: unknown = data !== null && typeof data === "object" ? Reflect.get(data, "ack") : undefined;
    if (typeof ack === "function") Reflect.apply(ack, undefined, []);
  });

  listen("luna:ceiling", (data) => {
    if (data !== null && typeof data === "object" && Reflect.get(data, "clear") === true) { arm({}); return; }
    arm(normaliseCeiling(data));
  });

  pi.on("message_end", async (event, ctx) => {
    last = ctx;
    const message = (event as { message?: { role?: string; usage?: { cost?: { total?: unknown } } } }).message;
    const spent = message?.role === "assistant" ? message.usage?.cost?.total : undefined;
    if (typeof spent === "number" && Number.isFinite(spent)) costUsd += spent;
    return undefined;
  });

  // A turn that ends in the model's final answer is the end of the run, not a limit being hit: a
  // run that finishes on its last allowed turn is a success, not a park. The next turn or tool call
  // is still checked (agent_start, tool_call), so nothing runs past the limit.
  pi.on("turn_end", async (event, ctx) => {
    last = ctx;
    turns += 1;
    if (!isFinalAnswer(event)) check(ctx);
    return undefined;
  });

  // A parked run stays parked: a call already queued is refused rather than left to run.
  pi.on("tool_call", async (_event, ctx) => {
    last = ctx;
    check(ctx);
    return parked ? { block: true as const, reason: `parked: ${parked}. Stop and report what is done; do not start more work.` } : undefined;
  });

  pi.on("agent_start", async (_event, ctx) => {
    last = ctx;
    runStartedAt = now();
    check(ctx);
  });
  pi.on("agent_end", async () => {
    if (runStartedAt && !parked && now() - runStartedAt >= after) notify("Luna: run finished");
    runStartedAt = 0;
  });

  // An approval card nobody answered for a minute is worth a bell; answering it cancels the bell.
  listen("luna:attention", (data) => {
    if (data === null || typeof data !== "object") return;
    const active: unknown = Reflect.get(data, "active");
    if (cardTimer) { clearTimeout(cardTimer); cardTimer = undefined; }
    if (active === true) {
      cardTimer = setTimeout(() => notify("Luna: waiting for you"), after);
      cardTimer.unref?.();
    }
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearTimeout(timer);
    if (cardTimer) clearTimeout(cardTimer);
  });
}
