// Generated from packages/web-ui/src/public/js/render.ts by `npm run build:web` (internal/docs/adr/0002).
// Edit the TypeScript source, not this file.
// render.ts — DOM construction helpers and the chat event renderer.
// All user/tool data is inserted as text nodes (no HTML parsing) to avoid injection.
// Assistant text is rendered as markdown via ./markdown.ts (which also builds DOM nodes only).
import { renderMarkdown } from "./markdown.js";
import { asRecord, displayText, isArray, isObject, toText } from "./guards.js";
/** Respect the OS "reduce motion" setting for the message reveal animation. */
function prefersReducedMotion() {
    try {
        if (typeof window === "undefined")
            return false;
        return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    }
    catch {
        return false;
    }
}
function isChildList(children) {
    return Array.isArray(children);
}
/** An `on<event>` prop value: the handler is called with the event, as `addEventListener` does. */
function isListener(value) {
    return typeof value === "function";
}
export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === "class")
            node.className = toText(value);
        else if (key === "text")
            node.textContent = displayText(value);
        // The page's CSP has no 'unsafe-inline' for styles. That blocks an inline style
        // attribute (including one written through the generic attribute setter below) but
        // not the CSSOM, so a style string is assigned through the latter.
        else if (key === "style" && typeof value === "string")
            node.style.cssText = value;
        else if (key === "dataset")
            Object.assign(node.dataset, value);
        else if (key.startsWith("on") && isListener(value))
            node.addEventListener(key.slice(2), value);
        else if (value !== undefined && value !== null && value !== false)
            node.setAttribute(key, value === true ? "" : toText(value));
    }
    for (const child of isChildList(children) ? children : [children]) {
        if (child === null || child === undefined)
            continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}
export function clear(node) {
    while (node.firstChild)
        node.removeChild(node.firstChild);
}
export function relativeTime(iso) {
    if (!iso)
        return "";
    if (typeof iso !== "string" && typeof iso !== "number" && !(iso instanceof Date))
        return "";
    const then = new Date(iso).getTime();
    if (Number.isNaN(then))
        return "";
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60)
        return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60)
        return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24)
        return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}
export function shortId(id) {
    return id ? toText(id).slice(0, 8) : "—";
}
/** Render the sidebar session list. */
export function renderSessions(listNode, sessions, activeId, onSelect) {
    clear(listNode);
    if (!sessions.length) {
        listNode.append(el("li", { class: "session-item" }, [
            el("div", { class: "session-preview", text: "No sessions found." }),
        ]));
        return;
    }
    for (const s of sessions) {
        const id = displayText(s.id);
        const running = s.status === "running";
        const external = s.status === "external";
        const dotClass = running ? " is-running" : external ? " is-external" : "";
        const dotTitle = running
            ? "running (this console)"
            : external
                ? "active in another process"
                : "idle";
        const item = el("li", {
            class: `session-item${s.id === activeId ? " is-active" : ""}`,
            dataset: { id },
            onclick: () => onSelect(id),
        }, [
            el("div", { class: "session-row" }, [
                el("span", { class: `session-status${dotClass}`, title: dotTitle }),
                el("span", { class: "session-id", text: shortId(s.id) }),
                el("span", {
                    class: "session-when",
                    text: relativeTime(s.lastActivityAt),
                }),
            ]),
            el("div", { class: "session-cwd", text: displayText(s.cwd || "") }),
            s.agent
                ? el("div", { class: "session-agent", text: `agent: ${displayText(s.agent)}` })
                : null,
            s.preview
                ? el("div", { class: "session-preview", text: displayText(s.preview) })
                : null,
        ]);
        listNode.append(item);
    }
}
/** Render the agents grid. `handlers` = {onUse, onEdit, onDelete}. */
export function renderAgents(gridNode, agents, handlers = {}) {
    clear(gridNode);
    if (!agents.length) {
        gridNode.append(el("article", { class: "agent-card" }, [
            el("p", { class: "agent-desc", text: "No agents found." }),
        ]));
        return;
    }
    for (const a of agents) {
        const chips = (isArray(a.tools) && a.tools.length ? a.tools : ["all tools"]).map((t) => el("span", { class: "tool-chip", text: displayText(t) }));
        gridNode.append(el("article", { class: "agent-card" }, [
            el("div", { class: "agent-name", text: displayText(a.name) }),
            el("p", {
                class: "agent-desc",
                text: displayText(a.description || "(no description)"),
            }),
            el("div", { class: "agent-tools" }, chips),
            el("div", { class: "agent-foot" }, [
                el("span", {
                    class: `badge${a.source === "project" ? " badge-project" : ""}`,
                    text: displayText(a.source),
                }),
                el("div", { class: "agent-actions" }, [
                    el("button", {
                        class: "btn btn-ghost",
                        type: "button",
                        onclick: () => handlers.onUse?.(a),
                    }, ["Run"]),
                    el("button", {
                        class: "btn btn-ghost",
                        type: "button",
                        onclick: () => handlers.onEdit?.(a),
                    }, ["Edit"]),
                    el("button", {
                        class: "btn btn-ghost",
                        type: "button",
                        onclick: () => handlers.onDelete?.(a),
                    }, ["Delete"]),
                ]),
            ]),
        ]));
    }
}
/** The text parts of a message's content (a string, or an array of parts), joined. */
function textOfContent(content) {
    if (typeof content === "string")
        return content;
    if (!isArray(content))
        return "";
    return content
        .map((p) => (isObject(p) && p.type === "text" && typeof p.text === "string" ? p.text : ""))
        .join("");
}
/** Renders pi events into a chat log element, live. */
export class ChatRenderer {
    log;
    assistantBody = null;
    assistantMsg = null;
    thinkingNode = null;
    /** The streamed markdown source of the open assistant message; null when none is open. */
    assistantRaw = null;
    tools = new Map(); // toolCallId -> {node, output, state}
    pendingToolResults = new Map(); // toolCallId -> message (arrived before its call)
    stick = true; // follow new output unless the reader scrolled up
    onStickChange = null;
    revealTimer = null;
    markdownTimer = null;
    revealState = null;
    constructor(logNode) {
        this.log = logNode;
        if (this.log && typeof this.log.addEventListener === "function") {
            this.log.addEventListener("scroll", () => this.updateStick());
        }
    }
    reset() {
        clear(this.log);
        this.assistantBody = null;
        this.assistantMsg = null;
        this.thinkingNode = null;
        this.assistantRaw = null;
        this.stick = true;
        if (this.onStickChange)
            this.onStickChange(true);
        if (this.markdownTimer) {
            clearTimeout(this.markdownTimer);
            this.markdownTimer = null;
        }
        if (this.revealTimer) {
            clearTimeout(this.revealTimer);
            this.revealTimer = null;
        }
        this.tools.clear();
        this.pendingToolResults.clear();
    }
    emptyState() {
        this.reset();
        this.log.append(el("div", { class: "empty" }, [
            el("p", { class: "empty-title", text: "No session open" }),
            el("p", {
                class: "empty-sub",
                text: "Pick a session on the left, or create a new one.",
            }),
        ]));
    }
    system(text) {
        this.log.append(el("div", { class: "msg msg-system", text }));
        this.scroll();
    }
    error(text) {
        this.log.append(el("div", { class: "msg msg-system msg-error", text }));
        this.scroll();
    }
    userMessage(text) {
        this.log.append(el("div", { class: "msg msg-user" }, [
            el("div", { class: "msg-head" }, [el("span", { text: "you" })]),
            el("div", { class: "msg-body", text }),
        ]));
        this.assistantBody = null;
        this.scroll();
    }
    /** Handle a raw pi event object. */
    handle(event) {
        if (!isObject(event))
            return;
        switch (event.type) {
            case "agent_start":
                this.system("agent started");
                break;
            case "message_start":
                this.handleMessageStart(event);
                break;
            case "message_end":
                this.handleMessageEnd(event);
                break;
            case "message_update":
                this.handleUpdate(event);
                break;
            case "tool_execution_start":
                this.toolStart(event);
                break;
            case "tool_execution_update":
                this.toolUpdate(event);
                break;
            case "tool_execution_end":
                this.toolEnd(event);
                break;
            case "compaction_start":
                this.system("compaction started");
                break;
            case "compaction_end":
                this.system("compaction finished");
                break;
            case "auto_retry_start":
                this.system("retrying after a transient error…");
                break;
            case "extension_error":
                this.error(`extension error: ${displayText(event.error || "unknown")}`);
                break;
            case "observed":
            case "observed_message":
            case "observed_compaction":
            case "observed_model_change":
            case "observed_thinking_level":
            case "observed_activity":
                this.handleObserved(event.type === "observed" ? event.data : event);
                break;
            default:
                break;
        }
    }
    handleMessageStart(event) {
        const msg = asRecord(event.message);
        if (msg.role === "user") {
            const text = textOfContent(msg.content);
            if (text)
                this.userMessage(text);
        }
        else if (msg.role === "assistant") {
            this.startAssistant();
        }
    }
    /**
     * Observed events come from tailing a session file written by another pi process
     * (the CLI). They carry complete messages rather than streaming deltas.
     */
    handleObserved(observed) {
        if (!isObject(observed))
            return;
        switch (observed.type) {
            case "observed_message":
                this.renderFullMessage(observed.message);
                break;
            case "observed_compaction":
                this.system("compaction checkpoint");
                break;
            case "observed_model_change":
                this.system(`model → ${displayText(observed.modelId || observed.provider || "changed")}`);
                break;
            case "observed_thinking_level":
                this.system(`thinking → ${toText(observed.level)}`);
                break;
            case "observed_activity":
                this.scroll();
                break;
            default:
                break;
        }
    }
    /** Render a complete message (no deltas) from an observed session entry. */
    renderFullMessage(message) {
        if (!isObject(message))
            return;
        if (message.role === "user") {
            const text = textOfContent(message.content);
            if (text)
                this.userMessage(text);
            return;
        }
        if (message.role === "toolResult") {
            this.observedToolResult(message);
            return;
        }
        if (message.role !== "assistant")
            return;
        const parts = (isArray(message.content) ? message.content : []).filter(isObject);
        const textLength = parts.reduce((total, part) => total + (part.type === "text" && typeof part.text === "string" ? part.text.length : 0), 0);
        // Very long messages and reduced-motion users skip the reveal.
        if (textLength === 0 || textLength > 20000 || prefersReducedMotion()) {
            this.renderParts(parts);
            return;
        }
        this.streamParts(parts);
    }
    /** Render observed parts immediately (no animation). */
    renderParts(parts) {
        const body = el("div", { class: "msg-body md-body" });
        const node = el("div", { class: "msg msg-assistant" }, [
            el("div", { class: "msg-head" }, [el("span", { text: "pi" })]),
            body,
        ]);
        this.log.append(node);
        let wrote = false;
        for (const part of parts) {
            if (part.type === "text" && part.text) {
                body.appendChild(renderMarkdown(displayText(part.text)));
                wrote = true;
            }
            else if (part.type === "thinking" && part.thinking) {
                this.appendThinkingBlock(displayText(part.thinking));
                wrote = true;
            }
            else if (part.type === "toolCall") {
                this.observedToolCall(part);
                wrote = true;
            }
        }
        if (!wrote)
            node.remove();
        this.finishObserved();
    }
    /**
     * Stream an observed (tailed) message in. A session running in the CLI flushes whole
     * messages, so without this the reply would appear as one block; here the text is revealed
     * progressively while keeping the original order of text/thinking/tool parts.
     */
    streamParts(parts) {
        this.finishPendingReveal();
        this.startAssistant();
        this.assistantRaw = "";
        let index = 0;
        const next = () => {
            const part = parts[index++];
            if (!part) {
                this.finishObserved();
                return;
            }
            if (part.type === "text" && part.text) {
                this.revealText(displayText(part.text), next);
                return;
            }
            if (part.type === "thinking" && part.thinking) {
                this.appendThinkingBlock(displayText(part.thinking));
            }
            else if (part.type === "toolCall") {
                this.observedToolCall(part);
            }
            next();
        };
        next();
    }
    revealText(text, done) {
        const reveal = { full: text, complete: null };
        this.revealState = reveal;
        const total = text.length;
        const steps = Math.max(6, Math.min(70, Math.round(total / 45)));
        const chunk = Math.max(1, Math.ceil(total / steps));
        let shown = 0;
        const tick = () => {
            this.revealTimer = null;
            shown = Math.min(total, shown + chunk);
            this.assistantRaw = text.slice(0, shown);
            this.flushMarkdown();
            if (shown < total)
                this.revealTimer = setTimeout(tick, 22);
            else {
                this.revealState = null;
                done();
            }
        };
        // Lets an interrupting event drive the reveal to completion through the normal path,
        // so the remaining parts (tools, etc.) still render in order.
        reveal.complete = () => {
            shown = total;
            tick();
        };
        tick();
    }
    /** If a reveal is mid-flight, complete it immediately so text is never left truncated. */
    finishPendingReveal() {
        const state = this.revealState;
        if (!state)
            return;
        if (this.revealTimer) {
            clearTimeout(this.revealTimer);
            this.revealTimer = null;
        }
        this.revealState = null;
        if (state.complete)
            state.complete();
    }
    finishObserved() {
        this.assistantBody = null;
        this.assistantMsg = null;
        this.assistantRaw = null;
        this.thinkingNode = null;
        this.flushPendingToolResults();
        this.scroll();
    }
    appendThinkingBlock(text) {
        const pre = el("div", { class: "thinking", text });
        this.log.append(el("details", {}, [el("summary", { text: "thinking" }), pre]));
    }
    observedToolCall(part) {
        const output = el("pre", { class: "tool-output" });
        const state = el("span", { class: "tool-state-running", text: "called" });
        const node = el("div", { class: "tool" }, [
            el("div", { class: "tool-head" }, [
                el("span", { class: "tool-name", text: displayText(part.name || "tool") }),
                state,
            ]),
            el("div", {
                class: "tool-args mono-sm muted",
                text: summarizeArgs(part.arguments),
            }),
            output,
        ]);
        this.log.append(node);
        if (part.id) {
            this.tools.set(part.id, { node, output, state });
            // A result may have arrived while the assistant text was still streaming in.
            const buffered = this.pendingToolResults.get(part.id);
            if (buffered) {
                this.pendingToolResults.delete(part.id);
                this.applyToolResult(buffered);
            }
        }
        this.scroll();
    }
    observedToolResult(message) {
        if (message.toolCallId && !this.tools.has(message.toolCallId)) {
            // Buffer it: the matching call has not been rendered yet (reveal still in flight).
            this.pendingToolResults.set(message.toolCallId, message);
            return;
        }
        if (!message.toolCallId) {
            // No way to correlate: show it as a standalone result block.
            const result = textOfContent(message.content);
            this.log.append(el("div", { class: "tool" }, [
                el("div", { class: "tool-head" }, [
                    el("span", { class: "tool-name", text: displayText(message.toolName || "tool") }),
                    el("span", {
                        class: message.isError ? "tool-state-error" : "tool-state-running",
                        text: message.isError ? "error" : "done",
                    }),
                ]),
                el("pre", { class: "tool-output", text: result }),
            ]));
            this.scroll();
            return;
        }
        this.applyToolResult(message);
    }
    applyToolResult(message) {
        const entry = this.tools.get(message.toolCallId);
        if (!entry)
            return;
        const result = textOfContent(message.content);
        entry.state.textContent = message.isError ? "error" : "done";
        entry.state.className = message.isError ? "tool-state-error" : "tool-state-running";
        if (result)
            entry.output.textContent = result;
        this.scroll();
    }
    /** Anything still buffered has no matching call in view; show it so nothing is lost. */
    flushPendingToolResults() {
        for (const message of this.pendingToolResults.values()) {
            const result = textOfContent(message.content);
            this.log.append(el("div", { class: "tool" }, [
                el("div", { class: "tool-head" }, [
                    el("span", { class: "tool-name", text: displayText(message.toolName || "tool") }),
                    el("span", {
                        class: message.isError ? "tool-state-error" : "tool-state-running",
                        text: message.isError ? "error" : "done",
                    }),
                ]),
                el("pre", { class: "tool-output", text: result }),
            ]));
        }
        this.pendingToolResults.clear();
    }
    handleMessageEnd(event) {
        const msg = asRecord(event.message);
        if (msg.role !== "assistant")
            return;
        // If the provider answered without streaming deltas, render the full text now.
        const text = textOfContent(msg.content);
        if (text && !this.assistantRaw)
            this.assistantRaw = text;
        this.flushMarkdown();
    }
    handleUpdate(event) {
        const delta = asRecord(event.assistantMessageEvent);
        if (delta.type === "text_delta" && typeof delta.delta === "string") {
            this.appendAssistant(delta.delta);
        }
        else if (delta.type === "thinking_delta" &&
            typeof delta.delta === "string") {
            this.appendThinking(delta.delta);
        }
    }
    startAssistant() {
        if (this.assistantBody)
            return;
        const body = el("div", { class: "msg-body md-body" });
        const node = el("div", { class: "msg msg-assistant" }, [
            el("div", { class: "msg-head" }, [el("span", { text: "pi" })]),
            body,
        ]);
        this.log.append(node);
        this.assistantMsg = node;
        this.assistantBody = body;
        this.assistantRaw = "";
        this.thinkingNode = null;
    }
    /** Accumulate streamed text, then re-render markdown (throttled while streaming). */
    appendAssistant(text) {
        // A live delta must not be clobbered by an in-flight reveal of an observed message.
        if (this.revealState)
            this.finishPendingReveal();
        if (!this.assistantBody)
            this.startAssistant();
        this.assistantRaw = (this.assistantRaw || "") + text;
        if (this.markdownTimer)
            return;
        this.markdownTimer = setTimeout(() => {
            this.markdownTimer = null;
            this.flushMarkdown();
        }, 120);
    }
    /** Render the accumulated markdown into the assistant body. */
    flushMarkdown() {
        if (!this.assistantBody || this.assistantRaw === null)
            return;
        if (this.markdownTimer) {
            clearTimeout(this.markdownTimer);
            this.markdownTimer = null;
        }
        this.assistantBody.replaceChildren(renderMarkdown(this.assistantRaw));
        this.scroll();
    }
    appendThinking(text) {
        if (!this.thinkingNode) {
            const pre = el("div", { class: "thinking" });
            const details = el("details", {}, [
                el("summary", { text: "thinking" }),
                pre,
            ]);
            this.log.append(details);
            this.thinkingNode = pre;
        }
        this.thinkingNode.append(document.createTextNode(text));
        this.scroll();
    }
    toolStart(event) {
        const output = el("pre", { class: "tool-output" });
        const state = el("span", { class: "tool-state-running", text: "running" });
        const node = el("div", { class: "tool" }, [
            el("div", { class: "tool-head" }, [
                el("span", { class: "tool-name", text: displayText(event.toolName || "tool") }),
                state,
            ]),
            el("div", {
                class: "tool-args mono-sm muted",
                text: summarizeArgs(event.args),
            }),
            output,
        ]);
        this.log.append(node);
        this.tools.set(event.toolCallId, { node, output, state });
        this.scroll();
    }
    toolUpdate(event) {
        const entry = this.tools.get(event.toolCallId);
        if (!entry)
            return;
        entry.output.textContent = textOfContent(asRecord(event.partialResult).content);
        this.scroll();
    }
    toolEnd(event) {
        const entry = this.tools.get(event.toolCallId);
        if (!entry)
            return;
        entry.state.textContent = event.isError ? "error" : "done";
        entry.state.className = event.isError
            ? "tool-state-error"
            : "tool-state-running";
        if (!entry.state.textContent)
            entry.state.remove();
        const result = textOfContent(asRecord(event.result).content);
        if (result)
            entry.output.textContent = result;
        this.scroll();
    }
    /** Follow the tail unless the reader has scrolled away; report that state upward. */
    updateStick() {
        const el = this.log;
        const distance = (el.scrollHeight || 0) - (el.scrollTop || 0) - (el.clientHeight || 0);
        const stick = distance < 90;
        if (stick !== this.stick) {
            this.stick = stick;
            if (this.onStickChange)
                this.onStickChange(stick);
        }
    }
    scroll(force = false) {
        if (force || this.stick) {
            this.log.scrollTop = this.log.scrollHeight;
        }
        this.updateStick();
    }
    /** Jump to the newest message and resume following. */
    goToEnd() {
        this.stick = true;
        if (this.onStickChange)
            this.onStickChange(true);
        this.log.scrollTop = this.log.scrollHeight;
    }
}
function summarizeArgs(args) {
    if (!isObject(args))
        return "";
    const keys = Object.keys(args);
    const first = keys[0];
    if (first === undefined)
        return "";
    const value = toText(args[first]);
    return `${first}: ${value.length > 120 ? `${value.slice(0, 120)}…` : value}`;
}
