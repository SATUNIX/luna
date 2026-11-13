import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import net from "node:net";
import { redact } from "./shared/redact.ts";
import { agentStateDir, buildAgentState, writeAgentState, type AgentState, type AgentStateName } from "./shared/agent-state.ts";

/**
 * herdr bridge. Inside a herdr pane it tells herdr when Luna needs the operator, and says so with a
 * herdr notification. Outside herdr it does nothing. It does not report working/idle state: herdr
 * detects that itself, or through its own pi integration (`herdr integration install pi`), which
 * this extension feeds through that integration's `herdr:blocked` event.
 *
 * It also keeps this agent's state file current (only inside a herdr pane: a plain interactive or headless
 * session writes none, and a killed process leaves its last state, so readers check `pid`) (shared/agent-state.ts, the schema every Luna agent
 * writes), so a script or the web console can read what the pane's agent is doing without herdr.
 *
 * Other Luna extensions announce themselves on one bus channel, `luna:attention`, and never import
 * this one. A payload with a boolean `active` opens or closes a blocking ask (an approval card, a
 * question); a payload without it is a one-off notice (a failed check).
 */

export type Attention = { kind: string; label: string; active?: boolean };

const CONTROL = /\p{Cc}/gu;
const clean = (text: unknown, max = 120): string => (typeof text === "string" ? text : "").replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function herdrSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const off = (env.PI_KIT_HERDR ?? "").trim().toLowerCase();
  if (off === "0" || off === "off" || off === "false") return undefined;
  if (env.PI_SUBAGENT_CHILD === "1" || env.PI_KIT_INTERNAL_CHILD === "1") return undefined;
  return env.HERDR_ENV === "1" && env.HERDR_PANE_ID && env.HERDR_SOCKET_PATH ? env.HERDR_SOCKET_PATH : undefined;
}

export function minSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_KIT_HERDR_NOTIFY_MIN_SECONDS;
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : 30;
}

/** One request, fire and forget: herdr being slow or gone must never hold Luna up. */
export function sendToHerdr(socketPath: string, request: unknown, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
    const socket = net.createConnection(endpoint);
    const finish = (delivered: boolean) => { clearTimeout(timer); socket.destroy(); resolve(delivered); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));
    socket.on("data", () => finish(true));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

export function notificationRequest(title: string, body: string, sound: "done" | "request"): unknown {
  return { id: `luna:${Date.now()}:${Math.random().toString(36).slice(2)}`, method: "notification.show", params: { title, body, sound } };
}

export default function herdr(pi: ExtensionAPI, send: typeof sendToHerdr = sendToHerdr, stateDir: string = agentStateDir()) {
  const socket = herdrSocket();
  if (!socket) return;

  // The agent-state file: one per pane, rewritten on every change. Failure to write never matters.
  const id = `pi-${process.pid}`;
  let current: AgentState | undefined;
  let worktree: string | undefined;
  let costUsd = 0;
  let tail = "";
  const report = (state: AgentStateName, waitingFor?: string) => {
    current = buildAgentState({ id, state, source: "session", waitingFor, tail: redact(tail), worktree: worktree === undefined ? undefined : redact(worktree), costUsd, previous: current });
    writeAgentState(stateDir, current);
  };
  pi.on("session_start", async (_event, ctx) => { worktree = (ctx as { cwd?: string } | undefined)?.cwd; report("done"); });
  pi.on("message_end", async (event) => {
    const m = (event as { message?: { role?: string; content?: unknown; usage?: { cost?: { total?: unknown } } } } | undefined)?.message;
    if (m?.role !== "assistant") return;
    if (typeof m.usage?.cost?.total === "number") costUsd += m.usage.cost.total;
    if (Array.isArray(m.content)) tail = m.content.map((c: { type?: string; text?: string }) => (c?.type === "text" && typeof c.text === "string" ? c.text : "")).join(" ").trim() || tail;
  });
  pi.on("session_shutdown", async () => { if (current?.state === "working" || current?.state === "blocked") report("stopped"); });
  const notify = (title: string, body: string, sound: "done" | "request") => void send(socket, notificationRequest(title, body, sound));

  // A run that a ceiling parked ends as an abort; the file keeps saying `parked`, not `stopped`, until the next run starts.
  let parked = false;
  pi.events?.on("luna:parked", () => { parked = true; report("parked"); });

  let startedAt = 0;
  pi.on("agent_start", async () => { startedAt = Date.now(); parked = false; report("working"); });
  pi.on("agent_end", async (event) => {
    // An aborted or failed run is not "ready for input": stay quiet, the operator caused it or sees it.
    const last = [...((event as { messages?: Array<{ role?: string; stopReason?: string }> } | undefined)?.messages ?? [])].reverse().find((m) => m?.role === "assistant");
    const stopped = last?.stopReason === "aborted" || last?.stopReason === "error";
    if (parked) { startedAt = 0; return; }
    report(last?.stopReason === "error" ? "failed" : stopped ? "stopped" : "done");
    if (!stopped && startedAt && Date.now() - startedAt >= minSeconds() * 1000) notify("Luna finished", "Ready for input", "done");
    startedAt = 0;
  });

  pi.events?.on("luna:attention", (data) => {
    const { kind, label, active } = (data ?? {}) as Partial<Attention>;
    const text = clean(label) || clean(kind) || "needs you";
    if (typeof active === "boolean") {
      // herdr's own pi integration turns this into the pane's "blocked" state and clears it on close.
      pi.events?.emit("herdr:blocked", { active, label: text });
      report(active ? "blocked" : "working", active ? text : undefined);
      if (active) notify("Luna needs you", text, "request");
      return;
    }
    notify(kind === "failed" ? "Luna: a check failed" : "Luna", text, "request");
  });
}
