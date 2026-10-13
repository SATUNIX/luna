// main.js — pi remote: pi-console for a phone, inside the Android app.
//
// Screens: computers (linked hosts) -> link a computer -> sessions -> chat, plus bottom sheets for
// a new session, session details and settings. Everything that leaves the phone goes through the
// app (./native.js); this page holds no keys and no tokens.
import { clear, el, relativeTime } from "../../public/js/render.js";
import { renderStats, renderTodos } from "../../public/js/panels.js";
import { dialogCard, MobileChat } from "./chat.js";
import { api, attach, call, on, openStream } from "./native.js";

const app = document.getElementById("app");
const sheetRoot = document.getElementById("sheet-root");
const toastNode = document.getElementById("toast");

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const state = { info: null, screen: null, stack: [] };

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

function icon(name) {
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	svg.classList.add("icon");
	for (const d of ICONS[name] || []) {
		const path = document.createElementNS(SVG, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}

function iconButton(name, label, onclick, extra = "") {
	return el("button", { class: `icon-btn ${extra}`, type: "button", "aria-label": label, title: label, onclick }, [icon(name)]);
}

function toast(message, level = "info") {
	toastNode.textContent = message;
	toastNode.className = `toast is-${level}`;
	toastNode.hidden = false;
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => (toastNode.hidden = true), level === "error" ? 5000 : 3000);
}

function topbar({ title, subtitle, back = state.stack.length > 0, actions = [] }) {
	const sub = el("div", { class: "topbar-sub" }, subtitle ? [subtitle] : []);
	const titleNode = el("div", { class: "topbar-title", text: title || "" });
	const bar = el("header", { class: "topbar" }, [
		back ? iconButton("back", "Back", () => goBack()) : el("div", { class: "topbar-pad" }),
		el("div", { class: "topbar-text" }, [titleNode, sub]),
		el("div", { class: "topbar-actions" }, actions),
	]);
	bar.setTitle = (text) => (titleNode.textContent = text);
	bar.setSubtitle = (nodeOrText) => sub.replaceChildren(...(nodeOrText ? [nodeOrText] : []));
	return bar;
}

function shortId(id) {
	return id ? String(id).slice(0, 8) : "";
}

function shortPath(p) {
	if (!p) return "";
	const parts = String(p).split("/").filter(Boolean);
	return parts.length <= 2 ? String(p) : `…/${parts.slice(-2).join("/")}`;
}

function firstLine(text, max = 90) {
	const line = String(text || "")
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean);
	if (!line) return "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function isTailscale(address) {
	const m = /^100\.(\d+)\./.exec(address || "");
	return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
}

function viaLabel(address) {
	if (!address) return "";
	return isTailscale(address) ? `via Tailscale (${address})` : `via ${address}`;
}

function errorMessage(error) {
	if (!error) return "something went wrong";
	if (error.code === "unreachable") return "The computer cannot be reached. Is it on, and is this phone on the same network or VPN?";
	if (error.code === "unlinked") return "This phone is no longer linked to that computer.";
	if (error.code === "pin_mismatch") return "Something with a different certificate answered at the computer's address. If pi remote was reset on the computer, link this phone again.";
	return error.message || String(error);
}

// --------------------------------------------------------------- navigation ---
function render(screen) {
	if (state.screen && state.screen.dispose) state.screen.dispose();
	closeSheet();
	state.screen = screen;
	app.replaceChildren(screen.node);
	if (screen.focus) screen.focus();
}

function go(factory, ...args) {
	if (state.screen) state.stack.push(state.screen.restore);
	render(factory(...args));
}

function replace(factory, ...args) {
	render(factory(...args));
}

function goBack() {
	if (closeSheet()) return true;
	const restore = state.stack.pop();
	if (!restore) return false;
	render(restore());
	return true;
}

function goHome() {
	state.stack = [];
	render(hostsScreen());
}

// The system back gesture arrives as a "back" event (see boot); at the first screen the app
// is told to step aside. Kept on window for the desktop development page.
window.__piBack = () => goBack();

// ------------------------------------------------------------------- sheets ---
let sheet = null;

function openSheet(title, content, { onClose } = {}) {
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

function closeSheet() {
	if (!sheet) return false;
	const { onClose } = sheet;
	sheet = null;
	sheetRoot.classList.remove("is-open");
	sheetRoot.replaceChildren();
	if (onClose) onClose();
	return true;
}

function confirmSheet(title, message, { confirm = "Continue", danger = false } = {}) {
	return new Promise((resolve) => {
		let answered = false;
		const done = (value) => {
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
			{ onClose: () => !answered && resolve(false) },
		);
	});
}

function promptSheet(title, value = "") {
	return new Promise((resolve) => {
		let answered = false;
		const field = el("input", { class: "field", type: "text", value, autocomplete: "off" });
		const done = (result) => {
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
			{ onClose: () => !answered && resolve(null) },
		);
		field.focus();
	});
}

// ------------------------------------------------------------- hosts screen ---
function hostsScreen() {
	const list = el("div", { class: "list" });
	const node = el("div", { class: "screen" }, [
		topbar({ title: "pi remote", back: false, actions: [iconButton("settings", "Settings", () => openSettings())] }),
		el("main", { class: "content" }, [list]),
	]);
	let disposed = false;

	function hostCard(host) {
		const dot = el("span", { class: "dot is-checking", title: "checking" });
		const via = el("span", { class: "card-meta", text: "checking…" });
		const card = el("button", { class: "card host-card", type: "button", onclick: () => go(sessionsScreen, host) }, [
			el("div", { class: "card-icon" }, [icon("computer")]),
			el("div", { class: "card-main" }, [
				el("div", { class: "card-title" }, [dot, el("span", { text: host.name })]),
				via,
				el("div", { class: "card-meta mono", text: `this phone: ${host.deviceIdDisplay}` }),
			]),
			el("div", { class: "card-chevron" }, [icon("forward")]),
		]);
		call("hosts.probe", { hostId: host.id })
			.then((r) => {
				if (disposed) return;
				dot.className = `dot ${r.reachable ? "is-online" : "is-offline"}`;
				if (r.reachable) via.textContent = `online ${viaLabel(r.address)}`;
				else if (r.code === "pin_mismatch" || r.code === "unlinked") via.textContent = `${errorMessage(r)}`;
				else via.textContent = `offline (last used ${relativeTime(host.lastUsedAt) || "never"})`;
			})
			.catch(() => {
				if (disposed) return;
				dot.className = "dot is-offline";
				via.textContent = "offline";
			});
		return card;
	}

	async function refresh() {
		let hosts = [];
		try {
			({ hosts } = await call("hosts.list"));
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
					el("button", { class: "btn btn-primary btn-block", type: "button", onclick: () => go(linkScreen, {}) }, [icon("qr"), el("span", { text: "Link a computer" })]),
				]),
			);
			return;
		}
		list.append(el("div", { class: "section-label", text: "Computers" }));
		for (const host of hosts) list.append(hostCard(host));
		list.append(el("button", { class: "btn btn-ghost btn-block add-host", type: "button", onclick: () => go(linkScreen, {}) }, [icon("plus"), el("span", { text: "Link another computer" })]));
	}

	refresh();
	return {
		node,
		restore: hostsScreen,
		dispose: () => (disposed = true),
		onResume: refresh,
	};
}

// -------------------------------------------------------------- link screen ---
function parsePairLink(link) {
	try {
		const url = new URL(link);
		if (url.protocol !== "pirc:") return null;
		const p = url.searchParams;
		const hosts = (p.get("h") || "").split(",").filter(Boolean);
		const port = Number(p.get("p"));
		if (!hosts.length || !Number.isInteger(port) || !p.get("f") || !p.get("c")) return null;
		return { hosts, port, name: p.get("n") || hosts[0], code: p.get("c"), fingerprint: p.get("f") };
	} catch {
		return null;
	}
}

function linkScreen({ link } = {}) {
	const body = el("main", { class: "content link" });
	const bar = topbar({ title: "Link a computer" });
	const node = el("div", { class: "screen" }, [bar, body]);
	let pairingId = null;
	let disposed = false;

	const step = (...children) => {
		if (!disposed) body.replaceChildren(el("div", { class: "stack" }, children));
	};

	function choose() {
		step(
			el("ol", { class: "steps" }, [
				el("li", { text: "On the computer, run /remote (or /remote pair) in pi." }),
				el("li", { text: "Scan the QR code it shows." }),
				el("li", { text: "Approve this phone in the terminal after checking its device ID." }),
			]),
			el("button", { class: "btn btn-primary btn-block", type: "button", onclick: scan }, [icon("qr"), el("span", { text: "Scan QR code" })]),
			el("button", { class: "btn btn-ghost btn-block", type: "button", onclick: manual }, [icon("keyboard"), el("span", { text: "Enter the details instead" })]),
			el("p", { class: "hint", text: "Away from home? Link over Tailscale or another VPN: the computer lists every address it can be reached at." }),
		);
	}

	async function scan() {
		try {
			const result = await call("pair.scan");
			if (result && result.link) fromLink(result.link);
		} catch (error) {
			toast(errorMessage(error), "error");
		}
	}

	function fromLink(text) {
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
				el("button", { class: "btn btn-primary", type: "button", text: "Link", onclick: () => begin({ link: text }, parsed.name) }),
			]),
		);
	}

	function manual() {
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
				const probe = await call("pair.probe", { address: addr, port: portNum });
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

	function confirmFingerprint(address, port, code, probe) {
		step(
			el("h2", { class: "step-title", text: `Check the computer’s certificate` }),
			el("p", { class: "sheet-text", text: `“${probe.name}” at ${address}:${port} presented this certificate. It must match the “Certificate” line shown by /remote on the computer.` }),
			el("div", { class: "fingerprint mono", text: probe.fingerprintDisplay }),
			el("div", { class: "row-actions" }, [
				el("button", { class: "btn btn-ghost", type: "button", text: "It does not match", onclick: choose }),
				el("button", { class: "btn btn-primary", type: "button", text: "It matches", onclick: () => begin({ addresses: [address], port, fingerprint: probe.fingerprint, code }, probe.name) }),
			]),
		);
	}

	async function begin(params, name) {
		step(el("div", { class: "spinner-block" }, [el("div", { class: "spinner" }), el("p", { text: `Contacting “${name}”…` })]));
		let started;
		try {
			started = await call("pair.begin", params);
		} catch (error) {
			return failed(errorMessage(error));
		}
		pairingId = started.pairingId;
		step(
			el("p", { class: "eyebrow", text: `Waiting for approval on “${started.hostName}”` }),
			el("div", { class: "device-id mono", text: started.deviceIdDisplay }),
			el("p", { class: "sheet-text", text: "In the terminal on the computer, approve the request after checking it shows exactly this device ID." }),
			el("div", { class: "spinner-row" }, [el("div", { class: "spinner" }), el("span", { text: "waiting…" })]),
			el("button", {
				class: "btn btn-ghost btn-block",
				type: "button",
				text: "Cancel",
				onclick: async () => {
					await call("pair.cancel", { pairingId }).catch(() => {});
					pairingId = null;
					choose();
				},
			}),
		);
		try {
			const result = await call("pair.wait", { pairingId });
			pairingId = null;
			if (disposed) return;
			if (result.state === "approved") {
				step(
					el("div", { class: "success-mark" }, [icon("check")]),
					el("h2", { class: "step-title", text: `Linked to “${result.host.name}”` }),
					el("p", { class: "sheet-text", text: "This phone can now open that computer’s pi sessions. Unlink it from here, or with /remote revoke on the computer." }),
					el("button", { class: "btn btn-primary btn-block", type: "button", text: "Open sessions", onclick: () => {
						state.stack = [hostsScreen];
						render(sessionsScreen(result.host));
					} }),
				);
				return;
			}
			if (result.state === "cancelled") return;
			failed(result.state === "rejected" ? "The computer rejected this phone." : `Linking ended: ${result.reason || result.state}.`);
		} catch (error) {
			pairingId = null;
			failed(errorMessage(error));
		}
	}

	function failed(message) {
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
const STATUS = {
	terminal: { label: "Terminal", cls: "is-terminal" },
	running: { label: "Running", cls: "is-running" },
	external: { label: "Open elsewhere", cls: "is-external" },
	idle: { label: "", cls: "is-idle" },
};

function sessionTitle(s) {
	return s.name || firstLine(s.preview) || `Session ${shortId(s.id)}`;
}

function sessionsScreen(host) {
	const live = el("div", { class: "list" });
	const recent = el("div", { class: "list" });
	const bar = topbar({
		title: host.name,
		subtitle: "connecting…",
		actions: [iconButton("refresh", "Refresh", () => refresh(true)), iconButton("more", "Computer", () => hostMenu(host))],
	});
	const fab = el("button", { class: "fab", type: "button", "aria-label": "New session", onclick: () => newSessionSheet(host) }, [icon("plus"), el("span", { text: "New" })]);
	const node = el("div", { class: "screen" }, [bar, el("main", { class: "content" }, [live, recent]), fab]);
	let disposed = false;
	let timer = null;
	let showAll = false;
	let sessions = [];

	function card(s) {
		const status = STATUS[s.status] || STATUS.idle;
		const badges = [];
		if (status.label) badges.push(el("span", { class: `chip ${status.cls}`, text: status.label }));
		if (s.busy) badges.push(el("span", { class: "chip is-busy" }, [el("span", { class: "pulse" }), el("span", { text: "working" })]));
		if (s.pendingDialogs) badges.push(el("span", { class: "chip is-alert", text: s.pendingDialogs === 1 ? "approval needed" : `${s.pendingDialogs} approvals needed` }));
		const model = s.model && typeof s.model === "object" ? s.model.id : s.model;
		return el("button", { class: `card session-card ${status.cls}`, type: "button", onclick: () => go(chatScreen, host, s) }, [
			el("div", { class: "card-main" }, [
				el("div", { class: "card-title", text: sessionTitle(s) }),
				el("div", { class: "card-meta mono", text: [shortPath(s.cwd), model].filter(Boolean).join("  ·  ") }),
				badges.length ? el("div", { class: "chips" }, badges) : null,
			]),
			el("div", { class: "card-side" }, [el("span", { class: "card-when", text: relativeTime(s.lastActivityAt) })]),
		]);
	}

	function draw() {
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
				recent.append(el("button", { class: "btn btn-quiet btn-block", type: "button", text: `Show ${rest.length - 25} more`, onclick: () => ((showAll = true), draw()) }));
			}
		}
	}

	async function refresh(manual = false) {
		clearTimeout(timer);
		try {
			const [{ sessions: list }, probe] = await Promise.all([api(host.id, "GET", "/api/sessions"), manual ? call("hosts.probe", { hostId: host.id }).catch(() => null) : Promise.resolve(null)]);
			if (disposed) return;
			sessions = Array.isArray(list) ? list : [];
			fab.hidden = false;
			draw();
			const where = probe && probe.address ? viaLabel(probe.address) : "connected";
			bar.setSubtitle(el("span", { class: "status-line" }, [el("span", { class: "dot is-online" }), el("span", { text: where })]));
		} catch (error) {
			if (disposed) return;
			bar.setSubtitle(el("span", { class: "status-line" }, [el("span", { class: "dot is-offline" }), el("span", { text: error.code === "unreachable" ? "offline" : "error" })]));
			if (error.code === "unlinked" || error.code === "pin_mismatch") {
				// Retrying cannot help: the phone has to be linked again.
				sessions = [];
				live.replaceChildren(
					el("div", { class: "empty" }, [
						el("h1", { class: "empty-title", text: "Link this phone again" }),
						el("p", { class: "empty-text", text: errorMessage(error) }),
						el("button", { class: "btn btn-primary btn-block", type: "button", onclick: () => go(linkScreen, {}) }, [icon("qr"), el("span", { text: "Link again" })]),
					]),
				);
				recent.replaceChildren();
				fab.hidden = true;
				return;
			}
			if (manual || !sessions.length) toast(errorMessage(error), "error");
		}
		if (!disposed) timer = setTimeout(refresh, 5000);
	}

	refresh(true);
	return {
		node,
		restore: () => sessionsScreen(host),
		dispose: () => {
			disposed = true;
			clearTimeout(timer);
		},
		onResume: () => refresh(true),
		onPause: () => clearTimeout(timer),
	};
}

function hostMenu(host) {
	const content = el("div", { class: "stack" }, [
		el("dl", { class: "facts" }, [
			el("dt", { text: "This phone’s ID" }),
			el("dd", { class: "mono", text: host.deviceIdDisplay }),
			el("dt", { text: "Addresses" }),
			el("dd", { class: "mono", text: (host.addresses || []).map((a) => `${a}:${host.port}`).join("\n") }),
			el("dt", { text: "Certificate" }),
			el("dd", { class: "mono", text: host.fingerprintDisplay || "" }),
			el("dt", { text: "Linked" }),
			el("dd", { text: host.pairedAt ? new Date(host.pairedAt).toLocaleString() : "" }),
		]),
		el("button", {
			class: "btn btn-ghost btn-block",
			type: "button",
			text: "Rename",
			onclick: async () => {
				const name = await promptSheet("Rename computer", host.name);
				if (!name) return;
				await call("hosts.rename", { hostId: host.id, name: name.trim() }).catch((e) => toast(errorMessage(e), "error"));
				closeSheet();
				goHome();
			},
		}),
		el("button", {
			class: "btn btn-danger btn-block",
			type: "button",
			text: "Unlink this phone",
			onclick: async () => {
				const ok = await confirmSheet(`Unlink from “${host.name}”?`, "The computer forgets this phone and the phone forgets its key. To use it again, link it again with /remote pair.", { confirm: "Unlink", danger: true });
				if (!ok) return;
				const result = await call("hosts.remove", { hostId: host.id, unlinkRemote: true }).catch((e) => ({ error: e }));
				if (result && result.error) toast(`Removed here, but the computer could not be told: ${errorMessage(result.error)}`, "warning");
				else toast(`Unlinked from “${host.name}”.`);
				goHome();
			},
		}),
	]);
	openSheet(host.name, content);
}

// --------------------------------------------------------------- chat screen ---
function chatScreen(host, session) {
	const log = el("div", { class: "chat-log", role: "log", "aria-live": "polite" });
	const chat = new MobileChat(log);
	const dock = el("div", { class: "dock" });
	const banner = el("div", { class: "banner", hidden: true });
	const jump = el("button", { class: "jump", type: "button", hidden: true, text: "↓ latest", onclick: () => chat.goToEnd() });
	chat.onStickChange = (stick) => (jump.hidden = stick);
	log.addEventListener("click", (event) => {
		const link = event.target.closest("a[href]");
		if (link) {
			// Never navigate the app's page: links open in the browser (http and https only).
			event.preventDefault();
			call("app.openUrl", { url: link.getAttribute("href") }).catch((error) => toast(errorMessage(error), "error"));
			return;
		}
		const head = event.target.closest(".tool-head");
		if (head && head.parentElement) head.parentElement.classList.toggle("is-open");
	});

	const stopBtn = iconButton("stop", "Stop the current run", () => abort(), "is-danger");
	stopBtn.hidden = true;
	const bar = topbar({ title: sessionTitle(session), actions: [stopBtn, iconButton("info", "Session details", () => detailsSheet())] });

	const input = el("textarea", { class: "composer-input", rows: "1", placeholder: "Message pi…", enterkeyhint: "enter" });
	const sendBtn = el("button", { class: "send-btn", type: "button", "aria-label": "Send", onclick: () => send() }, [icon("send")]);
	let mode = "followUp";
	const modeQueue = el("button", { class: "seg is-on", type: "button", text: "After this run", onclick: () => setMode("followUp") });
	const modeSteer = el("button", { class: "seg", type: "button", text: "Steer now", onclick: () => setMode("steer") });
	const modes = el("div", { class: "segmented", hidden: true }, [modeQueue, modeSteer]);
	const composerNote = el("div", { class: "composer-note", hidden: true });
	const composer = el("footer", { class: "composer" }, [composerNote, modes, el("div", { class: "composer-row" }, [input, sendBtn])]);

	const node = el("div", { class: "screen chat-screen" }, [bar, banner, el("div", { class: "chat-wrap" }, [log, jump]), dock, composer]);

	let stream = null;
	let lifecycle = session.status === "terminal" ? "terminal" : null;
	let busy = Boolean(session.busy);
	let disposed = false;
	let retry = 0;
	let retryTimer = null;
	// In the background the stream stays open for a short while (a quick switch to another app
	// loses nothing), then closes until the app is back in front.
	let paused = false;
	let pauseTimer = null;
	let fresh = true;
	let meta = { ...session };
	const cards = new Map();

	function setMode(next) {
		mode = next;
		modeQueue.classList.toggle("is-on", mode === "followUp");
		modeSteer.classList.toggle("is-on", mode === "steer");
	}

	function autosize() {
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
	}
	input.addEventListener("input", autosize);

	function drivable() {
		if (lifecycle === "watching") return "This session is open in a pi terminal that is not shared. Run /remote there to drive it from here.";
		if (lifecycle === "detached") return "The terminal stopped sharing this session.";
		if (lifecycle === "revoked") return "This phone was unlinked from the computer.";
		if (lifecycle === "host_stopping") return "pi remote stopped on the computer.";
		if (lifecycle === "gone") return "This session is no longer on the computer.";
		return null;
	}

	function updateChrome() {
		const reason = drivable();
		input.disabled = Boolean(reason);
		sendBtn.disabled = Boolean(reason);
		composerNote.hidden = !reason;
		composerNote.textContent = reason || "";
		modes.hidden = !busy || Boolean(reason);
		stopBtn.hidden = !busy || Boolean(reason);
		input.placeholder = busy ? (mode === "steer" ? "Steer the current run…" : "Queue a message for after this run…") : "Message pi…";
		const status = STATUS[lifecycle === "watching" ? "external" : lifecycle] || null;
		const model = meta.model && typeof meta.model === "object" ? meta.model.id : meta.model;
		const parts = [];
		if (status && status.label) parts.push(el("span", { class: `chip ${status.cls}`, text: status.label }));
		if (busy) parts.push(el("span", { class: "chip is-busy" }, [el("span", { class: "pulse" }), el("span", { text: "working" })]));
		if (model) parts.push(el("span", { class: "topbar-model mono", text: `${model}${meta.thinking ? ` · ${meta.thinking}` : ""}` }));
		bar.setSubtitle(el("span", { class: "status-line" }, parts));
	}

	function showBanner(text, action) {
		banner.replaceChildren(el("span", { text }), ...(action ? [el("button", { class: "btn btn-quiet", type: "button", text: action.label, onclick: action.run })] : []));
		banner.hidden = false;
	}

	function hideBanner() {
		banner.hidden = true;
	}

	// ---- dialogs
	function addDialog(dialog) {
		if (!dialog || cards.has(dialog.id)) return;
		const card = dialogCard(dialog, (payload) => api(host.id, "POST", `/api/sessions/${encodeURIComponent(session.id)}/ui-response`, { dialogId: dialog.id, ...payload }).catch((error) => {
			if (error.status === 404) {
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

	function removeDialog(id, by) {
		const card = cards.get(id);
		if (!card) return;
		cards.delete(id);
		card.dispose?.();
		card.classList.add("is-leaving");
		setTimeout(() => card.remove(), 180);
		if (by === "terminal") toast("Answered at the computer.");
	}

	function clearDialogs() {
		for (const id of [...cards.keys()]) {
			const card = cards.get(id);
			card.dispose?.();
			card.remove();
		}
		cards.clear();
	}

	// ---- stream
	function onFrame({ name, data }) {
		if (!data) return;
		if (fresh) {
			// The new stream replays everything: only now drop what the old one showed, so a
			// dropped connection leaves the transcript on screen while it reconnects.
			fresh = false;
			chat.reset();
			chat.replaying = true;
			clearDialogs();
		}
		switch (name) {
			case "lifecycle":
				lifecycle = data.state;
				if (data.session) meta = { ...meta, ...data.session };
				if (data.state === "terminal" && data.session) busy = Boolean(data.session.busy);
				if (data.state === "running" && typeof data.busy === "boolean") busy = data.busy;
				if (data.state === "detached") {
					busy = false;
					clearDialogs();
					showBanner("The terminal stopped sharing this session.", { label: "Reopen", run: () => connect() });
				} else if (data.state === "revoked") {
					showBanner("This phone was unlinked from the computer.");
				} else if (data.state === "host_stopping") {
					showBanner("pi remote stopped on the computer.", { label: "Retry", run: () => connect() });
				} else if (data.state === "gone") {
					busy = false;
					clearDialogs();
				} else if (data.state === "exited") {
					busy = false;
					chat.system(`pi exited${data.code !== undefined && data.code !== null ? ` (code ${data.code})` : ""}`);
				}
				updateChrome();
				return;
			case "observed":
				chat.handle(data.data);
				return;
			case "event": {
				const event = data.data;
				if (!event) return;
				if (event.type === "agent_start") busy = true;
				if (event.type === "agent_end" || event.type === "agent_settled") busy = false;
				if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled") updateChrome();
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
				addDialog(data.dialog);
				return;
			case "ui_resolved":
				removeDialog(data.id, data.by);
				return;
			case "notify":
				toast(data.message, data.level === "error" ? "error" : data.level === "warning" ? "warning" : "info");
				return;
			case "meta":
				if (data.session) {
					meta = { ...meta, ...data.session };
					if (typeof data.session.busy === "boolean") busy = data.session.busy;
					if (data.session.name) bar.setTitle(data.session.name);
					updateChrome();
				}
				return;
			case "notice":
				toast(data.message, "warning");
				return;
			default:
		}
	}

	function onState(stateName, message) {
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
		retryTimer = setTimeout(() => !disposed && connect(), delay);
	}

	function connect() {
		clearTimeout(retryTimer);
		if (stream) stream.close();
		fresh = true;
		hideBanner();
		stream = openStream(host.id, `/api/sessions/${encodeURIComponent(session.id)}/events`, onFrame, onState);
	}

	// ---- actions
	async function send() {
		const text = input.value.trim();
		if (!text || drivable()) return;
		const body = { message: text };
		if (busy) body.streamingBehavior = mode;
		input.value = "";
		autosize();
		const pendingNode = chat.addPending(text);
		const wasIdle = lifecycle === "idle" || lifecycle === "exited";
		try {
			const result = await api(host.id, "POST", `/api/sessions/${encodeURIComponent(session.id)}/prompt`, body);
			if (result && result.delivered === "steer") toast("Steering the current run.");
			else if (result && result.delivered === "followUp") toast("Queued for after this run.");
			// A session that was not running has just been started; follow it live.
			if (wasIdle) setTimeout(() => !disposed && connect(), 600);
		} catch (error) {
			chat.failPending(pendingNode, errorMessage(error));
			if (!input.value) {
				input.value = text;
				autosize();
			}
			toast(errorMessage(error), "error");
		}
	}

	async function abort() {
		try {
			await api(host.id, "POST", `/api/sessions/${encodeURIComponent(session.id)}/abort`, {});
			toast("Stopping…");
		} catch (error) {
			toast(errorMessage(error), "error");
		}
	}

	function detailsSheet() {
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
					const current = meta.model && typeof meta.model === "object" ? `${meta.model.provider}|${meta.model.id}` : "";
					modelSelect.replaceChildren(el("option", { value: "", text: current ? current.replace("|", " / ") : "current model" }));
					for (const provider of data.providers || []) {
						const group = el("optgroup", { label: provider.name });
						for (const model of provider.models || []) group.append(el("option", { value: `${provider.name}|${model.id}`, text: model.id }));
						modelSelect.append(group);
					}
					modelSelect.value = "";
				})
				.catch(() => modelSelect.replaceChildren(el("option", { value: "", text: "models unavailable" })));
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
			body.append(
				el("button", {
					class: "btn btn-danger btn-block",
					type: "button",
					text: "End this session’s pi process",
					onclick: async () => {
						const ok = await confirmSheet("End the pi process?", "The session is kept on the computer and can be continued later.", { confirm: "End it", danger: true });
						if (!ok) return;
						try {
							await api(host.id, "DELETE", `/api/sessions/${sid}`);
							toast("Ending the session…");
						} catch (error) {
							toast(errorMessage(error), "error");
						}
					},
				}),
			);
		}
		openSheet("Session", body);
		api(host.id, "GET", `/api/sessions/${sid}/stats`)
			.then((data) => renderStats(statsNode, data.stats, meta))
			.catch(() => statsNode.replaceChildren(el("p", { class: "hint", text: "No statistics for this session." })));
		api(host.id, "GET", `/api/sessions/${sid}/todos`)
			.then((data) => renderTodos(todosNode, data))
			.catch(() => todosNode.replaceChildren(el("li", { class: "hint", text: "No todos." })));
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
async function newSessionSheet(host) {
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
	for (const dir of cwds.cwds || []) cwd.append(el("option", { value: dir, text: dir }));
	for (const provider of models.providers || []) {
		const group = el("optgroup", { label: provider.name });
		for (const m of provider.models || []) group.append(el("option", { value: `${provider.name}|${m.id}`, text: m.id }));
		model.append(group);
	}
	for (const a of agents.agents || []) agent.append(el("option", { value: `${a.source || ""}|${a.name}`, text: a.description ? `${a.name}: ${firstLine(a.description, 50)}` : a.name }));
	create.onclick = async () => {
		error.textContent = "";
		const body = { cwd: cwdCustom.value.trim() || cwd.value || undefined };
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
			closeSheet();
			go(chatScreen, host, { ...result.session, status: "running" });
		} catch (e) {
			error.textContent = errorMessage(e);
			create.disabled = false;
			create.textContent = "Start session";
		}
	};
}

// ----------------------------------------------------------------- settings ---
async function openSettings() {
	const info = await call("app.info").catch(() => state.info || {});
	const lock = el("input", { type: "checkbox", class: "switch" });
	lock.checked = Boolean(info.lockEnabled);
	const secure = el("input", { type: "checkbox", class: "switch" });
	secure.checked = Boolean(info.secureScreen);
	lock.onchange = async () => {
		try {
			const r = await call("app.setLock", { enabled: lock.checked });
			lock.checked = Boolean(r.lockEnabled);
		} catch (error) {
			lock.checked = !lock.checked;
			toast(errorMessage(error), "error");
		}
	};
	secure.onchange = async () => {
		try {
			const r = await call("app.setSecureScreen", { enabled: secure.checked });
			secure.checked = Boolean(r.secureScreen);
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
async function boot() {
	let inApp = attach();
	if (!inApp && /[?&]mock\b/.test(location.search)) {
		// Development only: a stand-in for the app, served from mobile/dev (not packaged).
		try {
			const mock = await import("../dev/mock-native.js");
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
	on("resume", () => state.screen && state.screen.onResume && state.screen.onResume());
	on("pause", () => state.screen && state.screen.onPause && state.screen.onPause());
	try {
		state.info = await call("app.info");
	} catch {
		state.info = {};
	}
	render(hostsScreen());
	if (state.info.pendingLink) {
		go(linkScreen, { link: state.info.pendingLink });
		return;
	}
	try {
		const { hosts } = await call("hosts.list");
		if (hosts.length === 1) go(sessionsScreen, hosts[0]);
	} catch {
		/* the hosts screen reports it */
	}
}

boot();
