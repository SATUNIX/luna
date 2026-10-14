// slim.js — make pi's session events fit a phone on mobile data.
//
// pi streams every assistant delta together with the whole response so far (`partial`, and
// `message` on message_update), so a long answer costs O(n^2) bytes. The renderer only uses the
// delta, so those snapshots are dropped here. Large tool arguments and outputs are cut to a
// readable size, images are replaced by a marker, and per-run summaries that repeat the whole
// transcript (agent_end.messages, turn_end) are reduced. message_end keeps the final message,
// which is how a non-streaming answer is rendered.

const TEXT_LIMIT = 20_000;
const UPDATE_TAIL = 8_000;
const ARG_LIMIT = 2_000;

function cutText(text, limit) {
	if (typeof text !== "string" || text.length <= limit) return text;
	return `${text.slice(0, limit)}\n… [${text.length - limit} more characters on the computer]`;
}

function tailText(text, limit) {
	if (typeof text !== "string" || text.length <= limit) return text;
	return `[… ${text.length - limit} earlier characters]\n${text.slice(-limit)}`;
}

function slimContent(content, limit = TEXT_LIMIT, cut = cutText) {
	if (typeof content === "string") return cut(content, limit);
	if (!Array.isArray(content)) return content;
	return content.map((part) => {
		if (!part || typeof part !== "object") return part;
		if (part.type === "image") return { type: "image", mimeType: part.mimeType, omitted: true };
		if (part.type === "text") return { ...part, text: cut(part.text, limit) };
		if (part.type === "thinking") return { ...part, thinking: cut(part.thinking, limit), thinkingSignature: undefined };
		if (part.type === "toolCall") return { ...part, arguments: slimArgs(part.arguments) };
		return part;
	});
}

export function slimArgs(args) {
	if (!args || typeof args !== "object") return args;
	const out = Array.isArray(args) ? [] : {};
	for (const [key, value] of Object.entries(args)) {
		out[key] = typeof value === "string" ? cutText(value, ARG_LIMIT) : value;
	}
	return out;
}

export function slimMessage(message) {
	if (!message || typeof message !== "object") return message;
	return { ...message, content: slimContent(message.content) };
}

function slimResult(result, limit, cut) {
	if (!result || typeof result !== "object") return result;
	return { content: slimContent(result.content, limit, cut), isError: result.isError };
}

/** A slimmed copy of one pi session event (never mutates the input). */
export function slimEvent(event) {
	if (!event || typeof event !== "object") return event;
	switch (event.type) {
		case "message_update": {
			const ame = event.assistantMessageEvent || {};
			const kept = { type: ame.type };
			if (ame.contentIndex !== undefined) kept.contentIndex = ame.contentIndex;
			if (typeof ame.delta === "string") kept.delta = ame.delta;
			if (ame.type === "toolcall_end" && ame.toolCall) kept.toolCall = { ...ame.toolCall, arguments: slimArgs(ame.toolCall.arguments) };
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
	constructor(intervalMs = 250) {
		this.intervalMs = intervalMs;
		this.last = new Map();
	}

	pass(event) {
		if (!event || event.type !== "tool_execution_update") {
			if (event && event.type === "tool_execution_end") this.last.delete(event.toolCallId);
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
