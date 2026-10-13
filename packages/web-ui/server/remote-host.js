#!/usr/bin/env node
// remote-host.js — pi remote host: pi-console's API over HTTPS for linked phones.
//
// Started detached by the `remote-control` extension (`/remote`), or by hand. It serves two
// listeners:
//   - HTTPS for phones, on PI_REMOTE_BIND:PI_REMOTE_PORT (all interfaces, port 8765 by default),
//     with a self-signed certificate the phones pin, device pairing and signed-challenge login
//     (see remote/api.js, remote/pairing.js, remote/auth.js);
//   - a loopback control channel for local pi processes (pairing, devices, terminal-session
//     bridging), authenticated by a secret in control.json (0600). See remote/control.js.
//
// The pi-console modules are loaded after PI_CONSOLE_RUNTIME_DIR is pointed at this host's own
// state directory, so the temp files of sessions it starts never mix with a console's.
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./remote/api.js";
import { Authenticator, RateLimiter, DEFAULT_TOKEN_TTL_MS } from "./remote/auth.js";
import { BridgeHub } from "./remote/bridge.js";
import { formatCode, formatDeviceId, randomSecret, safeEqual } from "./remote/codes.js";
import { ControlServer } from "./remote/control.js";
import { DeviceRegistry } from "./remote/devices.js";
import { DialogTracker } from "./remote/dialogs.js";
import { Pairings } from "./remote/pairing.js";
import { encodeQr } from "./remote/qr.js";
import { audit, ensurePrivateDir, readAudit, readJsonFile, stateDir, statePaths, writePrivateFile } from "./remote/store.js";
import { assertUsable, certificateFingerprint, createTlsIdentity, displayFingerprint } from "./remote/tls.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8765;
const env = process.env;

const log = (line) => process.stderr.write(`${new Date().toISOString()} pi-remote: ${line}\n`);
const fail = (line, code = 2) => {
	log(`refusing to start: ${line}`);
	process.exit(code);
};

function kitVersion() {
	for (const candidate of [path.join(HERE, "..", "..", "..", "package.json"), path.join(HERE, "..", "package.json")]) {
		const pkg = readJsonFile(candidate);
		if (pkg && typeof pkg.version === "string" && /(^|\/)pi-system$/.test(String(pkg.name))) return pkg.version;
	}
	return readJsonFile(path.join(HERE, "..", "package.json"))?.version || "0.0.0";
}
const VERSION = kitVersion();

// ------------------------------------------------------------------ state ---
const paths = statePaths(stateDir(env));
ensurePrivateDir(paths.dir);
ensurePrivateDir(paths.runtime);
if (!env.PI_CONSOLE_RUNTIME_DIR) process.env.PI_CONSOLE_RUNTIME_DIR = paths.runtime;

// pi-console's modules read their configuration at import time, so import them now.
const routes = await import("./routes.js");
const spawnMod = await import("./spawn.js");
const sessionsMod = await import("./sessions.js");
const tailerMod = await import("./tailer.js");
const validate = await import("./validate.js");
const pc = {
	handleApi: routes.handleApi,
	closeAllConsoleStreams: routes.closeAllStreams,
	listSessions: sessionsMod.listSessions,
	listLiveSessions: spawnMod.listLiveSessions,
	getSession: spawnMod.getSession,
	killAll: spawnMod.killAll,
	acquireTailer: tailerMod.acquireTailer,
	releaseTailer: tailerMod.releaseTailer,
	closeAllTailers: tailerMod.closeAllTailers,
	isFileActive: tailerMod.isFileActive,
	entryToEvents: tailerMod.entryToEvents,
	parseSessionId: validate.parseSessionId,
	MODEL_ARG_RE: validate.MODEL_ARG_RE,
	THINKING_LEVELS: validate.THINKING_LEVELS,
	STREAMING_BEHAVIOURS: validate.STREAMING_BEHAVIOURS,
};

// ----------------------------------------------------------------- policy ---
function resolveBind(value) {
	const raw = String(value ?? "").trim().toLowerCase();
	if (!raw || raw === "all" || raw === "0.0.0.0") return { host: "0.0.0.0", mode: "all" };
	if (raw === "loopback" || raw === "localhost") return { host: "127.0.0.1", mode: "loopback" };
	if (raw === "tailscale") {
		const addr = interfaceAddresses().find((a) => a.tailscale);
		if (!addr) fail("PI_REMOTE_BIND=tailscale, but no Tailscale address (100.64.0.0/10) is up on this machine.");
		return { host: addr.address, mode: "tailscale" };
	}
	if (net.isIP(raw)) return { host: raw, mode: "address" };
	return fail(`PI_REMOTE_BIND "${raw.slice(0, 60)}" is not all, loopback, tailscale or an IP address.`);
}

const VIRTUAL_IF = /^(docker|br-|veth|virbr|podman|cni|flannel|cali|lxc|lxd|vmnet|vboxnet|kube|tun|wg-mullvad|zt)/;

function isTailscaleV4(address) {
	const [a, b] = address.split(".").map(Number);
	return a === 100 && b >= 64 && b <= 127;
}

/** Non-loopback IPv4 addresses of physical and VPN interfaces (container bridges skipped). */
function interfaceAddresses() {
	const out = [];
	for (const [name, list] of Object.entries(os.networkInterfaces())) {
		for (const { address, family, internal } of list || []) {
			if (internal || family !== "IPv4") continue;
			const tailscale = /^tailscale/.test(name) || isTailscaleV4(address);
			if (!tailscale && VIRTUAL_IF.test(name)) continue;
			out.push({ name, address, tailscale });
		}
	}
	// LAN first, then Tailscale: the app tries them in this order.
	return out.sort((a, b) => Number(a.tailscale) - Number(b.tailscale));
}

function advertisedAddresses(bind) {
	const extra = String(env.PI_REMOTE_ADVERTISE || "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => /^[A-Za-z0-9.-]{1,253}$/.test(s) || net.isIP(s));
	let base;
	if (bind.mode === "all") base = interfaceAddresses().map((a) => a.address);
	else if (bind.mode === "loopback") base = ["127.0.0.1"];
	else base = [bind.host];
	return [...new Set([...extra, ...base])].slice(0, 6);
}

const bind = resolveBind(env.PI_REMOTE_BIND);
const portRaw = String(env.PI_REMOTE_PORT ?? "").trim();
const port = portRaw === "" ? DEFAULT_PORT : Number(portRaw);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`PI_REMOTE_PORT "${portRaw.slice(0, 20)}" is not a port number.`);
const ttlMin = Number(env.PI_REMOTE_TOKEN_TTL_MIN || 0);
const tokenTtlMs = ttlMin >= 5 && ttlMin <= 24 * 60 ? ttlMin * 60_000 : DEFAULT_TOKEN_TTL_MS;

// ------------------------------------------------------- single instance ---
async function existingHost() {
	const control = readJsonFile(paths.control);
	if (!control || !Number.isInteger(control.port) || typeof control.secret !== "string") return false;
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port: control.port });
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, 1500);
		let buffer = "";
		socket.on("connect", () => socket.write(`${JSON.stringify({ t: "hello", secret: control.secret, role: "admin" })}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (buffer.includes("\n")) {
				clearTimeout(timer);
				socket.destroy();
				try {
					resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))).ok === true);
				} catch {
					resolve(false);
				}
			}
		});
		socket.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}
if (await existingHost()) {
	log("another remote host is already running for this state directory");
	process.exit(3);
}

// --------------------------------------------------------------- identity ---
let identity = readJsonFile(paths.identity);
if (!identity || typeof identity.serverId !== "string" || !/^[a-f0-9]{16}$/.test(identity.serverId)) {
	identity = { serverId: crypto.randomBytes(8).toString("hex"), createdAt: new Date().toISOString() };
	writePrivateFile(paths.identity, `${JSON.stringify(identity, null, 2)}\n`);
}
const displayName = String(env.PI_REMOTE_NAME || identity.name || os.hostname() || "pi")
	.replace(/[^\x20-\x7e]/g, "")
	.trim()
	.slice(0, 40) || "pi";

let keyPem;
let certPem;
if (fs.existsSync(paths.tlsKey) && fs.existsSync(paths.tlsCert)) {
	keyPem = fs.readFileSync(paths.tlsKey, "utf8");
	certPem = fs.readFileSync(paths.tlsCert, "utf8");
	try {
		assertUsable(certPem, keyPem);
	} catch (error) {
		fail(`the TLS identity in ${paths.dir} is unusable (${error.message}). Linked phones pin it, so it is not replaced silently: run /remote reset to create a new one and link the phones again.`);
	}
} else {
	const created = createTlsIdentity(`pi-remote ${identity.serverId}`);
	keyPem = created.keyPem;
	certPem = created.certPem;
	writePrivateFile(paths.tlsKey, keyPem);
	writePrivateFile(paths.tlsCert, certPem);
	audit(paths.audit, { event: "tls_identity_created" });
}
const fingerprint = certificateFingerprint(certPem);

// ------------------------------------------------------------- components ---
const onAudit = (record) => audit(paths.audit, record);
const devices = new DeviceRegistry(paths.devices);
const pairings = new Pairings({ fingerprint, devices, onAudit });
const auth = new Authenticator({ devices, fingerprint, serverId: identity.serverId, tokenTtlMs });
const limiter = new RateLimiter();
const hub = new BridgeHub();
const dialogs = new DialogTracker({ listLiveSessions: pc.listLiveSessions });
const admins = new Set();

function notify(message, level = "info") {
	log(message);
	for (const conn of admins) if (conn.subscribed) conn.send({ t: "evt", name: "notice", data: { message, level } });
}

const api = createApi({
	console: pc,
	auth,
	devices,
	pairings,
	limiter,
	hub,
	dialogs,
	identity: { serverId: identity.serverId, name: displayName },
	version: VERSION,
	onAudit,
	log,
	notify,
});

const addresses = advertisedAddresses(bind);
let httpsPort = port;

function pairLink(code) {
	const params = new URLSearchParams({ h: addresses.join(","), p: String(httpsPort), f: fingerprint, c: code, n: displayName.slice(0, 24) });
	return `pirc://pair?${params.toString()}`;
}

function deviceView(d, online) {
	return {
		id: d.id,
		display: formatDeviceId(d.id),
		name: d.name,
		platform: d.platform,
		pairedAt: d.pairedAt,
		lastSeenAt: d.lastSeenAt,
		lastAddress: d.lastAddress,
		online: online.has(d.id),
	};
}

function status() {
	const online = auth.activeDeviceIds();
	return {
		pid: process.pid,
		version: VERSION,
		name: displayName,
		serverId: identity.serverId,
		fingerprint,
		fingerprintDisplay: displayFingerprint(fingerprint),
		bind: bind.host,
		bindMode: bind.mode,
		port: httpsPort,
		addresses,
		startedAt: startedAt.toISOString(),
		devices: devices.list().map((d) => deviceView(d, online)),
		terminalSessions: hub.list().map((s) => s.summary()),
		runningSessions: pc.listLiveSessions().filter((p) => p.alive).length,
		streams: api.streamCount(),
		offer: pairings.offerSummary(),
		recent: readAudit(paths.audit, 40).filter((r) => /failure|bad_|rejected|blocked|unlinked|revoked/.test(r.event)).slice(-8),
	};
}

// ---------------------------------------------------------- control channel ---
const controlSecret = randomSecret(32);

function onAdmin(conn, msg) {
	if (msg.t !== "req") return;
	admins.add(conn);
	const reply = (data) => conn.send({ t: "res", id: msg.id, ok: true, data });
	const refuse = (error, status = 400) => conn.send({ t: "res", id: msg.id, ok: false, error, status });
	switch (msg.op) {
		case "status":
			return reply(status());
		case "subscribe":
			conn.subscribed = true;
			return reply({ subscribed: true });
		case "pair.create": {
			conn.onPairRequest = (request) => conn.send({ t: "evt", name: "pair.request", data: request });
			conn.onOfferClosed = (offer, reason) => conn.send({ t: "evt", name: "pair.closed", data: { offerId: offer.id, reason } });
			const offer = pairings.createOffer({ owner: conn, ttlMs: Number(msg.ttlSec) * 1000 || undefined });
			const link = pairLink(offer.code);
			const qr = encodeQr(link, { ecl: "M" });
			return reply({
				offerId: offer.id,
				code: offer.code,
				codeDisplay: formatCode(offer.code),
				expiresAt: new Date(offer.expiresAt).toISOString(),
				link,
				qr: { size: qr.size, rows: qr.modules.map((row) => row.map((v) => (v ? "1" : "0")).join("")) },
				addresses,
				port: httpsPort,
				fingerprint,
				fingerprintDisplay: displayFingerprint(fingerprint),
				name: displayName,
			});
		}
		case "pair.cancel":
			pairings.cancelOffer("cancelled by the operator");
			return reply({ cancelled: true });
		case "pair.decide":
			try {
				const result = pairings.decide(msg.requestId, msg.approve === true, { owner: conn });
				if (result.state === "approved") notify(`linked "${result.name}" (${result.deviceIdDisplay})`);
				return reply(result);
			} catch (error) {
				return refuse(error.message, error.status || 400);
			}
		case "devices.list":
			return reply({ devices: devices.list().map((d) => deviceView(d, auth.activeDeviceIds())) });
		case "devices.revoke": {
			const device = devices.resolve(msg.deviceId);
			if (!device) return refuse("no single linked device matches that id or name", 404);
			devices.remove(device.id);
			auth.revokeDevice(device.id);
			onAudit({ event: "device_revoked", deviceId: device.id, name: device.name });
			return reply({ revoked: deviceView(device, new Set()) });
		}
		case "devices.rename": {
			const device = devices.resolve(msg.deviceId);
			if (!device) return refuse("no single linked device matches that id or name", 404);
			return reply({ device: deviceView(devices.setName(device.id, msg.name), auth.activeDeviceIds()) });
		}
		case "shutdown":
			reply({ stopping: true });
			setTimeout(() => shutdown("stopped by /remote stop"), 50);
			return undefined;
		default:
			return refuse(`unknown operation ${String(msg.op).slice(0, 40)}`);
	}
}

function onBridge(conn, msg) {
	if (msg.t === "register") {
		try {
			const session = hub.register(conn, msg.session);
			conn.send({ t: "registered", id: session.id });
			log(`terminal session ${session.id} attached (pid ${conn.pid ?? "?"})`);
		} catch (error) {
			conn.send({ t: "registered", ok: false, error: error.message });
		}
		return;
	}
	if (msg.t === "unregister") {
		hub.unregister(conn, "detached");
		return;
	}
	hub.forConn(conn)?.onMessage(msg);
}

function onClose(conn) {
	admins.delete(conn);
	pairings.releaseOwner(conn);
	if (hub.forConn(conn)) {
		log(`terminal session ${hub.forConn(conn).id} detached`);
		hub.unregister(conn, "terminal closed");
	}
}

const control = new ControlServer({ secret: controlSecret, onAdmin, onBridge, onClose, log });

// ---------------------------------------------------------------- servers ---
const server = https.createServer({ key: keyPem, cert: certPem, minVersion: "TLSv1.2" }, (req, res) => {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("Cache-Control", "no-store");
	api.handle(req, res);
});
server.headersTimeout = 30_000;
server.requestTimeout = 60_000;
server.on("tlsClientError", () => {
	/* scanners and phones with a stale pin end here; nothing to do */
});

const startedAt = new Date();

server.on("error", (error) => {
	if (error.code === "EADDRINUSE") fail(`port ${port} on ${bind.host} is in use (set PI_REMOTE_PORT)`, 1);
	fail(`HTTPS server error: ${error.message}`, 1);
});

await new Promise((resolve) => server.listen(port, bind.host, resolve));
httpsPort = server.address().port;
const controlPort = await control.listen(0);

writePrivateFile(
	paths.control,
	`${JSON.stringify(
		{
			version: 1,
			pid: process.pid,
			port: controlPort,
			secret: controlSecret,
			https: { bind: bind.host, bindMode: bind.mode, port: httpsPort, addresses },
			fingerprint,
			serverId: identity.serverId,
			name: displayName,
			startedAt: startedAt.toISOString(),
		},
		null,
		2,
	)}\n`,
);

log(`listening on https://${bind.host.includes(":") ? `[${bind.host}]` : bind.host}:${httpsPort} (${bind.mode}); reachable at ${addresses.join(", ") || "(no addresses found)"}`);
log(`certificate fingerprint ${displayFingerprint(fingerprint)}; ${devices.list().length} linked device(s)`);
if (bind.mode === "all") log("bound to every interface: anything that can reach this port can try to link, which needs a code from the terminal and your approval");

// --------------------------------------------------------------- shutdown ---
let stopping = false;
async function shutdown(reason) {
	if (stopping) return;
	stopping = true;
	log(`stopping (${reason})`);
	setTimeout(() => process.exit(0), 6000).unref?.();
	try {
		api.closeAllStreams();
		hub.closeAll();
		control.close();
		dialogs.close();
		server.close();
		pc.closeAllConsoleStreams();
		pc.closeAllTailers();
		await pc.killAll();
		server.closeAllConnections?.();
		devices.flush();
	} catch (error) {
		log(`error while stopping: ${error.message}`);
	} finally {
		const current = readJsonFile(paths.control);
		if (current && current.pid === process.pid && safeEqual(current.secret, controlSecret)) fs.rmSync(paths.control, { force: true });
		process.exit(0);
	}
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
