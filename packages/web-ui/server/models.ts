// models.ts — expose providers/models from pi's models.json plus the configured default.
import { array, boolean, number, object, record, string, unknownValue, type Infer } from "../../core/lib/guard.ts";
import { MODELS_FILE, SETTINGS_FILE } from "./config.ts";
import { lenient, readJsonFile } from "./json.ts";

export interface ModelInfo {
	id: string;
	contextWindow?: number;
	reasoning?: boolean;
}

export interface ProviderInfo {
	name: string;
	models: ModelInfo[];
}

export interface ModelList {
	providers: ProviderInfo[];
	default: { provider: string; model: string };
}

// pi owns models.json and settings.json; only the fields read here are checked, each on its own.
const ModelEntrySchema = object({
	id: lenient(string()),
	contextWindow: lenient(number()),
	reasoning: lenient(boolean()),
});
const ProviderSchema = object({ models: lenient(array(unknownValue())) });
const ModelsFileSchema = object({ providers: lenient(record(lenient(ProviderSchema))) });

/** The keys of pi's settings.json the console shows. */
export const ConsoleSettingsSchema = object({
	defaultProvider: lenient(string()),
	defaultModel: lenient(string()),
	theme: lenient(string()),
	defaultThinkingLevel: lenient(string()),
	packages: lenient(array(unknownValue())),
});
export type ConsoleSettings = Infer<typeof ConsoleSettingsSchema>;

/** pi's settings.json as far as the console reads it; {} when absent or not an object. */
export function readConsoleSettings(): ConsoleSettings {
	return lenient(ConsoleSettingsSchema).parse(readJsonFile(SETTINGS_FILE)) ?? {};
}

function modelInfo(entry: unknown): ModelInfo | null {
	if (typeof entry === "string") return { id: entry };
	const parsed = lenient(ModelEntrySchema).parse(entry);
	if (!parsed?.id) return null;
	const { id, contextWindow, reasoning } = parsed;
	return {
		id,
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(reasoning === undefined ? {} : { reasoning }),
	};
}

/** { providers: [{name, models:[{id, contextWindow?, reasoning?}]}], default:{provider,model} } */
export function listModels(): ModelList {
	const raw = lenient(ModelsFileSchema).parse(readJsonFile(MODELS_FILE)) ?? {};
	const providers: ProviderInfo[] = [];
	for (const [name, cfg] of Object.entries(raw.providers ?? {})) {
		if (!cfg) continue;
		const models = (cfg.models ?? [])
			.map(modelInfo)
			.filter((m): m is ModelInfo => m !== null && Boolean(m.id));
		providers.push({ name, models });
	}
	providers.sort((a, b) => a.name.localeCompare(b.name));

	const settings = readConsoleSettings();
	const fallbackProvider = providers[0]?.name || "ollama";
	const provider = settings.defaultProvider || fallbackProvider;
	const providerEntry = providers.find((p) => p.name === provider);
	const model = settings.defaultModel || providerEntry?.models[0]?.id || "";

	return { providers, default: { provider, model } };
}
