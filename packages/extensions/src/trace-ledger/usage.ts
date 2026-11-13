// trace-ledger usage accounting: pure functions over the records the ledger already holds.
// A "usage" record is one model request as the provider reported it; a "result" record carries the
// characters the tool returned. /usage summarises both, and cacheDrop says when the prompt cache
// stopped paying. Nothing here touches the filesystem or the UI.

export interface UsageRecord {
  kind: "usage";
  ts: string;
  runId: string;
  childId: string | null;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Cost from the provider's price table; "unpriced" when the model has no price (cost is then 0, not free). */
  costUsd: number;
  costSource: "reported" | "unpriced";
  stopReason: string;
  /** Characters of tool results that entered this request (those returned since the previous one), by tool. */
  resultChars: Record<string, number>;
}

export interface ResultRecord {
  kind: "result";
  ts: string;
  runId: string;
  tool: string;
  target?: string | undefined;
  chars: number;
}

const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The usage record for an assistant message, or null when the message carries no usage (a user message, a stub). */
export function usageFromMessage(message: unknown, meta: { runId: string; childId: string | null; resultChars: Record<string, number>; now?: Date }): UsageRecord | null {
  if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return null;
  const u = message.usage;
  const cost = isRecord(u.cost) ? finite(u.cost.total) : 0;
  return {
    kind: "usage", ts: (meta.now ?? new Date()).toISOString(), runId: meta.runId, childId: meta.childId,
    model: typeof message.model === "string" ? message.model : "unknown",
    input: finite(u.input), output: finite(u.output), cacheRead: finite(u.cacheRead), cacheWrite: finite(u.cacheWrite),
    costUsd: cost, costSource: cost > 0 ? "reported" : "unpriced",
    stopReason: typeof message.stopReason === "string" ? message.stopReason : "unknown",
    resultChars: { ...meta.resultChars },
  };
}

/** A ledger line read back as a usage record, or null when its fields are not the ones written. */
export function asUsage(raw: Record<string, unknown>): UsageRecord | null {
  if (raw.kind !== "usage" || typeof raw.ts !== "string" || typeof raw.runId !== "string" || typeof raw.model !== "string") return null;
  if (typeof raw.stopReason !== "string" || !isRecord(raw.resultChars)) return null;
  return {
    kind: "usage", ts: raw.ts, runId: raw.runId, childId: typeof raw.childId === "string" ? raw.childId : null, model: raw.model,
    input: finite(raw.input), output: finite(raw.output), cacheRead: finite(raw.cacheRead), cacheWrite: finite(raw.cacheWrite),
    costUsd: finite(raw.costUsd), costSource: raw.costSource === "reported" ? "reported" : "unpriced", stopReason: raw.stopReason, resultChars: {},
  };
}

/** A ledger line read back as a result record with a size, or null. */
export function asResult(raw: Record<string, unknown>): ResultRecord | null {
  if (raw.kind !== "result" || typeof raw.ts !== "string" || typeof raw.runId !== "string" || typeof raw.tool !== "string" || typeof raw.chars !== "number") return null;
  return { kind: "result", ts: raw.ts, runId: raw.runId, tool: raw.tool, chars: finite(raw.chars), ...(typeof raw.target === "string" ? { target: raw.target } : {}) };
}

/** Characters of text a tool result's content holds (images count as nothing: they are not log text). */
export function resultChars(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const item of content) if (isRecord(item) && item.type === "text" && typeof item.text === "string") n += item.text.length;
  return n;
}

/** Share of the prompt the provider served from cache (0..1), or null when no prompt tokens were reported. */
export function cacheHit(r: Pick<UsageRecord, "input" | "cacheRead" | "cacheWrite">): number | null {
  const prompt = r.input + r.cacheRead + r.cacheWrite;
  return prompt > 0 ? r.cacheRead / prompt : null;
}

const MIN_PROMPT_TOKENS = 2000; // a tiny prompt says nothing about caching
const WAS_HEALTHY = 0.5;
const DROPPED_BELOW = 0.25;

/** True when the previous request read mostly from cache and this one barely did: the prefix changed or the cache expired. */
export function cacheDrop(prev: UsageRecord | undefined, cur: UsageRecord): boolean {
  if (prev?.model !== cur.model || prev.childId !== cur.childId) return false;
  if (cur.stopReason === "aborted" || cur.stopReason === "error") return false;
  const before = cacheHit(prev);
  const now = cacheHit(cur);
  if (before === null || now === null) return false;
  if (cur.input + cur.cacheRead + cur.cacheWrite < MIN_PROMPT_TOKENS) return false;
  return before >= WAS_HEALTHY && now < DROPPED_BELOW;
}

interface Tally { requests: number; costUsd: number }

export interface UsageSummary {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  unpricedRequests: number;
  cacheHitPct: number | null;
  /** Tokens spent on requests that ended aborted or in error: paid for, produced nothing usable. */
  abortedTokens: number;
  byModel: Array<{ name: string } & Tally>;
  byChild: Array<{ name: string } & Tally>;
  byTool: Array<{ tool: string; results: number; chars: number }>;
  topResults: Array<{ tool: string; target?: string | undefined; chars: number }>;
}

function rank(m: Map<string, Tally>): Array<{ name: string } & Tally> {
  return [...m.entries()].sort((a, b) => b[1].costUsd - a[1].costUsd).map(([name, t]) => ({ name, ...t }));
}

export function summariseUsage(usage: readonly UsageRecord[], results: readonly ResultRecord[]): UsageSummary {
  const sum: UsageSummary = { requests: usage.length, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpricedRequests: 0, cacheHitPct: null, abortedTokens: 0, byModel: [], byChild: [], byTool: [], topResults: [] };
  const model = new Map<string, Tally>();
  const child = new Map<string, Tally>();
  const bump = (m: Map<string, Tally>, key: string, r: UsageRecord) => {
    const e = m.get(key) ?? { requests: 0, costUsd: 0 };
    e.requests++; e.costUsd += r.costUsd; m.set(key, e);
  };
  for (const r of usage) {
    sum.input += r.input; sum.output += r.output; sum.cacheRead += r.cacheRead; sum.cacheWrite += r.cacheWrite; sum.costUsd += r.costUsd;
    if (r.costSource === "unpriced") sum.unpricedRequests++;
    if (r.stopReason === "aborted" || r.stopReason === "error") sum.abortedTokens += r.input + r.output + r.cacheRead + r.cacheWrite;
    bump(model, r.model, r); bump(child, r.childId ?? "root", r);
  }
  const prompt = sum.input + sum.cacheRead + sum.cacheWrite;
  sum.cacheHitPct = prompt > 0 ? Math.round((sum.cacheRead / prompt) * 100) : null;
  sum.byModel = rank(model);
  sum.byChild = rank(child);
  const tools = new Map<string, { results: number; chars: number }>();
  for (const r of results) { const e = tools.get(r.tool) ?? { results: 0, chars: 0 }; e.results++; e.chars += r.chars; tools.set(r.tool, e); }
  sum.byTool = [...tools.entries()].sort((a, b) => b[1].chars - a[1].chars).map(([tool, v]) => ({ tool, ...v }));
  sum.topResults = [...results].sort((a, b) => b.chars - a.chars).slice(0, 5).map((r) => ({ tool: r.tool, target: r.target, chars: r.chars }));
  return sum;
}

export function renderUsage(s: UsageSummary): string {
  if (s.requests === 0) return "usage: no model requests recorded yet.";
  const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
  const lines = [
    `usage: ${s.requests} request(s), ${usd(s.costUsd)}${s.unpricedRequests ? ` (${s.unpricedRequests} unpriced: their cost is not counted)` : ""}`,
    `  tokens: ${s.input} in, ${s.output} out, ${s.cacheRead} cache read, ${s.cacheWrite} cache write | cache hit: ${s.cacheHitPct === null ? "n/a" : `${s.cacheHitPct}%`}`,
    `  aborted or failed requests: ${s.abortedTokens} tokens`,
    `  by model: ${s.byModel.map((m) => `${m.name} ${m.requests}x ${usd(m.costUsd)}`).join(", ")}`,
  ];
  if (s.byChild.length > 1 || s.byChild[0]?.name !== "root") lines.push(`  by child: ${s.byChild.map((c) => `${c.name} ${c.requests}x ${usd(c.costUsd)}`).join(", ")}`);
  if (s.byTool.length) lines.push(`  tool results (chars): ${s.byTool.slice(0, 6).map((t) => `${t.tool} ${t.chars} in ${t.results}`).join(", ")}`);
  if (s.topResults.length) lines.push(`  largest results: ${s.topResults.map((t) => `${t.tool}${t.target ? " " + t.target.slice(0, 40) : ""} ${t.chars}`).join("; ")}`);
  return lines.join("\n");
}
