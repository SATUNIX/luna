// dialogs.js — dialogs that pi children started by this host are waiting on.
//
// In RPC mode, an extension's ctx.ui.select/confirm/input/editor (the tool firewall's approval
// prompt, ask_human, ...) becomes an `extension_ui_request` record on the child's stdout, and pi
// waits for an `extension_ui_response` with the same id. pi-console never answers these; the
// remote host does, so a phone can approve a tool call. This tracker follows every live child,
// keeps the dialogs still open (until answered, or until the timeout pi applies itself), and
// tells event-stream viewers when one opens or closes.
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const DIALOG_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;

export function dialogFromRequest(req) {
	if (!req || req.type !== "extension_ui_request" || !DIALOG_METHODS.has(req.method)) return null;
	const id = String(req.id ?? "");
	if (!DIALOG_ID_RE.test(id)) return null;
	const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);
	return {
		id,
		method: req.method,
		title: str(req.title, 8000) || "",
		message: str(req.message, 8000),
		placeholder: str(req.placeholder, 500),
		prefill: str(req.prefill, 20000),
		options: Array.isArray(req.options) ? req.options.slice(0, 50).map((o) => String(o).slice(0, 500)) : undefined,
		timeout: Number.isFinite(req.timeout) ? req.timeout : undefined,
		openedAt: new Date().toISOString(),
	};
}

export class DialogTracker {
	constructor({ listLiveSessions }) {
		this.listLiveSessions = listLiveSessions;
		this.procs = new WeakMap(); // proc -> {dialogs: Map, listeners: Set}
		this.timer = setInterval(() => this.sync(), 1000);
		this.timer.unref?.();
	}

	/** Start following any child that appeared since the last call. */
	sync() {
		for (const proc of this.listLiveSessions()) this.follow(proc);
	}

	follow(proc) {
		let entry = this.procs.get(proc);
		if (entry) return entry;
		entry = { dialogs: new Map(), listeners: new Set(), busy: false };
		this.procs.set(proc, entry);
		// Dialogs opened before we looked are in the child's replay buffer; one still within its
		// timeout is still open, since nothing but this host ever answers.
		for (const message of proc.replay || []) this.observe(proc, entry, message, false);
		proc.subscribe((message) => this.observe(proc, entry, message, true));
		return entry;
	}

	observe(proc, entry, message, live) {
		if (!message || message.type !== "event" || !message.data) return;
		// The child's busy state rides along: agent_settled is the only "idle again" signal.
		if (message.data.type === "agent_start") entry.busy = true;
		else if (message.data.type === "agent_settled") entry.busy = false;
		const dialog = dialogFromRequest(message.data);
		if (!dialog) return;
		if (dialog.timeout) {
			const closesAt = Date.now() + dialog.timeout;
			dialog.closesAt = closesAt;
			if (live) {
				const timer = setTimeout(() => this.resolve(proc, dialog.id, "timeout"), dialog.timeout + 250);
				timer.unref?.();
			}
		}
		entry.dialogs.set(dialog.id, dialog);
		if (live) this.notify(entry, { type: "ui_request", dialog });
	}

	open(proc) {
		const entry = this.follow(proc);
		const now = Date.now();
		for (const [id, dialog] of entry.dialogs) if (dialog.closesAt && dialog.closesAt < now) entry.dialogs.delete(id);
		return [...entry.dialogs.values()];
	}

	busy(proc) {
		return Boolean(this.follow(proc).busy);
	}

	has(proc, id) {
		return this.open(proc).some((d) => d.id === id);
	}

	resolve(proc, id, by) {
		const entry = this.procs.get(proc);
		if (!entry || !entry.dialogs.delete(id)) return;
		this.notify(entry, { type: "ui_resolved", id, by });
	}

	listen(proc, fn) {
		const entry = this.follow(proc);
		entry.listeners.add(fn);
		return () => entry.listeners.delete(fn);
	}

	notify(entry, message) {
		for (const fn of entry.listeners) {
			try {
				fn(message);
			} catch {
				/* a viewer failing must not stop the others */
			}
		}
	}

	close() {
		clearInterval(this.timer);
	}
}
