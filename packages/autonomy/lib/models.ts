// pi model entries for the run's models, from OpenRouter's model list. pi's built-in catalogue
// may not know a new model id; unknown ids fall back to a 128k context window and zero cost,
// which would compact too early and show no spend. The supervisor fetches the list on the host
// and writes the entries into the agent's models.json (through agent-state/run-models.json).

import { isRecord } from "../../core/lib/guard.ts";
import type { ModelPricing } from "./contract.ts";

/** Token prices in USD per million tokens, as pi's models.json holds them. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A full pi model entry built from an OpenRouter model spec. */
export interface ModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
}

/** A model entry for a provider without a model list: the id, and the contract's price if it gives one. */
export interface PlainModelEntry {
  id: string;
  cost?: ModelCost;
}

const perMillion = (v: unknown): number => (Number.isFinite(Number(v)) ? +(Number(v) * 1e6).toFixed(6) : 0);

/** `o[key]` when `o` is an object, else undefined. OpenRouter's list is outside data: nothing in it is trusted to have a shape. */
const field = (o: unknown, key: string): unknown => (isRecord(o) ? o[key] : undefined);
const numberOr = (fallback: number, ...candidates: unknown[]): number => {
  for (const c of candidates) if (c !== undefined && c !== null) return typeof c === "number" ? c : fallback;
  return fallback;
};

/**
 * @param list OpenRouter `data` array
 * @param ids the run's model ids
 */
export function modelEntries(list: unknown, ids: readonly string[]): ModelEntry[] {
  const byId = new Map((Array.isArray(list) ? (list as unknown[]) : []).map((m) => [field(m, "id"), m]));
  return ids.flatMap((id): ModelEntry[] => {
    const m: unknown = byId.get(id);
    if (!m) return [];
    const supported = field(m, "supported_parameters");
    const params = new Set(Array.isArray(supported) ? (supported as unknown[]) : []);
    const modalities = field(field(m, "architecture"), "input_modalities");
    const name = field(m, "name");
    const pricing = field(m, "pricing");
    const top = field(m, "top_provider");
    return [{
      id,
      name: typeof name === "string" ? name : id,
      reasoning: params.has("reasoning"),
      input: (Array.isArray(modalities) ? (modalities as unknown[]) : ["text"]).includes("image") ? ["text", "image"] : ["text"],
      contextWindow: numberOr(128000, field(top, "context_length"), field(m, "context_length")),
      maxTokens: numberOr(16384, field(top, "max_completion_tokens")),
      cost: {
        input: perMillion(field(pricing, "prompt")),
        output: perMillion(field(pricing, "completion")),
        cacheRead: perMillion(field(pricing, "input_cache_read")),
        cacheWrite: perMillion(field(pricing, "input_cache_write")),
      },
    }];
  });
}

/** The agent's models.json (see agentModelsJson). */
export interface AgentModelsJson {
  providers: {
    openrouter?: { baseUrl: string; apiKey: string; models?: Array<ModelEntry | PlainModelEntry> };
    relay?: { baseUrl: string; api: "openai-completions"; apiKey: string; models: Array<ModelEntry | PlainModelEntry> };
  };
}

/**
 * The agent's models.json: the provider pointed at the relay, with the run's models. OpenRouter is
 * pi's built-in provider (overridden to point at the relay); any other OpenAI-compatible provider
 * is a custom provider called `relay`. The key is always the placeholder the relay replaces.
 */
export function agentModelsJson(entries: Array<ModelEntry | PlainModelEntry>, provider = "openrouter"): AgentModelsJson {
  if (provider === "openrouter") return { providers: { openrouter: { baseUrl: "http://inference:8081/v1", apiKey: "relay", ...(entries.length ? { models: entries } : {}) } } };
  return { providers: { relay: { baseUrl: "http://inference:8081/v1", api: "openai-completions", apiKey: "relay", models: entries.length ? entries : [] } } };
}

/** Model entries for a provider that publishes no model list: only the ids (pi fills defaults), priced from the contract. */
export function plainModelEntries(ids: readonly string[], pricing: Readonly<Record<string, ModelPricing>> = {}): PlainModelEntry[] {
  return ids.map((id) => {
    const price = Object.hasOwn(pricing, id) ? pricing[id] : undefined;
    return { id, ...(price ? { cost: { input: price.inputPerMTok, output: price.outputPerMTok, cacheRead: 0, cacheWrite: 0 } } : {}) };
  });
}
