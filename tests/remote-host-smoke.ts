#!/usr/bin/env node
// Smoke test for the pi remote host (packages/web-ui/server/remote-host.ts), end to end over
// real TLS on loopback, with a stub `pi --mode rpc`:
//   - state files are owner-only and the certificate the host serves is the one it pins;
//   - pairing: wrong codes count and burn the offer, a proof over another certificate burns it,
//     a correct request waits for the operator, approval links the device, rejection does not;
//   - login: single-use challenges, channel binding (certificate fingerprint in the signature),
//     unknown devices and replays refused; every /api route needs the token;
//   - pi-console's API works through the host; event streams are slimmed; a dialog a pi child
//     opens reaches the phone and the phone's answer reaches the child;
//   - a terminal session attached over the control channel can be watched and driven;
//   - revoking a device ends its token and its open streams; repeated failed logins block;
//   - shutdown stops children and removes control.json;
//   - SEC-5 compensating controls: approving needs the device ID's last four characters, a second
//     claim of a code cancels the pairing, an approval from a process that is not an interactive
//     terminal is refused, every phone dialog answer is audited with its device, a device record
//     with no pairing approval on record is suspended at start, and binding every interface warns.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	ControlClient,
	PhoneClient,
	makeRemoteSandbox,
	makeRunner,
	parseLink,
	readControl,
	startRemoteHost,
	waitUntil,
	type ControlMessage,
	type LoginResult,
	type PhoneResponse,
	type RemoteHostHandle,
} from "./remote-test-harness.ts";
import type { StubStartEvent } from "./web-ui-test-harness.ts";
import { kitVersion } from "../packages/web-ui/server/remote-version.ts";
import { isolateKitEnv } from "../packages/core/eval/harness.ts";
import { DeviceRegistry } from "../packages/web-ui/server/remote/devices.ts";
import { clientErrorMessage } from "../packages/web-ui/server/remote/api.ts";

// Shapes of the host's replies that the checks read.
interface PairOffer {
	code: string;
	codeDisplay: string;
	link: string;
	qr: { rows: unknown[]; size: number };
}
interface PairRequestData {
	name: string;
	deviceId: string;
	requestId: string;
}
interface DeviceList {
	devices: Array<{ id: string }>;
}
interface HostStatus {
	name: string;
	port: number;
	recent: Array<{ event: string }>;
}
interface PairJson {
	code: string;
	state: string;
	deviceId: string;
	requestId: string;
}
interface SessionList {
	sessions: Array<{ id: string; status: string }>;
}
/** One event-stream frame's data; each frame kind carries only the fields that belong to it. */
interface FrameData {
	state: string;
	id: string;
	dialog: { id: string; method: string; options: string[] };
	data: {
		type: string;
		message: { content: Array<{ text: string }> };
		assistantMessageEvent: { delta: string; partial: unknown };
	};
}

/** A reply's parsed JSON body; a reply that is not JSON fails the check. */
function jsonOf<T>(res: PhoneResponse<T>): T {
	if (res.json === null) throw new Error(`not a JSON reply: ${res.status} ${res.text}`);
	return res.json;
}
/** The data of a control-channel event (`pair.request` here). */
const evtData = (m: ControlMessage): PairRequestData => m.data as PairRequestData;

const { check, finish } = makeRunner("remote-host smoke");
const restoreKitEnv = isolateKitEnv();
const sandbox = makeRemoteSandbox();
let hostToStop: RemoteHostHandle | null = null;
let adminToClose: ControlClient | null = null;

const mode = (file: string): number => fs.statSync(file).mode & 0o777;

try {
  await check("version lookup recognises compatible kit package names", () => {
    const root = path.join(sandbox.root, "version-fixture");
    fs.mkdirSync(root, { recursive: true });
    for (const name of ["@satunix/pi-system", "@satunix/luna", "pi-system", "@legacy/pi-system"]) {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version: "9.8.7" }));
      assert.equal(kitVersion(root), "9.8.7", name);
    }
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "luna", version: "9.8.7" }));
    assert.equal(kitVersion(root), "0.0.0", "bare luna is foreign");
  });
	await check("a failed request tells the client an Error's message, never a stringified thrown value", () => {
		assert.equal(clientErrorMessage(new Error("unknown session")), "unknown session");
		const thrown = { status: 404, toString: () => "Error: boom\n    at secret (/srv/app.ts:1:1)" };
		assert.equal(clientErrorMessage(thrown), "request failed");
		assert.equal(clientErrorMessage("plain string"), "request failed");
	});
	// The checks use these; the nullable copies outside the try tell the cleanup what is still open.
	const host = await startRemoteHost(sandbox);
	hostToStop = host;
	const admin = await ControlClient.connect(host.control);
	adminToClose = admin;

	await check("a device is found by its full name, spaces included", () => {
		const registry = new DeviceRegistry(path.join(sandbox.root, "devices-resolve.json"));
		const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
		const added = registry.add({ publicKey: spki, name: "Pixel 8", platform: "android", address: "127.0.0.1" });
		assert.equal(registry.resolve("Pixel 8")?.id, added.id);
		assert.equal(registry.resolve(added.id.slice(0, 6))?.id, added.id);
		assert.equal(registry.resolve(["Pixel 8"]), null);
	});

	await check("state is owner-only and the served certificate is the pinned one", async () => {
		if (process.platform !== "win32") {
			assert.equal(mode(sandbox.stateDir), 0o700);
			for (const name of ["tls-key.pem", "control.json", "identity.json"]) assert.equal(mode(path.join(sandbox.stateDir, name)), 0o600, name);
		}
		const phone = new PhoneClient({ port: host.port, fingerprint: host.fingerprint });
		const hello = await phone.request<{ service: string; name: string }>("GET", "/v1/hello");
		assert.equal(hello.status, 200);
		assert.equal(jsonOf(hello).service, "pi-remote");
		assert.equal(jsonOf(hello).name, "test-box");
		const wrong = new PhoneClient({ port: host.port, fingerprint: "A".repeat(43) });
		await assert.rejects(wrong.request("GET", "/v1/hello"), /pin mismatch/);
	});

	await check("the control channel refuses a wrong secret", async () => {
		await assert.rejects(ControlClient.connect(host.control, "admin", { secret: "x".repeat(43) }), /not authorised|closed/);
	});

	await check("every /api route needs a token", async () => {
		const phone = new PhoneClient({ port: host.port, fingerprint: host.fingerprint });
		const routes: Array<[string, string]> = [["GET", "/api/sessions"], ["GET", "/api/config"], ["POST", "/api/sessions"], ["GET", "/api/sessions/x/events"], ["DELETE", "/api/remote/device"]];
		for (const [method, p] of routes) {
			const res = await phone.request(method, p, method === "GET" ? undefined : {}, { token: null });
			assert.equal(res.status, 401, `${method} ${p}`);
		}
		const bogus = await phone.request("GET", "/api/sessions", undefined, { token: "a".repeat(43) });
		assert.equal(bogus.status, 401);
	});

	let phone: PhoneClient;

	await check("wrong codes count against the offer and the fifth burns it", async () => {
		const offer = await admin.request<PairOffer>("pair.create");
		assert.match(offer.codeDisplay, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
		assert.equal(offer.qr.rows.length, offer.qr.size);
		const link = parseLink(offer.link);
		assert.equal(link.fingerprint, host.fingerprint);
		assert.equal(link.port, host.port);
		const p = new PhoneClient({ port: host.port, fingerprint: host.fingerprint });
		const wrong = offer.code === "0000000000" ? "1111111111" : "0000000000";
		for (let i = 0; i < 4; i++) assert.equal((await p.pair<PairJson>(wrong)).status, 403);
		const fifth = await p.pair<PairJson>(wrong);
		assert.equal(fifth.status, 410);
		await admin.waitFor((m) => m.t === "evt" && m.name === "pair.closed");
		assert.equal((await p.pair<PairJson>(offer.code)).status, 410, "the burned code no longer works");
	});

	await check("a proof made over another certificate burns the code (interception)", async () => {
		const offer = await admin.request<PairOffer>("pair.create");
		const p = new PhoneClient({ port: host.port, fingerprint: host.fingerprint });
		const res = await p.pair<PairJson>(offer.code, { proof: p.pairProof(offer.code, "B".repeat(43)) });
		assert.equal(res.status, 403);
		assert.equal(jsonOf(res).code, "bad_proof");
		assert.equal((await p.pair<PairJson>(offer.code)).status, 410);
	});

	await check("a pairing field of the wrong type is refused, never stringified into the proof", async () => {
		const offer = await admin.request<PairOffer>("pair.create");
		const p = new PhoneClient({ port: host.port, fingerprint: host.fingerprint, name: "Typed Phone" });
		const good = { code: offer.code, publicKey: p.publicKeyB64, name: "Typed Phone", platform: "android", proof: p.pairProof(offer.code) };
		for (const [field, value] of [["name", ["Typed Phone"]], ["proof", [good.proof]], ["platform", ["android"]]] as const) {
			const res = await p.request<{ error: string }>("POST", "/v1/pair", { ...good, [field]: value });
			assert.equal(res.status, 400, `${field}: ${res.text}`);
			assert.equal(jsonOf(res).error, `invalid ${field}`);
		}
		const status = await admin.request<{ offer: { attempts: number } | null }>("status");
		assert.equal(status.offer?.attempts, 0, "a refused body is not a guess and does not burn the code");
		await admin.request("pair.cancel");
	});

	await check("a correct code waits for the operator; rejection links nothing", async () => {
		const offer = await admin.request<PairOffer>("pair.create");
		const p = new PhoneClient({ port: host.port, fingerprint: host.fingerprint, name: "Rejected Phone" });
		const res = await p.pair<PairJson>(offer.codeDisplay.toLowerCase());
		assert.equal(res.status, 202);
		assert.equal(jsonOf(res).state, "pending");
		const evt = await admin.waitFor((m) => m.t === "evt" && m.name === "pair.request" && evtData(m).name === "Rejected Phone");
		assert.equal(evtData(evt).deviceId, jsonOf(res).deviceId);
		const poll = await p.request<PairJson>("GET", `/v1/pair/${jsonOf(res).requestId}`);
		assert.equal(jsonOf(poll).state, "pending");
		await admin.request("pair.decide", { requestId: evtData(evt).requestId, approve: false });
		const after = await p.request<PairJson>("GET", `/v1/pair/${jsonOf(res).requestId}?wait=2`);
		assert.equal(jsonOf(after).state, "rejected");
		const list = await admin.request<DeviceList>("devices.list");
		assert.equal(list.devices.length, 0);
	});

	await check("the platform a phone claims reaches the operator without control characters", async () => {
		const offer = await admin.request<PairOffer>("pair.create");
		const p = new PhoneClient({ port: host.port, fingerprint: host.fingerprint, name: "Escape Phone" });
		const res = await p.request<PairJson>("POST", "/v1/pair", { code: offer.code, publicKey: p.publicKeyB64, name: "Escape Phone", platform: "and\u001b[2J\u001b]0;x\u0007roid", proof: p.pairProof(offer.code) });
		assert.equal(res.status, 202, res.text);
		const evt = await admin.waitFor((m) => m.t === "evt" && m.name === "pair.request" && evtData(m).name === "Escape Phone");
		const platform = (evt.data as { platform: string }).platform;
		assert.equal(platform, "and [2J ]0;x roid", "ESC and BEL became spaces");
		await admin.request("pair.decide", { requestId: evtData(evt).requestId, approve: false });
	});

	await check("approval links the device and the phone can log in", async () => {
		const offer = await admin.request<PairOffer>("pair.create");
		phone = new PhoneClient({ port: host.port, fingerprint: host.fingerprint, name: "Pixel Test" });
		const res = await phone.pair<PairJson>(offer.code);
		assert.equal(res.status, 202);
		const waiting = phone.request<PairJson>("GET", `/v1/pair/${jsonOf(res).requestId}?wait=10`);
		const evt = await admin.waitFor((m) => m.t === "evt" && m.name === "pair.request" && evtData(m).name === "Pixel Test");
		await admin.request("pair.decide", { requestId: evtData(evt).requestId, approve: true, confirm: evtData(evt).deviceId.slice(-4) });
		const decided = await waiting;
		assert.equal(jsonOf(decided).state, "approved");
		assert.equal(jsonOf(decided).deviceId, jsonOf(res).deviceId);
		phone.deviceId = jsonOf(res).deviceId;
		const derived = crypto.createHash("sha256").update(Buffer.from(phone.publicKeyB64, "base64")).digest();
		assert.equal(phone.deviceId.length, 16);
		assert.ok(derived.length === 32);
		const login = await phone.login();
		assert.equal(login.status, 200, login.text);
		const who = await phone.request<{ device: { name: string } }>("GET", "/api/remote/whoami");
		assert.equal(who.status, 200);
		assert.equal(jsonOf(who).device.name, "Pixel Test");
		const devices = JSON.parse(fs.readFileSync(path.join(sandbox.stateDir, "devices.json"), "utf8")) as DeviceList;
		assert.equal(devices.devices.length, 1);
		assert.ok(!JSON.stringify(devices).includes("PRIVATE"), "no private key material on the host");
	});

	await check("a phone can unlink itself; the DELETE must declare JSON like every other change", async () => {
		const offer = await admin.request<PairOffer>("pair.create");
		const leaver = new PhoneClient({ port: host.port, fingerprint: host.fingerprint, name: "Leaving Phone" });
		const res = await leaver.pair<PairJson>(offer.code);
		assert.equal(res.status, 202, res.text);
		const waiting = leaver.request<PairJson>("GET", `/v1/pair/${jsonOf(res).requestId}?wait=10`);
		const evt = await admin.waitFor((m) => m.t === "evt" && m.name === "pair.request" && evtData(m).name === "Leaving Phone");
		await admin.request("pair.decide", { requestId: evtData(evt).requestId, approve: true, confirm: evtData(evt).deviceId.slice(-4).toLowerCase() });
		assert.equal(jsonOf(await waiting).state, "approved");
		leaver.deviceId = jsonOf(res).deviceId;
		assert.equal((await leaver.login()).status, 200);
		const bare = await leaver.request("DELETE", "/api/remote/device");
		assert.equal(bare.status, 415, "a bodiless DELETE without a JSON content type is refused");
		const gone = await leaver.request<{ unlinked: boolean }>("DELETE", "/api/remote/device", {});
		assert.equal(gone.status, 200, gone.text);
		assert.equal(jsonOf(gone).unlinked, true);
		assert.equal((await leaver.request("GET", "/api/sessions")).status, 401, "its token ends at once");
		// No login attempt here: a failed one counts against this address, and later checks
		// spend that allowance exactly.
		const list = await admin.request<DeviceList>("devices.list");
		assert.ok(!list.devices.some((d) => d.id === leaver.deviceId));
		assert.ok(list.devices.some((d) => d.id === phone.deviceId), "other phones stay linked");
	});

	await check("approving needs the device ID's last four characters from the phone; a wrong value rejects", async () => {
		const offer = await admin.request<PairOffer>("pair.create");
		const p = new PhoneClient({ port: host.port, fingerprint: host.fingerprint, name: "Unchecked Phone" });
		const res = await p.pair<PairJson>(offer.code);
		assert.equal(res.status, 202, res.text);
		const evt = await admin.waitFor((m) => m.t === "evt" && m.name === "pair.request" && evtData(m).name === "Unchecked Phone");
		const wrong = evtData(evt).deviceId.slice(-4) === "0000" ? "1111" : "0000";
		const result = await admin.request<{ state: string; reason: string }>("pair.decide", { requestId: evtData(evt).requestId, approve: true, confirm: wrong });
		assert.equal(result.state, "rejected", "a wrong confirmation rejects, it does not approve");
		assert.match(result.reason, /did not match/);
		const none = await admin.request<{ state: string }>("pair.decide", { requestId: evtData(evt).requestId, approve: true, confirm: evtData(evt).deviceId.slice(-4) });
		assert.equal(none.state, "rejected", "the decision is final");
		const list = await admin.request<DeviceList>("devices.list");
		assert.ok(!list.devices.some((d) => d.id === evtData(evt).deviceId), "nothing was linked");
	});

	await check("a second device presenting a claimed code cancels the pairing (second claim refused)", async () => {
		const offer = await admin.request<PairOffer>("pair.create");
		const first = new PhoneClient({ port: host.port, fingerprint: host.fingerprint, name: "First Phone" });
		const second = new PhoneClient({ port: host.port, fingerprint: host.fingerprint, name: "Second Phone" });
		const res = await first.pair<PairJson>(offer.code);
		assert.equal(res.status, 202, res.text);
		const evt = await admin.waitFor((m) => m.t === "evt" && m.name === "pair.request" && evtData(m).name === "First Phone");
		const contested = await second.pair<{ code: string }>(offer.code);
		assert.equal(contested.status, 409, contested.text);
		assert.equal(jsonOf(contested).code, "offer_contested");
		await admin.waitFor((m) => m.t === "evt" && m.name === "pair.request.closed" && evtData(m).requestId === evtData(evt).requestId);
		const poll = await first.request<PairJson & { reason: string }>("GET", `/v1/pair/${jsonOf(res).requestId}`);
		assert.equal(jsonOf(poll).state, "cancelled", "the first claim is cancelled too: the code has leaked");
		const late = await admin.request<{ state: string }>("pair.decide", { requestId: evtData(evt).requestId, approve: true, confirm: evtData(evt).deviceId.slice(-4) });
		assert.equal(late.state, "cancelled", "a contested request cannot be approved");
		const audit = fs.readFileSync(path.join(sandbox.stateDir, "audit.jsonl"), "utf8");
		assert.match(audit, /"event":"pair_second_claim"/);
	});

	await check("a phone approval from a process that is not an interactive terminal is refused", async () => {
		// A detached child, as pi runs an agent's shell command: its own session, no controlling terminal.
		const script = `const net = await import("node:net");
const [port, secret] = process.argv.slice(1);
const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
let buffer = "";
socket.setEncoding("utf8");
socket.on("connect", () => { socket.write(JSON.stringify({ t: "hello", secret, role: "admin" }) + "\\n"); socket.write(JSON.stringify({ t: "req", id: "1", op: "pair.create" }) + "\\n"); });
socket.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\\n")) !== -1) {
    const msg = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
    if (msg.t === "res" && msg.id === "1") console.log("OFFER " + msg.data.code);
    if (msg.t === "evt" && msg.name === "pair.request") socket.write(JSON.stringify({ t: "req", id: "2", op: "pair.decide", requestId: msg.data.requestId, approve: true, confirm: msg.data.deviceId.slice(-4) }) + "\\n");
    if (msg.t === "res" && msg.id === "2") { console.log("DECIDE " + JSON.stringify(msg)); } // stays connected: closing would cancel the request
  }
});`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script, String(host.control.port), host.control.secret], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c: string) => (out += c));
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		try {
			await waitUntil(() => /^OFFER /m.test(out), 10_000, "the detached client to open an offer");
			const code = /^OFFER (\S+)/m.exec(out)?.[1] ?? "";
			const p = new PhoneClient({ port: host.port, fingerprint: host.fingerprint, name: "Agent Phone" });
			const res = await p.pair<PairJson>(code);
			assert.equal(res.status, 202, res.text);
			await waitUntil(() => /^DECIDE /m.test(out), 10_000, "the detached client's decision");
			assert.match(out, /"ok":false/, "the approval is refused");
			assert.match(out, /"status":403/);
			assert.match(out, /interactive terminal/);
			if (process.platform === "linux") assert.match(out, /no controlling terminal/, "the host found the client's process and judged it");
			const poll = await p.request<PairJson>("GET", `/v1/pair/${jsonOf(res).requestId}`);
			assert.equal(jsonOf(poll).state, "pending", "nothing was decided");
			const list = await admin.request<DeviceList>("devices.list");
			assert.ok(!list.devices.some((d) => d.id === jsonOf(res).deviceId), "nothing was linked");
			const audit = fs.readFileSync(path.join(sandbox.stateDir, "audit.jsonl"), "utf8");
			assert.match(audit, /"event":"pair_decide_refused"/);
			const approvedBy = audit.trim().split("\n").map((l) => JSON.parse(l) as { event: string; decidedBy?: { pid: number } }).filter((r) => r.event === "pair_approved");
			assert.ok(approvedBy.length > 0 && approvedBy.every((r) => r.decidedBy?.pid === process.pid), "every approval names the terminal process that gave it");
		} finally {
			child.kill();
			await exited;
		}
	});

	await check("challenges are single use and bound to the certificate", async () => {
		const first = await phone.login();
		assert.equal(first.status, 200);
		const replay = await phone.request("POST", "/v1/auth/token", { deviceId: phone.deviceId, nonce: first.nonce, signature: first.signature });
		assert.equal(replay.status, 401, "a used nonce cannot be replayed");
		const challenge = await phone.request<{ nonce: string }>("POST", "/v1/auth/challenge", { deviceId: phone.deviceId });
		const nonce = jsonOf(challenge).nonce;
		for (const body of [{ deviceId: [phone.deviceId], nonce, signature: first.signature }, { deviceId: phone.deviceId, nonce: [nonce], signature: first.signature }, { deviceId: phone.deviceId, nonce, signature: [first.signature] }]) {
			const typed = await phone.request("POST", "/v1/auth/token", body);
			assert.equal(typed.status, 400, `a field of the wrong type is refused, not stringified: ${typed.text}`);
		}
		const relayed = await phone.login({ fingerprint: "C".repeat(43) });
		assert.equal(relayed.status, 401, "a signature over another certificate is refused");
		const stranger = new PhoneClient({ port: host.port, fingerprint: host.fingerprint });
		const unknown = await stranger.login({ deviceId: "0123456789ABCDEF" });
		assert.equal(unknown.status, 401);
		assert.equal((await phone.login()).status, 200);
	});

	await check("pi-console's API answers through the host", async () => {
		const config = await phone.request("GET", "/api/config");
		assert.equal(config.status, 200);
		const models = await phone.request("GET", "/api/models");
		assert.equal(models.status, 200);
		const cwds = await phone.request("GET", "/api/cwds");
		assert.equal(cwds.status, 200);
		const noJson = await phone.request("POST", "/api/sessions", undefined, { rawBody: "{}", headers: { "Content-Type": "text/plain" } });
		assert.equal(noJson.status, 415);
	});

	let sessionId: string;
	await check("a session started from the phone streams slimmed events", async () => {
		const created = await phone.request<{ session: { id: string } }>("POST", "/api/sessions", { cwd: sandbox.cwd });
		assert.equal(created.status, 201, created.text);
		sessionId = jsonOf(created).session.id;
		const stream = phone.stream<FrameData>(sessionId);
		assert.equal(await stream.ready, 200);
		await stream.waitFor((f) => f.event === "history_end");
		const prompt = await phone.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/prompt`, { message: "hi there" });
		assert.equal(prompt.status, 202, prompt.text);
		await stream.waitFor((f) => f.event === "event" && f.data.data.type === "agent_settled");
		const updates = stream.frames.filter((f) => f.event === "event" && f.data.data.type === "message_update");
		assert.equal(updates.length, 3);
		for (const u of updates) {
			assert.equal(u.data.data.message, undefined, "no message snapshot on updates");
			assert.equal(u.data.data.assistantMessageEvent.partial, undefined, "no partial snapshot on updates");
		}
		assert.equal(updates.map((u) => u.data.data.assistantMessageEvent.delta).join(""), "Hello from the stub");
		const listed = await phone.request<SessionList>("GET", "/api/sessions");
		assert.ok(jsonOf(listed).sessions.some((s) => s.id === sessionId && s.status === "running"));
		stream.close();
	});

	await check("a session that is nowhere (not shared, running or on disk) streams as gone", async () => {
		const stream = phone.stream<FrameData>("00000000-0000-4000-8000-000000000000");
		assert.equal(await stream.ready, 200);
		await stream.waitFor((f) => f.event === "history_end");
		const first = stream.frames[0];
		assert.ok(first, "a frame arrived before history_end");
		assert.equal(first.event, "lifecycle");
		assert.equal(first.data.state, "gone");
		stream.close();
	});

	await check("a dialog a pi child opens can be answered from the phone", async () => {
		const stream = phone.stream<FrameData>(sessionId);
		await stream.waitFor((f) => f.event === "history_end");
		await phone.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/prompt`, { message: "please ask me" });
		const request = await stream.waitFor((f) => f.event === "ui_request");
		assert.equal(request.data.dialog.method, "select");
		assert.deepEqual(request.data.dialog.options, ["Allow once", "Deny"]);
		const bogus = await phone.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/ui-response`, { dialogId: "not-open", value: "Deny" });
		assert.equal(bogus.status, 404, "only a dialog the child opened can be answered");
		const answer = await phone.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/ui-response`, { dialogId: request.data.dialog.id, value: "Deny" });
		assert.equal(answer.status, 200, answer.text);
		await stream.waitFor((f) => f.event === "ui_resolved" && f.data.id === request.data.dialog.id);
		await waitUntil(() => sandbox.stubEvents().some((e) => e.event === "cmd" && e.cmd.type === "extension_ui_response" && e.cmd.value === "Deny"), 5000, "the child to receive the answer");
		// The answer is audited with the device that gave it (SEC-5 compensating control).
		const answers = fs.readFileSync(path.join(sandbox.stateDir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.event === "phone_dialog_answer");
		assert.equal(answers.length, 1, "one audit record per phone answer");
		assert.equal(answers[0]?.deviceId, phone.deviceId);
		assert.equal(answers[0]?.choice, "Deny");
		assert.equal(answers[0]?.method, "select");
		const again = await phone.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/ui-response`, { dialogId: request.data.dialog.id, value: "Allow once" });
		assert.equal(again.status, 404, "a dialog is answered once");
		stream.close();
	});

	await check("the control secret never reaches a pi child", async () => {
		const starts = sandbox.stubEvents().filter((e): e is StubStartEvent => e.event === "start");
		assert.ok(starts.length >= 1);
		const control = readControl(sandbox);
		assert.ok(control, "the host is running");
		for (const start of starts) {
			assert.ok(!JSON.stringify(start).includes(control.secret), "not in argv or the PI_REMOTE_* environment");
			assert.ok(start.env, "the stub records the child's environment");
			assert.ok(!start.env.some((k) => /SECRET|TOKEN/.test(k)));
		}
	});

	await check("a terminal session attached over the control channel can be watched and driven", async () => {
		const bridge = await ControlClient.connect(host.control, "bridge");
		bridge.send({ t: "register", session: { id: "term-session-1", cwd: sandbox.cwd, name: "from the terminal", busy: false, model: { provider: "p", id: "m" }, thinking: "low" } });
		await bridge.waitFor((m) => m.t === "registered");
		const listed = await phone.request<SessionList>("GET", "/api/sessions");
		const entry = jsonOf(listed).sessions.find((s) => s.id === "term-session-1");
		assert.equal(entry?.status, "terminal");

		bridge.listeners.add((m) => {
			if (m.t !== "cmd") return;
			if (m.op === "snapshot") {
				bridge.send({ t: "event", seq: 1, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "in snapshot" }] } } });
				bridge.send({ t: "res", id: m.id, ok: true, data: { seq: 1, messages: [{ role: "user", content: [{ type: "text", text: "earlier prompt" }], timestamp: 5 }] } });
				bridge.send({ t: "event", seq: 2, event: { type: "message_update", message: { big: true }, assistantMessageEvent: { type: "text_delta", delta: "live", partial: { big: true } } } });
			} else if (m.op === "prompt") bridge.send({ t: "res", id: m.id, ok: true, data: { delivered: "followUp" } });
			else if (m.op === "models") bridge.send({ t: "res", id: m.id, ok: "yes", data: { models: [] } });
			else if (m.op === "ui_response") { bridge.send({ t: "ui_done", id: m.dialogId, by: "phone" }); bridge.send({ t: "res", id: m.id, ok: true }); }
			else bridge.send({ t: "res", id: m.id, ok: true });
		});

		const stream = phone.stream<FrameData>("term-session-1");
		await stream.waitFor((f) => f.event === "history_end");
		const history = stream.frames.filter((f) => f.event === "observed");
		assert.equal(history.length, 1);
		const [observed] = history;
		assert.ok(observed, "one observed frame");
		const [part] = observed.data.data.message.content;
		assert.ok(part, "the observed message has content");
		assert.equal(part.text, "earlier prompt");
		const live = await stream.waitFor((f) => f.event === "event" && f.data.data.type === "message_update");
		assert.equal(live.data.data.assistantMessageEvent.delta, "live");
		assert.equal(live.data.data.assistantMessageEvent.partial, undefined);
		assert.ok(!stream.frames.some((f) => f.event === "event" && f.data.data.type === "message_end"), "an event already in the snapshot is not sent twice");

		const prompt = await phone.request("POST", "/api/sessions/term-session-1/prompt", { message: "from the phone", streamingBehavior: "followUp" });
		assert.equal(prompt.status, 202, prompt.text);
		const cmd = await bridge.waitFor((m) => m.t === "cmd" && m.op === "prompt");
		assert.equal(cmd.message, "from the phone");
		assert.equal(cmd.streamingBehavior, "followUp");

		const typedLevel = await phone.request("POST", "/api/sessions/term-session-1/thinking", { level: ["high"] });
		assert.equal(typedLevel.status, 400, "a thinking level that is not a string is refused, not stringified");
		const level = await phone.request<{ level: string }>("POST", "/api/sessions/term-session-1/thinking", { level: "high" });
		assert.equal(level.status, 200, level.text);
		assert.equal((await bridge.waitFor((m) => m.t === "cmd" && m.op === "set_thinking")).level, "high");

		bridge.send({ t: "ui", dialog: { id: "tdlg1", method: "confirm", title: "Approve tool call?", message: "HIGH · bash · ls" } });
		const ui = await stream.waitFor((f) => f.event === "ui_request");
		assert.equal(ui.data.dialog.method, "confirm");
		const answered = await phone.request("POST", "/api/sessions/term-session-1/ui-response", { dialogId: "tdlg1", confirmed: true });
		assert.equal(answered.status, 200, answered.text);
		const uiCmd = await bridge.waitFor((m) => m.t === "cmd" && m.op === "ui_response");
		assert.equal(uiCmd.confirmed, true);
		assert.equal((uiCmd.by as { deviceId?: string } | undefined)?.deviceId, phone.deviceId, "the terminal is told which phone answered");
		const termAnswer = fs.readFileSync(path.join(sandbox.stateDir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.event === "phone_dialog_answer" && r.session === "term-session-1");
		assert.equal(termAnswer.length, 1, "the terminal-session answer is audited once");
		assert.equal(termAnswer[0]?.tier, "high", "with the approval card's tier");
		assert.equal(termAnswer[0]?.choice, "yes");
		await stream.waitFor((f) => f.event === "ui_resolved" && f.data.id === "tdlg1");

		// Bridge frames are untrusted too: a field of the wrong type is ignored or refused, never stringified.
		const models = await phone.request("GET", "/api/sessions/term-session-1/models");
		assert.equal(models.status, 409, `only ok: true is success: ${models.text}`);
		bridge.send({ t: "ui", dialog: { id: 7, method: "confirm", title: "numeric id" } });
		bridge.send({ t: "ui", dialog: { id: "tdlg2", method: "select", title: "mixed options", options: ["a", { b: 1 }] } });
		bridge.send({ t: "ui", dialog: { id: "tdlg3", method: "confirm", title: "kept open" } });
		await stream.waitFor((f) => f.event === "ui_request" && f.data.dialog.id === "tdlg3");
		assert.ok(!stream.frames.some((f) => f.event === "ui_request" && ["7", "tdlg2"].includes(f.data.dialog.id)), "malformed dialogs are not shown");
		assert.equal((await phone.request("POST", "/api/sessions/term-session-1/ui-response", { dialogId: "7", confirmed: true })).status, 404);
		bridge.send({ t: "ui_done", id: ["tdlg3"], by: "terminal" });
		const stillOpen = await phone.request("POST", "/api/sessions/term-session-1/ui-response", { dialogId: "tdlg3", confirmed: false });
		assert.equal(stillOpen.status, 200, `a ui_done with a non-string id closes nothing: ${stillOpen.text}`);

		const stop = await phone.request("DELETE", "/api/sessions/term-session-1", {});
		assert.equal(stop.status, 409, "a terminal session cannot be killed from the phone");
		bridge.close();
		await stream.waitFor((f) => f.event === "lifecycle" && f.data.state === "detached");
		const after = await phone.request<SessionList>("GET", "/api/sessions");
		assert.ok(!jsonOf(after).sessions.some((s) => s.id === "term-session-1" && s.status === "terminal"));
		stream.close();
	});

	await check("revoking a device ends its token and its open streams at once", async () => {
		const stream = phone.stream<FrameData>(sessionId);
		await stream.waitFor((f) => f.event === "history_end");
		assert.ok(phone.deviceId !== null, "the approval check above set deviceId");
		const revoked = await admin.request<{ revoked: { id: string } }>("devices.revoke", { deviceId: phone.deviceId.slice(0, 6) });
		assert.equal(revoked.revoked.id, phone.deviceId);
		await stream.waitFor((f) => f.event === "lifecycle" && f.data.state === "revoked");
		await waitUntil(() => stream.closed, 3000, "the stream to close");
		assert.equal((await phone.request("GET", "/api/sessions")).status, 401);
		assert.equal((await phone.login()).status, 401, "a revoked device cannot log in again");
	});

	await check("repeated failed logins block the address", async () => {
		const p = new PhoneClient({ port: host.port, fingerprint: host.fingerprint });
		let last: LoginResult | null = null;
		for (let i = 0; i < 12; i++) last = await p.login({ deviceId: "0123456789ABCDEF" });
		assert.ok(last, "the loop above always runs");
		assert.equal(last.status, 429);
	});

	await check("status reports the host without secrets", async () => {
		const status = await admin.request<HostStatus>("status");
		assert.equal(status.name, "test-box");
		assert.equal(status.port, host.port);
		const control = readControl(sandbox);
		assert.ok(control, "the host is running");
		assert.ok(!JSON.stringify(status).includes(control.secret));
		assert.ok(status.recent.some((r) => r.event === "auth_failure"));
	});

	await check("shutdown stops the children and removes control.json", async () => {
		await admin.request("shutdown");
		const result = await host.exited;
		assert.equal(result.code, 0);
		assert.equal(readControl(sandbox), null);
		const starts = sandbox.stubEvents().filter((e): e is StubStartEvent => e.event === "start");
		for (const start of starts) {
			let alive = true;
			try {
				process.kill(start.pid, 0);
			} catch {
				alive = false;
			}
			assert.equal(alive, false, `stub pi ${start.pid} still running`);
		}
		hostToStop = null;
	});

	await check("a device record with no pairing approval on record is suspended at start; binding every interface warns", async () => {
		const planted = makeRemoteSandbox("pi-remote-planted-");
		let second: RemoteHostHandle | null = null;
		try {
			const p = new PhoneClient({ port: 1, fingerprint: "", name: "Planted Phone" });
			fs.mkdirSync(planted.stateDir, { recursive: true, mode: 0o700 });
			const record = new DeviceRegistry(path.join(planted.stateDir, "devices.json")).add({ publicKey: p.publicKeyB64, name: "Planted Phone" });
			second = await startRemoteHost(planted, { env: { PI_REMOTE_BIND: "all" } });
			p.port = second.port;
			p.fingerprint = second.fingerprint;
			p.deviceId = record.id;
			const out = second.output();
			assert.match(out, /WARNING: linked device "Planted Phone" .* has no pairing approval in audit\.jsonl/);
			assert.match(out, /WARNING: bound to every interface .* PI_REMOTE_BIND=tailscale, or loopback/);
			const ctl = await ControlClient.connect(second.control);
			try {
				const status = await ctl.request<{ warnings: string[]; devices: Array<{ id: string; suspended: boolean }> }>("status");
				assert.ok(status.warnings.some((w) => /bound to every interface/.test(w)), "status carries the bind warning");
				assert.ok(status.warnings.some((w) => /Planted Phone/.test(w)), "and the suspended device");
				assert.equal(status.devices.find((d) => d.id === record.id)?.suspended, true);
			} finally {
				ctl.close();
			}
			const login = await p.login();
			assert.notEqual(login.status, 200, "a suspended device cannot log in");
			assert.match(fs.readFileSync(path.join(planted.stateDir, "audit.jsonl"), "utf8"), /"event":"device_unaudited"/);
		} finally {
			await second?.stop();
			planted.cleanup();
		}
	});
} finally {
  restoreKitEnv();
	adminToClose?.close();
	if (hostToStop) {
		await hostToStop.stop();
		if (process.env.REMOTE_TEST_DEBUG) console.error(hostToStop.output());
	}
	sandbox.cleanup();
}
finish();
