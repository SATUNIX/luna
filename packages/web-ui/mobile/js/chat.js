// chat.js — pi-console's chat renderer, adapted for a phone, and the approval cards.
//
// MobileChat reuses ChatRenderer (public/js/render.js) so a session reads the same here as in
// pi-console: markdown answers, thinking blocks, tool cards. On top of it: history is drawn at
// once instead of animated, a phone joining mid-answer can be given the work in progress, each
// assistant message gets its own bubble, and a prompt shows as pending until pi echoes it.
import { ChatRenderer, el } from "../../public/js/render.js";

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => p && p.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("");
}

const QUIET = new Set(["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end"]);

export class MobileChat extends ChatRenderer {
	constructor(logNode) {
		super(logNode);
		this.replaying = false;
		this.pending = [];
	}

	reset() {
		super.reset();
		this.pending = [];
	}

	handle(event) {
		if (!event || typeof event !== "object") return;
		// Run state is shown in the header, not as chat lines.
		if (QUIET.has(event.type)) return;
		if (event.type === "message_start" && event.message) {
			if (event.message.role === "user") this.settlePending(textOf(event.message.content));
			// A new assistant message (after a tool call, say) gets its own bubble.
			if (event.message.role === "assistant") this.closeAssistant();
		}
		super.handle(event);
	}

	closeAssistant() {
		if (this.assistantBody) this.flushMarkdown();
		if (this.assistantMsg && this.assistantRaw === "" && !this.assistantBody?.childNodes.length) this.assistantMsg.remove();
		this.assistantBody = null;
		this.assistantMsg = null;
		this.assistantRaw = null;
		this.thinkingNode = null;
	}

	/**
	 * A live answer's bubble is created by its first text, not by message_start, so thinking
	 * (which streams first) reads above the answer, and a tool-only message leaves no empty bubble.
	 */
	handleMessageStart(event) {
		const message = event.message || {};
		if (message.role === "assistant") return;
		super.handleMessageStart(event);
	}

	handleMessageEnd(event) {
		const message = event.message || {};
		if (message.role === "assistant" && !this.assistantBody && textOf(message.content)) this.startAssistant();
		super.handleMessageEnd(event);
	}

	/** History: thinking first, then the answer, then its tool calls; no empty bubbles. */
	renderParts(parts) {
		for (const part of parts) if (part.type === "thinking" && part.thinking) this.appendThinkingBlock(part.thinking);
		const texts = parts.filter((part) => part.type === "text" && part.text);
		if (texts.length) super.renderParts(texts);
		for (const part of parts) if (part.type === "toolCall") this.observedToolCall(part);
		this.finishObserved();
	}

	/** A tool call after an answer with no text: drop the empty "pi" bubble it left. */
	toolStart(event) {
		if (this.assistantMsg && !this.assistantRaw) this.closeAssistant();
		super.toolStart(event);
	}

	/** History arrives as complete messages; draw them at once instead of revealing them. */
	renderFullMessage(message) {
		if (message && message.role === "user") this.settlePending(textOf(message.content));
		if (this.replaying && message && message.role === "assistant") {
			const parts = (Array.isArray(message.content) ? message.content : []).filter((p) => p && typeof p === "object");
			this.renderParts(parts);
			return;
		}
		super.renderFullMessage(message);
	}

	/** The answer and tools in flight when this phone joined (sent once, after the history). */
	applyStreaming(state) {
		if (!state || typeof state !== "object") return;
		const message = state.message;
		if (message && Array.isArray(message.content)) {
			this.closeAssistant();
			for (const part of message.content) {
				if (part && part.type === "thinking" && part.thinking) this.appendThinking(part.thinking);
			}
			const text = textOf(message.content);
			if (text) {
				this.startAssistant();
				this.assistantRaw = text;
				this.flushMarkdown();
			}
		}
		for (const tool of Array.isArray(state.tools) ? state.tools : []) {
			if (tool && tool.toolCallId) this.toolStart({ toolCallId: tool.toolCallId, toolName: tool.toolName, args: tool.args });
		}
		this.scroll();
	}

	/** Show a prompt the moment it is sent; pi's own echo replaces it. */
	addPending(text) {
		const node = el("div", { class: "msg msg-user is-pending" }, [
			el("div", { class: "msg-head" }, [el("span", { text: "you" }), el("span", { class: "pending-label", text: "sending" })]),
			el("div", { class: "msg-body", text }),
		]);
		this.log.append(node);
		this.pending.push({ text: text.trim(), node });
		this.scroll(true);
		return node;
	}

	settlePending(text) {
		if (!this.pending.length) return;
		const wanted = String(text || "").trim();
		let index = this.pending.findIndex((p) => p.text === wanted);
		if (index === -1) index = 0;
		const [entry] = this.pending.splice(index, 1);
		entry.node.remove();
	}

	failPending(node, message) {
		const entry = this.pending.find((p) => p.node === node);
		if (!entry) return;
		node.classList.add("is-failed");
		const label = node.querySelector(".pending-label");
		if (label) label.textContent = message || "not sent";
		this.pending = this.pending.filter((p) => p !== entry);
	}
}

// ------------------------------------------------------------- approval cards ---
const POSITIVE = /^(allow|approve|yes|accept|continue|proceed|ok|confirm|run)/i;
const NEGATIVE = /^(deny|reject|no|cancel|abort|block|stop|refuse|don't|do not)/i;

function countdown(node, openedAt, timeoutMs) {
	if (!timeoutMs || timeoutMs <= 0) return () => {};
	const deadline = Date.parse(openedAt || "") + timeoutMs || Date.now() + timeoutMs;
	const tick = () => {
		const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
		node.textContent = left > 0 ? `expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "expired";
	};
	tick();
	const timer = setInterval(tick, 1000);
	return () => clearInterval(timer);
}

/**
 * A card for a dialog pi opened (a tool approval, a choice, a question).
 * `answer(payload)` sends {value}|{confirmed}|{cancelled} and resolves when the host accepted it.
 */
export function dialogCard(dialog, answer) {
	const status = el("div", { class: "dialog-status" });
	const expires = el("span", { class: "dialog-expires" });
	const kind = dialog.method === "input" ? "Input needed" : dialog.method === "confirm" ? "Confirm" : "Approval needed";
	const body = [];
	if (dialog.title) body.push(el("div", { class: "dialog-title", text: dialog.title }));
	if (dialog.message) body.push(el("div", { class: "dialog-message", text: dialog.message }));

	const actions = el("div", { class: "dialog-actions" });
	const buttons = [];
	const send = async (payload, button) => {
		for (const b of buttons) b.disabled = true;
		if (button) button.classList.add("is-busy");
		status.textContent = "sending…";
		try {
			await answer(payload);
			status.textContent = "sent";
			card.classList.add("is-answered");
		} catch (error) {
			for (const b of buttons) b.disabled = false;
			if (button) button.classList.remove("is-busy");
			status.textContent = error && error.message ? error.message : "could not send the answer";
		}
	};
	const button = (label, cls, payload) => {
		const b = el("button", { class: `btn ${cls}`, type: "button", text: label, onclick: () => send(payload, b) });
		buttons.push(b);
		return b;
	};

	if (dialog.method === "select") {
		for (const option of dialog.options || []) {
			const cls = NEGATIVE.test(option) ? "btn-danger" : POSITIVE.test(option) ? "btn-primary" : "btn-ghost";
			actions.append(button(option, `${cls} btn-block`, { value: option }));
		}
		actions.append(button("Dismiss", "btn-quiet btn-block", { cancelled: true }));
	} else if (dialog.method === "confirm") {
		actions.classList.add("is-row");
		actions.append(button("Deny", "btn-danger", { confirmed: false }), button("Approve", "btn-primary", { confirmed: true }));
	} else {
		const input = el("textarea", { class: "dialog-input", rows: "3", placeholder: dialog.placeholder || "" });
		const row = el("div", { class: "dialog-actions is-row" });
		const submit = button("Send", "btn-primary", null);
		submit.onclick = () => send({ value: input.value }, submit);
		row.append(button("Cancel", "btn-ghost", { cancelled: true }), submit);
		actions.append(input, row);
	}

	const card = el("section", { class: `dialog-card dialog-${dialog.method}`, dataset: { id: dialog.id } }, [
		el("div", { class: "dialog-head" }, [el("span", { class: "dialog-kind", text: kind }), expires]),
		...body,
		actions,
		status,
		el("div", { class: "dialog-foot", text: "Answer here or at the computer: the first answer counts." }),
	]);
	card.dispose = countdown(expires, dialog.openedAt, dialog.timeout);
	return card;
}
