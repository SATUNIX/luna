// dialogs.ts — dialogs that pi children started by this host are waiting on.
//
// In RPC mode, an extension's ctx.ui.select/confirm/input/editor (the tool firewall's approval
// prompt, ask_human, ...) becomes an `extension_ui_request` record on the child's stdout, and pi
// waits for an `extension_ui_response` with the same id. pi-console never answers these; the
// remote host does, so a phone can approve a tool call. This tracker follows every live child,
// keeps the dialogs still open (until answered, or until the timeout pi applies itself), and
// tells event-stream viewers when one opens or closes.
import { isRecord } from "../../../core/lib/guard.ts";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"] as const);
const DIALOG_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;

export type DialogMethod = "select" | "confirm" | "input" | "editor";

/** An open dialog, cleaned from the child's `extension_ui_request` (every field bounded). */
export interface Dialog {
	id: string;
	method: DialogMethod;
	title: string;
	message?: string;
	placeholder?: string;
	prefill?: string;
	options?: string[];
	/** Milliseconds pi waits before it gives up on the dialog itself. */
	timeout?: number;
	openedAt: string;
	/** When the dialog times out (epoch ms), if it has a timeout. */
	closesAt?: number;
}

/** Who or what closed a dialog ("phone", "timeout", ...). */
export type DialogResolvedBy = string;

/** What a dialog listener is told. */
export type DialogNotice = { type: "ui_request"; dialog: Dialog } | { type: "ui_resolved"; id: string; by: DialogResolvedBy };

export type DialogListener = (notice: DialogNotice) => void;

/**
 * A live pi child as the tracker sees it: the records it has already emitted (`replay`) and a
 * subscription to the ones to come. The records are the child's untrusted output.
 */
export interface DialogSource {
	readonly replay?: readonly unknown[];
	subscribe(fn: (message: unknown) => void): unknown;
}

export interface DialogTrackerOptions {
	readonly listLiveSessions: () => Iterable<DialogSource>;
}

/** What the tracker keeps per child. */
export interface DialogEntry {
	readonly dialogs: Map<string, Dialog>;
	readonly listeners: Set<DialogListener>;
	busy: boolean;
}

function isDialogMethod(value: unknown): value is DialogMethod {
	return DIALOG_METHODS.has(value as DialogMethod);
}

export function dialogFromRequest(req: unknown): Dialog | null {
	if (!isRecord(req) || req.type !== "extension_ui_request" || !isDialogMethod(req.method)) return null;
	// pi's ids are strings; a number is read as its digits, anything else is refused.
	const id = typeof req.id === "string" ? req.id : typeof req.id === "number" ? String(req.id) : "";
	if (!DIALOG_ID_RE.test(id)) return null;
	const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
	const message = str(req.message, 8000);
	const placeholder = str(req.placeholder, 500);
	const prefill = str(req.prefill, 20000);
	const options = Array.isArray(req.options) ? req.options.slice(0, 50).map((o: unknown) => String(o).slice(0, 500)) : undefined;
	const timeout = typeof req.timeout === "number" && Number.isFinite(req.timeout) ? req.timeout : undefined;
	// Absent fields are left out (not set to undefined); the key order is the one phones have always seen.
	return {
		id,
		method: req.method,
		title: str(req.title, 8000) || "",
		...(message === undefined ? {} : { message }),
		...(placeholder === undefined ? {} : { placeholder }),
		...(prefill === undefined ? {} : { prefill }),
		...(options === undefined ? {} : { options }),
		...(timeout === undefined ? {} : { timeout }),
		openedAt: new Date().toISOString(),
	};
}

export class DialogTracker {
	private readonly listLiveSessions: () => Iterable<DialogSource>;
	private readonly procs = new WeakMap<DialogSource, DialogEntry>();
	private readonly timer: NodeJS.Timeout;

	constructor({ listLiveSessions }: DialogTrackerOptions) {
		this.listLiveSessions = listLiveSessions;
		this.timer = setInterval(() => this.sync(), 1000);
		this.timer.unref();
	}

	/** Start following any child that appeared since the last call. */
	sync(): void {
		for (const proc of this.listLiveSessions()) this.follow(proc);
	}

	follow(proc: DialogSource): DialogEntry {
		const known = this.procs.get(proc);
		if (known) return known;
		const created: DialogEntry = { dialogs: new Map(), listeners: new Set(), busy: false };
		this.procs.set(proc, created);
		// Dialogs opened before we looked are in the child's replay buffer; one still within its
		// timeout is still open, since nothing but this host ever answers.
		for (const message of proc.replay ?? []) this.observe(proc, created, message, false);
		proc.subscribe((message) => this.observe(proc, created, message, true));
		return created;
	}

	private observe(proc: DialogSource, entry: DialogEntry, message: unknown, live: boolean): void {
		if (!isRecord(message) || message.type !== "event" || !message.data) return;
		const data = message.data;
		// The child's busy state rides along: agent_settled is the only "idle again" signal.
		if (isRecord(data) && data.type === "agent_start") entry.busy = true;
		else if (isRecord(data) && data.type === "agent_settled") entry.busy = false;
		const dialog = dialogFromRequest(data);
		if (!dialog) return;
		if (dialog.timeout) {
			const closesAt = Date.now() + dialog.timeout;
			dialog.closesAt = closesAt;
			if (live) {
				const timer = setTimeout(() => this.resolve(proc, dialog.id, "timeout"), dialog.timeout + 250);
				timer.unref();
			}
		}
		entry.dialogs.set(dialog.id, dialog);
		if (live) this.notify(entry, { type: "ui_request", dialog });
	}

	open(proc: DialogSource): Dialog[] {
		const entry = this.follow(proc);
		const now = Date.now();
		for (const [id, dialog] of entry.dialogs) if (dialog.closesAt && dialog.closesAt < now) entry.dialogs.delete(id);
		return [...entry.dialogs.values()];
	}

	busy(proc: DialogSource): boolean {
		return this.follow(proc).busy;
	}

	has(proc: DialogSource, id: string): boolean {
		return this.open(proc).some((d) => d.id === id);
	}

	resolve(proc: DialogSource, id: string, by: DialogResolvedBy): void {
		const entry = this.procs.get(proc);
		if (!entry?.dialogs.delete(id)) return;
		this.notify(entry, { type: "ui_resolved", id, by });
	}

	listen(proc: DialogSource, fn: DialogListener): () => boolean {
		const entry = this.follow(proc);
		entry.listeners.add(fn);
		return () => entry.listeners.delete(fn);
	}

	private notify(entry: DialogEntry, message: DialogNotice): void {
		for (const fn of entry.listeners) {
			try {
				fn(message);
			} catch {
				/* a viewer failing must not stop the others */
			}
		}
	}

	close(): void {
		clearInterval(this.timer);
	}
}
