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
//   - shutdown stops children and removes control.json.
import assert from "node:assert/strict";
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
		await admin.request("pair.decide", { requestId: evtData(evt).requestId, approve: true });
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
		await admin.request("pair.decide", { requestId: evtData(evt).requestId, approve: true });
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

		bridge.send({ t: "ui", dialog: { id: "tdlg1", method: "confirm", title: "Approve tool call?", message: "bash: ls" } });
		const ui = await stream.waitFor((f) => f.event === "ui_request");
		assert.equal(ui.data.dialog.method, "confirm");
		const answered = await phone.request("POST", "/api/sessions/term-session-1/ui-response", { dialogId: "tdlg1", confirmed: true });
		assert.equal(answered.status, 200, answered.text);
		const uiCmd = await bridge.waitFor((m) => m.t === "cmd" && m.op === "ui_response");
		assert.equal(uiCmd.confirmed, true);
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
