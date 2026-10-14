#!/usr/bin/env node
// Smoke test for the pi remote host (packages/web-ui/server/remote-host.js), end to end over
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
} from "./remote-test-harness.mjs";

const { check, finish } = makeRunner("remote-host smoke");
const sandbox = makeRemoteSandbox();
let host = null;
let admin = null;

const mode = (file) => fs.statSync(file).mode & 0o777;

try {
	host = await startRemoteHost(sandbox);
	admin = await ControlClient.connect(host.control);

	await check("state is owner-only and the served certificate is the pinned one", async () => {
		if (process.platform !== "win32") {
			assert.equal(mode(sandbox.stateDir), 0o700);
			for (const name of ["tls-key.pem", "control.json", "identity.json"]) assert.equal(mode(path.join(sandbox.stateDir, name)), 0o600, name);
		}
		const phone = new PhoneClient({ port: host.port, fingerprint: host.fingerprint });
		const hello = await phone.request("GET", "/v1/hello");
		assert.equal(hello.status, 200);
		assert.equal(hello.json.service, "pi-remote");
		assert.equal(hello.json.name, "test-box");
		const wrong = new PhoneClient({ port: host.port, fingerprint: "A".repeat(43) });
		await assert.rejects(wrong.request("GET", "/v1/hello"), /pin mismatch/);
	});

	await check("the control channel refuses a wrong secret", async () => {
		await assert.rejects(ControlClient.connect(host.control, "admin", { secret: "x".repeat(43) }), /not authorised|closed/);
	});

	await check("every /api route needs a token", async () => {
		const phone = new PhoneClient({ port: host.port, fingerprint: host.fingerprint });
		for (const [method, p] of [["GET", "/api/sessions"], ["GET", "/api/config"], ["POST", "/api/sessions"], ["GET", "/api/sessions/x/events"], ["DELETE", "/api/remote/device"]]) {
			const res = await phone.request(method, p, method === "GET" ? undefined : {}, { token: null });
			assert.equal(res.status, 401, `${method} ${p}`);
		}
		const bogus = await phone.request("GET", "/api/sessions", undefined, { token: "a".repeat(43) });
		assert.equal(bogus.status, 401);
	});

	let phone = null;

	await check("wrong codes count against the offer and the fifth burns it", async () => {
		const offer = await admin.request("pair.create");
		assert.match(offer.codeDisplay, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
		assert.equal(offer.qr.rows.length, offer.qr.size);
		const link = parseLink(offer.link);
		assert.equal(link.fingerprint, host.fingerprint);
		assert.equal(link.port, host.port);
		const p = new PhoneClient({ port: host.port, fingerprint: host.fingerprint });
		const wrong = offer.code === "0000000000" ? "1111111111" : "0000000000";
		for (let i = 0; i < 4; i++) assert.equal((await p.pair(wrong)).status, 403);
		const fifth = await p.pair(wrong);
		assert.equal(fifth.status, 410);
		await admin.waitFor((m) => m.t === "evt" && m.name === "pair.closed");
		assert.equal((await p.pair(offer.code)).status, 410, "the burned code no longer works");
	});

	await check("a proof made over another certificate burns the code (interception)", async () => {
		const offer = await admin.request("pair.create");
		const p = new PhoneClient({ port: host.port, fingerprint: host.fingerprint });
		const res = await p.pair(offer.code, { proof: p.pairProof(offer.code, "B".repeat(43)) });
		assert.equal(res.status, 403);
		assert.equal(res.json.code, "bad_proof");
		assert.equal((await p.pair(offer.code)).status, 410);
	});

	await check("a correct code waits for the operator; rejection links nothing", async () => {
		const offer = await admin.request("pair.create");
		const p = new PhoneClient({ port: host.port, fingerprint: host.fingerprint, name: "Rejected Phone" });
		const res = await p.pair(offer.codeDisplay.toLowerCase());
		assert.equal(res.status, 202);
		assert.equal(res.json.state, "pending");
		const evt = await admin.waitFor((m) => m.t === "evt" && m.name === "pair.request" && m.data.name === "Rejected Phone");
		assert.equal(evt.data.deviceId, res.json.deviceId);
		const poll = await p.request("GET", `/v1/pair/${res.json.requestId}`);
		assert.equal(poll.json.state, "pending");
		await admin.request("pair.decide", { requestId: evt.data.requestId, approve: false });
		const after = await p.request("GET", `/v1/pair/${res.json.requestId}?wait=2`);
		assert.equal(after.json.state, "rejected");
		const list = await admin.request("devices.list");
		assert.equal(list.devices.length, 0);
	});

	await check("approval links the device and the phone can log in", async () => {
		const offer = await admin.request("pair.create");
		phone = new PhoneClient({ port: host.port, fingerprint: host.fingerprint, name: "Pixel Test" });
		const res = await phone.pair(offer.code);
		assert.equal(res.status, 202);
		const waiting = phone.request("GET", `/v1/pair/${res.json.requestId}?wait=10`);
		const evt = await admin.waitFor((m) => m.t === "evt" && m.name === "pair.request" && m.data.name === "Pixel Test");
		await admin.request("pair.decide", { requestId: evt.data.requestId, approve: true });
		const decided = await waiting;
		assert.equal(decided.json.state, "approved");
		assert.equal(decided.json.deviceId, res.json.deviceId);
		phone.deviceId = res.json.deviceId;
		const derived = crypto.createHash("sha256").update(Buffer.from(phone.publicKeyB64, "base64")).digest();
		assert.equal(phone.deviceId.length, 16);
		assert.ok(derived.length === 32);
		const login = await phone.login();
		assert.equal(login.status, 200, login.text);
		const who = await phone.request("GET", "/api/remote/whoami");
		assert.equal(who.status, 200);
		assert.equal(who.json.device.name, "Pixel Test");
		const devices = JSON.parse(fs.readFileSync(path.join(sandbox.stateDir, "devices.json"), "utf8"));
		assert.equal(devices.devices.length, 1);
		assert.ok(!JSON.stringify(devices).includes("PRIVATE"), "no private key material on the host");
	});

	await check("a phone can unlink itself; the DELETE must declare JSON like every other change", async () => {
		const offer = await admin.request("pair.create");
		const leaver = new PhoneClient({ port: host.port, fingerprint: host.fingerprint, name: "Leaving Phone" });
		const res = await leaver.pair(offer.code);
		assert.equal(res.status, 202, res.text);
		const waiting = leaver.request("GET", `/v1/pair/${res.json.requestId}?wait=10`);
		const evt = await admin.waitFor((m) => m.t === "evt" && m.name === "pair.request" && m.data.name === "Leaving Phone");
		await admin.request("pair.decide", { requestId: evt.data.requestId, approve: true });
		assert.equal((await waiting).json.state, "approved");
		leaver.deviceId = res.json.deviceId;
		assert.equal((await leaver.login()).status, 200);
		const bare = await leaver.request("DELETE", "/api/remote/device");
		assert.equal(bare.status, 415, "a bodiless DELETE without a JSON content type is refused");
		const gone = await leaver.request("DELETE", "/api/remote/device", {});
		assert.equal(gone.status, 200, gone.text);
		assert.equal(gone.json.unlinked, true);
		assert.equal((await leaver.request("GET", "/api/sessions")).status, 401, "its token ends at once");
		// No login attempt here: a failed one counts against this address, and later checks
		// spend that allowance exactly.
		const list = await admin.request("devices.list");
		assert.ok(!list.devices.some((d) => d.id === leaver.deviceId));
		assert.ok(list.devices.some((d) => d.id === phone.deviceId), "other phones stay linked");
	});

	await check("challenges are single use and bound to the certificate", async () => {
		const first = await phone.login();
		assert.equal(first.status, 200);
		const replay = await phone.request("POST", "/v1/auth/token", { deviceId: phone.deviceId, nonce: first.nonce, signature: first.signature });
		assert.equal(replay.status, 401, "a used nonce cannot be replayed");
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

	let sessionId = null;
	await check("a session started from the phone streams slimmed events", async () => {
		const created = await phone.request("POST", "/api/sessions", { cwd: sandbox.cwd });
		assert.equal(created.status, 201, created.text);
		sessionId = created.json.session.id;
		const stream = phone.stream(sessionId);
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
		const listed = await phone.request("GET", "/api/sessions");
		assert.ok(listed.json.sessions.some((s) => s.id === sessionId && s.status === "running"));
		stream.close();
	});

	await check("a session that is nowhere (not shared, running or on disk) streams as gone", async () => {
		const stream = phone.stream("00000000-0000-4000-8000-000000000000");
		assert.equal(await stream.ready, 200);
		await stream.waitFor((f) => f.event === "history_end");
		assert.equal(stream.frames[0].event, "lifecycle");
		assert.equal(stream.frames[0].data.state, "gone");
		stream.close();
	});

	await check("a dialog a pi child opens can be answered from the phone", async () => {
		const stream = phone.stream(sessionId);
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
		const starts = sandbox.stubEvents().filter((e) => e.event === "start");
		assert.ok(starts.length >= 1);
		const control = readControl(sandbox);
		for (const start of starts) {
			assert.ok(!JSON.stringify(start).includes(control.secret), "not in argv or the PI_REMOTE_* environment");
			assert.ok(!start.env.some((k) => /SECRET|TOKEN/.test(k)));
		}
	});

	await check("a terminal session attached over the control channel can be watched and driven", async () => {
		const bridge = await ControlClient.connect(host.control, "bridge");
		bridge.send({ t: "register", session: { id: "term-session-1", cwd: sandbox.cwd, name: "from the terminal", busy: false, model: { provider: "p", id: "m" }, thinking: "low" } });
		await bridge.waitFor((m) => m.t === "registered");
		const listed = await phone.request("GET", "/api/sessions");
		const entry = listed.json.sessions.find((s) => s.id === "term-session-1");
		assert.equal(entry.status, "terminal");

		bridge.listeners.add((m) => {
			if (m.t !== "cmd") return;
			if (m.op === "snapshot") {
				bridge.send({ t: "event", seq: 1, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "in snapshot" }] } } });
				bridge.send({ t: "res", id: m.id, ok: true, data: { seq: 1, messages: [{ role: "user", content: [{ type: "text", text: "earlier prompt" }], timestamp: 5 }] } });
				bridge.send({ t: "event", seq: 2, event: { type: "message_update", message: { big: true }, assistantMessageEvent: { type: "text_delta", delta: "live", partial: { big: true } } } });
			} else if (m.op === "prompt") bridge.send({ t: "res", id: m.id, ok: true, data: { delivered: "followUp" } });
			else if (m.op === "ui_response") bridge.send({ t: "ui_done", id: m.dialogId, by: "phone" }), bridge.send({ t: "res", id: m.id, ok: true });
			else bridge.send({ t: "res", id: m.id, ok: true });
		});

		const stream = phone.stream("term-session-1");
		await stream.waitFor((f) => f.event === "history_end");
		const history = stream.frames.filter((f) => f.event === "observed");
		assert.equal(history.length, 1);
		assert.equal(history[0].data.data.message.content[0].text, "earlier prompt");
		const live = await stream.waitFor((f) => f.event === "event" && f.data.data.type === "message_update");
		assert.equal(live.data.data.assistantMessageEvent.delta, "live");
		assert.equal(live.data.data.assistantMessageEvent.partial, undefined);
		assert.ok(!stream.frames.some((f) => f.event === "event" && f.data.data.type === "message_end"), "an event already in the snapshot is not sent twice");

		const prompt = await phone.request("POST", "/api/sessions/term-session-1/prompt", { message: "from the phone", streamingBehavior: "followUp" });
		assert.equal(prompt.status, 202, prompt.text);
		const cmd = await bridge.waitFor((m) => m.t === "cmd" && m.op === "prompt");
		assert.equal(cmd.message, "from the phone");
		assert.equal(cmd.streamingBehavior, "followUp");

		bridge.send({ t: "ui", dialog: { id: "tdlg1", method: "confirm", title: "Approve tool call?", message: "bash: ls" } });
		const ui = await stream.waitFor((f) => f.event === "ui_request");
		assert.equal(ui.data.dialog.method, "confirm");
		const answered = await phone.request("POST", "/api/sessions/term-session-1/ui-response", { dialogId: "tdlg1", confirmed: true });
		assert.equal(answered.status, 200, answered.text);
		const uiCmd = await bridge.waitFor((m) => m.t === "cmd" && m.op === "ui_response");
		assert.equal(uiCmd.confirmed, true);
		await stream.waitFor((f) => f.event === "ui_resolved" && f.data.id === "tdlg1");

		const stop = await phone.request("DELETE", "/api/sessions/term-session-1", {});
		assert.equal(stop.status, 409, "a terminal session cannot be killed from the phone");
		bridge.close();
		await stream.waitFor((f) => f.event === "lifecycle" && f.data.state === "detached");
		const after = await phone.request("GET", "/api/sessions");
		assert.ok(!after.json.sessions.some((s) => s.id === "term-session-1" && s.status === "terminal"));
		stream.close();
	});

	await check("revoking a device ends its token and its open streams at once", async () => {
		const stream = phone.stream(sessionId);
		await stream.waitFor((f) => f.event === "history_end");
		const revoked = await admin.request("devices.revoke", { deviceId: phone.deviceId.slice(0, 6) });
		assert.equal(revoked.revoked.id, phone.deviceId);
		await stream.waitFor((f) => f.event === "lifecycle" && f.data.state === "revoked");
		await waitUntil(() => stream.closed, 3000, "the stream to close");
		assert.equal((await phone.request("GET", "/api/sessions")).status, 401);
		assert.equal((await phone.login()).status, 401, "a revoked device cannot log in again");
	});

	await check("repeated failed logins block the address", async () => {
		const p = new PhoneClient({ port: host.port, fingerprint: host.fingerprint });
		let last = null;
		for (let i = 0; i < 12; i++) last = await p.login({ deviceId: "0123456789ABCDEF" });
		assert.equal(last.status, 429);
	});

	await check("status reports the host without secrets", async () => {
		const status = await admin.request("status");
		assert.equal(status.name, "test-box");
		assert.equal(status.port, host.port);
		const control = readControl(sandbox);
		assert.ok(!JSON.stringify(status).includes(control.secret));
		assert.ok(status.recent.some((r) => r.event === "auth_failure"));
	});

	await check("shutdown stops the children and removes control.json", async () => {
		await admin.request("shutdown");
		const result = await host.exited;
		assert.equal(result.code, 0);
		assert.equal(readControl(sandbox), null);
		const starts = sandbox.stubEvents().filter((e) => e.event === "start");
		for (const start of starts) {
			let alive = true;
			try {
				process.kill(start.pid, 0);
			} catch {
				alive = false;
			}
			assert.equal(alive, false, `stub pi ${start.pid} still running`);
		}
		host = null;
	});
} finally {
	admin?.close();
	if (host) {
		await host.stop();
		if (process.env.REMOTE_TEST_DEBUG) console.error(host.output());
	}
	sandbox.cleanup();
}
finish();
