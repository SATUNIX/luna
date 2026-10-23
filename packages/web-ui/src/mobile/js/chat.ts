// chat.js — pi-console's chat renderer, adapted for a phone, and the approval cards.
//
// MobileChat reuses ChatRenderer (public/js/render.js) so a session reads the same here as in
// pi-console: markdown answers, thinking blocks, tool cards. On top of it: history is drawn at
// once instead of animated, a phone joining mid-answer can be given the work in progress, each
// assistant message gets its own bubble, and a prompt shows as pending until pi echoes it.
//
// Events, messages and dialogs come from the computer through the app: `unknown` until narrowed.
import { ChatRenderer, el } from "../../public/js/render.ts";

/** A pi event, message or content part once it is known to be an object. */
type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
	return typeof value === "object" && value !== null;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p: unknown): p is Rec & { text: string } => isRecord(p) && p.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("");
}

const QUIET = new Set(["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end"]);

interface PendingPrompt {
	text: string;
	node: HTMLElement;
}

export class MobileChat extends ChatRenderer {
	replaying: boolean;
	pending: PendingPrompt[];

	constructor(logNode: HTMLElement) {
		super(logNode);
		this.replaying = false;
		this.pending = [];
	}

	override reset(): void {
		super.reset();
		this.pending = [];
	}

	override handle(event: unknown): void {
		if (!isRecord(event)) return;
		// Run state is shown in the header, not as chat lines.
		if (typeof event.type === "string" && QUIET.has(event.type)) return;
		if (event.type === "message_start" && isRecord(event.message)) {
			if (event.message.role === "user") this.settlePending(textOf(event.message.content));
			// A new assistant message (after a tool call, say) gets its own bubble.
			if (event.message.role === "assistant") this.closeAssistant();
		}
		super.handle(event);
	}

	closeAssistant(): void {
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
	override handleMessageStart(event: Rec): void {
		const message = isRecord(event.message) ? event.message : {};
		if (message.role === "assistant") return;
		super.handleMessageStart(event);
	}

	override handleMessageEnd(event: Rec): void {
		const message = isRecord(event.message) ? event.message : {};
		if (message.role === "assistant" && !this.assistantBody && textOf(message.content)) this.startAssistant();
		super.handleMessageEnd(event);
	}

	/** History: thinking first, then the answer, then its tool calls; no empty bubbles. */
	override renderParts(parts: Rec[]): void {
		for (const part of parts) if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking) this.appendThinkingBlock(part.thinking);
		const texts = parts.filter((part) => part.type === "text" && part.text);
		if (texts.length) super.renderParts(texts);
		for (const part of parts) if (part.type === "toolCall") this.observedToolCall(part);
		this.finishObserved();
	}

	/** A tool call after an answer with no text: drop the empty "pi" bubble it left. */
	override toolStart(event: Rec): void {
		if (this.assistantMsg && !this.assistantRaw) this.closeAssistant();
		super.toolStart(event);
	}

	/** History arrives as complete messages; draw them at once instead of revealing them. */
	override renderFullMessage(message: unknown): void {
		if (isRecord(message) && message.role === "user") this.settlePending(textOf(message.content));
		if (this.replaying && isRecord(message) && message.role === "assistant") {
			const content: unknown[] = Array.isArray(message.content) ? message.content : [];
			const parts = content.filter(isRecord);
			this.renderParts(parts);
			return;
		}
		super.renderFullMessage(message);
	}

	/** The answer and tools in flight when this phone joined (sent once, after the history). */
	applyStreaming(state: unknown): void {
		if (!isRecord(state)) return;
		const message = state.message;
		if (isRecord(message) && Array.isArray(message.content)) {
			this.closeAssistant();
			const content: unknown[] = message.content;
			for (const part of content) {
				if (isRecord(part) && part.type === "thinking" && typeof part.thinking === "string" && part.thinking) this.appendThinking(part.thinking);
			}
			const text = textOf(message.content);
			if (text) {
				this.startAssistant();
				this.assistantRaw = text;
				this.flushMarkdown();
			}
		}
		const tools: unknown[] = Array.isArray(state.tools) ? state.tools : [];
		for (const tool of tools) {
			if (isRecord(tool) && tool.toolCallId) this.toolStart({ toolCallId: tool.toolCallId, toolName: tool.toolName, args: tool.args });
		}
		this.scroll();
	}

	/** Show a prompt the moment it is sent; pi's own echo replaces it. */
	addPending(text: string): HTMLElement {
		const node = el("div", { class: "msg msg-user is-pending" }, [
			el("div", { class: "msg-head" }, [el("span", { text: "you" }), el("span", { class: "pending-label", text: "sending" })]),
			el("div", { class: "msg-body", text }),
		]);
		this.log.append(node);
		this.pending.push({ text: text.trim(), node });
		this.scroll(true);
		return node;
	}

	settlePending(text: string): void {
		if (!this.pending.length) return;
		const wanted = text.trim();
		let index = this.pending.findIndex((p) => p.text === wanted);
		if (index === -1) index = 0;
		const [entry] = this.pending.splice(index, 1);
		entry?.node.remove();
	}

	failPending(node: HTMLElement, message?: string): void {
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

/** A dialog pi opened, as main.ts narrows it from a ui_request frame. */
export interface Dialog {
	id: string;
	method: string;
	title?: string | undefined;
	message?: string | undefined;
	options?: string[] | undefined;
	placeholder?: string | undefined;
	/** Milliseconds from `openedAt`. */
	timeout?: number | undefined;
	openedAt?: string | undefined;
}

export type DialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

/** A dialog card; `dispose()` stops its countdown. */
export type DialogCard = HTMLElement & { dispose: () => void };

function countdown(node: HTMLElement, openedAt: string | undefined, timeoutMs: number | undefined): () => void {
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
export function dialogCard(dialog: Dialog, answer: (payload: DialogAnswer) => Promise<unknown>): DialogCard {
	const status = el("div", { class: "dialog-status" });
	const expires = el("span", { class: "dialog-expires" });
	const kind = dialog.method === "input" ? "Input needed" : dialog.method === "confirm" ? "Confirm" : "Approval needed";
	const body: HTMLElement[] = [];
	if (dialog.title) body.push(el("div", { class: "dialog-title", text: dialog.title }));
	if (dialog.message) body.push(el("div", { class: "dialog-message", text: dialog.message }));

	const actions = el("div", { class: "dialog-actions" });
	const buttons: HTMLButtonElement[] = [];
	const send = async (payload: DialogAnswer, button: HTMLButtonElement): Promise<void> => {
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
			status.textContent = error instanceof Error && error.message ? error.message : "could not send the answer";
		}
	};
	// `payload` is the answer, or a function that reads it at the tap (a typed value).
	const button = (label: string, cls: string, payload: DialogAnswer | (() => DialogAnswer)): HTMLButtonElement => {
		const b = el("button", { class: `btn ${cls}`, type: "button", text: label, onclick: () => { void send(typeof payload === "function" ? payload() : payload, b); } });
		buttons.push(b);
		return b;
	};

	if (dialog.method === "select") {
		for (const option of dialog.options ?? []) {
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
		row.append(button("Cancel", "btn-ghost", { cancelled: true }), button("Send", "btn-primary", () => ({ value: input.value })));
		actions.append(input, row);
	}

	const card = el("section", { class: `dialog-card dialog-${dialog.method}`, dataset: { id: dialog.id } }, [
		el("div", { class: "dialog-head" }, [el("span", { class: "dialog-kind", text: kind }), expires]),
		...body,
		actions,
		status,
		el("div", { class: "dialog-foot", text: "Answer here or at the computer: the first answer counts." }),
	]);
	return Object.assign(card, { dispose: countdown(expires, dialog.openedAt, dialog.timeout) });
}
