#!/usr/bin/env node
// remote-cli.ts — manage the pi remote host without a pi terminal (a headless box, over SSH).
//
//   node packages/web-ui/server/remote-cli.ts start      start the host in the background
//   node packages/web-ui/server/remote-cli.ts status     addresses, certificate, phones, sessions
//   node packages/web-ui/server/remote-cli.ts pair       show a QR code and approve a phone here
//   node packages/web-ui/server/remote-cli.ts devices    list linked phones
//   node packages/web-ui/server/remote-cli.ts revoke <id prefix|name>
//   node packages/web-ui/server/remote-cli.ts rename <id prefix|name> <new name>
//   node packages/web-ui/server/remote-cli.ts stop       stop the host
//
// It speaks the host's loopback control channel with the secret from control.json, so it must
// run as the same user as the host. Approving a phone needs this terminal (stdin a TTY).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { array, boolean, type Infer, isRecord, nullable, number, object, optional, parseJson, safeParse, type Schema, string, unknownValue } from "../../core/lib/guard.ts";
import { renderHalfBlocks } from "./remote/qr.ts";
import { ControlFileSchema, ensurePrivateDir, readJsonFileAs, stateDir, statePaths } from "./remote/store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const paths = statePaths(stateDir());
const out = (line = ""): void => {
	process.stdout.write(`${line}\n`);
};
const die = (line: string, code = 1): never => {
	process.stderr.write(`remote: ${line}\n`);
	process.exit(code);
};

// What this CLI reads from the host's replies. They come over a socket, so they are checked
// before use; fields the CLI does not show are not required.
const DeviceViewSchema = object({
	name: string(),
	display: string(),
	online: optional(boolean()),
	lastSeenAt: optional(nullable(string())),
});
type DeviceView = Infer<typeof DeviceViewSchema>;

/** The fields hostLine shows: the advertised addresses (an array of strings, else none) and the HTTPS port. */
interface Reach {
	readonly addresses?: unknown;
	readonly port: number;
}

const StatusSchema = object({
	pid: number(),
	version: string(),
	name: string(),
	bind: string(),
	bindMode: string(),
	port: number(),
	addresses: optional(unknownValue()),
	fingerprintDisplay: string(),
	terminalSessions: array(unknownValue()),
	runningSessions: number(),
	streams: number(),
	devices: array(DeviceViewSchema),
});

const OfferSchema = object({
	qr: object({ size: number({ integer: true }), rows: array(string()) }),
	addresses: optional(unknownValue()),
	port: number(),
	codeDisplay: string(),
	fingerprintDisplay: string(),
	expiresAt: string(),
});

const PairRequestSchema = object({
	requestId: string(),
	name: string(),
	platform: string(),
	address: optional(nullable(string())),
	deviceIdDisplay: string(),
});

const DecisionSchema = object({ state: string(), name: string(), deviceIdDisplay: string() });
const DevicesSchema = object({ devices: array(DeviceViewSchema) });
const NamedDeviceSchema = object({ name: string(), display: string() });
const RevokedSchema = object({ revoked: NamedDeviceSchema });
const RenamedSchema = object({ device: NamedDeviceSchema });

/** One record from the host other than a reply (an event), or the local `{t:"closed"}`. */
type HostMessage = Record<string, unknown>;

interface Pending {
	readonly ok: (data: unknown) => void;
	readonly no: (error: Error) => void;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

class Admin {
	readonly pending = new Map<string, Pending>();
	readonly listeners = new Set<(msg: HostMessage) => void>();
	nextId = 1;
	readonly socket: net.Socket;

	constructor(socket: net.Socket) {
		this.socket = socket;
	}

	static open(): Promise<Admin | null> {
		const control = readJsonFileAs(paths.control, ControlFileSchema);
		if (!control) return Promise.resolve(null);
		return new Promise((resolve) => {
			const socket = net.connect({ host: "127.0.0.1", port: control.port });
			const admin = new Admin(socket);
			let buffer = "";
			let greeted = false;
			const timer = setTimeout(() => {
				socket.destroy();
				resolve(null);
			}, 3000);
			socket.setEncoding("utf8");
			socket.on("connect", () => socket.write(`${JSON.stringify({ t: "hello", secret: control.secret, role: "admin", pid: process.pid })}\n`));
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				let nl;
				while ((nl = buffer.indexOf("\n")) !== -1) {
					let msg: unknown;
					try {
						msg = parseJson(buffer.slice(0, nl));
					} catch {
						msg = null;
					}
					buffer = buffer.slice(nl + 1);
					if (!isRecord(msg)) continue;
					if (!greeted) {
						greeted = true;
						clearTimeout(timer);
						resolve(msg.ok ? admin : null);
						continue;
					}
					const waiter = msg.t === "res" && typeof msg.id === "string" ? admin.pending.get(msg.id) : undefined;
					if (waiter && typeof msg.id === "string") {
						admin.pending.delete(msg.id);
						if (msg.ok) waiter.ok(msg.data);
						else waiter.no(new Error(typeof msg.error === "string" && msg.error ? msg.error : "refused"));
					} else {
						for (const fn of admin.listeners) fn(msg);
					}
				}
			});
			socket.on("error", () => {
				if (!greeted) {
					clearTimeout(timer);
					resolve(null);
				}
			});
			socket.on("close", () => {
				for (const { no } of admin.pending.values()) no(new Error("the host closed the connection"));
				admin.pending.clear();
				for (const fn of admin.listeners) fn({ t: "closed" });
			});
		});
	}

	/** Send one request; resolves with the reply's data once `schema` accepts it. */
	request<T>(op: string, schema: Schema<T>, args: Readonly<Record<string, unknown>> = {}): Promise<T> {
		const id = `c${this.nextId++}`;
		return new Promise((ok, no) => {
			this.pending.set(id, {
				ok: (data) => {
					const result = safeParse(schema, data, op);
					if (result.ok) ok(result.value);
					else no(new Error(`unexpected reply from the host (${result.error.message})`));
				},
				no,
			});
			this.socket.write(`${JSON.stringify({ t: "req", id, op, ...args })}\n`);
		});
	}

	close(): void {
		this.socket.destroy();
	}
}

async function admin(): Promise<Admin> {
	const link = await Admin.open();
	if (!link) return die(`the host is not running (state: ${paths.dir}). Start it with "remote-cli.ts start" or /remote in pi.`);
	return link;
}

function hostLine(s: Reach): string {
	const addresses = Array.isArray(s.addresses) ? s.addresses.filter((a): a is string => typeof a === "string") : [];
	return addresses.length ? addresses.map((a) => `${a.includes(":") ? `[${a}]` : a}:${s.port}`).join(", ") : `port ${s.port} (no address found; set PI_REMOTE_ADVERTISE)`;
}

function deviceLines(devices: readonly DeviceView[]): string[] {
	if (!devices.length) return ["  (no phones linked)"];
	return devices.map((d) => `  ${d.online ? "●" : "○"} ${d.name}  ${d.display}  ${d.lastSeenAt ? `last seen ${d.lastSeenAt.slice(0, 16).replace("T", " ")}` : "never seen"}`);
}

function ask(question: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

async function start(): Promise<void> {
	const running = await Admin.open();
	if (running) {
		const s = await running.request("status", StatusSchema);
		running.close();
		out(`remote: already running (pid ${s.pid}), reachable at ${hostLine(s)}`);
		return;
	}
	ensurePrivateDir(paths.dir);
	const log = fs.openSync(paths.log, "a", 0o600);
	const child = spawn(process.execPath, [path.join(HERE, `remote-host${path.extname(fileURLToPath(import.meta.url))}`)], { cwd: path.join(HERE, ".."), detached: true, stdio: ["ignore", log, log], env: process.env });
	child.unref();
	fs.closeSync(log);
	for (let i = 0; i < 48; i++) {
		await new Promise((r) => setTimeout(r, 250));
		const link = await Admin.open();
		if (link) {
			const s = await link.request("status", StatusSchema);
			link.close();
			out(`remote: started (pid ${s.pid}), reachable at ${hostLine(s)}. Log: ${paths.log}`);
			return;
		}
		if (child.exitCode !== null && child.exitCode !== 3) break;
	}
	die(`the host did not start; see ${paths.log}`);
}

async function status(): Promise<void> {
	const link = await Admin.open();
	if (!link) {
		out(`remote: not running (state: ${paths.dir})`);
		return;
	}
	const s = await link.request("status", StatusSchema);
	link.close();
	out(`pi remote host "${s.name}" (pid ${s.pid}, ${s.version})`);
	out(`  Listening    ${s.bindMode === "all" ? "all interfaces" : s.bind}, port ${s.port}`);
	out(`  Reach it at  ${hostLine(s)}`);
	out(`  Certificate  ${s.fingerprintDisplay}`);
	out(`  Shared terminal sessions ${s.terminalSessions.length}; sessions started from phones ${s.runningSessions}; open streams ${s.streams}`);
	out("Linked phones:");
	for (const line of deviceLines(s.devices)) out(line);
}

async function pair(): Promise<void> {
	if (!process.stdin.isTTY) die("pairing needs an interactive terminal to approve the phone");
	const link = await admin();
	const events: HostMessage[] = [];
	let wake: (() => void) | null = null;
	link.listeners.add((msg) => {
		if (msg.t === "evt" || msg.t === "closed") {
			events.push(msg);
			wake?.();
		}
	});
	const offer = await link.request("pair.create", OfferSchema, { ttlSec: 300 });
	const qr = { size: offer.qr.size, modules: offer.qr.rows.map((row) => Array.from(row, (c) => c === "1")) };
	out();
	for (const line of renderHalfBlocks(qr, { quiet: 2, ansi: process.stdout.isTTY })) out(line);
	out();
	out("Scan this with the pi remote app, or add the host by hand:");
	out(`  Address      ${hostLine(offer)}`);
	out(`  Code         ${offer.codeDisplay}`);
	out(`  Certificate  ${offer.fingerprintDisplay}`);
	out(`Waiting for the phone (until ${new Date(offer.expiresAt).toTimeString().slice(0, 5)}; Ctrl-C cancels)…`);
	const onSigint = async () => {
		await link.request("pair.cancel", unknownValue()).catch(() => {});
		out("\nremote: linking cancelled.");
		process.exit(130);
	};
	const onSigintEvent = (): void => void onSigint();
	process.once("SIGINT", onSigintEvent);
	const expiresAt = Date.parse(offer.expiresAt);
	for (;;) {
		if (!events.length) {
			await new Promise<void>((resolve) => {
				wake = resolve;
				setTimeout(resolve, Math.max(0, expiresAt - Date.now())).unref();
			});
			wake = null;
		}
		const event = events.shift();
		if (!event) {
			await link.request("pair.cancel", unknownValue()).catch(() => {});
			return die("the pairing code expired");
		}
		if (event.t === "closed") die("the host stopped");
		if (event.name === "pair.closed") {
			const reason = isRecord(event.data) ? event.data.reason : undefined;
			die(`pairing ended: ${typeof reason === "string" && reason ? reason : "closed"}`);
		}
		if (event.name !== "pair.request") continue;
		const parsed = safeParse(PairRequestSchema, event.data, "pair.request");
		if (!parsed.ok) return die(`unexpected link request from the host (${parsed.error.message})`);
		const request = parsed.value;
		process.off("SIGINT", onSigintEvent);
		out();
		out(`Link request from "${request.name}" (${request.platform}) at ${request.address || "an unknown address"}`);
		out(`  Device ID    ${request.deviceIdDisplay}`);
		out("Approve only if the phone in your hand shows exactly this device ID.");
		const answer = (await ask("Approve? [y/N] ")).trim().toLowerCase();
		const result = await link.request("pair.decide", DecisionSchema, { requestId: request.requestId, approve: answer === "y" || answer === "yes" });
		link.close();
		if (result.state === "approved") {
			out(`remote: linked "${result.name}" (${result.deviceIdDisplay}).`);
			return;
		}
		return die(`${result.state} "${request.name}"`);
	}
}

async function devicesCmd(): Promise<void> {
	const link = await admin();
	const { devices } = await link.request("devices.list", DevicesSchema);
	link.close();
	out("Linked phones:");
	for (const line of deviceLines(devices)) out(line);
}

async function revoke(target: string | undefined): Promise<void> {
	if (!target) die("usage: remote-cli.ts revoke <device id prefix or name>");
	const link = await admin();
	try {
		const { revoked } = await link.request("devices.revoke", RevokedSchema, { deviceId: target });
		out(`remote: unlinked "${revoked.name}" (${revoked.display}).`);
	} catch (error) {
		die(errorMessage(error));
	} finally {
		link.close();
	}
}

async function renameDevice(target: string | undefined, name: string): Promise<void> {
	if (!target || !name) die("usage: remote-cli.ts rename <device id prefix or name> <new name>");
	const link = await admin();
	try {
		const { device } = await link.request("devices.rename", RenamedSchema, { deviceId: target, name });
		out(`remote: renamed ${device.display} to "${device.name}".`);
	} catch (error) {
		die(errorMessage(error));
	} finally {
		link.close();
	}
}

async function stop(): Promise<void> {
	const link = await Admin.open();
	if (!link) {
		out("remote: not running");
		return;
	}
	await link.request("shutdown", unknownValue()).catch(() => {});
	link.close();
	for (let i = 0; i < 40 && fs.existsSync(paths.control); i++) await new Promise((r) => setTimeout(r, 100));
	out("remote: stopped");
}

const [cmd = "status", ...rest] = process.argv.slice(2);
const commands: Readonly<Record<string, () => Promise<void>>> = {
	start,
	status,
	pair,
	devices: devicesCmd,
	revoke: () => revoke(rest[0]),
	rename: () => renameDevice(rest[0], rest.slice(1).join(" ")),
	stop,
};
// Own keys only: "constructor" or "toString" must not reach an Object.prototype method.
if (!Object.hasOwn(commands, cmd)) {
	out("usage: remote-cli.ts [start|status|pair|devices|revoke <id>|rename <id> <name>|stop]");
	process.exit(cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 2);
}
await commands[cmd]?.();
