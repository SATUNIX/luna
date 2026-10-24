// Pure, dependency-light provider resolution for the live evaluation runner.
// Kept separate from run.ts so it can be exercised offline in tests.
import fs from "node:fs";
import { isRecord, parseJson } from "../../lib/guard.ts";

/** A model entry from models.json; only the id is checked, the rest passes through untouched. */
export interface ProviderModel {
  readonly id: string;
  readonly [key: string]: unknown;
}

/**
 * A provider from models.json. Only the first model's id is checked here: the whole object is
 * returned as written, because the runner copies it (minus credentials) into the sandbox config.
 */
export interface ProviderConfig {
  readonly models: readonly [ProviderModel, ...unknown[]];
  readonly baseUrl?: unknown;
  readonly apiKey?: unknown;
  readonly headers?: unknown;
  readonly [key: string]: unknown;
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!isRecord(value) || !Array.isArray(value.models)) return false;
  const first: unknown = value.models[0];
  return isRecord(first) && typeof first.id === "string" && first.id.length > 0;
}

export function resolveProvider(modelsFile: string, providerName: string): ProviderConfig {
  const parsed = parseJson(fs.readFileSync(modelsFile, "utf8"));
  if (!isRecord(parsed)) throw new Error("models file is not a JSON object");
  const providers = parsed.providers;
  if (!isRecord(providers)) throw new Error("models file has no providers map");
  // Own keys only: a provider name such as "constructor" must not resolve to a prototype member.
  const provider = Object.hasOwn(providers, providerName) ? providers[providerName] : undefined;
  if (!provider) throw new Error("Requested provider is not configured");
  if (!isProviderConfig(provider)) {
    throw new Error(`provider "${providerName}" has no usable model id`);
  }
  return provider;
}
