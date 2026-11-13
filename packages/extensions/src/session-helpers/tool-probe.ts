/**
 * Tool-call probe: does this local model actually call a tool when asked? A model that was not
 * trained for tool calls answers in prose, and the first sign is an agent that "does nothing". One
 * round trip with one trivial tool tells the operator before they lose a session to it. The result is
 * cached per model in <agent dir>/pi-kit/tool-probe.json and shown on the Doctor page (/menu); it only runs for a model on this machine or network
 * (model-fit.ts isLocalBaseUrl) and only when PI_KIT_TOOL_PROBE=1: "local" is judged from the address alone, so a private
 * gateway to a hosted model also looks local, and the probe sends a real request with the provider's auth headers.
 *
 * Self-containment rule: node builtins only. The model call is injected so the probe is tested offline.
 */
import fs from "node:fs";
import path from "node:path";

export interface ProbeRecord {
  /** The model: "provider/id". */
  model: string;
  ok: boolean;
  /** ISO time of the probe. */
  at: string;
  /** Why it failed, when it did. */
  detail?: string;
}

/** What the probe needs back from the model: the content parts of its reply. */
export type ProbeCompleter = (request: { system: string; prompt: string }, signal?: AbortSignal) => Promise<ReadonlyArray<{ type: string; name?: string }>>;

/** The one tool the probe offers (the completer declares it: a string argument "word"). */
export const PROBE_TOOL_NAME = "echo";

export function probeFile(agentDir: string): string {
  return path.join(agentDir, "pi-kit", "tool-probe.json");
}

const prop = (o: object, key: string): unknown => Reflect.get(o, key);

export function readProbes(file: string): ProbeRecord[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((r: unknown): ProbeRecord[] => {
      if (typeof r !== "object" || r === null) return [];
      const model = prop(r, "model");
      const ok = prop(r, "ok");
      const at = prop(r, "at");
      const detail = prop(r, "detail");
      return typeof model === "string" && typeof ok === "boolean" && typeof at === "string" ? [{ model, ok, at, ...(typeof detail === "string" ? { detail } : {}) }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * One round trip: ask for a call to the echo tool and see whether a tool call came back. Null when the
 * server could not be asked (down, loading, no auth): nothing is learned, so nothing is cached and the
 * next model switch tries again.
 */
export async function probeToolCalls(model: string, complete: ProbeCompleter, signal?: AbortSignal): Promise<ProbeRecord | null> {
  const at = new Date().toISOString();
  try {
    const parts = await complete({ system: "You are a test. Use the tool you are given.", prompt: "Call the echo tool with the word ping." }, signal);
    const called = parts.some((p) => p.type === "toolCall" && p.name === PROBE_TOOL_NAME);
    return called ? { model, ok: true, at } : { model, ok: false, at, detail: "answered in text instead of calling the tool" };
  } catch {
    return null;
  }
}

/** Replace (or add) one model's record. */
export function withProbe(records: readonly ProbeRecord[], record: ProbeRecord): ProbeRecord[] {
  return [...records.filter((r) => r.model !== record.model), record].slice(-20);
}
