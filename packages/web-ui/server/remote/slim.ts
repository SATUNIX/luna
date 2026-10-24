// slim.ts — make pi's session events fit a phone on mobile data.
//
// pi streams every assistant delta together with the whole response so far (`partial`, and
// `message` on message_update), so a long answer costs O(n^2) bytes. The renderer only uses the
// delta, so those snapshots are dropped here. Large tool arguments and outputs are cut to a
// readable size, images are replaced by a marker, and per-run summaries that repeat the whole
// transcript (agent_end.messages, turn_end) are reduced. message_end keeps the final message,
// which is how a non-streaming answer is rendered.

import { isRecord } from "../../../core/lib/guard.ts";

const TEXT_LIMIT = 20_000;
const UPDATE_TAIL = 8_000;
const ARG_LIMIT = 2_000;

type Cut = (text: unknown, limit: number) => unknown;

function cutText(text: unknown, limit: number): unknown {
	if (typeof text !== "string" || text.length <= limit) return text;
	return `${text.slice(0, limit)}\n… [${text.length - limit} more characters on the computer]`;
}

function tailText(text: unknown, limit: number): unknown {
	if (typeof text !== "string" || text.length <= limit) return text;
	return `[… ${text.length - limit} earlier characters]\n${text.slice(-limit)}`;
}

function slimContent(content: unknown, limit = TEXT_LIMIT, cut: Cut = cutText): unknown {
	if (typeof content === "string") return cut(content, limit);
	if (!Array.isArray(content)) return content;
	return content.map((part: unknown) => {
		if (!isRecord(part)) return part;
		if (part.type === "image") return { type: "image", mimeType: part.mimeType, omitted: true };
		if (part.type === "text") return { ...part, text: cut(part.text, limit) };
		if (part.type === "thinking") return { ...part, thinking: cut(part.thinking, limit), thinkingSignature: undefined };
		if (part.type === "toolCall") return { ...part, arguments: slimArgs(part.arguments) };
		return part;
	});
}

/** Tool-call arguments with every long string value cut (one level deep). */
export function slimArgs(args: unknown): unknown {
	if (!args || typeof args !== "object") return args;
	const slim = (value: unknown): unknown => (typeof value === "string" ? cutText(value, ARG_LIMIT) : value);
	if (Array.isArray(args)) return args.map(slim);
	return Object.fromEntries(Object.entries(args).map(([key, value]: [string, unknown]) => [key, slim(value)]));
}

export function slimMessage(message: unknown): unknown {
	if (!isRecord(message)) return message;
	return { ...message, content: slimContent(message.content) };
}

function slimResult(result: unknown, limit: number, cut: Cut): unknown {
	if (!isRecord(result)) return result;
	return { content: slimContent(result.content, limit, cut), isError: result.isError };
}

/** A slimmed copy of one pi session event (never mutates the input). */
export function slimEvent(event: unknown): unknown {
	if (!isRecord(event)) return event;
	switch (event.type) {
		case "message_update": {
			const ame = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : {};
			const kept: Record<string, unknown> = { type: ame.type };
			if (ame.contentIndex !== undefined) kept.contentIndex = ame.contentIndex;
			if (typeof ame.delta === "string") kept.delta = ame.delta;
			if (ame.type === "toolcall_end" && isRecord(ame.toolCall)) kept.toolCall = { ...ame.toolCall, arguments: slimArgs(ame.toolCall.arguments) };
			if (ame.reason) kept.reason = ame.reason;
			return { type: "message_update", assistantMessageEvent: kept };
		}
		case "message_start":
		case "message_end":
			return { ...event, message: slimMessage(event.message) };
		case "tool_execution_start":
			return { ...event, args: slimArgs(event.args) };
		case "tool_execution_update":
			return { ...event, args: undefined, partialResult: slimResult(event.partialResult, UPDATE_TAIL, tailText) };
		case "tool_execution_end":
			return { ...event, args: undefined, result: slimResult(event.result, TEXT_LIMIT, cutText) };
		case "agent_end":
			return { type: "agent_end" };
		case "turn_end":
			return { type: "turn_end", turnIndex: event.turnIndex };
		default:
			return event;
	}
}

/**
 * Drops tool_execution_update events that arrive within `intervalMs` of the previous one for the
 * same call: the output is cumulative and tool_execution_end carries the final state, so
 * skipping intermediate updates loses nothing a phone needs.
 */
export class UpdateThrottle {
	readonly intervalMs: number;
	private readonly last = new Map<unknown, number>();

	constructor(intervalMs = 250) {
		this.intervalMs = intervalMs;
	}

	pass(event: unknown): boolean {
		if (!isRecord(event) || event.type !== "tool_execution_update") {
			if (isRecord(event) && event.type === "tool_execution_end") this.last.delete(event.toolCallId);
			return true;
		}
		const now = Date.now();
		const prev = this.last.get(event.toolCallId) || 0;
		if (now - prev < this.intervalMs) return false;
		this.last.set(event.toolCallId, now);
		if (this.last.size > 500) this.last.delete(this.last.keys().next().value);
		return true;
	}
}
