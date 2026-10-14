#!/usr/bin/env node
// remote-cli.js — manage the pi remote host without a pi terminal (a headless box, over SSH).
//
//   node packages/web-ui/server/remote-cli.js start      start the host in the background
//   node packages/web-ui/server/remote-cli.js status     addresses, certificate, phones, sessions
//   node packages/web-ui/server/remote-cli.js pair       show a QR code and approve a phone here
//   node packages/web-ui/server/remote-cli.js devices    list linked phones
//   node packages/web-ui/server/remote-cli.js revoke <id prefix|name>
//   node packages/web-ui/server/remote-cli.js rename <id prefix|name> <new name>
//   node packages/web-ui/server/remote-cli.js stop       stop the host
//
// It speaks the host's loopback control channel with the secret from control.json, so it must
// run as the same user as the host. Approving a phone needs this terminal (stdin a TTY).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { renderHalfBlocks } from "./remote/qr.js";
import { ensurePrivateDir, readJsonFile, stateDir, statePaths } from "./remote/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const paths = statePaths(stateDir());
const out = (line = "") => process.stdout.write(`${line}\n`);
const die = (line, code = 1) => {
	process.stderr.write(`remote: ${line}\n`);
	process.exit(code);
};

class Admin {
	static open() {
		const control = readJsonFile(paths.control);
		if (!control || !Number.isInteger(control.port) || typeof control.secret !== "string") return Promise.resolve(null);
		return new Promise((resolve) => {
			const admin = new Admin();
			admin.pending = new Map();
			admin.listeners = new Set();
			admin.nextId = 1;
			const socket = net.connect({ host: "127.0.0.1", port: control.port });
			admin.socket = socket;
			let buffer = "";
			let greeted = false;
			const timer = setTimeout(() => {
				socket.destroy();
				resolve(null);
			}, 3000);
			socket.setEncoding("utf8");
			socket.on("connect", () => socket.write(`${JSON.stringify({ t: "hello", secret: control.secret, role: "admin", pid: process.pid })}\n`));
			socket.on("data", (chunk) => {
				buffer += chunk;
				let nl;
				while ((nl = buffer.indexOf("\n")) !== -1) {
					let msg;
					try {
						msg = JSON.parse(buffer.slice(0, nl));
					} catch {
						msg = null;
					}
					buffer = buffer.slice(nl + 1);
					if (!msg) continue;
					if (!greeted) {
						greeted = true;
						clearTimeout(timer);
						resolve(msg.ok ? admin : null);
						continue;
					}
					if (msg.t === "res" && admin.pending.has(msg.id)) {
						const { ok, no } = admin.pending.get(msg.id);
						admin.pending.delete(msg.id);
						if (msg.ok) ok(msg.data);
						else no(new Error(msg.error || "refused"));
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

	request(op, args = {}) {
		const id = `c${this.nextId++}`;
		return new Promise((ok, no) => {
			this.pending.set(id, { ok, no });
			this.socket.write(`${JSON.stringify({ t: "req", id, op, ...args })}\n`);
		});
	}

	close() {
		this.socket.destroy();
	}
}

async function admin() {
	const link = await Admin.open();
	if (!link) die(`the host is not running (state: ${paths.dir}). Start it with "remote-cli.js start" or /remote in pi.`);
	return link;
}

function hostLine(s) {
	const addresses = Array.isArray(s.addresses) ? s.addresses : [];
	return addresses.length ? addresses.map((a) => `${a.includes(":") ? `[${a}]` : a}:${s.port}`).join(", ") : `port ${s.port} (no address found; set PI_REMOTE_ADVERTISE)`;
}

function deviceLines(devices) {
	if (!devices.length) return ["  (no phones linked)"];
	return devices.map((d) => `  ${d.online ? "●" : "○"} ${d.name}  ${d.display}  ${d.lastSeenAt ? `last seen ${String(d.lastSeenAt).slice(0, 16).replace("T", " ")}` : "never seen"}`);
}

function ask(question) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

async function start() {
	const running = await Admin.open();
	if (running) {
		const s = await running.request("status");
		running.close();
		return out(`remote: already running (pid ${s.pid}), reachable at ${hostLine(s)}`);
	}
	ensurePrivateDir(paths.dir);
	const log = fs.openSync(paths.log, "a", 0o600);
	const child = spawn(process.execPath, [path.join(HERE, "remote-host.js")], { cwd: path.join(HERE, ".."), detached: true, stdio: ["ignore", log, log], env: process.env });
	child.unref();
	fs.closeSync(log);
	for (let i = 0; i < 48; i++) {
		await new Promise((r) => setTimeout(r, 250));
		const link = await Admin.open();
		if (link) {
			const s = await link.request("status");
			link.close();
			return out(`remote: started (pid ${s.pid}), reachable at ${hostLine(s)}. Log: ${paths.log}`);
		}
		if (child.exitCode !== null && child.exitCode !== 3) break;
	}
	die(`the host did not start; see ${paths.log}`);
}

async function status() {
	const link = await Admin.open();
	if (!link) return out(`remote: not running (state: ${paths.dir})`);
	const s = await link.request("status");
	link.close();
	out(`pi remote host "${s.name}" (pid ${s.pid}, ${s.version})`);
	out(`  Listening    ${s.bindMode === "all" ? "all interfaces" : s.bind}, port ${s.port}`);
	out(`  Reach it at  ${hostLine(s)}`);
	out(`  Certificate  ${s.fingerprintDisplay}`);
	out(`  Shared terminal sessions ${s.terminalSessions.length}; sessions started from phones ${s.runningSessions}; open streams ${s.streams}`);
	out("Linked phones:");
	for (const line of deviceLines(s.devices)) out(line);
}

async function pair() {
	if (!process.stdin.isTTY) die("pairing needs an interactive terminal to approve the phone");
	const link = await admin();
	const events = [];
	let wake = null;
	link.listeners.add((msg) => {
		if (msg.t === "evt" || msg.t === "closed") {
			events.push(msg);
			wake?.();
		}
	});
	const offer = await link.request("pair.create", { ttlSec: 300 });
	const qr = { size: offer.qr.size, modules: offer.qr.rows.map((row) => [...row].map((c) => c === "1")) };
	out();
	for (const line of renderHalfBlocks(qr, { quiet: 2, ansi: process.stdout.isTTY })) out(line);
	out();
	out("Scan this with the pi remote app, or add the host by hand:");
	out(`  Address      ${hostLine(offer)}`);
	out(`  Code         ${offer.codeDisplay}`);
	out(`  Certificate  ${offer.fingerprintDisplay}`);
	out(`Waiting for the phone (until ${new Date(offer.expiresAt).toTimeString().slice(0, 5)}; Ctrl-C cancels)…`);
	const onSigint = async () => {
		await link.request("pair.cancel").catch(() => {});
		out("\nremote: linking cancelled.");
		process.exit(130);
	};
	process.once("SIGINT", onSigint);
	const expiresAt = Date.parse(offer.expiresAt);
	for (;;) {
		if (!events.length) {
			await new Promise((resolve) => {
				wake = resolve;
				setTimeout(resolve, Math.max(0, expiresAt - Date.now())).unref();
			});
			wake = null;
		}
		const event = events.shift();
		if (!event) {
			await link.request("pair.cancel").catch(() => {});
			die("the pairing code expired");
		}
		if (event.t === "closed") die("the host stopped");
		if (event.name === "pair.closed") die(`pairing ended: ${event.data?.reason || "closed"}`);
		if (event.name !== "pair.request") continue;
		const request = event.data;
		process.off("SIGINT", onSigint);
		out();
		out(`Link request from "${request.name}" (${request.platform}) at ${request.address || "an unknown address"}`);
		out(`  Device ID    ${request.deviceIdDisplay}`);
		out("Approve only if the phone in your hand shows exactly this device ID.");
		const answer = (await ask("Approve? [y/N] ")).trim().toLowerCase();
		const result = await link.request("pair.decide", { requestId: request.requestId, approve: answer === "y" || answer === "yes" });
		link.close();
		if (result.state === "approved") return out(`remote: linked "${result.name}" (${result.deviceIdDisplay}).`);
		return die(`${result.state} "${request.name}"`);
	}
}

async function devicesCmd() {
	const link = await admin();
	const { devices } = await link.request("devices.list");
	link.close();
	out("Linked phones:");
	for (const line of deviceLines(devices)) out(line);
}

async function revoke(target) {
	if (!target) die("usage: remote-cli.js revoke <device id prefix or name>");
	const link = await admin();
	try {
		const { revoked } = await link.request("devices.revoke", { deviceId: target });
		out(`remote: unlinked "${revoked.name}" (${revoked.display}).`);
	} catch (error) {
		die(error.message);
	} finally {
		link.close();
	}
}

async function renameDevice(target, name) {
	if (!target || !name) die("usage: remote-cli.js rename <device id prefix or name> <new name>");
	const link = await admin();
	try {
		const { device } = await link.request("devices.rename", { deviceId: target, name });
		out(`remote: renamed ${device.display} to "${device.name}".`);
	} catch (error) {
		die(error.message);
	} finally {
		link.close();
	}
}

async function stop() {
	const link = await Admin.open();
	if (!link) return out("remote: not running");
	await link.request("shutdown").catch(() => {});
	link.close();
	for (let i = 0; i < 40 && fs.existsSync(paths.control); i++) await new Promise((r) => setTimeout(r, 100));
	out("remote: stopped");
}

const [cmd = "status", ...rest] = process.argv.slice(2);
const commands = {
	start,
	status,
	pair,
	devices: devicesCmd,
	revoke: () => revoke(rest[0]),
	rename: () => renameDevice(rest[0], rest.slice(1).join(" ")),
	stop,
};
if (!commands[cmd]) {
	out("usage: remote-cli.js [start|status|pair|devices|revoke <id>|rename <id> <name>|stop]");
	process.exit(cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 2);
}
await commands[cmd]();
