// bridge.ts — expose the session running in this terminal to linked phones, through the host.
//
// While attached, every session event is forwarded (slimmed: no O(n^2) partial snapshots, long
// texts cut) with a sequence number, the host can ask for a history snapshot, and a phone can
// prompt, steer, abort, switch model or thinking level, and answer the dialogs other extensions
// open (tool-firewall approvals, for example). pi stays the only writer of the session file.
//
// Dialog mirroring: pi gives every extension the same UI context object, so wrapping its
// select/confirm/input here lets a phone answer a dialog that another extension opened. The
// terminal keeps its dialog; whichever side answers first wins and the other side's copy is
// closed (the terminal's through the AbortSignal the dialog API supports). `editor` and `custom`
// dialogs are not mirrored: the phone is told the terminal is waiting instead.
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import { ControlLink, HostError, type Json } from "./host.ts";

const TEXT_LIMIT = 20_000;
const UPDATE_TAIL = 8_000;
const ARG_LIMIT = 2_000;
const TOOL_UPDATE_MS = 250;
const SNAPSHOT_MESSAGES = 200;
const SNAPSHOT_BUDGET = 3_000_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 30_000;
type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const MIRROR: unique symbol = Symbol.for("pi-system.remote-control.mirror");

/** A loosely shaped object: session events, messages and host frames are read through this and checked field by field. */
type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null;
}

// ------------------------------------------------------------------- slimming ---
function cutText(text: unknown, limit: number): unknown {
  if (typeof text !== "string" || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [${text.length - limit} more characters on the computer]`;
}

function tailText(text: unknown, limit: number): unknown {
  if (typeof text !== "string" || text.length <= limit) return text;
  return `[… ${text.length - limit} earlier characters]\n${text.slice(-limit)}`;
}

function slimArgs(args: unknown): unknown {
  if (!isRecord(args)) return args;
  if (Array.isArray(args)) return args.map((value: unknown) => (typeof value === "string" ? cutText(value, ARG_LIMIT) : value));
  const out: Rec = {};
  for (const [key, value] of Object.entries(args)) out[key] = typeof value === "string" ? cutText(value, ARG_LIMIT) : value;
  return out;
}

function slimContent(content: unknown, limit = TEXT_LIMIT, cut = cutText): unknown {
  if (typeof content === "string") return cut(content, limit);
  if (!Array.isArray(content)) return content;
  return content.map((part: unknown) => {
    if (!isRecord(part)) return part;
    if (part.type === "image") return { type: "image", mimeType: part.mimeType, omitted: true };
    if (part.type === "text") return { type: "text", text: cut(part.text, limit) };
    if (part.type === "thinking") return { type: "thinking", thinking: cut(part.thinking, limit) };
    if (part.type === "toolCall") return { type: "toolCall", id: part.id, name: part.name, arguments: slimArgs(part.arguments) };
    return part;
  });
}

function slimMessage(message: unknown, cut: typeof cutText = cutText): unknown {
  if (!isRecord(message)) return message;
  const out: Rec = { role: message.role, content: slimContent(message.content, TEXT_LIMIT, cut), timestamp: message.timestamp };
  for (const key of ["toolCallId", "toolName", "isError", "stopReason", "errorMessage", "provider", "model"]) {
    const value = message[key];
    if (value !== undefined) out[key] = typeof value === "string" ? value.slice(0, 2000) : value;
  }
  return out;
}

function slimResult(result: unknown, limit: number, cut: typeof cutText): unknown {
  if (!isRecord(result)) return result;
  return { content: slimContent(result.content, limit, cut), isError: result.isError };
}

export function slimEvent(event: Rec): Rec {
  switch (event.type) {
    case "message_update": {
      const ame: Rec = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : {};
      const kept: Rec = { type: ame.type };
      if (ame.contentIndex !== undefined) kept.contentIndex = ame.contentIndex;
      if (typeof ame.delta === "string") kept.delta = ame.delta;
      if (ame.type === "toolcall_end" && isRecord(ame.toolCall)) kept.toolCall = { id: ame.toolCall.id, name: ame.toolCall.name, arguments: slimArgs(ame.toolCall.arguments) };
      if (ame.reason) kept.reason = ame.reason;
      return { type: "message_update", assistantMessageEvent: kept };
    }
    case "message_start":
    case "message_end":
      return { type: event.type, message: slimMessage(event.message) };
    case "tool_execution_start":
      return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, args: slimArgs(event.args) };
    case "tool_execution_update":
      return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, partialResult: slimResult(event.partialResult, UPDATE_TAIL, tailText) };
    case "tool_execution_end":
      return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result: slimResult(event.result, TEXT_LIMIT, cutText) };
    case "agent_end":
      return { type: "agent_end" };
    case "turn_start":
      return { type: "turn_start", turnIndex: event.turnIndex };
    case "turn_end":
      return { type: "turn_end", turnIndex: event.turnIndex };
    default:
      return { type: event.type };
  }
}

// ----------------------------------------------------------------- dialogs ---
type DialogMethod = "select" | "confirm" | "input";

/** An answer to a mirrored dialog: a string for select/input, a boolean for confirm, undefined when dismissed. */
type DialogAnswer = string | boolean | undefined;

interface OpenDialog {
  method: DialogMethod;
  title: string;
  options?: string[] | undefined;
  answer: (value: DialogAnswer) => void;
}

/** What a dialog closed without an answer resolves to: false for a confirm (as pi's dismissed confirm does), else undefined. */
function unanswered(dialog: OpenDialog): false | undefined {
  return dialog.method === "confirm" ? false : undefined;
}

/** The terminal's dialog functions, held as plain function values (they are saved and later put back as they were). */
interface UiOriginals {
  select: ExtensionUIContext["select"];
  confirm: ExtensionUIContext["confirm"];
  input: ExtensionUIContext["input"];
  notify: ExtensionUIContext["notify"];
}

interface DialogFields {
  title: string;
  message?: unknown;
  placeholder?: unknown;
  options?: string[];
}

/** A select or input result from a phone: its text, or undefined when dismissed. */
function textAnswer(value: DialogAnswer): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type AvailableModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

function isUiOriginals(value: unknown): value is UiOriginals {
  return isRecord(value) && typeof value.select === "function" && typeof value.confirm === "function" && typeof value.input === "function" && typeof value.notify === "function";
}

/** The originals a mirror recorded on this UI object, if one is installed. */
function mirrorOf(ui: object): UiOriginals | undefined {
  const original: unknown = Reflect.get(ui, MIRROR);
  return isUiOriginals(original) ? original : undefined;
}

/** The terminal's own dialog functions, bypassing the mirror (pairing approval must never reach a phone). */
export function terminalUi(ui: ExtensionUIContext): UiOriginals {
  const original = mirrorOf(ui);
  if (original) return original;
  return {
    select: (...args) => ui.select(...args),
    confirm: (...args) => ui.confirm(...args),
    input: (...args) => ui.input(...args),
    notify: (...args) => {
      ui.notify(...args);
    },
  };
}

export type BridgeState = "connecting" | "attached" | "reconnecting" | "detached";

export interface BridgeOptions {
  pi: ExtensionAPI;
  getCtx: () => ExtensionContext | null;
  onState: (state: BridgeState, detail?: string) => void;
}

/** One terminal session's presence on the host. */
export class SessionBridge {
  private link: ControlLink | null = null;
  private registered = false;
  private wanted = false;
  private seq = 0;
  private queue: Array<{ seq: number; event: Rec }> = [];
  private flushScheduled = false;
  private streamingMessage: unknown = null;
  private runningTools = new Map<unknown, { toolCallId: unknown; toolName: unknown; args: unknown }>();
  private endedMessages: unknown[] = [];
  private toolUpdateAt = new Map<unknown, number>();
  private busy = false;
  private dialogs = new Map<string, OpenDialog>();
  private mirroredUi: ExtensionUIContext | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = RETRY_MIN_MS;
  sessionId: string | null = null;

  constructor(private opts: BridgeOptions) {}

  get attached(): boolean {
    return this.registered;
  }

  /** Connect to the host and register this session. Throws HostError when the host is not running. */
  async attach(): Promise<string> {
    this.wanted = true;
    this.clearRetry();
    if (this.registered && this.link && !this.link.closed) return this.sessionId || "";
    this.opts.onState("connecting");
    const id = await this.connect();
    this.retryDelay = RETRY_MIN_MS;
    return id;
  }

  private async connect(): Promise<string> {
    const ctx = this.opts.getCtx();
    if (!ctx) throw new HostError("the session is not ready yet", "refused");
    const link = await ControlLink.open("bridge");
    this.link = link;
    link.onMessage = (msg) => {
      this.onHostMessage(msg);
    };
    link.onClose = () => {
      this.onLinkClosed(link);
    };
    const meta = this.meta(ctx);
    const registered: Rec = await new Promise<Rec>((resolve, reject) => {
      const timer = setTimeout(() => reject(new HostError("the remote host did not register this session", "timeout")), 5_000);
      const previous = link.onMessage;
      link.onMessage = (msg) => {
        if (msg.t === "registered") {
          clearTimeout(timer);
          link.onMessage = previous;
          resolve(msg);
          return;
        }
        previous(msg);
      };
      link.send({ t: "register", session: meta });
    }).catch((error: unknown) => {
      link.close();
      this.link = null;
      throw error;
    });
    if (registered.ok === false || typeof registered.id !== "string") {
      link.close();
      this.link = null;
      throw new HostError(typeof registered.error === "string" && registered.error ? registered.error : "the remote host refused this session", "refused");
    }
    this.sessionId = registered.id;
    this.registered = true;
    this.installMirror(ctx);
    this.opts.onState("attached");
    return registered.id;
  }

  /** Stop exposing this session. The host stays up for other sessions and phones. */
  detach(): void {
    this.wanted = false;
    this.clearRetry();
    this.removeMirror();
    for (const dialog of this.dialogs.values()) dialog.answer(unanswered(dialog));
    this.dialogs.clear();
    const link = this.link;
    this.link = null;
    this.registered = false;
    if (link && !link.closed) {
      link.send({ t: "unregister" });
      link.close();
    }
    this.queue = [];
    this.opts.onState("detached");
  }

  private onLinkClosed(link: ControlLink): void {
    if (this.link !== link) return;
    this.link = null;
    this.registered = false;
    this.removeMirror();
    for (const dialog of this.dialogs.values()) dialog.answer(unanswered(dialog));
    this.dialogs.clear();
    if (!this.wanted) return;
    this.opts.onState("reconnecting", "the remote host went away");
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.wanted) return;
      this.connect().then(
        () => {
          this.retryDelay = RETRY_MIN_MS;
        },
        () => {
          this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
          this.scheduleRetry();
        },
      );
    }, this.retryDelay);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  // ------------------------------------------------------------- session meta ---
  private meta(ctx: ExtensionContext): Rec {
    // Optional calls: not every pi version (or test double) has each accessor.
    const sm: Pick<ExtensionContext["sessionManager"], "getSessionId"> & Partial<ExtensionContext["sessionManager"]> = ctx.sessionManager;
    let thinking: string | null;
    try {
      thinking = this.opts.pi.getThinkingLevel();
    } catch {
      thinking = null;
    }
    return {
      id: sm.getSessionId(),
      sessionFile: sm.getSessionFile?.() ?? null,
      cwd: sm.getCwd?.() ?? ctx.cwd,
      name: sm.getSessionName?.() ?? null,
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
      thinking,
      busy: this.busy || !ctx.isIdle(),
      pid: process.pid,
      dialogs: true,
    };
  }

  /** Tell the host the model, thinking level or name changed. */
  sendMeta(): void {
    const ctx = this.opts.getCtx();
    if (!ctx || !this.registered || !this.link) return;
    const meta = this.meta(ctx);
    delete meta.id;
    this.link.send({ t: "meta", meta });
  }

  /** Forward a notification shown in the terminal. */
  notify(message: unknown, level: string): void {
    if (!this.registered || !this.link) return;
    this.link.send({ t: "notify", message: String(message).slice(0, 2000), level: ["info", "warning", "error"].includes(level) ? level : "info" });
  }

  // ------------------------------------------------------------------ events ---
  /** Every session event passes through here; streaming state is tracked even while detached. */
  observe(event: unknown): void {
    if (!isRecord(event)) return; // pi's session events are always objects
    switch (event.type) {
      case "agent_start":
        this.busy = true;
        break;
      case "agent_settled":
        this.busy = false;
        this.streamingMessage = null;
        this.runningTools.clear();
        this.toolUpdateAt.clear();
        break;
      case "message_start":
        if (isRecord(event.message) && event.message.role === "assistant") this.streamingMessage = event.message;
        break;
      case "message_update":
        this.streamingMessage = event.message ?? this.streamingMessage;
        break;
      case "message_end":
        if (isRecord(event.message) && event.message.role === "assistant") this.streamingMessage = null;
        if (this.registered) {
          this.endedMessages.push(event.message);
          if (this.endedMessages.length > 50) this.endedMessages.shift();
        }
        break;
      case "tool_execution_start":
        this.runningTools.set(event.toolCallId, { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        break;
      case "tool_execution_update": {
        if (!this.registered) return;
        const now = Date.now();
        if (now - (this.toolUpdateAt.get(event.toolCallId) || 0) < TOOL_UPDATE_MS) return; // the end event carries the final state
        this.toolUpdateAt.set(event.toolCallId, now);
        break;
      }
      case "tool_execution_end":
        this.runningTools.delete(event.toolCallId);
        this.toolUpdateAt.delete(event.toolCallId);
        break;
      default:
        break;
    }
    if (!this.registered) return;
    this.queue.push({ seq: ++this.seq, event });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      // Deferred so that a message another extension rewrites in its message_end handler (pi
      // replaces it in place) is sent as it was persisted.
      setImmediate(() => {
        this.flush();
      });
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    const link = this.link;
    const queued = this.queue;
    this.queue = [];
    if (!link || !this.registered) return;
    for (const item of queued) {
      let slim: Rec;
      try {
        slim = slimEvent(item.event);
      } catch {
        continue;
      }
      link.send({ t: "event", seq: item.seq, event: slim });
    }
  }

  /** History for a phone that opens this session: the branch, plus what is in flight. */
  private snapshot(): Rec {
    this.flush(); // everything numbered up to `seq` is on the wire before the reply
    const ctx = this.opts.getCtx();
    const messages: unknown[] = [];
    const seen = new Set<unknown>();
    if (ctx) {
      try {
        const branch: readonly unknown[] = ctx.sessionManager.getBranch();
        for (const entry of branch) {
          if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
          const role = entry.message.role;
          if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
          messages.push(entry.message);
          seen.add(entry.message);
        }
      } catch {
        /* no branch (ephemeral session): what this bridge saw is still sent */
      }
    }
    // pi persists a message after its message_end handlers run; one that ended a moment ago
    // may not be in the branch yet.
    for (const message of this.endedMessages) if (!seen.has(message)) messages.push(message);

    const out: unknown[] = [];
    let budget = SNAPSHOT_BUDGET;
    for (let i = messages.length - 1; i >= 0 && out.length < SNAPSHOT_MESSAGES; i--) {
      const slim = slimMessage(messages[i]);
      const size = JSON.stringify(slim).length;
      if (size > budget && out.length > 0) break;
      budget -= size;
      out.push(slim);
    }
    out.reverse();

    const streaming =
      this.streamingMessage || this.runningTools.size > 0
        ? {
            // The tail, not the head: live deltas continue from the end of this text.
            message: this.streamingMessage ? slimMessage(this.streamingMessage, tailText) : null,
            tools: [...this.runningTools.values()].map((t) => ({ toolCallId: t.toolCallId, toolName: t.toolName, args: slimArgs(t.args) })),
          }
        : null;
    return { messages: out, seq: this.seq, streaming, truncated: messages.length > out.length };
  }

  // ---------------------------------------------------------------- commands ---
  private onHostMessage(frame: Json): void {
    const msg: Rec = frame;
    if (msg.t !== "cmd" || typeof msg.id !== "string") return;
    const id = msg.id;
    const link = this.link;
    if (!link) return;
    const reply = (data: unknown = {}) => {
      link.send({ t: "res", id, ok: true, data });
    };
    const refuse = (error: string, status = 409) => {
      link.send({ t: "res", id, ok: false, error, status });
    };
    Promise.resolve()
      .then(() => this.command(msg, reply, refuse))
      .catch((error: unknown) => {
        refuse(error instanceof Error ? error.message : String(error), 500);
      });
  }

  private async command(msg: Rec, reply: (data?: unknown) => void, refuse: (error: string, status?: number) => void): Promise<void> {
    const ctx = this.opts.getCtx();
    const pi = this.opts.pi;
    switch (msg.op) {
      case "snapshot":
        reply(this.snapshot());
        return;
      case "prompt": {
        if (!ctx) {
          refuse("the session is not ready", 409);
          return;
        }
        const text = typeof msg.message === "string" ? msg.message.trim() : "";
        if (!text) {
          refuse("message is required", 400);
          return;
        }
        if (text.length > 100_000) {
          refuse("message too long", 413);
          return;
        }
        const command = /^\/([A-Za-z][\w:.-]*)(?:\s|$)/.exec(text);
        if (command) {
          const name = command[1] ?? ""; // the group always matches; "" is refused below as not a command
          // pi names a command that two extensions register "remote:1", "remote:2", ...: still /remote.
          if (/^remote(?::\d+)?$/i.test(name)) {
            refuse("/remote can only be used at the computer", 403);
            return;
          }
          const known = (() => {
            try {
              return pi.getCommands().some((c) => c.name === name);
            } catch {
              return false;
            }
          })();
          if (!known) {
            refuse(`/${name} only works at the computer's terminal (or is not a command)`, 400);
            return;
          }
        }
        const idle = ctx.isIdle();
        const deliverAs = idle ? undefined : msg.streamingBehavior === "steer" ? "steer" : "followUp";
        pi.sendUserMessage(text, deliverAs ? { deliverAs, expandPromptTemplates: true } : { expandPromptTemplates: true });
        reply({ delivered: deliverAs || "now" });
        return;
      }
      case "abort":
        if (!ctx) {
          refuse("the session is not ready", 409);
          return;
        }
        ctx.abort();
        reply({ aborted: true });
        return;
      case "models": {
        if (!ctx) {
          refuse("the session is not ready", 409);
          return;
        }
        const byProvider = new Map<string, Array<Pick<AvailableModel, "id" | "name" | "contextWindow" | "reasoning">>>();
        for (const model of ctx.modelRegistry.getAvailable()) {
          const list = byProvider.get(model.provider) ?? [];
          list.push({ id: model.id, name: model.name, contextWindow: model.contextWindow, reasoning: model.reasoning });
          byProvider.set(model.provider, list);
        }
        const providers = [...byProvider.entries()].map(([name, models]) => ({ name, models })).sort((a, b) => a.name.localeCompare(b.name));
        const current = ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : { provider: "", model: "" };
        let thinking: string | null;
        try {
          thinking = pi.getThinkingLevel();
        } catch {
          thinking = null;
        }
        reply({ providers, default: current, current, thinking });
        return;
      }
      case "set_model": {
        if (!ctx) {
          refuse("the session is not ready", 409);
          return;
        }
        if (typeof msg.provider !== "string" || typeof msg.modelId !== "string") {
          refuse("provider and modelId must be strings", 400);
          return;
        }
        const model = ctx.modelRegistry.find(msg.provider, msg.modelId);
        if (!model) {
          refuse("no such model", 404);
          return;
        }
        const ok = await pi.setModel(model);
        if (!ok) {
          refuse("pi has no credentials for that model", 409);
          return;
        }
        this.sendMeta();
        reply({ provider: model.provider, id: model.id });
        return;
      }
      case "set_thinking": {
        const requested = typeof msg.level === "string" ? msg.level : "";
        const level = THINKING_LEVELS.find((known) => known === requested);
        if (level === undefined) {
          refuse("invalid thinking level", 400);
          return;
        }
        pi.setThinkingLevel(level);
        this.sendMeta();
        reply(pi.getThinkingLevel());
        return;
      }
      case "ui_response": {
        const dialog = typeof msg.dialogId === "string" ? this.dialogs.get(msg.dialogId) : undefined;
        if (!dialog) {
          refuse("that dialog is no longer open", 404);
          return;
        }
        let value: DialogAnswer;
        if (msg.cancelled === true) value = unanswered(dialog);
        else if (dialog.method === "confirm") {
          if (typeof msg.confirmed !== "boolean") {
            refuse("this dialog needs confirmed: true or false", 400);
            return;
          }
          value = msg.confirmed;
        } else if (dialog.method === "select") {
          if (typeof msg.value !== "string" || !(dialog.options ?? []).includes(msg.value)) {
            refuse("that is not one of the options", 400);
            return;
          }
          value = msg.value;
        } else {
          if (typeof msg.value !== "string" || msg.value.length > 100_000) {
            refuse("this dialog needs a text value", 400);
            return;
          }
          value = msg.value;
        }
        dialog.answer(value);
        reply({ answered: true });
        // The host names the phone that answered: say so at the terminal, so an approval given from
        // a phone is never silent here (the host audits it with the device ID too).
        if (isRecord(msg.by) && typeof msg.by.name === "string" && typeof msg.by.display === "string") {
          const shown = typeof value === "string" ? (dialog.method === "select" ? value : "typed text") : value === true ? "yes" : value === false ? "no" : "cancelled";
          try {
            const ui = ctx?.ui;
            if (ui) terminalUi(ui).notify(`remote: "${msg.by.name.slice(0, 64)}" (${msg.by.display.slice(0, 24)}) answered "${dialog.title.split("\n")[0]?.slice(0, 80) ?? ""}" from the phone: ${shown.slice(0, 80)}`, "info");
          } catch {
            /* session ended */
          }
        }
        return;
      }
      default:
        refuse(`unknown command ${String(msg.op).slice(0, 40)}`, 400);
        return;
    }
  }

  // ----------------------------------------------------------- dialog mirror ---
  private installMirror(ctx: ExtensionContext): void {
    let ui: ExtensionUIContext;
    try {
      ui = ctx.ui;
    } catch {
      return;
    }
    if (!ui || typeof ui.select !== "function") return;
    // A copy left by an earlier instance (before /reload, say) is replaced, keeping the
    // terminal's real functions it recorded.
    const terminal: UiOriginals = ui; // the functions themselves, saved to be put back unchanged
    const original: UiOriginals = mirrorOf(ui) ?? {
      select: terminal.select,
      confirm: terminal.confirm,
      input: terminal.input,
      notify: terminal.notify,
    };
    const { select, confirm, input } = original;
    ui.select = (title, options, dialogOpts) =>
      this.mirrored((opts) => select(title, options, opts), "select", { title, options: Array.isArray(options) ? options.map(String) : [] }, dialogOpts, textAnswer);
    ui.confirm = (title, message, dialogOpts) => this.mirrored((opts) => confirm(title, message, opts), "confirm", { title, message }, dialogOpts, (value) => value === true);
    ui.input = (title, placeholder, dialogOpts) => this.mirrored((opts) => input(title, placeholder, opts), "input", { title, placeholder }, dialogOpts, textAnswer);
    ui.notify = (message, type) => {
      original.notify(message, type);
      this.notify(message, type || "info");
    };
    Object.defineProperty(ui, MIRROR, { value: original, configurable: true, enumerable: false });
    this.mirroredUi = ui;
  }

  private removeMirror(): void {
    const ui = this.mirroredUi;
    this.mirroredUi = null;
    const original = ui ? mirrorOf(ui) : undefined;
    if (!ui || !original) return;
    ui.select = original.select;
    ui.confirm = original.confirm;
    ui.input = original.input;
    ui.notify = original.notify;
    Reflect.deleteProperty(ui, MIRROR);
  }

  /**
   * Run a terminal dialog and offer the same dialog to the phones; the first answer wins.
   * `fromPhone` turns a phone's answer (already checked against the dialog's method) into the
   * dialog's own result type.
   */
  private mirrored<T>(
    run: (opts: ExtensionUIDialogOptions | undefined) => Promise<T>,
    method: DialogMethod,
    fields: DialogFields,
    dialogOpts: ExtensionUIDialogOptions | undefined,
    fromPhone: (value: DialogAnswer) => T,
  ): Promise<T> {
    const link = this.link;
    const outer = dialogOpts?.signal;
    if (!link || !this.registered || outer?.aborted) return run(dialogOpts);

    const id = crypto.randomBytes(9).toString("base64url");
    const local = new AbortController();
    const onOuterAbort = () => {
      local.abort();
    };
    outer?.addEventListener("abort", onOuterAbort, { once: true });

    return new Promise<T>((resolve) => {
      let settled = false;
      const finish = (by: string) => {
        settled = true;
        outer?.removeEventListener("abort", onOuterAbort);
        this.dialogs.delete(id);
        if (this.link && this.registered) this.link.send({ t: "ui_done", id, by });
      };
      this.dialogs.set(id, {
        method,
        title: fields.title,
        options: fields.options,
        answer: (value) => {
          if (settled) return;
          finish("phone");
          resolve(fromPhone(value));
          local.abort(); // close the terminal's copy
        },
      });
      const timeout = dialogOpts?.timeout;
      link.send({
        t: "ui",
        dialog: {
          id,
          method,
          title: fields.title ?? "",
          message: typeof fields.message === "string" ? fields.message : undefined,
          placeholder: typeof fields.placeholder === "string" ? fields.placeholder : undefined,
          options: fields.options,
          timeout: Number.isFinite(timeout) ? timeout : undefined,
        },
      });
      const terminal = Promise.resolve().then(() => run({ ...(dialogOpts ?? {}), signal: local.signal }));
      terminal.then(
        (value) => {
          if (settled) return;
          finish(outer?.aborted ? "cancelled" : "terminal");
          resolve(value);
        },
        () => {
          if (settled) return;
          finish("terminal");
          resolve(terminal); // settles with the terminal's own rejection reason
        },
      );
    });
  }
}
