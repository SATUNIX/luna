#!/usr/bin/env node
// remote-host.ts — pi remote host: pi-console's API over HTTPS for linked phones.
//
// Started detached by the `remote-control` extension (`/remote`), or by hand. It serves two
// listeners:
//   - HTTPS for phones, on PI_REMOTE_BIND:PI_REMOTE_PORT (all interfaces, port 8765 by default),
//     with a self-signed certificate the phones pin, device pairing and signed-challenge login
//     (see remote/api.ts, remote/pairing.ts, remote/auth.ts);
//   - a loopback control channel for local pi processes (pairing, devices, terminal-session
//     bridging), authenticated by a secret in control.json (0600). See remote/control.ts.
//
// The pi-console modules are loaded after PI_CONSOLE_RUNTIME_DIR is pointed at this host's own
// state directory, so the temp files of sessions it starts never mix with a console's.
import { kitVersion } from "./remote-version.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import { isRecord, object, parseJson, safeParse, string } from "../../core/lib/guard.ts";
import { createApi } from "./remote/api.ts";
import { Authenticator, RateLimiter, DEFAULT_TOKEN_TTL_MS } from "./remote/auth.ts";
import { BridgeHub } from "./remote/bridge.ts";
import { formatCode, formatDeviceId, randomSecret, safeEqual } from "./remote/codes.ts";
import { type ControlConnection, type ControlMessage, ControlServer } from "./remote/control.ts";
import { type DeviceRecord, DeviceRegistry } from "./remote/devices.ts";
import { DialogTracker } from "./remote/dialogs.ts";
import { Pairings } from "./remote/pairing.ts";
import { inspectPeer } from "./remote/peer.ts";
import { encodeQr } from "./remote/qr.ts";
import { audit, ControlFileSchema, ensurePrivateDir, readAudit, readJsonFile, readJsonFileAs, stateDir, statePaths, writePrivateFile } from "./remote/store.ts";
import { assertUsable, certificateFingerprint, createTlsIdentity, displayFingerprint } from "./remote/tls.ts";

const DEFAULT_PORT = 8765;
const env = process.env;

const log = (line: string): void => {
	process.stderr.write(`${new Date().toISOString()} pi-remote: ${line}\n`);
};
const fail = (line: string, code = 2): never => {
	log(`refusing to start: ${line}`);
	process.exit(code);
};
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** The HTTP status an error carries (PairingError and friends), or 400. */
const errorStatus = (error: unknown): number => {
	const status: unknown = isRecord(error) ? error.status : undefined;
	return typeof status === "number" && status ? status : 400;
};

const VERSION = kitVersion();

// ------------------------------------------------------------------ state ---
const paths = statePaths(stateDir(env));
ensurePrivateDir(paths.dir);
ensurePrivateDir(paths.runtime);
if (!env.PI_CONSOLE_RUNTIME_DIR) process.env.PI_CONSOLE_RUNTIME_DIR = paths.runtime;

// pi-console's modules read their configuration at import time, so import them now.
const routes = await import("./routes.ts");
const spawnMod = await import("./spawn.ts");
const sessionsMod = await import("./sessions.ts");
const tailerMod = await import("./tailer.ts");
const validate = await import("./validate.ts");
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
type BindMode = "all" | "loopback" | "tailscale" | "address";
interface Bind {
	readonly host: string;
	readonly mode: BindMode;
}
interface InterfaceAddress {
	readonly name: string;
	readonly address: string;
	readonly tailscale: boolean;
}

function resolveBind(value: string | undefined): Bind {
	const raw = (value ?? "").trim().toLowerCase();
	if (!raw || raw === "all" || raw === "0.0.0.0") return { host: "0.0.0.0", mode: "all" };
	if (raw === "loopback" || raw === "localhost") return { host: "127.0.0.1", mode: "loopback" };
	if (raw === "tailscale") {
		const addr = interfaceAddresses().find((a) => a.tailscale);
		if (!addr) return fail("PI_REMOTE_BIND=tailscale, but no Tailscale address (100.64.0.0/10) is up on this machine.");
		return { host: addr.address, mode: "tailscale" };
	}
	if (net.isIP(raw)) return { host: raw, mode: "address" };
	return fail(`PI_REMOTE_BIND "${raw.slice(0, 60)}" is not all, loopback, tailscale or an IP address.`);
}

const VIRTUAL_IF = /^(docker|br-|veth|virbr|podman|cni|flannel|cali|lxc|lxd|vmnet|vboxnet|kube|tun|wg-mullvad|zt)/;

function isTailscaleV4(address: string): boolean {
	const [a, b] = address.split(".").map(Number);
	return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/** Non-loopback IPv4 addresses of physical and VPN interfaces (container bridges skipped). */
function interfaceAddresses(): InterfaceAddress[] {
	const out: InterfaceAddress[] = [];
	for (const [name, list] of Object.entries(os.networkInterfaces())) {
		for (const { address, family, internal } of list ?? []) {
			if (internal || family !== "IPv4") continue;
			const tailscale = /^tailscale/.test(name) || isTailscaleV4(address);
			if (!tailscale && VIRTUAL_IF.test(name)) continue;
			out.push({ name, address, tailscale });
		}
	}
	// LAN first, then Tailscale: the app tries them in this order.
	return out.sort((a, b) => Number(a.tailscale) - Number(b.tailscale));
}

function advertisedAddresses(bind: Bind): string[] {
	const extra = (env.PI_REMOTE_ADVERTISE || "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => /^[A-Za-z0-9.-]{1,253}$/.test(s) || net.isIP(s));
	let base: string[];
	if (bind.mode === "all") base = interfaceAddresses().map((a) => a.address);
	else if (bind.mode === "loopback") base = ["127.0.0.1"];
	else base = [bind.host];
	return [...new Set([...extra, ...base])].slice(0, 6);
}

const bind = resolveBind(env.PI_REMOTE_BIND);
const BIND_ALL_WARNING = "bound to every interface (PI_REMOTE_BIND unset or all): anything that can reach this port can try to link a phone, which needs a code from the terminal and your approval. Set PI_REMOTE_BIND=tailscale, or loopback, unless the phones are on this LAN only";
const portRaw = (env.PI_REMOTE_PORT ?? "").trim();
const port = portRaw === "" ? DEFAULT_PORT : Number(portRaw);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`PI_REMOTE_PORT "${portRaw.slice(0, 20)}" is not a port number.`);
const ttlMin = Number(env.PI_REMOTE_TOKEN_TTL_MIN || 0);
const tokenTtlMs = ttlMin >= 5 && ttlMin <= 24 * 60 ? ttlMin * 60_000 : DEFAULT_TOKEN_TTL_MS;

// ------------------------------------------------------- single instance ---
async function existingHost(): Promise<boolean> {
	const control = readJsonFileAs(paths.control, ControlFileSchema);
	if (!control) return false;
	return new Promise<boolean>((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port: control.port });
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, 1500);
		let buffer = "";
		socket.on("connect", () => socket.write(`${JSON.stringify({ t: "hello", secret: control.secret, role: "admin" })}\n`));
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			if (buffer.includes("\n")) {
				clearTimeout(timer);
				socket.destroy();
				try {
					const reply = parseJson(buffer.slice(0, buffer.indexOf("\n")));
					resolve(isRecord(reply) && reply.ok === true);
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
/**
 * identity.json: only the server id is required (a file without a valid one is replaced). The
 * optional display name, set by hand, is used only when it is a string.
 */
const IdentityFileSchema = object({ serverId: string({ pattern: /^[a-f0-9]{16}$/ }) });
const savedIdentity = readJsonFile(paths.identity);
const parsedIdentity = safeParse(IdentityFileSchema, savedIdentity, "identity.json");
let identity: { readonly serverId: string; readonly name?: string };
if (parsedIdentity.ok) {
	const savedName = isRecord(savedIdentity) ? savedIdentity.name : undefined;
	identity = typeof savedName === "string" ? { serverId: parsedIdentity.value.serverId, name: savedName } : parsedIdentity.value;
} else {
	const created = { serverId: crypto.randomBytes(8).toString("hex"), createdAt: new Date().toISOString() };
	writePrivateFile(paths.identity, `${JSON.stringify(created, null, 2)}\n`);
	identity = created;
}
const displayName = (env.PI_REMOTE_NAME || identity.name || os.hostname() || "pi")
	.replace(/[^\x20-\x7e]/g, "")
	.trim()
	.slice(0, 40) || "pi";

let keyPem: string;
let certPem: string;
if (fs.existsSync(paths.tlsKey) && fs.existsSync(paths.tlsCert)) {
	keyPem = fs.readFileSync(paths.tlsKey, "utf8");
	certPem = fs.readFileSync(paths.tlsCert, "utf8");
	try {
		assertUsable(certPem, keyPem);
	} catch (error) {
		fail(`the TLS identity in ${paths.dir} is unusable (${errorMessage(error)}). Linked phones pin it, so it is not replaced silently: run /remote reset to create a new one and link the phones again.`);
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
const onAudit = (record: Readonly<Record<string, unknown>>): void => audit(paths.audit, record);
const devices = new DeviceRegistry(paths.devices);
// Every linked device got there through an approval this host audited (pair_approved). One that
// did not (a record written into devices.json by something else) is suspended: listed, refused at
// login, and reported, until the operator revokes it or pairs it again.
const startupWarnings: string[] = [];
{
	const approved = new Set(readAudit(paths.audit, Number.MAX_SAFE_INTEGER).filter((r) => r.event === "pair_approved" && typeof r.deviceId === "string").map((r) => r.deviceId));
	for (const d of devices.list()) {
		if (approved.has(d.id)) continue;
		devices.suspend(d.id);
		audit(paths.audit, { event: "device_unaudited", deviceId: d.id, name: d.name });
		const line = `linked device "${d.name}" (${formatDeviceId(d.id)}) has no pairing approval in audit.jsonl, so it was not linked through this host: it is suspended (it cannot log in) until you revoke it or pair it again`;
		startupWarnings.push(line);
		log(`WARNING: ${line}`);
	}
}
const pairings = new Pairings({ fingerprint, devices, onAudit });
const auth = new Authenticator({ devices, fingerprint, serverId: identity.serverId, tokenTtlMs });
const limiter = new RateLimiter();
const hub = new BridgeHub();
const dialogs = new DialogTracker({ listLiveSessions: pc.listLiveSessions });
const admins = new Set<ControlConnection>();

function notify(message: string, level = "info"): void {
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

function pairLink(code: string): string {
	const params = new URLSearchParams({ h: addresses.join(","), p: String(httpsPort), f: fingerprint, c: code, n: displayName.slice(0, 24) });
	return `pirc://pair?${params.toString()}`;
}

function deviceView(d: DeviceRecord, online: ReadonlySet<string>) {
	return {
		id: d.id,
		display: formatDeviceId(d.id),
		name: d.name,
		suspended: devices.isSuspended(d.id),
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
		warnings: [...(bind.mode === "all" ? [BIND_ALL_WARNING] : []), ...startupWarnings],
		recent: readAudit(paths.audit, 40).filter((r) => typeof r.event === "string" && /failure|bad_|rejected|blocked|unlinked|revoked|unaudited|second_claim|decide_refused/.test(r.event)).slice(-8),
	};
}

// ---------------------------------------------------------- control channel ---
const controlSecret = randomSecret(32);

function onAdmin(conn: ControlConnection, msg: ControlMessage): void {
	if (msg.t !== "req") return;
	admins.add(conn);
	const reply = (data: unknown): void => {
		conn.send({ t: "res", id: msg.id, ok: true, data });
	};
	const refuse = (error: string, status = 400): void => {
		conn.send({ t: "res", id: msg.id, ok: false, error, status });
	};
	switch (msg.op) {
		case "status":
			reply(status());
			return;
		case "subscribe":
			conn.subscribed = true;
			reply({ subscribed: true });
			return;
		case "pair.create": {
			conn.onPairRequest = (request) => conn.send({ t: "evt", name: "pair.request", data: request });
			conn.onRequestClosed = (request) => conn.send({ t: "evt", name: "pair.request.closed", data: request });
			conn.onOfferClosed = (offer, reason) => conn.send({ t: "evt", name: "pair.closed", data: { offerId: offer.id, reason } });
			// An absent or unusable ttlSec leaves the offer's default lifetime (Pairings clamps the rest).
			const ttlMs = Number(msg.ttlSec) * 1000;
			const offer = pairings.createOffer(ttlMs ? { owner: conn, ttlMs } : { owner: conn });
			const link = pairLink(offer.code);
			const qr = encodeQr(link, { ecl: "M" });
			reply({
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
			return;
		}
		case "pair.cancel":
			pairings.cancelOffer("cancelled by the operator");
			reply({ cancelled: true });
			return;
		case "pair.decide": {
			// Request ids are strings; anything else matches no request (as Pairings would answer).
			if (typeof msg.requestId !== "string") {
				refuse("no such pairing request", 404);
				return;
			}
			// Approving a phone gives it the operator's authority, so it must come from a person: the
			// connection's process must be an interactive terminal's foreground process (remote/peer.ts).
			// A rejection may come from anywhere.
			let decidedBy: Record<string, unknown> | undefined;
			if (msg.approve === true) {
				const peer = inspectPeer(conn.socket.remotePort, conn.socket.localPort);
				if (!peer.ok) {
					onAudit({ event: "pair_decide_refused", why: peer.why, pid: peer.pid });
					notify(`refused a phone approval that did not come from an interactive terminal (${peer.why})`, "warning");
					refuse(`approving a phone needs a person at an interactive terminal: the connection's process does not qualify (${peer.why})`, 403);
					return;
				}
				decidedBy = { pid: peer.pid, tty: peer.tty };
			}
			try {
				const result = pairings.decide(msg.requestId, msg.approve === true, { owner: conn, confirm: msg.confirm, decidedBy });
				if (result.state === "approved") notify(`linked "${result.name}" (${result.deviceIdDisplay})`);
				reply(result);
				return;
			} catch (error) {
				refuse(errorMessage(error), errorStatus(error));
				return;
			}
		}
		case "devices.list":
			reply({ devices: devices.list().map((d) => deviceView(d, auth.activeDeviceIds())) });
			return;
		case "devices.revoke": {
			const device = devices.resolve(msg.deviceId);
			if (!device) {
				refuse("no single linked device matches that id or name", 404);
				return;
			}
			devices.remove(device.id);
			auth.revokeDevice(device.id);
			onAudit({ event: "device_revoked", deviceId: device.id, name: device.name });
			reply({ revoked: deviceView(device, new Set()) });
			return;
		}
		case "devices.rename": {
			const device = devices.resolve(msg.deviceId);
			const renamed = device ? devices.setName(device.id, msg.name) : null;
			if (!renamed) {
				refuse("no single linked device matches that id or name", 404);
				return;
			}
			reply({ device: deviceView(renamed, auth.activeDeviceIds()) });
			return;
		}
		case "shutdown":
			reply({ stopping: true });
			setTimeout(() => void shutdown("stopped by /remote stop"), 50);
			return;
		default:
			refuse(`unknown operation ${String(msg.op).slice(0, 40)}`);
			return;
	}
}

function onBridge(conn: ControlConnection, msg: ControlMessage): void {
	if (msg.t === "register") {
		try {
			const session = hub.register(conn, msg.session);
			conn.send({ t: "registered", id: session.id });
			log(`terminal session ${session.id} attached (pid ${conn.pid ?? "?"})`);
		} catch (error) {
			conn.send({ t: "registered", ok: false, error: errorMessage(error) });
		}
		return;
	}
	if (msg.t === "unregister") {
		hub.unregister(conn, "detached");
		return;
	}
	hub.forConn(conn)?.onMessage(msg);
}

function onClose(conn: ControlConnection): void {
	admins.delete(conn);
	pairings.releaseOwner(conn);
	const session = hub.forConn(conn);
	if (session) {
		log(`terminal session ${session.id} detached`);
		hub.unregister(conn, "terminal closed");
	}
}

const control = new ControlServer({ secret: controlSecret, onAdmin, onBridge, onClose, log });

// ---------------------------------------------------------------- servers ---
const server = https.createServer({ key: keyPem, cert: certPem, minVersion: "TLSv1.2" }, (req, res) => {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("Cache-Control", "no-store");
	void api.handle(req, res);
});
server.headersTimeout = 30_000;
server.requestTimeout = 60_000;
server.on("tlsClientError", () => {
	/* scanners and phones with a stale pin end here; nothing to do */
});

const startedAt = new Date();

server.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code === "EADDRINUSE") fail(`port ${port} on ${bind.host} is in use (set PI_REMOTE_PORT)`, 1);
	fail(`HTTPS server error: ${error.message}`, 1);
});

await new Promise<void>((resolve) => server.listen(port, bind.host, resolve));
const listening = server.address();
httpsPort = listening !== null && typeof listening === "object" ? listening.port : port;
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
if (bind.mode === "all") log(`WARNING: ${BIND_ALL_WARNING}`);

// --------------------------------------------------------------- shutdown ---
let stopping = false;
async function shutdown(reason: string): Promise<void> {
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
		log(`error while stopping: ${errorMessage(error)}`);
	} finally {
		// Remove control.json only while it is still this process's (a newer host may have replaced it).
		const current = readJsonFileAs(paths.control, ControlFileSchema);
		if (current?.pid === process.pid && safeEqual(current.secret, controlSecret)) fs.rmSync(paths.control, { force: true });
		process.exit(0);
	}
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGHUP", () => void shutdown("SIGHUP"));
