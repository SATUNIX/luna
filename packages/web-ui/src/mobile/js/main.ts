// main.js — pi remote: pi-console for a phone, inside the Android app.
//
// Screens: computers (linked hosts) -> link a computer -> sessions -> chat, plus bottom sheets for
// a new session, session details and settings. Everything that leaves the phone goes through the
// app (./native.js); this page holds no keys and no tokens.
//
// Everything the app answers (its own methods and the computers' phone API, relayed by
// `api()`) arrives as `unknown` and is narrowed here into the local shapes below.
import { clear, el, relativeTime } from "../../public/js/render.ts";
import { renderStats, renderTodos } from "../../public/js/panels.ts";
import { dialogCard, MobileChat, type Dialog, type DialogCard } from "./chat.ts";
import { api, attach, call, on, openStream, type NativeParams, type NativeStream, type StreamFrame } from "./native.ts";

declare global {
	interface Window {
		/** The system back gesture, for the desktop development page. */
		__piBack?: () => boolean;
	}
}

// ------------------------------------------------------------------- shapes ---
// What main.ts reads from the app and the computers. The app's are HostStore.toPage, Remote.kt
// and MainActivity.appInfo; the computers' mirror packages/web-ui/server/remote/api.ts.

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
	return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function strOrNull(value: unknown): string | null | undefined {
	return value === null ? null : str(value);
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** A linked computer, as the app shows it to the page (HostStore.toPage). */
interface Host {
	id: string;
	name: string;
	addresses: string[];
	port?: number | undefined;
	fingerprintDisplay?: string | undefined;
	deviceIdDisplay?: string | undefined;
	pairedAt?: string | undefined;
	lastUsedAt?: string | null | undefined;
}

function asHost(value: unknown): Host | null {
	if (!isRecord(value) || typeof value.id !== "string") return null;
	return {
		id: value.id,
		name: str(value.name) ?? "",
		addresses: stringList(value.addresses),
		port: typeof value.port === "number" ? value.port : undefined,
		fingerprintDisplay: str(value.fingerprintDisplay),
		deviceIdDisplay: str(value.deviceIdDisplay),
		pairedAt: str(value.pairedAt),
		lastUsedAt: strOrNull(value.lastUsedAt),
	};
}

/** hosts.list → {hosts}. */
function asHosts(value: unknown): Host[] {
	const list = isRecord(value) && Array.isArray(value.hosts) ? value.hosts : [];
	return list.flatMap((h: unknown) => asHost(h) ?? []);
}

/** app.info. */
interface AppInfo {
	version?: string | undefined;
	keyStorage?: string | undefined;
	lockEnabled?: boolean | undefined;
	secureScreen?: boolean | undefined;
	pendingLink?: string | undefined;
}

function asAppInfo(value: unknown): AppInfo {
	if (!isRecord(value)) return {};
	return {
		version: str(value.version),
		keyStorage: str(value.keyStorage),
		lockEnabled: typeof value.lockEnabled === "boolean" ? value.lockEnabled : undefined,
		secureScreen: typeof value.secureScreen === "boolean" ? value.secureScreen : undefined,
		pendingLink: str(value.pendingLink),
	};
}

/** hosts.probe: {reachable, address} or {reachable: false, code, message}. */
interface Probe {
	reachable: boolean;
	address?: string | undefined;
	code?: string | undefined;
	message?: string | undefined;
}

function asProbe(value: unknown): Probe {
	if (!isRecord(value)) return { reachable: false };
	return { reachable: Boolean(value.reachable), address: str(value.address), code: str(value.code), message: str(value.message) };
}

/** pair.probe: the certificate a computer presented. */
interface PairProbe {
	name: string;
	fingerprint: string;
	fingerprintDisplay: string;
}

function asPairProbe(value: unknown): PairProbe | null {
	if (!isRecord(value) || typeof value.fingerprint !== "string") return null;
	return { name: str(value.name) ?? "", fingerprint: value.fingerprint, fingerprintDisplay: str(value.fingerprintDisplay) ?? "" };
}

/** pair.begin: the request the computer is now showing. */
interface PairStart {
	pairingId: string;
	hostName: string;
	deviceIdDisplay: string;
}

function asPairStart(value: unknown): PairStart | null {
	if (!isRecord(value) || typeof value.pairingId !== "string") return null;
	return { pairingId: value.pairingId, hostName: str(value.hostName) ?? "", deviceIdDisplay: str(value.deviceIdDisplay) ?? "" };
}

/** pair.wait: approved (with the new host), cancelled, rejected, expired or failed. */
interface PairResult {
	state: string | undefined;
	host: Host | null;
	reason: string | undefined;
}

function asPairResult(value: unknown): PairResult {
	if (!isRecord(value)) return { state: undefined, host: null, reason: undefined };
	return { state: str(value.state), host: asHost(value.host), reason: str(value.reason) };
}

/** A session's model: {provider, id} from a terminal (BridgeMeta), or a bare id. */
interface ModelRef {
	provider?: string | null | undefined;
	id?: string | null | undefined;
}

/**
 * One entry of GET /api/sessions (SessionView in server/remote/api.ts), also the `session` of a
 * lifecycle or meta frame and of POST /api/sessions. Only the fields a frame carries are set, so
 * a frame's session merges over what the page knows.
 */
interface PhoneSession {
	id: string;
	name?: string | null | undefined;
	cwd?: string | null | undefined;
	preview?: string | undefined;
	status?: string | undefined;
	busy?: boolean | undefined;
	pendingDialogs?: number | undefined;
	agent?: string | null | undefined;
	model?: ModelRef | string | null | undefined;
	thinking?: string | null | undefined;
	lastActivityAt?: string | null | undefined;
}

type SessionPatch = Partial<PhoneSession>;

function asModel(value: unknown): ModelRef | string | null | undefined {
	if (value === null || typeof value === "string") return value;
	if (isRecord(value)) return { provider: strOrNull(value.provider), id: strOrNull(value.id) };
	return undefined;
}

/** The well-typed fields of a session record; absent or mistyped ones are left out. */
function sessionPatch(value: unknown): SessionPatch {
	const patch: SessionPatch = {};
	if (!isRecord(value)) return patch;
	if (typeof value.id === "string") patch.id = value.id;
	const name = strOrNull(value.name);
	if (name !== undefined) patch.name = name;
	const cwd = strOrNull(value.cwd);
	if (cwd !== undefined) patch.cwd = cwd;
	if (typeof value.preview === "string") patch.preview = value.preview;
	if (typeof value.status === "string") patch.status = value.status;
	if (typeof value.busy === "boolean") patch.busy = value.busy;
	if (typeof value.pendingDialogs === "number") patch.pendingDialogs = value.pendingDialogs;
	const agent = strOrNull(value.agent);
	if (agent !== undefined) patch.agent = agent;
	const model = asModel(value.model);
	if (model !== undefined) patch.model = model;
	const thinking = strOrNull(value.thinking);
	if (thinking !== undefined) patch.thinking = thinking;
	const lastActivityAt = strOrNull(value.lastActivityAt);
	if (lastActivityAt !== undefined) patch.lastActivityAt = lastActivityAt;
	return patch;
}

function asSession(value: unknown): PhoneSession | null {
	const patch = sessionPatch(value);
	return patch.id === undefined ? null : { ...patch, id: patch.id };
}

/** GET /api/models (or a terminal's /models): providers with their model ids. */
interface Provider {
	name: string;
	models: string[];
}

function asProviders(value: unknown): Provider[] {
	const list = isRecord(value) && Array.isArray(value.providers) ? value.providers : [];
	return list.flatMap((p: unknown) => {
		if (!isRecord(p) || typeof p.name !== "string") return [];
		const models = Array.isArray(p.models) ? p.models : [];
		return [{ name: p.name, models: models.flatMap((m: unknown) => (isRecord(m) && typeof m.id === "string" ? [m.id] : [])) }];
	});
}

/** GET /api/agents: the agent definitions a new session can start with. */
interface PhoneAgent {
	name: string;
	description?: string | undefined;
	source?: string | undefined;
}

function asAgents(value: unknown): PhoneAgent[] {
	const list = isRecord(value) && Array.isArray(value.agents) ? value.agents : [];
	return list.flatMap((a: unknown) => (isRecord(a) && typeof a.name === "string" ? [{ name: a.name, description: str(a.description), source: str(a.source) }] : []));
}

/** A dialog of a ui_request frame (Dialog in server/remote/dialogs.ts). */
function asDialog(value: unknown): Dialog | null {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.method !== "string") return null;
	const options = Array.isArray(value.options) && value.options.every((o) => typeof o === "string") ? stringList(value.options) : undefined;
	return {
		id: value.id,
		method: value.method,
		title: str(value.title),
		message: str(value.message),
		options,
		placeholder: str(value.placeholder),
		timeout: typeof value.timeout === "number" ? value.timeout : undefined,
		openedAt: str(value.openedAt),
	};
}

/** A screen: its node, how to rebuild it after Back, and its lifecycle hooks. */
interface Screen {
	node: HTMLElement;
	restore: () => Screen;
	dispose?: () => void;
	focus?: () => void;
	onResume?: () => void;
	onPause?: () => void;
}

function byId(id: string): HTMLElement {
	const node = document.getElementById(id);
	if (!node) throw new Error(`index.html has no #${id}`);
	return node;
}

const app = byId("app");
const sheetRoot = byId("sheet-root");
const toastNode = byId("toast");

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const state: { info: AppInfo | null; screen: Screen | null; stack: Array<() => Screen> } = { info: null, screen: null, stack: [] };

// ------------------------------------------------------------------ helpers ---
const SVG = "http://www.w3.org/2000/svg";
const ICONS = {
	back: ["M15 18l-6-6 6-6"],
	forward: ["M9 18l6-6-6-6"],
	plus: ["M12 5v14", "M5 12h14"],
	refresh: ["M20 11a8 8 0 1 0-2.34 5.66", "M20 4v7h-7"],
	settings: ["M4 7h9", "M17 7h3", "M4 17h3", "M11 17h9", "M15 5v4", "M9 15v4"],
	more: ["M12 5.5v.01", "M12 12v.01", "M12 18.5v.01"],
	stop: ["M7 7h10v10H7z"],
	send: ["M12 19V5", "M5 12l7-7 7 7"],
	info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v6", "M12 7.5v.01"],
	qr: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h2v2h-2z", "M18 18h2v2h-2z", "M18 14h2", "M14 19h2"],
	keyboard: ["M3 6h18v12H3z", "M7 10h.01", "M11 10h.01", "M15 10h.01", "M7 14h10"],
	close: ["M6 6l12 12", "M18 6L6 18"],
	computer: ["M3 5h18v11H3z", "M8 20h8", "M12 16v4"],
	check: ["M5 12.5l4.5 4.5L19 7.5"],
};

type IconName = keyof typeof ICONS;

function icon(name: IconName): SVGSVGElement {
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	svg.classList.add("icon");
	for (const d of ICONS[name]) {
		const path = document.createElementNS(SVG, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}

function iconButton(name: IconName, label: string, onclick: (event: MouseEvent) => void, extra = ""): HTMLButtonElement {
	return el("button", { class: `icon-btn ${extra}`, type: "button", "aria-label": label, title: label, onclick }, [icon(name)]);
}

type ToastLevel = "info" | "warning" | "error";
let toastTimer: number | undefined;

function toast(message: string, level: ToastLevel = "info"): void {
	toastNode.textContent = message;
	toastNode.className = `toast is-${level}`;
	toastNode.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (toastNode.hidden = true), level === "error" ? 5000 : 3000);
}

type Topbar = HTMLElement & { setTitle: (text: string) => void; setSubtitle: (nodeOrText: Node | string | null) => void };

interface TopbarOptions {
	title: string;
	subtitle?: string | undefined;
	back?: boolean | undefined;
	actions?: HTMLElement[] | undefined;
}

function topbar({ title, subtitle, back = state.stack.length > 0, actions = [] }: TopbarOptions): Topbar {
	const sub = el("div", { class: "topbar-sub" }, subtitle ? [subtitle] : []);
	const titleNode = el("div", { class: "topbar-title", text: title || "" });
	const bar = el("header", { class: "topbar" }, [
		back ? iconButton("back", "Back", () => goBack()) : el("div", { class: "topbar-pad" }),
		el("div", { class: "topbar-text" }, [titleNode, sub]),
		el("div", { class: "topbar-actions" }, actions),
	]);
	return Object.assign(bar, {
		setTitle: (text: string) => (titleNode.textContent = text),
		setSubtitle: (nodeOrText: Node | string | null) => { sub.replaceChildren(...(nodeOrText ? [nodeOrText] : [])); },
	});
}

function shortId(id: string | null | undefined): string {
	return id ? id.slice(0, 8) : "";
}

function shortPath(p: string | null | undefined): string {
	if (!p) return "";
	const parts = p.split("/").filter(Boolean);
	return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

function firstLine(text: string | null | undefined, max = 90): string {
	const line = (text || "")
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean);
	if (!line) return "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function isTailscale(address: string | undefined): boolean {
	const m = /^100\.(\d+)\./.exec(address || "");
	return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
}

function viaLabel(address: string | undefined): string {
	if (!address) return "";
	return isTailscale(address) ? `via Tailscale (${address})` : `via ${address}`;
}

function errorMessage(error: unknown): string {
	if (!error) return "something went wrong";
	const code = isRecord(error) ? error.code : undefined;
	if (code === "unreachable") return "The computer cannot be reached. Is it on, and is this phone on the same network or VPN?";
	if (code === "unlinked") return "This phone is no longer linked to that computer.";
	if (code === "pin_mismatch") return "Something with a different certificate answered at the computer's address. If pi remote was reset on the computer, link this phone again.";
	const message = isRecord(error) ? str(error.message) : undefined;
	if (message) return message;
	// What String() made of the thrown value: an Error reads "Error: …", a primitive as itself.
	if (error instanceof Error) return error.toString();
	if (typeof error === "string") return error;
	if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") return String(error);
	return Object.prototype.toString.call(error);
}

/** The model id a session record carries, whichever form it has. */
function modelId(model: PhoneSession["model"]): string | null | undefined {
	return model && typeof model === "object" ? model.id : model;
}

// --------------------------------------------------------------- navigation ---
function render(screen: Screen): void {
	if (state.screen?.dispose) state.screen.dispose();
	closeSheet();
	state.screen = screen;
	app.replaceChildren(screen.node);
	if (screen.focus) screen.focus();
}

function go<A extends unknown[]>(factory: (...args: A) => Screen, ...args: A): void {
	if (state.screen) state.stack.push(state.screen.restore);
	render(factory(...args));
}

function goBack(): boolean {
	if (closeSheet()) return true;
	const restore = state.stack.pop();
	if (!restore) return false;
	render(restore());
	return true;
}

function goHome(): void {
	state.stack = [];
	render(hostsScreen());
}

// The system back gesture arrives as a "back" event (see boot); at the first screen the app
// is told to step aside. Kept on window for the desktop development page.
window.__piBack = () => goBack();

// ------------------------------------------------------------------- sheets ---
let sheet: { onClose: (() => void) | undefined } | null = null;

function openSheet(title: string, content: Node, { onClose }: { onClose?: () => void } = {}): HTMLElement {
	closeSheet();
	const panel = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title }, [
		el("div", { class: "sheet-head" }, [el("div", { class: "sheet-title", text: title }), iconButton("close", "Close", () => closeSheet())]),
		el("div", { class: "sheet-body" }, [content]),
	]);
	const scrim = el("div", { class: "sheet-scrim", onclick: () => closeSheet() });
	sheetRoot.replaceChildren(scrim, panel);
	sheet = { onClose };
	requestAnimationFrame(() => sheetRoot.classList.add("is-open"));
	return panel;
}

function closeSheet(): boolean {
	if (!sheet) return false;
	const { onClose } = sheet;
	sheet = null;
	sheetRoot.classList.remove("is-open");
	sheetRoot.replaceChildren();
	if (onClose) onClose();
	return true;
}

function confirmSheet(title: string, message: string, { confirm = "Continue", danger = false } = {}): Promise<boolean> {
	return new Promise((resolve) => {
		let answered = false;
		const done = (value: boolean): void => {
			answered = true;
			closeSheet();
			resolve(value);
		};
		openSheet(
			title,
			el("div", { class: "stack" }, [
				el("p", { class: "sheet-text", text: message }),
				el("div", { class: "row-actions" }, [
					el("button", { class: "btn btn-ghost", type: "button", text: "Cancel", onclick: () => done(false) }),
					el("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, type: "button", text: confirm, onclick: () => done(true) }),
				]),
			]),
			{ onClose: () => { if (!answered) resolve(false); } },
		);
	});
}

function promptSheet(title: string, value = ""): Promise<string | null> {
	return new Promise((resolve) => {
		let answered = false;
		const field = el("input", { class: "field", type: "text", value, autocomplete: "off" });
		const done = (result: string | null): void => {
			answered = true;
			closeSheet();
			resolve(result);
		};
		openSheet(
			title,
			el("div", { class: "stack" }, [
				field,
				el("div", { class: "row-actions" }, [
					el("button", { class: "btn btn-ghost", type: "button", text: "Cancel", onclick: () => done(null) }),
					el("button", { class: "btn btn-primary", type: "button", text: "Save", onclick: () => done(field.value.trim() || null) }),
				]),
			]),
			{ onClose: () => { if (!answered) resolve(null); } },
		);
		field.focus();
	});
}

// ------------------------------------------------------------- hosts screen ---
function hostsScreen(): Screen {
	const list = el("div", { class: "list" });
	const node = el("div", { class: "screen" }, [
		topbar({ title: "pi remote", back: false, actions: [iconButton("settings", "Settings", () => void openSettings())] }),
		el("main", { class: "content" }, [list]),
	]);
	let disposed = false;

	function hostCard(host: Host): HTMLButtonElement {
		const dot = el("span", { class: "dot is-checking", title: "checking" });
		const via = el("span", { class: "card-meta", text: "checking…" });
		const card = el("button", { class: "card host-card", type: "button", onclick: () => { go(sessionsScreen, host); } }, [
			el("div", { class: "card-icon" }, [icon("computer")]),
			el("div", { class: "card-main" }, [
				el("div", { class: "card-title" }, [dot, el("span", { text: host.name })]),
				via,
				el("div", { class: "card-meta mono", text: `this phone: ${String(host.deviceIdDisplay)}` }),
			]),
			el("div", { class: "card-chevron" }, [icon("forward")]),
		]);
		call("hosts.probe", { hostId: host.id })
			.then((result) => {
				if (disposed) return;
				const r = asProbe(result);
				dot.className = `dot ${r.reachable ? "is-online" : "is-offline"}`;
				if (r.reachable) via.textContent = `online ${viaLabel(r.address)}`;
				else if (r.code === "pin_mismatch" || r.code === "unlinked") via.textContent = errorMessage(r);
				else via.textContent = `offline (last used ${relativeTime(host.lastUsedAt) || "never"})`;
			})
			.catch(() => {
				if (disposed) return;
				dot.className = "dot is-offline";
				via.textContent = "offline";
			});
		return card;
	}

	async function refresh(): Promise<void> {
		let hosts: Host[] = [];
		try {
			hosts = asHosts(await call("hosts.list"));
		} catch (error) {
			toast(errorMessage(error), "error");
		}
		if (disposed) return;
		clear(list);
		if (!hosts.length) {
			list.append(
				el("div", { class: "empty" }, [
					el("div", { class: "empty-mark" }, [icon("computer")]),
					el("h1", { class: "empty-title", text: "Link your computer" }),
					el("p", { class: "empty-text", text: "On the computer, run /remote in pi. It shows a QR code: scan it here, then approve this phone in the terminal." }),
					el("button", { class: "btn btn-primary btn-block", type: "button", onclick: () => { go(linkScreen, {}); } }, [icon("qr"), el("span", { text: "Link a computer" })]),
				]),
			);
			return;
		}
		list.append(el("div", { class: "section-label", text: "Computers" }));
		for (const host of hosts) list.append(hostCard(host));
		list.append(el("button", { class: "btn btn-ghost btn-block add-host", type: "button", onclick: () => { go(linkScreen, {}); } }, [icon("plus"), el("span", { text: "Link another computer" })]));
	}

	void refresh();
	return {
		node,
		restore: hostsScreen,
		dispose: () => (disposed = true),
		onResume: () => void refresh(),
	};
}

// -------------------------------------------------------------- link screen ---
interface PairLink {
	hosts: string[];
	port: number;
	name: string;
	code: string;
	fingerprint: string;
}

function parsePairLink(link: string): PairLink | null {
	try {
		const url = new URL(link);
		if (url.protocol !== "pirc:") return null;
		const p = url.searchParams;
		const hosts = (p.get("h") || "").split(",").filter(Boolean);
		const port = Number(p.get("p"));
		const fingerprint = p.get("f");
		const code = p.get("c");
		if (!hosts.length || !Number.isInteger(port) || !fingerprint || !code) return null;
		return { hosts, port, name: p.get("n") || String(hosts[0]), code, fingerprint };
	} catch {
		return null;
	}
}

function linkScreen({ link }: { link?: string | undefined } = {}): Screen {
	const body = el("main", { class: "content link" });
	const bar = topbar({ title: "Link a computer" });
	const node = el("div", { class: "screen" }, [bar, body]);
	let pairingId: string | null = null;
	let disposed = false;

	const step = (...children: Node[]): void => {
		if (!disposed) body.replaceChildren(el("div", { class: "stack" }, children));
	};

	function choose(): void {
		step(
			el("ol", { class: "steps" }, [
				el("li", { text: "On the computer, run /remote (or /remote pair) in pi." }),
				el("li", { text: "Scan the QR code it shows." }),
				el("li", { text: "Approve this phone in the terminal after checking its device ID." }),
			]),
			el("button", { class: "btn btn-primary btn-block", type: "button", onclick: () => void scan() }, [icon("qr"), el("span", { text: "Scan QR code" })]),
			el("button", { class: "btn btn-ghost btn-block", type: "button", onclick: manual }, [icon("keyboard"), el("span", { text: "Enter the details instead" })]),
			el("p", { class: "hint", text: "Away from home? Link over Tailscale or another VPN: the computer lists every address it can be reached at." }),
		);
	}

	async function scan(): Promise<void> {
		try {
			const result = await call("pair.scan");
			const scanned = isRecord(result) ? str(result.link) : undefined;
			if (scanned) fromLink(scanned);
		} catch (error) {
			toast(errorMessage(error), "error");
		}
	}

	function fromLink(text: string): void {
		const parsed = parsePairLink(text);
		if (!parsed) {
			step(el("p", { class: "error-text", text: "That QR code is not a pi remote pairing code." }), el("button", { class: "btn btn-ghost btn-block", type: "button", text: "Try again", onclick: choose }));
			return;
		}
		step(
			el("h2", { class: "step-title", text: `Link to “${parsed.name}”?` }),
			el("dl", { class: "facts" }, [
				el("dt", { text: "Addresses" }),
				el("dd", { class: "mono", text: parsed.hosts.map((h) => `${h}:${parsed.port}`).join("\n") }),
			]),
			el("p", { class: "hint", text: "Only link to a computer you just ran /remote on." }),
			el("div", { class: "row-actions" }, [
				el("button", { class: "btn btn-ghost", type: "button", text: "Cancel", onclick: choose }),
				el("button", { class: "btn btn-primary", type: "button", text: "Link", onclick: () => void begin({ link: text }, parsed.name) }),
			]),
		);
	}

	function manual(): void {
		const address = el("input", { class: "field", type: "text", inputmode: "url", autocapitalize: "off", autocomplete: "off", spellcheck: "false", placeholder: "an address /remote shows" });
		const port = el("input", { class: "field", type: "number", inputmode: "numeric", value: "8765" });
		const code = el("input", { class: "field mono", type: "text", autocapitalize: "characters", autocomplete: "off", spellcheck: "false", placeholder: "ABCDE-FGHJK", maxlength: "11" });
		const error = el("p", { class: "error-text" });
		const next = el("button", { class: "btn btn-primary btn-block", type: "button", text: "Continue" });
		next.onclick = async () => {
			error.textContent = "";
			const addr = address.value.trim();
			const portNum = Number(port.value);
			const codeText = code.value.trim().toUpperCase();
			if (!addr || !Number.isInteger(portNum) || portNum <= 0 || portNum > 65535 || codeText.replace(/[^0-9A-Z]/g, "").length !== 10) {
				error.textContent = "Enter the address, the port and the 10-character code shown on the computer.";
				return;
			}
			next.disabled = true;
			next.textContent = "Connecting…";
			try {
				const probe = asPairProbe(await call("pair.probe", { address: addr, port: portNum }));
				if (!probe) throw new Error("the app sent a malformed answer");
				confirmFingerprint(addr, portNum, codeText, probe);
			} catch (e) {
				error.textContent = errorMessage(e);
				next.disabled = false;
				next.textContent = "Continue";
			}
		};
		step(
			el("label", { class: "label", text: "Computer address" }),
			address,
			el("label", { class: "label", text: "Port" }),
			port,
			el("label", { class: "label", text: "Code" }),
			code,
			error,
			next,
			el("button", { class: "btn btn-quiet btn-block", type: "button", text: "Back", onclick: choose }),
		);
		address.focus();
	}

	function confirmFingerprint(address: string, port: number, code: string, probe: PairProbe): void {
		step(
			el("h2", { class: "step-title", text: `Check the computer’s certificate` }),
			el("p", { class: "sheet-text", text: `“${probe.name}” at ${address}:${port} presented this certificate. It must match the “Certificate” line shown by /remote on the computer.` }),
			el("div", { class: "fingerprint mono", text: probe.fingerprintDisplay }),
			el("div", { class: "row-actions" }, [
				el("button", { class: "btn btn-ghost", type: "button", text: "It does not match", onclick: choose }),
				el("button", { class: "btn btn-primary", type: "button", text: "It matches", onclick: () => void begin({ addresses: [address], port, fingerprint: probe.fingerprint, code }, probe.name) }),
			]),
		);
	}

	async function begin(params: NativeParams["pair.begin"], name: string): Promise<void> {
		step(el("div", { class: "spinner-block" }, [el("div", { class: "spinner" }), el("p", { text: `Contacting “${name}”…` })]));
		let started: PairStart | null;
		try {
			started = asPairStart(await call("pair.begin", params));
		} catch (error) {
			failed(errorMessage(error));
			return;
		}
		if (!started) {
			failed("the app sent a malformed answer");
			return;
		}
		const id = started.pairingId;
		pairingId = id;
		const cancel = async (): Promise<void> => {
			// The app reads a missing id as "" and cancels nothing, so an ended one is skipped here.
			if (pairingId) await call("pair.cancel", { pairingId }).catch(() => {});
			pairingId = null;
			choose();
		};
		step(
			el("p", { class: "eyebrow", text: `Waiting for approval on “${started.hostName}”` }),
			el("div", { class: "device-id mono", text: started.deviceIdDisplay }),
			el("p", { class: "sheet-text", text: "In the terminal on the computer, approve the request after checking it shows exactly this device ID." }),
			el("div", { class: "spinner-row" }, [el("div", { class: "spinner" }), el("span", { text: "waiting…" })]),
			el("button", {
				class: "btn btn-ghost btn-block",
				type: "button",
				text: "Cancel",
				onclick: () => void cancel(),
			}),
		);
		try {
			const result = asPairResult(await call("pair.wait", { pairingId: id }));
			pairingId = null;
			if (disposed) return;
			const host = result.host;
			if (result.state === "approved" && host) {
				step(
					el("div", { class: "success-mark" }, [icon("check")]),
					el("h2", { class: "step-title", text: `Linked to “${host.name}”` }),
					el("p", { class: "sheet-text", text: "This phone can now open that computer’s pi sessions. Unlink it from here, or with /remote revoke on the computer." }),
					el("button", { class: "btn btn-primary btn-block", type: "button", text: "Open sessions", onclick: () => {
						state.stack = [hostsScreen];
						render(sessionsScreen(host));
					} }),
				);
				return;
			}
			if (result.state === "cancelled") return;
			failed(result.state === "rejected" ? "The computer rejected this phone." : `Linking ended: ${String(result.reason || result.state)}.`);
		} catch (error) {
			pairingId = null;
			failed(errorMessage(error));
		}
	}

	function failed(message: string): void {
		step(el("p", { class: "error-text", text: message }), el("button", { class: "btn btn-primary btn-block", type: "button", text: "Start again", onclick: choose }));
	}

	if (link) fromLink(link);
	else choose();
	return {
		node,
		restore: () => linkScreen({}),
		dispose: () => {
			disposed = true;
			if (pairingId) call("pair.cancel", { pairingId }).catch(() => {});
		},
	};
}

// ---------------------------------------------------------- sessions screen ---
interface StatusStyle {
	label: string;
	cls: string;
}

const IDLE: StatusStyle = { label: "", cls: "is-idle" };
const STATUS: Readonly<Record<string, StatusStyle>> = {
	terminal: { label: "Terminal", cls: "is-terminal" },
	running: { label: "Running", cls: "is-running" },
	external: { label: "Open elsewhere", cls: "is-external" },
	idle: IDLE,
};

function sessionTitle(s: PhoneSession): string {
	return s.name || firstLine(s.preview) || `Session ${shortId(s.id)}`;
}

function sessionsScreen(host: Host): Screen {
	const live = el("div", { class: "list" });
	const recent = el("div", { class: "list" });
	const bar = topbar({
		title: host.name,
		subtitle: "connecting…",
		actions: [iconButton("refresh", "Refresh", () => void refresh(true)), iconButton("more", "Computer", () => { hostMenu(host); })],
	});
	const fab = el("button", { class: "fab", type: "button", "aria-label": "New session", onclick: () => void newSessionSheet(host) }, [icon("plus"), el("span", { text: "New" })]);
	const node = el("div", { class: "screen" }, [bar, el("main", { class: "content" }, [live, recent]), fab]);
	let disposed = false;
	let timer: number | undefined;
	let showAll = false;
	let sessions: PhoneSession[] = [];

	function card(s: PhoneSession): HTMLButtonElement {
		const status = STATUS[s.status ?? ""] ?? IDLE;
		const badges: HTMLElement[] = [];
		if (status.label) badges.push(el("span", { class: `chip ${status.cls}`, text: status.label }));
		if (s.busy) badges.push(el("span", { class: "chip is-busy" }, [el("span", { class: "pulse" }), el("span", { text: "working" })]));
		if (s.pendingDialogs) badges.push(el("span", { class: "chip is-alert", text: s.pendingDialogs === 1 ? "approval needed" : `${s.pendingDialogs} approvals needed` }));
		const model = modelId(s.model);
		return el("button", { class: `card session-card ${status.cls}`, type: "button", onclick: () => { go(chatScreen, host, s); } }, [
			el("div", { class: "card-main" }, [
				el("div", { class: "card-title", text: sessionTitle(s) }),
				el("div", { class: "card-meta mono", text: [shortPath(s.cwd), model].filter(Boolean).join("  ·  ") }),
				badges.length ? el("div", { class: "chips" }, badges) : null,
			]),
			el("div", { class: "card-side" }, [el("span", { class: "card-when", text: relativeTime(s.lastActivityAt) })]),
		]);
	}

	function draw(): void {
		clear(live);
		clear(recent);
		const liveOnes = sessions.filter((s) => s.status === "terminal" || s.status === "running" || s.status === "external");
		const rest = sessions.filter((s) => !liveOnes.includes(s));
		live.append(el("div", { class: "section-label", text: "Live" }));
		if (!liveOnes.length) {
			live.append(el("p", { class: "hint", text: "Nothing is shared right now. Run /remote in a pi terminal to drive it from here, or start a new session." }));
		}
		for (const s of liveOnes) live.append(card(s));
		if (rest.length) {
			recent.append(el("div", { class: "section-label", text: "Recent" }));
			for (const s of showAll ? rest : rest.slice(0, 25)) recent.append(card(s));
			if (!showAll && rest.length > 25) {
				recent.append(el("button", { class: "btn btn-quiet btn-block", type: "button", text: `Show ${rest.length - 25} more`, onclick: () => { showAll = true; draw(); } }));
			}
		}
	}

	async function refresh(manual = false): Promise<void> {
		clearTimeout(timer);
		try {
			const [listed, probed] = await Promise.all([api(host.id, "GET", "/api/sessions"), manual ? call("hosts.probe", { hostId: host.id }).catch(() => null) : Promise.resolve(null)]);
			if (disposed) return;
			const list = isRecord(listed) ? listed.sessions : undefined;
			sessions = Array.isArray(list) ? list.flatMap((s: unknown) => asSession(s) ?? []) : [];
			fab.hidden = false;
			draw();
			const probe = probed === null ? null : asProbe(probed);
			const where = probe?.address ? viaLabel(probe.address) : "connected";
			bar.setSubtitle(el("span", { class: "status-line" }, [el("span", { class: "dot is-online" }), el("span", { text: where })]));
		} catch (error) {
			if (disposed) return;
			const code = isRecord(error) ? error.code : undefined;
			bar.setSubtitle(el("span", { class: "status-line" }, [el("span", { class: "dot is-offline" }), el("span", { text: code === "unreachable" ? "offline" : "error" })]));
			if (code === "unlinked" || code === "pin_mismatch") {
				// Retrying cannot help: the phone has to be linked again.
				sessions = [];
				live.replaceChildren(
					el("div", { class: "empty" }, [
						el("h1", { class: "empty-title", text: "Link this phone again" }),
						el("p", { class: "empty-text", text: errorMessage(error) }),
						el("button", { class: "btn btn-primary btn-block", type: "button", onclick: () => { go(linkScreen, {}); } }, [icon("qr"), el("span", { text: "Link again" })]),
					]),
				);
				recent.replaceChildren();
				fab.hidden = true;
				return;
			}
			if (manual || !sessions.length) toast(errorMessage(error), "error");
		}
		if (!disposed) timer = setTimeout(() => void refresh(), 5000);
	}

	void refresh(true);
	return {
		node,
		restore: () => sessionsScreen(host),
		dispose: () => {
			disposed = true;
			clearTimeout(timer);
		},
		onResume: () => void refresh(true),
		onPause: () => { clearTimeout(timer); },
	};
}

function hostMenu(host: Host): void {
	async function rename(): Promise<void> {
		const name = await promptSheet("Rename computer", host.name);
		if (!name) return;
		await call("hosts.rename", { hostId: host.id, name: name.trim() }).catch((e: unknown) => { toast(errorMessage(e), "error"); });
		closeSheet();
		goHome();
	}
	async function unlink(): Promise<void> {
		const ok = await confirmSheet(`Unlink from “${host.name}”?`, "The computer forgets this phone and the phone forgets its key. To use it again, link it again with /remote pair.", { confirm: "Unlink", danger: true });
		if (!ok) return;
		const result = await call("hosts.remove", { hostId: host.id, unlinkRemote: true }).catch((e: unknown) => ({ error: e }));
		if (isRecord(result) && result.error) toast(`Removed here, but the computer could not be told: ${errorMessage(result.error)}`, "warning");
		else toast(`Unlinked from “${host.name}”.`);
		goHome();
	}
	const content = el("div", { class: "stack" }, [
		el("dl", { class: "facts" }, [
			el("dt", { text: "This phone’s ID" }),
			el("dd", { class: "mono", text: host.deviceIdDisplay }),
			el("dt", { text: "Addresses" }),
			el("dd", { class: "mono", text: host.addresses.map((a) => `${a}:${String(host.port)}`).join("\n") }),
			el("dt", { text: "Certificate" }),
			el("dd", { class: "mono", text: host.fingerprintDisplay || "" }),
			el("dt", { text: "Linked" }),
			el("dd", { text: host.pairedAt ? new Date(host.pairedAt).toLocaleString() : "" }),
		]),
		el("button", {
			class: "btn btn-ghost btn-block",
			type: "button",
			text: "Rename",
			onclick: () => void rename(),
		}),
		el("button", {
			class: "btn btn-danger btn-block",
			type: "button",
			text: "Unlink this phone",
			onclick: () => void unlink(),
		}),
	]);
	openSheet(host.name, content);
}

// --------------------------------------------------------------- chat screen ---
function chatScreen(host: Host, session: PhoneSession): Screen {
	const log = el("div", { class: "chat-log", role: "log", "aria-live": "polite" });
	const chat = new MobileChat(log);
	const dock = el("div", { class: "dock" });
	const banner = el("div", { class: "banner", hidden: true });
	const jump = el("button", { class: "jump", type: "button", hidden: true, text: "↓ latest", onclick: () => { chat.goToEnd(); } });
	chat.onStickChange = (stick) => (jump.hidden = stick);
	log.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const link = target.closest("a[href]");
		if (link) {
			// Never navigate the app's page: links open in the browser (http and https only).
			event.preventDefault();
			call("app.openUrl", { url: link.getAttribute("href") }).catch((error: unknown) => { toast(errorMessage(error), "error"); });
			return;
		}
		const head = target.closest(".tool-head");
		if (head?.parentElement) head.parentElement.classList.toggle("is-open");
	});

	const stopBtn = iconButton("stop", "Stop the current run", () => void abort(), "is-danger");
	stopBtn.hidden = true;
	const bar = topbar({ title: sessionTitle(session), actions: [stopBtn, iconButton("info", "Session details", () => { detailsSheet(); })] });

	const input = el("textarea", { class: "composer-input", rows: "1", placeholder: "Message pi…", enterkeyhint: "enter" });
	const sendBtn = el("button", { class: "send-btn", type: "button", "aria-label": "Send", onclick: () => void send() }, [icon("send")]);
	let mode: "followUp" | "steer" = "followUp";
	const modeQueue = el("button", { class: "seg is-on", type: "button", text: "After this run", onclick: () => { setMode("followUp"); } });
	const modeSteer = el("button", { class: "seg", type: "button", text: "Steer now", onclick: () => { setMode("steer"); } });
	const modes = el("div", { class: "segmented", hidden: true }, [modeQueue, modeSteer]);
	const composerNote = el("div", { class: "composer-note", hidden: true });
	const composer = el("footer", { class: "composer" }, [composerNote, modes, el("div", { class: "composer-row" }, [input, sendBtn])]);

	const node = el("div", { class: "screen chat-screen" }, [bar, banner, el("div", { class: "chat-wrap" }, [log, jump]), dock, composer]);

	let stream: NativeStream | null = null;
	let lifecycle: string | null = session.status === "terminal" ? "terminal" : null;
	let busy = Boolean(session.busy);
	let disposed = false;
	let retry = 0;
	let retryTimer: number | undefined;
	// In the background the stream stays open for a short while (a quick switch to another app
	// loses nothing), then closes until the app is back in front.
	let paused = false;
	let pauseTimer: number | undefined;
	let fresh = true;
	let meta: PhoneSession = { ...session };
	const cards = new Map<string, DialogCard>();

	function setMode(next: "followUp" | "steer"): void {
		mode = next;
		modeQueue.classList.toggle("is-on", mode === "followUp");
		modeSteer.classList.toggle("is-on", mode === "steer");
	}

	function autosize(): void {
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
	}
	input.addEventListener("input", autosize);

	function drivable(): string | null {
		if (lifecycle === "watching") return "This session is open in a pi terminal that is not shared. Run /remote there to drive it from here.";
		if (lifecycle === "detached") return "The terminal stopped sharing this session.";
		if (lifecycle === "revoked") return "This phone was unlinked from the computer.";
		if (lifecycle === "host_stopping") return "pi remote stopped on the computer.";
		if (lifecycle === "gone") return "This session is no longer on the computer.";
		return null;
	}

	function updateChrome(): void {
		const reason = drivable();
		input.disabled = Boolean(reason);
		sendBtn.disabled = Boolean(reason);
		composerNote.hidden = !reason;
		composerNote.textContent = reason || "";
		modes.hidden = !busy || Boolean(reason);
		stopBtn.hidden = !busy || Boolean(reason);
		input.placeholder = busy ? (mode === "steer" ? "Steer the current run…" : "Queue a message for after this run…") : "Message pi…";
		const status = STATUS[lifecycle === "watching" ? "external" : String(lifecycle)] ?? null;
		const model = modelId(meta.model);
		const parts: HTMLElement[] = [];
		if (status?.label) parts.push(el("span", { class: `chip ${status.cls}`, text: status.label }));
		if (busy) parts.push(el("span", { class: "chip is-busy" }, [el("span", { class: "pulse" }), el("span", { text: "working" })]));
		if (model) parts.push(el("span", { class: "topbar-model mono", text: `${model}${meta.thinking ? ` · ${meta.thinking}` : ""}` }));
		bar.setSubtitle(el("span", { class: "status-line" }, parts));
	}

	function showBanner(text: string, action?: { label: string; run: () => void }): void {
		banner.replaceChildren(el("span", { text }), ...(action ? [el("button", { class: "btn btn-quiet", type: "button", text: action.label, onclick: action.run })] : []));
		banner.hidden = false;
	}

	function hideBanner(): void {
		banner.hidden = true;
	}

	// ---- dialogs
	function addDialog(dialog: Dialog | null): void {
		if (!dialog || cards.has(dialog.id)) return;
		const card = dialogCard(dialog, (payload) => api(host.id, "POST", `/api/sessions/${encodeURIComponent(session.id)}/ui-response`, { dialogId: dialog.id, ...payload }).catch((error: unknown) => {
			if (isRecord(error) && error.status === 404) {
				removeDialog(dialog.id, "terminal");
				toast("Already answered at the computer.");
				return;
			}
			throw new Error(errorMessage(error));
		}));
		cards.set(dialog.id, card);
		dock.append(card);
		call("app.haptic", { kind: "alert" }).catch(() => {});
	}

	function removeDialog(id: string, by: string | undefined): void {
		const card = cards.get(id);
		if (!card) return;
		cards.delete(id);
		card.dispose();
		card.classList.add("is-leaving");
		setTimeout(() => { card.remove(); }, 180);
		if (by === "terminal") toast("Answered at the computer.");
	}

	function clearDialogs(): void {
		for (const card of cards.values()) {
			card.dispose();
			card.remove();
		}
		cards.clear();
	}

	// ---- stream
	function onFrame({ name, data: raw }: StreamFrame): void {
		if (!raw) return;
		if (fresh) {
			// The new stream replays everything: only now drop what the old one showed, so a
			// dropped connection leaves the transcript on screen while it reconnects.
			fresh = false;
			chat.reset();
			chat.replaying = true;
			clearDialogs();
		}
		const data: Rec = isRecord(raw) ? raw : {};
		switch (name) {
			case "lifecycle": {
				const next = str(data.state) ?? null;
				const frameSession = isRecord(data.session) ? data.session : null;
				lifecycle = next;
				if (frameSession) meta = { ...meta, ...sessionPatch(frameSession) };
				if (next === "terminal" && frameSession) busy = Boolean(frameSession.busy);
				if (next === "running" && typeof data.busy === "boolean") busy = data.busy;
				if (next === "detached") {
					busy = false;
					clearDialogs();
					showBanner("The terminal stopped sharing this session.", { label: "Reopen", run: () => { connect(); } });
				} else if (next === "revoked") {
					showBanner("This phone was unlinked from the computer.");
				} else if (next === "host_stopping") {
					showBanner("pi remote stopped on the computer.", { label: "Retry", run: () => { connect(); } });
				} else if (next === "gone") {
					busy = false;
					clearDialogs();
				} else if (next === "exited") {
					busy = false;
					const code = data.code;
					chat.system(`pi exited${code !== undefined && code !== null ? ` (code ${typeof code === "number" || typeof code === "string" ? code : JSON.stringify(code)})` : ""}`);
				}
				updateChrome();
				return;
			}
			case "observed":
				chat.handle(data.data);
				return;
			case "event": {
				const event = data.data;
				if (!event) return;
				const type = isRecord(event) ? event.type : undefined;
				if (type === "agent_start") busy = true;
				if (type === "agent_end" || type === "agent_settled") busy = false;
				if (type === "agent_start" || type === "agent_end" || type === "agent_settled") updateChrome();
				chat.handle(event);
				return;
			}
			case "streaming":
				chat.applyStreaming(data.state);
				return;
			case "history_end":
				chat.replaying = false;
				chat.goToEnd();
				return;
			case "ui_request":
				addDialog(asDialog(data.dialog));
				return;
			case "ui_resolved":
				if (typeof data.id === "string") removeDialog(data.id, str(data.by));
				return;
			case "notify":
				toast(str(data.message) ?? "", data.level === "error" ? "error" : data.level === "warning" ? "warning" : "info");
				return;
			case "meta":
				if (isRecord(data.session)) {
					const patch = sessionPatch(data.session);
					meta = { ...meta, ...patch };
					if (typeof data.session.busy === "boolean") busy = data.session.busy;
					if (patch.name) bar.setTitle(patch.name);
					updateChrome();
				}
				return;
			case "notice":
				toast(str(data.message) ?? "", "warning");
				return;
			default:
		}
	}

	function onState(stateName: string, message?: string | null): void {
		if (disposed) return;
		if (stateName === "open") {
			retry = 0;
			hideBanner();
			return;
		}
		// closed or error: reconnect unless the session cannot come back by itself.
		stream = null;
		if (paused || lifecycle === "detached" || lifecycle === "revoked") return;
		if (message && /unlinked/i.test(message)) {
			showBanner("This phone is no longer linked to that computer.");
			return;
		}
		const delay = Math.min(1000 * 2 ** retry, 15000);
		retry++;
		showBanner(retry > 1 ? `Reconnecting… (${message || "connection lost"})` : "Reconnecting…");
		clearTimeout(retryTimer);
		retryTimer = setTimeout(() => { if (!disposed) connect(); }, delay);
	}

	function connect(): void {
		clearTimeout(retryTimer);
		if (stream) stream.close();
		fresh = true;
		hideBanner();
		stream = openStream(host.id, `/api/sessions/${encodeURIComponent(session.id)}/events`, onFrame, onState);
	}

	// ---- actions
	async function send(): Promise<void> {
		const text = input.value.trim();
		if (!text || drivable()) return;
		// PromptBody in server/remote/api.ts.
		const body: { message: string; streamingBehavior?: string } = { message: text };
		if (busy) body.streamingBehavior = mode;
		input.value = "";
		autosize();
		const pendingNode = chat.addPending(text);
		const wasIdle = lifecycle === "idle" || lifecycle === "exited";
		try {
			const result = await api(host.id, "POST", `/api/sessions/${encodeURIComponent(session.id)}/prompt`, body);
			const delivered = isRecord(result) ? result.delivered : undefined;
			if (delivered === "steer") toast("Steering the current run.");
			else if (delivered === "followUp") toast("Queued for after this run.");
			// A session that was not running has just been started; follow it live.
			if (wasIdle) setTimeout(() => { if (!disposed) connect(); }, 600);
		} catch (error) {
			chat.failPending(pendingNode, errorMessage(error));
			if (!input.value) {
				input.value = text;
				autosize();
			}
			toast(errorMessage(error), "error");
		}
	}

	async function abort(): Promise<void> {
		try {
			await api(host.id, "POST", `/api/sessions/${encodeURIComponent(session.id)}/abort`, {});
			toast("Stopping…");
		} catch (error) {
			toast(errorMessage(error), "error");
		}
	}

	function detailsSheet(): void {
		const body = el("div", { class: "stack" });
		const sid = encodeURIComponent(session.id);
		const modelSelect = el("select", { class: "field" });
		const thinkingSelect = el("select", { class: "field" }, THINKING.map((t) => el("option", { value: t, text: t })));
		thinkingSelect.value = meta.thinking || "medium";
		const statsNode = el("div", { class: "kv-wrap" }, [el("p", { class: "hint", text: "Loading…" })]);
		const todosNode = el("ul", { class: "todos" });
		const controllable = lifecycle === "terminal" || lifecycle === "running";

		body.append(
			el("dl", { class: "facts" }, [
				el("dt", { text: "Folder" }),
				el("dd", { class: "mono", text: meta.cwd || "" }),
				el("dt", { text: "Session" }),
				el("dd", { class: "mono", text: session.id }),
			]),
		);
		if (controllable) {
			body.append(el("label", { class: "label", text: "Model" }), modelSelect, el("label", { class: "label", text: "Thinking" }), thinkingSelect);
			const modelsPath = lifecycle === "terminal" ? `/api/sessions/${sid}/models` : "/api/models";
			api(host.id, "GET", modelsPath)
				.then((data) => {
					const current = meta.model && typeof meta.model === "object" ? `${String(meta.model.provider)}|${String(meta.model.id)}` : "";
					modelSelect.replaceChildren(el("option", { value: "", text: current ? current.replaceAll("|", " / ") : "current model" }));
					for (const provider of asProviders(data)) {
						const group = el("optgroup", { label: provider.name });
						for (const model of provider.models) group.append(el("option", { value: `${provider.name}|${model}`, text: model }));
						modelSelect.append(group);
					}
					modelSelect.value = "";
				})
				.catch(() => { modelSelect.replaceChildren(el("option", { value: "", text: "models unavailable" })); });
			modelSelect.onchange = async () => {
				if (!modelSelect.value) return;
				const [provider, ...rest] = modelSelect.value.split("|");
				try {
					await api(host.id, "POST", `/api/sessions/${sid}/model`, { provider, modelId: rest.join("|") });
					meta.model = { provider, id: rest.join("|") };
					updateChrome();
					toast(`Model: ${rest.join("|")}`);
				} catch (error) {
					toast(errorMessage(error), "error");
				}
			};
			thinkingSelect.onchange = async () => {
				try {
					await api(host.id, "POST", `/api/sessions/${sid}/thinking`, { level: thinkingSelect.value });
					meta.thinking = thinkingSelect.value;
					updateChrome();
					toast(`Thinking: ${thinkingSelect.value}`);
				} catch (error) {
					toast(errorMessage(error), "error");
				}
			};
		}
		body.append(el("div", { class: "section-label", text: "Usage" }), statsNode, el("div", { class: "section-label", text: "Todos" }), todosNode);
		if (lifecycle === "running") {
			const endSession = async (): Promise<void> => {
				const ok = await confirmSheet("End the pi process?", "The session is kept on the computer and can be continued later.", { confirm: "End it", danger: true });
				if (!ok) return;
				try {
					await api(host.id, "DELETE", `/api/sessions/${sid}`);
					toast("Ending the session…");
				} catch (error) {
					toast(errorMessage(error), "error");
				}
			};
			body.append(
				el("button", {
					class: "btn btn-danger btn-block",
					type: "button",
					text: "End this session’s pi process",
					onclick: () => void endSession(),
				}),
			);
		}
		openSheet("Session", body);
		api(host.id, "GET", `/api/sessions/${sid}/stats`)
			.then((data) => {
				if (!isRecord(data)) throw new TypeError("no statistics");
				renderStats(statsNode, isRecord(data.stats) ? data.stats : null, meta);
			})
			.catch(() => { statsNode.replaceChildren(el("p", { class: "hint", text: "No statistics for this session." })); });
		api(host.id, "GET", `/api/sessions/${sid}/todos`)
			.then((data) => { renderTodos(todosNode, isRecord(data) ? data : null); })
			.catch(() => { todosNode.replaceChildren(el("li", { class: "hint", text: "No todos." })); });
	}

	updateChrome();
	connect();
	return {
		node,
		restore: () => chatScreen(host, meta),
		dispose: () => {
			disposed = true;
			clearTimeout(retryTimer);
			clearTimeout(pauseTimer);
			if (stream) stream.close();
			clearDialogs();
		},
		onPause: () => {
			clearTimeout(pauseTimer);
			pauseTimer = setTimeout(() => {
				paused = true;
				clearTimeout(retryTimer);
				if (stream) stream.close();
				stream = null;
			}, 30000);
		},
		onResume: () => {
			clearTimeout(pauseTimer);
			paused = false;
			if (!stream && lifecycle !== "detached" && lifecycle !== "revoked") connect();
		},
	};
}

// ----------------------------------------------------------- new session ---
async function newSessionSheet(host: Host): Promise<void> {
	const cwd = el("select", { class: "field" });
	const cwdCustom = el("input", { class: "field mono", type: "text", placeholder: "or type a folder path", autocapitalize: "off", spellcheck: "false" });
	const model = el("select", { class: "field" }, [el("option", { value: "", text: "pi’s default" })]);
	const thinking = el("select", { class: "field" }, [el("option", { value: "", text: "pi’s default" }), ...THINKING.map((t) => el("option", { value: t, text: t }))]);
	const agent = el("select", { class: "field" }, [el("option", { value: "", text: "none" })]);
	const error = el("p", { class: "error-text" });
	const create = el("button", { class: "btn btn-primary btn-block", type: "button", text: "Start session" });
	openSheet(
		"New session",
		el("div", { class: "stack" }, [
			el("label", { class: "label", text: "Folder" }),
			cwd,
			cwdCustom,
			el("label", { class: "label", text: "Model" }),
			model,
			el("label", { class: "label", text: "Thinking" }),
			thinking,
			el("label", { class: "label", text: "Agent" }),
			agent,
			error,
			create,
		]),
	);
	const [cwds, models, agents] = await Promise.all([
		api(host.id, "GET", "/api/cwds").catch(() => ({ cwds: [] })),
		api(host.id, "GET", "/api/models").catch(() => ({ providers: [] })),
		api(host.id, "GET", "/api/agents").catch(() => ({ agents: [] })),
	]);
	for (const dir of stringList(isRecord(cwds) ? cwds.cwds : undefined)) cwd.append(el("option", { value: dir, text: dir }));
	for (const provider of asProviders(models)) {
		const group = el("optgroup", { label: provider.name });
		for (const m of provider.models) group.append(el("option", { value: `${provider.name}|${m}`, text: m }));
		model.append(group);
	}
	for (const a of asAgents(agents)) agent.append(el("option", { value: `${a.source || ""}|${a.name}`, text: a.description ? `${a.name}: ${firstLine(a.description, 50)}` : a.name }));
	create.onclick = async () => {
		error.textContent = "";
		// What POST /api/sessions reads (pi-console's spawn request).
		const body: { cwd: string | undefined; provider?: string | undefined; model?: string; thinking?: string; agent?: string; agentSource?: string } = { cwd: cwdCustom.value.trim() || cwd.value || undefined };
		if (model.value) {
			const [provider, ...rest] = model.value.split("|");
			body.provider = provider;
			body.model = rest.join("|");
		}
		if (thinking.value) body.thinking = thinking.value;
		if (agent.value) {
			const [source, ...name] = agent.value.split("|");
			body.agent = name.join("|");
			if (source) body.agentSource = source;
		}
		create.disabled = true;
		create.textContent = "Starting…";
		try {
			const result = await api(host.id, "POST", "/api/sessions", body);
			const started = asSession({ ...(isRecord(result) && isRecord(result.session) ? result.session : {}), status: "running" });
			if (!started) throw new Error("the computer sent a malformed answer");
			closeSheet();
			go(chatScreen, host, started);
		} catch (e) {
			error.textContent = errorMessage(e);
			create.disabled = false;
			create.textContent = "Start session";
		}
	};
}

// ----------------------------------------------------------------- settings ---
async function openSettings(): Promise<void> {
	const info = await call("app.info").then(asAppInfo, () => state.info ?? {});
	const lock = el("input", { type: "checkbox", class: "switch" });
	lock.checked = Boolean(info.lockEnabled);
	const secure = el("input", { type: "checkbox", class: "switch" });
	secure.checked = Boolean(info.secureScreen);
	lock.onchange = async () => {
		try {
			const r = await call("app.setLock", { enabled: lock.checked });
			lock.checked = Boolean(asAppInfo(r).lockEnabled);
		} catch (error) {
			lock.checked = !lock.checked;
			toast(errorMessage(error), "error");
		}
	};
	secure.onchange = async () => {
		try {
			const r = await call("app.setSecureScreen", { enabled: secure.checked });
			secure.checked = Boolean(asAppInfo(r).secureScreen);
		} catch (error) {
			secure.checked = !secure.checked;
			toast(errorMessage(error), "error");
		}
	};
	openSheet(
		"Settings",
		el("div", { class: "stack" }, [
			el("label", { class: "setting" }, [
				el("div", {}, [el("div", { class: "setting-title", text: "Lock the app" }), el("div", { class: "hint", text: "Ask for your fingerprint, face or screen lock when pi remote opens." })]),
				lock,
			]),
			el("label", { class: "setting" }, [
				el("div", {}, [el("div", { class: "setting-title", text: "Hide from screenshots" }), el("div", { class: "hint", text: "Blocks screenshots and blanks the app in the recent-apps view." })]),
				secure,
			]),
			el("dl", { class: "facts" }, [
				el("dt", { text: "Version" }),
				el("dd", { text: info.version || "" }),
				el("dt", { text: "Keys" }),
				el("dd", { text: info.keyStorage ? `Android Keystore (${info.keyStorage})` : "Android Keystore" }),
			]),
			el("p", { class: "hint", text: "pi remote talks to your computers directly, over your network or VPN. There is no pi remote server in between." }),
		]),
	);
}

// --------------------------------------------------------------------- boot ---
async function boot(): Promise<void> {
	let inApp = attach();
	if (!inApp && /[?&]mock\b/.test(location.search)) {
		// Development only: a stand-in for the app, served from mobile/dev (not packaged).
		try {
			const mock = await import("../dev/mock-native.ts");
			inApp = attach(mock.createMockChannel());
		} catch {
			inApp = false;
		}
	}
	if (!inApp) {
		app.replaceChildren(
			el("div", { class: "empty" }, [
				el("h1", { class: "empty-title", text: "pi remote" }),
				el("p", { class: "empty-text", text: "This page is the pi remote Android app’s interface. Open it in the app." }),
			]),
		);
		return;
	}
	on("deeplink", (msg) => {
		if (msg.link) go(linkScreen, { link: msg.link });
	});
	on("back", () => {
		if (!goBack()) call("app.exit").catch(() => {});
	});
	on("resume", () => state.screen?.onResume?.());
	on("pause", () => state.screen?.onPause?.());
	let info: AppInfo;
	try {
		info = asAppInfo(await call("app.info"));
	} catch {
		info = {};
	}
	state.info = info;
	render(hostsScreen());
	if (info.pendingLink) {
		go(linkScreen, { link: info.pendingLink });
		return;
	}
	try {
		const hosts = asHosts(await call("hosts.list"));
		const only = hosts[0];
		if (hosts.length === 1 && only) go(sessionsScreen, only);
	} catch {
		/* the hosts screen reports it */
	}
}

void boot();
