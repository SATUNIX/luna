// The run manager: one LLM call, made only when the supervisor sees a trigger (lib/triggers.ts).
// It reads a bounded bundle of the cycle's state and must answer with exactly one decision from a
// fixed list. The supervisor validates the answer, executes it, and the manager is done: it has no
// tools, no memory between calls and no way to act by itself.

import { isRecord, literal, matches, parseJson } from "../../core/lib/guard.ts";

/** The closed set of decisions, in the order the system prompt lists them. */
export const DECISION_NAMES = ["CONTINUE", "NUDGE", "RESTART_SESSION", "NEW_CYCLE", "RESET_TO_LAST_GOOD", "ABORT_RUN"] as const;
export type DecisionName = (typeof DECISION_NAMES)[number];
const DecisionNameSchema = literal(...DECISION_NAMES);

/** A validated manager decision. Only these shapes ever leave parseDecision. */
export type ManagerDecision =
  | { decision: "CONTINUE"; reason: string; extendMinutes: number }
  | { decision: "NUDGE" | "RESTART_SESSION"; reason: string; message: string }
  | { decision: "NEW_CYCLE" | "RESET_TO_LAST_GOOD" | "ABORT_RUN"; reason: string };

export const DECISIONS: Readonly<Record<DecisionName, string>> = {
  CONTINUE: "The cycle is progressing; give it more time (extendMinutes, 10-120).",
  NUDGE: "The agent is drifting or stuck on something specific; send it one steering message (message).",
  RESTART_SESSION: "The session is wedged (looping, context exhausted, crashed); start a fresh session on the same workspace, briefed with message.",
  NEW_CYCLE: "This cycle has done what it can; close it as partial (committed work is kept) and start the next cycle.",
  RESET_TO_LAST_GOOD: "This cycle's work is in a bad state (red and getting worse); keep its head as an abandoned tag and restart the cycle's branch from the integration branch (the last merged state).",
  ABORT_RUN: "Continuing wastes budget or risks harm (repeated failures with no progress across cycles); stop the whole run for a human.",
};

const MAX_MESSAGE = 2000;

/**
 * Parse and validate the manager's reply (model output: the least trusted input). Returns a
 * decision from the closed union or throws with the reason; nothing is coerced into a decision.
 */
export function parseDecision(text: string | null | undefined): ManagerDecision {
  const json = extractJson(text);
  if (!json) throw new Error("manager reply has no JSON object");
  const { decision, reason } = json;
  if (typeof decision !== "string" || !matches(DecisionNameSchema, decision)) throw new Error(`unknown decision ${JSON.stringify(decision)}`);
  if (typeof reason !== "string" || !reason.trim()) throw new Error("reason is required");
  const why = reason.trim().slice(0, 1000);
  switch (decision) {
    case "CONTINUE": {
      // A number, not anything Number() can turn into one: null, "", [] and true became 10 minutes.
      const m = json["extendMinutes"];
      if (typeof m !== "number" || !Number.isFinite(m)) throw new Error("CONTINUE needs extendMinutes");
      return { decision, reason: why, extendMinutes: Math.min(120, Math.max(10, Math.round(m))) };
    }
    case "NUDGE":
    case "RESTART_SESSION": {
      const message = json["message"];
      if (typeof message !== "string" || !message.trim()) throw new Error(`${decision} needs message`);
      return { decision, reason: why, message: message.trim().slice(0, MAX_MESSAGE) };
    }
    case "NEW_CYCLE":
    case "RESET_TO_LAST_GOOD":
    case "ABORT_RUN":
      return { decision, reason: why };
  }
}

/** The JSON object in a model reply (fenced, or the outermost braces), or null. */
export function extractJson(text: string | null | undefined): Record<string, unknown> | null {
  const s = (text ?? "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const candidate = fenced?.[1] ?? s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1);
  try {
    const v = parseJson(candidate);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/** Keep the head and tail of a long text, marking what was cut. */
export const clip = (text: string | null | undefined, max: number): string => {
  const s = text ?? "";
  return s.length <= max ? s : `${s.slice(0, max / 2)}\n…[${s.length - max} chars cut]…\n${s.slice(-max / 2)}`;
};

/** Everything the manager may know about the cycle (lib/cycle.ts assembles it). */
export interface ManagerBundle {
  run: string;
  cycle: number;
  cycles: number;
  triggers: readonly string[];
  elapsedMinutes: number;
  limits: { readonly softMinutes: number; readonly hardMinutes: number };
  extendedMinutes?: number | undefined;
  costUsd?: number | undefined;
  budget: { readonly perCycleUsd: number; readonly perCycleHardUsd?: number | undefined; readonly totalUsd: number };
  totalCostUsd?: number | undefined;
  managerCalls?: number | undefined;
  previousDecisions?: readonly { readonly decision: string; readonly reason: string }[] | undefined;
  idleMinutes?: number | null | undefined;
  sinceCommitMinutes?: number | null | undefined;
  gates?: readonly string[] | undefined;
  gitLog?: string | null | undefined;
  activity?: string | null | undefined;
  plan?: string | null | undefined;
  handoff?: string | null | undefined;
}

/** The manager's user prompt: everything it may know about the cycle, bounded in size. */
export function buildBundle(b: ManagerBundle): string {
  return [
    `Run ${b.run}, cycle ${b.cycle} of ${b.cycles}. Trigger(s): ${b.triggers.join(", ")}.`,
    `Elapsed ${Math.round(b.elapsedMinutes)} min (soft ${b.limits.softMinutes}, hard ${b.limits.hardMinutes}); extended ${b.extendedMinutes ?? 0} min so far.`,
    `Cost this cycle $${(b.costUsd ?? 0).toFixed(2)} (review at $${b.budget.perCycleUsd}, hard stop at $${b.budget.perCycleHardUsd ?? 2 * b.budget.perCycleUsd}); run total $${(b.totalCostUsd ?? 0).toFixed(2)} of $${b.budget.totalUsd}.`,
    `Manager calls this cycle before this one: ${b.managerCalls ?? 0}. Previous decisions: ${b.previousDecisions?.length ? b.previousDecisions.map((d) => `${d.decision} (${d.reason})`).join("; ") : "none"}.`,
    `Last session event ${b.idleMinutes != null ? `${Math.round(b.idleMinutes)} min ago` : "unknown"}; last push ${b.sinceCommitMinutes != null ? `${Math.round(b.sinceCommitMinutes)} min ago` : "none this cycle"}.`,
    `Post-cycle gates (latest last): ${b.gates?.length ? b.gates.join(", ") : "none yet"}.`,
    "",
    "## Commits this cycle (git log --stat)",
    clip(b.gitLog || "(none)", 6000),
    "",
    "## Recent session activity (tools, errors, guard notes; oldest first)",
    clip(b.activity || "(none)", 8000),
    "",
    "## Cycle plan",
    clip(b.plan || "(not written yet)", 3000),
    "",
    "## Handoff (autonomy/HANDOFF.md)",
    clip(b.handoff || "(none)", 2000),
  ].join("\n");
}

export function systemPrompt(): string {
  return [
    "You manage an unattended run in which a coding agent improves a repository in cycles (review, plan, improve, verify).",
    "You are called only when something needs a decision. Choose exactly one decision:",
    ...Object.entries(DECISIONS).map(([k, v]) => `- ${k}: ${v}`),
    "Prefer the least disruptive decision that the evidence supports. Commits and passing gates are progress; repeated identical tool calls, the same error recurring, or long silence are not.",
    'Reply with only a JSON object: {"decision": "...", "reason": "one or two sentences citing the evidence", "extendMinutes": n (CONTINUE only), "message": "..." (NUDGE and RESTART_SESSION only)}.',
    "A NUDGE or RESTART_SESSION message is read by the agent as coming from the operator: be specific and actionable.",
  ].join("\n");
}

/** One host-side model call: `complete(system, user)` resolves to the reply text. */
export type Complete = (system: string, user: string) => Promise<string>;

/** Call the model. `complete(system, user)` returns the reply text; injected for tests. */
export async function decide(bundle: ManagerBundle, complete: Complete): Promise<ManagerDecision> {
  const text = await complete(systemPrompt(), buildBundle(bundle));
  return parseDecision(text);
}

/**
 * A chat-completions `complete` for the host (the manager and the reviews run outside the container).
 * Named for OpenRouter, which reports cost with `usage: {include: true}`; with usageInclude false it
 * sends a plain OpenAI-compatible request and the caller prices the tokens (onUsage gets the usage object).
 */
export function openRouterComplete({ apiKey, model, upstream, fetchImpl = fetch, timeoutMs = 120_000, onUsage = () => {}, usageInclude = true }: OpenRouterOptions): Complete {
  return async (system, user) => {
    const res = await fetchImpl(`${upstream.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, ...(usageInclude ? { usage: { include: true } } : {}), messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`manager model HTTP ${res.status}: ${text.slice(0, 300)}`);
    const parsed = parseJson(text);
    const json = isRecord(parsed) ? parsed : {};
    if (json["usage"]) onUsage(usageOf(json["usage"])); // the manager's spend counts toward the run budget too
    const choices = json["choices"];
    const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
    const message = isRecord(first) ? first["message"] : undefined;
    const content = isRecord(message) ? message["content"] : undefined;
    // A reply that is not text has no decision in it; parseDecision rejects "".
    return typeof content === "string" ? content : "";
  };
}

/** Token counts and cost an upstream reports for one call; fields that are not numbers are dropped. */
export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}

function usageOf(value: unknown): ChatUsage {
  const out: ChatUsage = {};
  if (!isRecord(value)) return out;
  for (const key of ["prompt_tokens", "completion_tokens", "cost"] as const) {
    const v = value[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  upstream: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number | undefined;
  onUsage?: (usage: ChatUsage) => void;
  usageInclude?: boolean;
}
