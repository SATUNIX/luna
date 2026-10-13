#!/usr/bin/env node
// remote-control extension smoke: `/remote` in a (scripted) terminal against the REAL remote host,
// with a simulated phone doing what the Android app does.
//
// Pins: /remote starts the host and shows a pairing QR code and code; a phone that claims the
// code is linked only after the terminal approves the request; the terminal session then appears
// to the phone as a "terminal" session with its history; events are forwarded slimmed; a phone
// prompt reaches pi.sendUserMessage while /remote and terminal-only commands are refused; a
// dialog another extension opens is mirrored and the first answer (phone or terminal) wins,
// closing the other copy; notifications reach the phone; /remote detach restores the terminal's
// dialogs and ends the phone's view; rpc mode refuses linking; /remote stop stops the host.
//
// Hermetic: temp HOME, agent dir and state dir, loopback only, a stub instead of pi, no model.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakePi, isolateKitEnv, loadExtension, setEnv } from "../packages/core/eval/harness.mjs";
import { PhoneClient, makeRemoteSandbox, readControl, waitUntil } from "./remote-test-harness.mjs";
import { REPO, baseEnv } from "./web-ui-test-harness.mjs";

const restoreKit = isolateKitEnv();
for (const key of Object.keys(process.env)) if (key.startsWith("PI_REMOTE_")) delete process.env[key];

const sandbox = makeRemoteSandbox("pi-remote-ext-");
const restore = [];
for (const [key, value] of Object.entries(
	baseEnv(sandbox, {
		PI_REMOTE_STATE_DIR: sandbox.stateDir,
		PI_REMOTE_BIND: "loopback",
		PI_REMOTE_PORT: "0",
		PI_REMOTE_NAME: "test-box",
		PI_KIT_WEBUI_ROOT: path.join(REPO, "packages", "web-ui"),
	}),
)) {
	restore.push(setEnv(key, value));
}

let checks = 0;
const ok = (label) => {
	checks++;
	console.log(`  ok ${checks} - ${label}`);
};

// ------------------------------------------------------------ scripted terminal ---
function makeTerminal(mode = "tui") {
	const dialogs = [];
	const notes = [];
	const widgets = new Map();
	const statuses = new Map();
	const open = (method, title, extra, opts, onAbort) =>
		new Promise((resolve) => {
			const entry = { method, title, ...extra, opts, resolve, aborted: false, settled: false };
			const settle = (value) => {
				if (entry.settled) return;
				entry.settled = true;
				resolve(value);
			};
			entry.answer = settle;
			dialogs.push(entry);
			const signal = opts?.signal;
			if (signal?.aborted) {
				entry.aborted = true;
				settle(onAbort);
			}
			signal?.addEventListener(
				"abort",
				() => {
					entry.aborted = true;
					settle(onAbort);
				},
				{ once: true },
			);
		});
	const ui = {
		select: (title, options, opts) => open("select", title, { options }, opts, undefined),
		confirm: (title, message, opts) => open("confirm", title, { message }, opts, false),
		input: (title, placeholder, opts) => open("input", title, { placeholder }, opts, undefined),
		notify: (message, level) => notes.push({ message, level }),
		setStatus: (key, value) => statuses.set(key, value),
		setWidget: (key, value) => widgets.set(key, value),
	};
	const originals = { select: ui.select, confirm: ui.confirm, input: ui.input, notify: ui.notify };
	return { ui, dialogs, notes, widgets, statuses, originals, mode };
}

const terminal = makeTerminal();
let idle = true;
let aborts = 0;
const branch = [
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "earlier question" }], timestamp: 10 } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "earlier answer" }], timestamp: 11 } },
	{ type: "model_change", provider: "x", modelId: "y" },
];
const models = [
	{ provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 200000, reasoning: true },
	{ provider: "local", id: "tiny", name: "Tiny", contextWindow: 8000, reasoning: false },
];
const ctx = {
	mode: "tui",
	hasUI: true,
	ui: terminal.ui,
	cwd: sandbox.cwd,
	sessionManager: {
		getSessionId: () => "ext-session-1",
		getSessionFile: () => null,
		getCwd: () => sandbox.cwd,
		getSessionName: () => "smoke session",
		getBranch: () => branch,
	},
	modelRegistry: {
		getAvailable: () => models,
		find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
	},
	model: models[0],
	isIdle: () => idle,
	abort: () => {
		aborts++;
	},
};

const fake = fakePi();
let thinking = "medium";
fake.api.getThinkingLevel = () => thinking;
fake.api.setThinkingLevel = (level) => {
	thinking = level;
};
fake.api.registerCommand("compact-notes", { handler: async () => {} });
const extension = await loadExtension("packages/extensions/src/remote-control/index.ts");
extension(fake.api);
const remote = fake.commands.get("remote");
const emit = (name, event) => fake.handlers.get(name)(event, ctx);

const nextDialog = (predicate, timeoutMs = 8000) => waitUntil(() => terminal.dialogs.find((d) => !d.settled && predicate(d)), timeoutMs, "a terminal dialog");

let phone;
let stream;
try {
	await emit("session_start", { type: "session_start", reason: "startup" });
	assert.equal(readControl(sandbox), null, "no host is started by session_start");
	ok("loading the extension and starting a session opens nothing");

	// ------------------------------------------------------------------- pairing ---
	const running = remote.handler("", ctx);
	const waiting = await nextDialog((d) => d.title.startsWith("Waiting for the phone"), 20_000);
	// pi cuts a string-array widget off at 10 lines (InteractiveMode.MAX_WIDGET_LINES) and the QR code alone
	// is 23+ rows, so the widget must be a component factory, rendered for the terminal's real size.
	const factory = terminal.widgets.get("remote-pair");
	assert.equal(typeof factory, "function", "the pairing widget is a component, not a string array pi would cut at 10 lines");
	const render = (columns, rows) => factory({ terminal: { columns, rows } }, undefined).render(columns);
	const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
	const qrCount = (lines) => lines.filter((line) => line.includes("\x1b[30;107m")).length;
	const wide = render(130, 60);
	assert.ok(qrCount(wide) >= 12, "a large terminal gets the half-block QR code");
	assert.ok(wide.length < 40 && qrCount(wide) > 0, "beside the details the whole panel is only as tall as the QR code");
	const stacked = render(70, 60);
	assert.ok(qrCount(stacked) >= 12 && stacked.length > wide.length, "a tall, narrow terminal gets the QR code above the details");
	const small = render(130, 24);
	assert.equal(qrCount(small), 0, "a terminal too short for the QR code gets the details alone, not a clipped QR code");
	assert.ok(small.some((line) => /needs a terminal of at least \d+ columns by \d+ rows/.test(line)), "and is told what size the QR code needs");
	assert.equal(qrCount(render(40, 60)), 0, "a terminal too narrow for the QR code gets the details alone");
	for (const [columns, rows] of [[130, 60], [70, 60], [130, 24], [40, 60], [20, 10]]) {
		for (const line of render(columns, rows)) assert.ok(plain(line).length <= columns, `no line is wider than the ${columns}-column terminal: ${plain(line)}`);
	}
	const lines = wide.map(plain);
	const codeLine = lines.find((line) => line.includes("Code  "));
	const code = /([0-9A-Z]{5}-[0-9A-Z]{5})/.exec(codeLine)[1];
	const control = readControl(sandbox);
	assert.ok(control && control.https.port > 0, "the host wrote control.json");
	const fingerprint = control.fingerprint;
	const fpLine = lines.find((line) => line.includes("Certificate"));
	const fpHex = Buffer.from(fingerprint, "base64url").toString("hex").toUpperCase();
	assert.equal(fpLine.slice(fpLine.indexOf("Certificate")).replace(/\s+/g, "").replace("Certificate", ""), fpHex.slice(0, 32), "the widget shows the pinned certificate's fingerprint");
	for (const small of [render(130, 24), render(40, 60)]) assert.ok(small.map(plain).some((line) => line.includes(code)), "the code is shown even without the QR code");
	ok("/remote starts the host and shows a QR code, the code and the certificate fingerprint, fitted to the terminal");

	phone = new PhoneClient({ port: control.https.port, fingerprint, name: "Smoke Phone" });
	const claim = await phone.pair(code);
	assert.equal(claim.status, 202, `claim accepted: ${claim.text}`);
	phone.deviceId = claim.json.deviceId;
	const approval = await nextDialog((d) => d.title.includes("Device ID"));
	assert.ok(waiting.aborted, "the waiting prompt closed when the request arrived");
	assert.ok(approval.title.includes(claim.json.deviceIdDisplay), "the approval prompt shows the phone's device ID");
	assert.ok(approval.title.includes("Smoke Phone"), "and its name");
	const early = await phone.login();
	assert.equal(early.status, 401, "the phone cannot log in before the terminal approves");
	approval.answer(approval.options.find((o) => o.startsWith("Approve")));
	await running;
	const login = await phone.login();
	assert.equal(login.status, 200, `login after approval: ${login.text}`);
	assert.ok(terminal.notes.some((n) => /linked "Smoke Phone"/.test(n.message)), "the terminal reports the link");
	assert.equal(terminal.widgets.get("remote-pair"), undefined, "the pairing widget is removed");
	assert.equal(terminal.statuses.get("remote"), "remote ●", "the status bar shows the session is shared");
	ok("the phone is linked only after the terminal approves the device ID");

	// --------------------------------------------------------- terminal session ---
	const list = await phone.request("GET", "/api/sessions");
	const mine = list.json.sessions.find((s) => s.id === "ext-session-1");
	assert.ok(mine, "the terminal session is listed");
	assert.equal(mine.status, "terminal");
	assert.equal(mine.name, "smoke session");
	assert.deepEqual(mine.model, { provider: "anthropic", id: "claude-test" });
	ok("the shared session is listed for the phone as a terminal session");

	stream = phone.stream("ext-session-1");
	assert.equal(await stream.ready, 200);
	await stream.waitFor((f) => f.event === "history_end");
	const observed = stream.frames.filter((f) => f.event === "observed").map((f) => f.data.data.message.content[0].text);
	assert.deepEqual(observed, ["earlier question", "earlier answer"], "history comes from the session branch");
	assert.equal(stream.frames[0].event, "lifecycle");
	assert.equal(stream.frames[0].data.state, "terminal");
	ok("opening it replays the branch history");

	const big = "x".repeat(50_000);
	await emit("agent_start", { type: "agent_start" });
	await emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
	const partial = { role: "assistant", content: [{ type: "text", text: `${big}Hi` }] };
	await emit("message_update", { type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi", partial } });
	const update = await stream.waitFor((f) => f.event === "event" && f.data.data.type === "message_update");
	assert.equal(update.data.data.assistantMessageEvent.delta, "Hi");
	assert.equal(update.data.data.message, undefined, "no message snapshot is forwarded");
	assert.equal(update.data.data.assistantMessageEvent.partial, undefined, "no partial snapshot is forwarded");
	await emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: big } });
	const toolStart = await stream.waitFor((f) => f.event === "event" && f.data.data.type === "tool_execution_start");
	assert.ok(toolStart.data.data.args.command.length < 3000, "long tool arguments are cut");
	ok("live events are forwarded slimmed");

	// A second viewer joining mid-stream gets the in-progress message and tool.
	const second = phone.stream("ext-session-1");
	await second.waitFor((f) => f.event === "history_end");
	const streaming = second.frames.find((f) => f.event === "streaming");
	assert.ok(streaming, "a streaming frame describes the work in progress");
	assert.ok(streaming.data.state.message.content[0].text.endsWith("Hi"), "with the partial answer");
	assert.equal(streaming.data.state.tools[0].toolCallId, "t1", "and the running tool");
	second.close();
	await emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false });
	await emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hi" }], timestamp: 12 } });
	await emit("agent_end", { type: "agent_end", messages: [partial, partial] });
	await emit("agent_settled", { type: "agent_settled" });
	const agentEnd = await stream.waitFor((f) => f.event === "event" && f.data.data.type === "agent_end");
	assert.equal(agentEnd.data.data.messages, undefined, "agent_end does not repeat the transcript");
	ok("a viewer joining mid-run sees the partial answer and running tools");

	// ------------------------------------------------------------- phone commands ---
	const prompt = await phone.request("POST", "/api/sessions/ext-session-1/prompt", { message: "hello from the phone" });
	assert.equal(prompt.status, 202, prompt.text);
	assert.equal(prompt.json.delivered, "now");
	await waitUntil(() => fake.steers.some((s) => s.message === "hello from the phone"), 3000, "the prompt to reach pi");
	assert.equal(fake.steers.find((s) => s.message === "hello from the phone").opts.expandPromptTemplates, true);
	idle = false;
	const steer = await phone.request("POST", "/api/sessions/ext-session-1/prompt", { message: "change course", streamingBehavior: "steer" });
	assert.equal(steer.json.delivered, "steer");
	assert.equal(fake.steers.find((s) => s.message === "change course").opts.deliverAs, "steer");
	const queued = await phone.request("POST", "/api/sessions/ext-session-1/prompt", { message: "then this" });
	assert.equal(queued.json.delivered, "followUp", "a prompt while busy is queued as a follow-up by default");
	idle = true;
	const remoteCmd = await phone.request("POST", "/api/sessions/ext-session-1/prompt", { message: "/remote stop" });
	assert.equal(remoteCmd.status, 403, "a phone cannot run /remote");
	const builtin = await phone.request("POST", "/api/sessions/ext-session-1/prompt", { message: "/quit" });
	assert.equal(builtin.status, 400, "terminal-only commands are refused, not sent to the model");
	const known = await phone.request("POST", "/api/sessions/ext-session-1/prompt", { message: "/compact-notes now" });
	assert.equal(known.status, 202, "a registered extension command is allowed");
	const pathLike = await phone.request("POST", "/api/sessions/ext-session-1/prompt", { message: "/etc/hosts looks wrong" });
	assert.equal(pathLike.status, 202, "text that merely starts with a path is a normal prompt");
	ok("phone prompts reach pi (now, steer, follow-up); /remote and terminal-only commands are refused");

	const abort = await phone.request("POST", "/api/sessions/ext-session-1/abort", {});
	assert.equal(abort.status, 202);
	assert.equal(aborts, 1);
	const modelList = await phone.request("GET", "/api/sessions/ext-session-1/models");
	assert.deepEqual(
		modelList.json.providers.map((p) => p.name),
		["anthropic", "local"],
	);
	const setModel = await phone.request("POST", "/api/sessions/ext-session-1/model", { provider: "local", modelId: "tiny" });
	assert.equal(setModel.status, 200, setModel.text);
	assert.equal(fake.modelSelections.at(-1).id, "tiny");
	const badModel = await phone.request("POST", "/api/sessions/ext-session-1/model", { provider: "local", modelId: "nope" });
	assert.equal(badModel.status, 404);
	const setThinking = await phone.request("POST", "/api/sessions/ext-session-1/thinking", { level: "high" });
	assert.equal(setThinking.status, 200);
	assert.equal(thinking, "high");
	await stream.waitFor((f) => f.event === "meta" && f.data.session.thinking === "high");
	ok("abort, model list, model and thinking changes work from the phone");

	// ------------------------------------------------------------ dialog mirror ---
	assert.notEqual(ctx.ui.select, terminal.originals.select, "dialogs are mirrored while shared");
	const firewall = ctx.ui.select("Allow bash: rm -rf build?", ["Allow once", "Deny"], { timeout: 60_000 });
	const request = await stream.waitFor((f) => f.event === "ui_request" && f.data.dialog.title.startsWith("Allow bash"));
	const tuiCopy = terminal.dialogs.find((d) => d.title === "Allow bash: rm -rf build?");
	assert.ok(tuiCopy && !tuiCopy.settled, "the terminal shows the dialog too");
	const invalid = await phone.request("POST", "/api/sessions/ext-session-1/ui-response", { dialogId: request.data.dialog.id, value: "Allow everything forever" });
	assert.equal(invalid.status, 400, "an answer that is not one of the options is refused");
	const answered = await phone.request("POST", "/api/sessions/ext-session-1/ui-response", { dialogId: request.data.dialog.id, value: "Deny" });
	assert.equal(answered.status, 200, answered.text);
	assert.equal(await firewall, "Deny", "the phone's answer is returned to the extension that asked");
	assert.ok(tuiCopy.aborted, "and the terminal's copy is closed");
	await stream.waitFor((f) => f.event === "ui_resolved" && f.data.id === request.data.dialog.id && f.data.by === "phone");
	ok("a phone answers a dialog another extension opened; the terminal's copy closes");

	const confirm = ctx.ui.confirm("Proceed?", "Deploy to staging");
	const confirmRequest = await stream.waitFor((f) => f.event === "ui_request" && f.data.dialog.method === "confirm");
	assert.equal(confirmRequest.data.dialog.message, "Deploy to staging");
	const confirmCopy = await nextDialog((d) => d.title === "Proceed?");
	confirmCopy.answer(true);
	assert.equal(await confirm, true);
	await stream.waitFor((f) => f.event === "ui_resolved" && f.data.id === confirmRequest.data.dialog.id && f.data.by === "terminal");
	const late = await phone.request("POST", "/api/sessions/ext-session-1/ui-response", { dialogId: confirmRequest.data.dialog.id, confirmed: false });
	assert.equal(late.status, 404, "a dialog answered at the terminal can no longer be answered");
	ok("an answer at the terminal wins and closes the phone's copy");

	ctx.ui.notify("Firewall policy reloaded", "warning");
	const note = await stream.waitFor((f) => f.event === "notify" && f.data.message === "Firewall policy reloaded");
	assert.equal(note.data.level, "warning");
	assert.ok(terminal.notes.some((n) => n.message === "Firewall policy reloaded"), "the terminal still shows it");
	ok("notifications reach the phone as well as the terminal");

	// ------------------------------------------------------------------ detach ---
	await remote.handler("detach", ctx);
	await stream.waitFor((f) => f.event === "lifecycle" && f.data.state === "detached");
	assert.equal(ctx.ui.select, terminal.originals.select, "detach restores the terminal's own dialogs");
	assert.equal(ctx.ui.notify, terminal.originals.notify);
	assert.equal(terminal.statuses.get("remote"), undefined);
	const after = await phone.request("GET", "/api/sessions");
	assert.ok(!after.json.sessions.some((s) => s.id === "ext-session-1" && s.status === "terminal"), "the session is no longer shared");
	await remote.handler("status", ctx);
	assert.ok(terminal.notes.at(-1).message.includes("is not shared"), "status says this session is not shared");
	assert.ok(terminal.notes.at(-1).message.includes("Smoke Phone"), "status lists the linked phone");
	ok("/remote detach ends the phone's view and restores the terminal's dialogs");

	// ------------------------------------------------------------- rpc refusal ---
	const rpcTerminal = makeTerminal("rpc");
	const rpcCtx = { ...ctx, mode: "rpc", ui: rpcTerminal.ui };
	await remote.handler("pair", rpcCtx);
	assert.match(rpcTerminal.notes.at(-1).message, /only works in an interactive pi terminal/);
	assert.equal(rpcTerminal.dialogs.length, 0, "no pairing prompt in rpc mode");
	await remote.handler("devices", rpcCtx);
	assert.ok(rpcTerminal.notes.at(-1).message.includes("Smoke Phone"), "read-only views still work");
	ok("rpc mode (a session a phone may be driving) cannot link phones or share sessions");

	// ------------------------------------------------------------------- stop ---
	await remote.handler("stop", ctx);
	await waitUntil(() => !fs.existsSync(path.join(sandbox.stateDir, "control.json")), 8000, "the host to stop");
	assert.match(terminal.notes.at(-1).message, /host stopped/);
	ok("/remote stop stops the host");

	await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	console.log(`remote-control extension smoke: OK (${checks} checks)`);
} catch (error) {
	console.error("remote-control extension smoke: FAILED");
	console.error(error);
	try {
		console.error(fs.readFileSync(path.join(sandbox.stateDir, "host.log"), "utf8").slice(-3000));
	} catch {
		/* no log */
	}
	process.exitCode = 1;
} finally {
	stream?.close();
	const control = readControl(sandbox);
	if (control?.pid) {
		try {
			process.kill(control.pid, "SIGTERM");
		} catch {
			/* already gone */
		}
	}
	for (const undo of restore.reverse()) undo();
	restoreKit();
	sandbox.cleanup();
}
