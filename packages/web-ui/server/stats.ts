// stats.ts — token/cost/context statistics for a session.
// Live sessions answer via the RPC `get_session_stats` command; idle sessions are
// computed from the assistant usage records already on disk.
import * as fs from "node:fs";
import { array, isRecord, number, object, parseJson, string, union, unknownValue, type Infer } from "../../core/lib/guard.ts";
import { lenient } from "./json.ts";
import { listModels } from "./models.ts";

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

export interface ContextUsage {
	tokens: number;
	contextWindow: number;
	percent: number;
}

/** Statistics computed from a session file. */
export interface DiskSessionStats {
	live: false;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	totalMessages: number;
	tokens: TokenTotals;
	cost: number;
	contextUsage: ContextUsage | null;
	model: string | null;
	provider: string | null;
	lastTimestamp: string | number | null;
}

/** The live child's own `get_session_stats` answer (pi's shape, passed through) plus `live` and `cost`. */
export interface LiveSessionStats {
	[key: string]: unknown;
	live: true;
	cost: number;
}

export type SessionStats = DiskSessionStats | LiveSessionStats;

/** The part of a running pi child that stats needs (spawn.ts's PiRpcProcess). */
export interface StatsSource {
	readonly alive: boolean;
	send(command: { type: "get_session_stats" }, options: { timeoutMs: number }): Promise<unknown>;
}

/** The part of a session summary that stats needs. */
export interface StatsSummary {
	readonly sessionFile?: string | null | undefined;
}

// A session file is pi's; each field is checked on its own and dropped when it has the wrong type.
const UsageSchema = object({
	input: lenient(number()),
	output: lenient(number()),
	cacheRead: lenient(number()),
	cacheWrite: lenient(number()),
	cost: lenient(object({ total: lenient(number()) })),
});
type Usage = Infer<typeof UsageSchema>;
const MessageSchema = object({
	role: lenient(string()),
	timestamp: lenient(union(string(), number())),
	content: lenient(array(unknownValue())),
	model: lenient(string()),
	provider: lenient(string()),
	usage: lenient(UsageSchema),
});
const EntrySchema = object({
	type: lenient(string()),
	message: lenient(MessageSchema),
});

function emptyTotals(): TokenTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: 0,
	};
}

function contextWindowFor(modelId: string | null): number | null {
	try {
		for (const provider of listModels().providers) {
			const hit = provider.models.find((m) => m.id === modelId);
			if (hit?.contextWindow) return hit.contextWindow;
		}
	} catch {
		/* ignore */
	}
	return null;
}

/** Sum assistant usage records from a session file. */
export function statsFromDisk(sessionFile: string | null | undefined): DiskSessionStats {
	const totals = emptyTotals();
	let userMessages = 0;
	let assistantMessages = 0;
	let toolCalls = 0;
	let lastUsage: Usage | null = null;
	let model: string | null = null;
	let provider: string | null = null;
	let lastTimestamp: string | number | null = null;

	if (sessionFile && fs.existsSync(sessionFile)) {
		const text = fs.readFileSync(sessionFile, "utf8");
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let value: unknown;
			try {
				value = parseJson(line);
			} catch {
				continue;
			}
			const entry = lenient(EntrySchema).parse(value);
			if (entry?.type !== "message") continue;
			const msg = entry.message ?? {};
			if (msg.timestamp) lastTimestamp = msg.timestamp;
			if (msg.role === "user") userMessages++;
			if (msg.role !== "assistant") continue;
			assistantMessages++;
			if (msg.content)
				toolCalls += msg.content.filter(
					(p) => isRecord(p) && p.type === "toolCall",
				).length;
			if (msg.model) model = msg.model;
			if (msg.provider) provider = msg.provider;
			const usage = msg.usage;
			if (!usage) continue;
			lastUsage = usage;
			totals.input += usage.input || 0;
			totals.output += usage.output || 0;
			totals.cacheRead += usage.cacheRead || 0;
			totals.cacheWrite += usage.cacheWrite || 0;
			totals.cost += usage.cost?.total || 0;
		}
		totals.total =
			totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	}

	const window = contextWindowFor(model);
	const contextTokens = lastUsage
		? (lastUsage.input || 0) + (lastUsage.cacheRead || 0)
		: null;
	const contextUsage =
		window && contextTokens !== null
			? {
					tokens: contextTokens,
					contextWindow: window,
					percent: Math.round((contextTokens / window) * 100),
				}
			: null;

	return {
		live: false,
		userMessages,
		assistantMessages,
		toolCalls,
		totalMessages: userMessages + assistantMessages,
		tokens: totals,
		cost: totals.cost,
		contextUsage,
		model,
		provider,
		lastTimestamp,
	};
}

/** The child's answer is untrusted: only a JSON object is passed through, and `cost` must be a number. */
function liveStats(data: unknown): LiveSessionStats | null {
	if (!isRecord(data)) return null;
	const tokens = data.tokens;
	const tokenCost = isRecord(tokens) ? tokens.cost : undefined;
	const cost =
		typeof data.cost === "number"
			? data.cost
			: typeof tokenCost === "number"
				? tokenCost
				: 0;
	return { ...data, live: true, cost };
}

/** Prefer the live child's own accounting; fall back to the file. */
export async function sessionStats(
	summary: StatsSummary | null | undefined,
	proc: StatsSource | null | undefined,
): Promise<SessionStats> {
	if (proc?.alive) {
		try {
			const data = await proc.send(
				{ type: "get_session_stats" },
				{ timeoutMs: 8000 },
			);
			const live = liveStats(data);
			if (live) return live;
		} catch {
			/* fall through to disk */
		}
	}
	return statsFromDisk(summary?.sessionFile);
}
