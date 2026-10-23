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
import { stripVTControlCharacters } from "node:util";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fakePi, isolateKitEnv, loadExtension, loadModule, setEnv } from "../packages/core/eval/harness.ts";
import type * as RemoteHost from "../packages/extensions/src/remote-control/host.ts";
import { PhoneClient, makeRemoteSandbox, readControl, waitUntil, type PhoneResponse, type PhoneStream } from "./remote-test-harness.ts";
import { REPO, baseEnv } from "./web-ui-test-harness.ts";

// ---------------------------------------------------------------- types ---
interface DialogOptions {
	signal?: AbortSignal;
	timeout?: number;
}
/** A dialog the scripted terminal is showing (or showed). */
interface TerminalDialog {
	method: string;
	title: string;
	options?: string[];
	message?: string;
	placeholder?: string;
	opts: DialogOptions | undefined;
	resolve: (value: unknown) => void;
	aborted: boolean;
	settled: boolean;
	/** Answer it as the person at the terminal would. */
	answer: (value: unknown) => void;
}
interface Note {
	message: string;
	level: string | undefined;
}
interface Terminal {
	ui: {
		select: (title: string, options: string[], opts?: DialogOptions) => Promise<unknown>;
		confirm: (title: string, message: string, opts?: DialogOptions) => Promise<unknown>;
		input: (title: string, placeholder?: string, opts?: DialogOptions) => Promise<unknown>;
		notify: (message: string, level?: string) => number;
		setStatus(key: string, value: unknown): Map<string, unknown>;
		setWidget(key: string, value: unknown): Map<string, unknown>;
	};
	dialogs: TerminalDialog[];
	notes: Note[];
	widgets: Map<string, unknown>;
	statuses: Map<string, unknown>;
	originals: Pick<Terminal["ui"], "select" | "confirm" | "input" | "notify">;
	mode: string;
}
/** What the extension passes to setWidget for the pairing panel. */
type WidgetFactory = (tui: { terminal: { columns: number; rows: number } }, theme: undefined) => { render(width: number): string[] };

interface SessionList {
	sessions: Array<{ id: string; status: string; name?: string; model?: { provider: string; id: string } }>;
}
interface StreamingState {
	message: { content: Array<{ text: string }> };
	tools: Array<{ toolCallId: string }>;
}
/** One event-stream frame's data; each frame kind carries only the fields that belong to it. */
interface FrameData {
	/** A lifecycle frame's state name, or a streaming frame's work in progress. */
	state: string | StreamingState;
	id: string;
	by: string;
	message: string;
	level: string;
	session: { thinking: string };
	dialog: { id: string; method: string; title: string; message: string };
	data: {
		type: string;
		message: { content: Array<{ text: string }> };
		assistantMessageEvent: { delta: string; partial: unknown };
		args: { command: string };
		messages: unknown;
	};
}

/** A reply's parsed JSON body; a reply that is not JSON fails the run. */
function jsonOf<T>(res: PhoneResponse<T>): T {
	if (res.json === null) throw new Error(`not a JSON reply: ${res.status} ${res.text}`);
	return res.json;
}
/** A value the run cannot continue without. */
function present<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new Error(`missing ${what}`);
	return value;
}
const lastNote = (t: Terminal): string => present(t.notes.at(-1), "terminal notification").message;

const restoreKit = isolateKitEnv();
for (const key of Object.keys(process.env)) if (key.startsWith("PI_REMOTE_")) Reflect.deleteProperty(process.env, key);

const sandbox = makeRemoteSandbox("pi-remote-ext-");
const restore: Array<() => void> = [];
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
const ok = (label: string): void => {
	checks++;
	console.log(`  ok ${checks} - ${label}`);
};

// ------------------------------------------------------------ scripted terminal ---
function makeTerminal(mode = "tui"): Terminal {
	const dialogs: TerminalDialog[] = [];
	const notes: Note[] = [];
	const widgets = new Map<string, unknown>();
	const statuses = new Map<string, unknown>();
	const open = (
		method: string,
		title: string,
		extra: { options?: string[]; message?: string; placeholder?: string },
		opts: DialogOptions | undefined,
		onAbort: unknown,
	): Promise<unknown> =>
		new Promise((resolve) => {
			// settle is declared first so the entry can carry it as `answer` from the start.
			const settle = (value: unknown): void => {
				if (entry.settled) return;
				entry.settled = true;
				resolve(value);
			};
			const entry: TerminalDialog = { method, title, ...extra, opts, resolve, aborted: false, settled: false, answer: settle };
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
	const ui: Terminal["ui"] = {
		select: (title, options, opts) => open("select", title, { options }, opts, undefined),
		confirm: (title, message, opts) => open("confirm", title, { message }, opts, false),
		input: (title, placeholder, opts) => open("input", title, placeholder === undefined ? {} : { placeholder }, opts, undefined),
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
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
	},
	model: models[0],
	isIdle: () => idle,
	abort: () => {
		aborts++;
	},
};

const fake = fakePi();
let thinking = "medium";
// fakePi() has no thinking-level API; add one the extension can read and change.
Object.assign(fake.api, {
	getThinkingLevel: () => thinking,
	setThinkingLevel: (level: string) => {
		thinking = level;
	},
});
fake.api.registerCommand("compact-notes", { handler: async () => {} });
// pi's name for a second extension's "remote" command (the first becomes "remote:1").
fake.api.registerCommand("remote:2", { handler: async () => {} });
const extension = await loadExtension("packages/extensions/src/remote-control/index.ts");
extension(fake.api);
const remote = fake.commands.get("remote");
const emit = async (name: string, event: object): Promise<unknown> => fake.handlers.get(name)(event, ctx);

const nextDialog = (predicate: (d: TerminalDialog) => boolean, timeoutMs = 8000): Promise<TerminalDialog> => waitUntil(() => terminal.dialogs.find((d) => !d.settled && predicate(d)), timeoutMs, "a terminal dialog");

let phone: PhoneClient;
let stream: PhoneStream<FrameData> | undefined;
try {
	await emit("session_start", { type: "session_start", reason: "startup" });
	assert.equal(readControl(sandbox), null, "no host is started by session_start");
	ok("loading the extension and starting a session opens nothing");

	// ------------------------------------------------------------------- pairing ---
	const running = remote.handler("", ctx);
	const waiting = await nextDialog((d) => d.title.startsWith("Waiting for the phone"), 20_000);
	// pi cuts a string-array widget off at 10 lines (InteractiveMode.MAX_WIDGET_LINES) and the QR code alone
	// is 23+ rows, so the widget must be a component factory, rendered for the terminal's real size.
	const factory = terminal.widgets.get("remote-pair") as WidgetFactory;
	assert.equal(typeof factory, "function", "the pairing widget is a component, not a string array pi would cut at 10 lines");
	const render = (columns: number, rows: number): string[] => factory({ terminal: { columns, rows } }, undefined).render(columns);
	const plain = (line: string): string => stripVTControlCharacters(line);
	const qrCount = (lines: string[]): number => lines.filter((line) => line.includes("\x1b[30;107m")).length;
	const wide = render(130, 60);
	assert.ok(qrCount(wide) >= 12, "a large terminal gets the half-block QR code");
	assert.ok(wide.length < 40 && qrCount(wide) > 0, "beside the details the whole panel is only as tall as the QR code");
	const stacked = render(70, 60);
	assert.ok(qrCount(stacked) >= 12 && stacked.length > wide.length, "a tall, narrow terminal gets the QR code above the details");
	const small = render(130, 24);
	assert.equal(qrCount(small), 0, "a terminal too short for the QR code gets the details alone, not a clipped QR code");
	assert.ok(small.some((line) => /needs a terminal of at least \d+ columns by \d+ rows/.test(line)), "and is told what size the QR code needs");
	assert.equal(qrCount(render(40, 60)), 0, "a terminal too narrow for the QR code gets the details alone");
	for (const [columns, rows] of [[130, 60], [70, 60], [130, 24], [40, 60], [20, 10]] satisfies Array<[number, number]>) {
		for (const line of render(columns, rows)) assert.ok(plain(line).length <= columns, `no line is wider than the ${columns}-column terminal: ${plain(line)}`);
	}
	const lines = wide.map(plain);
	const codeLine = lines.find((line) => line.includes("Code  "));
	const code = present(present(/([0-9A-Z]{5}-[0-9A-Z]{5})/.exec(present(codeLine, "the code line")), "the pairing code")[1], "the pairing code");
	const control = readControl(sandbox);
	assert.ok(control && control.https.port > 0, "the host wrote control.json");
	const fingerprint = control.fingerprint;
	const fpLine = present(lines.find((line) => line.includes("Certificate")), "the certificate line");
	const fpHex = Buffer.from(fingerprint, "base64url").toString("hex").toUpperCase();
	assert.equal(fpLine.slice(fpLine.indexOf("Certificate")).replace(/\s+/g, "").replace("Certificate", ""), fpHex.slice(0, 32), "the widget shows the pinned certificate's fingerprint");
	for (const small of [render(130, 24), render(40, 60)]) assert.ok(small.map(plain).some((line) => line.includes(code)), "the code is shown even without the QR code");
	ok("/remote starts the host and shows a QR code, the code and the certificate fingerprint, fitted to the terminal");

	phone = new PhoneClient({ port: control.https.port, fingerprint, name: "Smoke Phone" });
	const claim = await phone.pair<{ deviceId: string; deviceIdDisplay: string }>(code);
	assert.equal(claim.status, 202, `claim accepted: ${claim.text}`);
	phone.deviceId = jsonOf(claim).deviceId;
	const approval = await nextDialog((d) => d.title.includes("Device ID"));
	assert.ok(waiting.aborted, "the waiting prompt closed when the request arrived");
	assert.ok(approval.title.includes(jsonOf(claim).deviceIdDisplay), "the approval prompt shows the phone's device ID");
	assert.ok(approval.title.includes("Smoke Phone"), "and its name");
	const early = await phone.login();
	assert.equal(early.status, 401, "the phone cannot log in before the terminal approves");
	approval.answer(present(approval.options, "approval options").find((o) => o.startsWith("Approve")));
	await running;
	const login = await phone.login();
	assert.equal(login.status, 200, `login after approval: ${login.text}`);
	assert.ok(terminal.notes.some((n) => /linked "Smoke Phone"/.test(n.message)), "the terminal reports the link");
	assert.equal(terminal.widgets.get("remote-pair"), undefined, "the pairing widget is removed");
	assert.equal(terminal.statuses.get("remote"), "remote ●", "the status bar shows the session is shared");
	ok("the phone is linked only after the terminal approves the device ID");

	// --------------------------------------------------------- terminal session ---
	const list = await phone.request<SessionList>("GET", "/api/sessions");
	const mine = jsonOf(list).sessions.find((s) => s.id === "ext-session-1");
	assert.ok(mine, "the terminal session is listed");
	assert.equal(mine.status, "terminal");
	assert.equal(mine.name, "smoke session");
	assert.deepEqual(mine.model, { provider: "anthropic", id: "claude-test" });
	ok("the shared session is listed for the phone as a terminal session");

	stream = phone.stream<FrameData>("ext-session-1");
	assert.equal(await stream.ready, 200);
	await stream.waitFor((f) => f.event === "history_end");
	const observed = stream.frames.filter((f) => f.event === "observed").map((f) => present(f.data.data.message.content[0], "the message's first part").text);
	assert.deepEqual(observed, ["earlier question", "earlier answer"], "history comes from the session branch");
	const firstFrame = present(stream.frames[0], "the first frame");
	assert.equal(firstFrame.event, "lifecycle");
	assert.equal(firstFrame.data.state, "terminal");
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
	const second = phone.stream<FrameData>("ext-session-1");
	await second.waitFor((f) => f.event === "history_end");
	const streaming = second.frames.find((f) => f.event === "streaming");
	assert.ok(streaming, "a streaming frame describes the work in progress");
	assert.ok(present((streaming.data.state as StreamingState).message.content[0], "the partial answer").text.endsWith("Hi"), "with the partial answer");
	assert.equal(present((streaming.data.state as StreamingState).tools[0], "the running tool").toolCallId, "t1", "and the running tool");
	second.close();
	await emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false });
	await emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hi" }], timestamp: 12 } });
	await emit("agent_end", { type: "agent_end", messages: [partial, partial] });
	await emit("agent_settled", { type: "agent_settled" });
	const agentEnd = await stream.waitFor((f) => f.event === "event" && f.data.data.type === "agent_end");
	assert.equal(agentEnd.data.data.messages, undefined, "agent_end does not repeat the transcript");
	ok("a viewer joining mid-run sees the partial answer and running tools");

	// ------------------------------------------------------------- phone commands ---
	const prompt = await phone.request<{ delivered: string }>("POST", "/api/sessions/ext-session-1/prompt", { message: "hello from the phone" });
	assert.equal(prompt.status, 202, prompt.text);
	assert.equal(jsonOf(prompt).delivered, "now");
	await waitUntil(() => fake.steers.some((s) => s.message === "hello from the phone"), 3000, "the prompt to reach pi");
	assert.equal(fake.steers.find((s) => s.message === "hello from the phone")?.opts?.expandPromptTemplates, true);
	idle = false;
	const steer = await phone.request<{ delivered: string }>("POST", "/api/sessions/ext-session-1/prompt", { message: "change course", streamingBehavior: "steer" });
	assert.equal(jsonOf(steer).delivered, "steer");
	assert.equal(fake.steers.find((s) => s.message === "change course")?.opts?.deliverAs, "steer");
	const queued = await phone.request<{ delivered: string }>("POST", "/api/sessions/ext-session-1/prompt", { message: "then this" });
	assert.equal(jsonOf(queued).delivered, "followUp", "a prompt while busy is queued as a follow-up by default");
	idle = true;
	const remoteCmd = await phone.request("POST", "/api/sessions/ext-session-1/prompt", { message: "/remote stop" });
	assert.equal(remoteCmd.status, 403, "a phone cannot run /remote");
	const remoteDup = await phone.request("POST", "/api/sessions/ext-session-1/prompt", { message: "/remote:2 stop" });
	assert.equal(remoteDup.status, 403, "nor /remote under the name pi gives a duplicate registration");
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
	const modelList = await phone.request<{ providers: Array<{ name: string }> }>("GET", "/api/sessions/ext-session-1/models");
	assert.deepEqual(
		jsonOf(modelList).providers.map((p) => p.name),
		["anthropic", "local"],
	);
	const setModel = await phone.request("POST", "/api/sessions/ext-session-1/model", { provider: "local", modelId: "tiny" });
	assert.equal(setModel.status, 200, setModel.text);
	assert.equal(fake.modelSelections.at(-1)?.id, "tiny");
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
	const stillOpen = ctx.ui.confirm("Keep going?", "Asked just before sharing stops");
	await stream.waitFor((f) => f.event === "ui_request" && f.data.dialog.title === "Keep going?");
	await remote.handler("detach", ctx);
	await stream.waitFor((f) => f.event === "lifecycle" && f.data.state === "detached");
	assert.equal(await stillOpen, false, "a confirm still open when sharing stops reads false, as a dismissed one does");
	assert.equal(ctx.ui.select, terminal.originals.select, "detach restores the terminal's own dialogs");
	assert.equal(ctx.ui.notify, terminal.originals.notify);
	assert.equal(terminal.statuses.get("remote"), undefined);
	const after = await phone.request<SessionList>("GET", "/api/sessions");
	assert.ok(!jsonOf(after).sessions.some((s) => s.id === "ext-session-1" && s.status === "terminal"), "the session is no longer shared");
	await remote.handler("status", ctx);
	assert.ok(lastNote(terminal).includes("is not shared"), "status says this session is not shared");
	assert.ok(lastNote(terminal).includes("Smoke Phone"), "status lists the linked phone");
	ok("/remote detach ends the phone's view and restores the terminal's dialogs");

	// ------------------------------------------------------------- rpc refusal ---
	const rpcTerminal = makeTerminal("rpc");
	const rpcCtx = { ...ctx, mode: "rpc", ui: rpcTerminal.ui };
	await remote.handler("pair", rpcCtx);
	assert.match(lastNote(rpcTerminal), /only works in an interactive pi terminal/);
	assert.equal(rpcTerminal.dialogs.length, 0, "no pairing prompt in rpc mode");
	await remote.handler("devices", rpcCtx);
	assert.ok(lastNote(rpcTerminal).includes("Smoke Phone"), "read-only views still work");
	ok("rpc mode (a session a phone may be driving) cannot link phones or share sessions");

	// ------------------------------------------------------------------- stop ---
	await remote.handler("stop", ctx);
	await waitUntil(() => !fs.existsSync(path.join(sandbox.stateDir, "control.json")), 8000, "the host to stop");
	assert.match(lastNote(terminal), /host stopped/);
	ok("/remote stop stops the host");

	// ------------------------------------------------------- malformed records ---
	// A control record that is not a JSON object must be ignored (or, in place of the hello, refused):
	// a throw inside the socket's data listener is an uncaught exception, and pi exits on those.
	{
		const { ControlLink } = await loadModule<typeof RemoteHost>("packages/extensions/src/remote-control/host.ts");
		const replies = ['{"t":"hello","ok":true}\nnull\n7\n', "null\n"];
		const fakeHost = net.createServer((socket) => socket.end(replies.shift() ?? ""));
		await new Promise<void>((resolve) => fakeHost.listen(0, "127.0.0.1", resolve));
		const address = fakeHost.address();
		assert.ok(address && typeof address === "object");
		const controlFile = path.join(sandbox.stateDir, "control.json");
		fs.writeFileSync(controlFile, JSON.stringify({ port: address.port, secret: "fake-host" }));
		const thrown: unknown[] = [];
		const onUncaught = (error: unknown): void => {
			thrown.push(error);
		};
		process.on("uncaughtException", onUncaught);
		try {
			const link = await ControlLink.open("admin");
			await waitUntil(() => link.closed, 3000, "the fake host to hang up");
			assert.deepEqual(thrown, [], "null and 7 after the hello are ignored");
			await assert.rejects(ControlLink.open("admin"), { code: "refused" }, "null in place of the hello is a refusal");
			assert.deepEqual(thrown, [], "and is not thrown either");
		} finally {
			process.off("uncaughtException", onUncaught);
			fakeHost.close();
			fs.rmSync(controlFile, { force: true });
		}
		ok("a control record that is not a JSON object is ignored, not thrown");
	}

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
