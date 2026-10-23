// mock-native.js — a stand-in for the Android app, for working on the mobile UI in a desktop
// browser (open mobile/index.html?mock from any static server). Development only: the app does
// not package this directory. Everything here is fake: one computer, a few sessions, a streamed
// answer to any prompt, and an approval dialog when a prompt contains "approve".
import type { NativeChannel, NativeMessageHandler } from "../js/native.ts";

type Params = Record<string, unknown>;

interface MockSession {
	id: string;
	name?: string;
	cwd: string;
	status: string;
	busy?: boolean;
	pendingDialogs?: number;
	model?: { provider: string; id: string };
	thinking?: string;
	preview?: string;
	lastActivityAt: string;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Params {
	return typeof value === "object" && value !== null;
}

/** The page sends strings; anything else reads as "" here, as the app's optString would. */
const str = (value: unknown): string => (typeof value === "string" ? value : "");

export function createMockChannel(): NativeChannel {
	const listeners = new Set<NativeMessageHandler>();
	const emit = (msg: unknown): void => {
		const data = JSON.stringify(msg);
		for (const fn of listeners) setTimeout(() => fn({ data }), 0);
	};
	const hosts = [
		{
			id: "h1",
			name: "workstation",
			addresses: ["198.51.100.20", "100.101.102.103"],
			port: 8765,
			fingerprintDisplay: "1A2B 3C4D 5E6F 7081 92A3 B4C5 D6E7 F809",
			deviceIdDisplay: "8CVZ-VXMM-P4Q6-CV71",
			pairedAt: new Date(Date.now() - 86400000).toISOString(),
			lastUsedAt: new Date().toISOString(),
		},
	];
	const now = Date.now();
	const sessions: MockSession[] = [
		{ id: "term-1", name: "refactor auth middleware", cwd: "/work/src/api", status: "terminal", busy: true, pendingDialogs: 0, model: { provider: "anthropic", id: "claude-opus-5-5" }, thinking: "high", lastActivityAt: new Date(now - 20000).toISOString() },
		{ id: "run-1", cwd: "/work/src/site", status: "running", busy: false, pendingDialogs: 1, preview: "Update the blog index page", lastActivityAt: new Date(now - 300000).toISOString() },
		{ id: "ext-1", cwd: "/work/src/infra", status: "external", preview: "Plan the backup rotation", lastActivityAt: new Date(now - 600000).toISOString() },
		...Array.from({ length: 6 }, (_, i) => ({ id: `old-${i}`, cwd: `/work/src/project-${i}`, status: "idle", preview: `Earlier work item ${i + 1}`, lastActivityAt: new Date(now - (i + 2) * 3600000).toISOString() })),
	];
	const streams = new Map<string, string>();
	let nextStream = 1;
	const first = (): (typeof hosts)[number] => {
		const host = hosts[0];
		if (!host) throw new Error("mock: no computer linked");
		return host;
	};

	const frame = (streamId: string, name: string, payload: unknown): void => emit({ event: "stream.frame", streamId, name, data: JSON.stringify(payload) });

	async function answer(streamId: string, sessionId: string, text: string): Promise<void> {
		const send = (data: unknown): void => frame(streamId, "event", { sessionId, type: "event", data });
		send({ type: "agent_start" });
		send({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
		send({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
		if (/approve/i.test(text)) {
			await wait(400);
			frame(streamId, "ui_request", {
				dialog: {
					id: `d${Date.now()}`,
					method: "select",
					title: "tool-firewall: bash wants to run\n\n  rm -rf ./build && npm run build\n\nrisk: medium (deletes files inside the workspace)",
					options: ["Allow once", "Allow for this session", "Deny", "Deny and tell the agent why"],
					timeout: 120000,
					openedAt: new Date().toISOString(),
				},
			});
			return;
		}
		send({ type: "message_start", message: { role: "assistant", content: [] } });
		const reply = "Sure. I looked at `src/auth.ts` and here is the plan:\n\n1. Move the token check into **one middleware**.\n2. Add tests for expired tokens.\n\n```ts\nexport function requireAuth(req, res, next) {\n  if (!req.user) return res.status(401).end();\n  next();\n}\n```\n";
		for (const piece of reply.match(/.{1,12}/gs) ?? []) {
			await wait(40);
			send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: piece } });
		}
		send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
		send({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test -- auth" } });
		await wait(600);
		send({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "PASS src/auth.test.ts\n  ✓ rejects expired tokens (12 ms)\n  ✓ accepts fresh tokens (3 ms)" }] } });
		send({ type: "agent_end" });
	}

	const routes: Record<string, ((params: Params) => unknown) | undefined> = {
		"app.info": () => ({ version: "dev", keyStorage: "mock", lockEnabled: false, secureScreen: false }),
		"app.setLock": ({ enabled }) => ({ lockEnabled: enabled }),
		"app.setSecureScreen": ({ enabled }) => ({ secureScreen: enabled }),
		"app.haptic": () => ({}),
		"app.openUrl": () => ({}),
		"hosts.list": () => ({ hosts }),
		"hosts.probe": async () => (await wait(300), { reachable: true, address: first().addresses[0], latencyMs: 12 }),
		"hosts.rename": ({ name }) => ((first().name = str(name)), {}),
		"hosts.remove": () => (hosts.splice(0, 1), {}),
		"pair.scan": () => ({ link: "pirc://pair?h=198.51.100.20%2C100.101.102.103&p=8765&f=abc&c=ABCDEFGHJK&n=workstation" }),
		"pair.probe": () => ({ fingerprint: "abc", fingerprintDisplay: "1A2B 3C4D 5E6F 7081 92A3 B4C5 D6E7 F809", name: "workstation" }),
		"pair.begin": async () => (await wait(500), { pairingId: "p1", deviceIdDisplay: "8CVZ-VXMM-P4Q6-CV71", hostName: "workstation" }),
		"pair.wait": async () => (await wait(2500), { state: "approved", host: hosts[0] }),
		"pair.cancel": () => ({}),
		"api.closeStream": ({ streamId }) => (streams.delete(str(streamId)), {}),
		"api.stream": ({ path }) => {
			const streamId = `s${String(nextStream++)}`;
			const sessionId = decodeURIComponent(String(str(path).split("/")[3]));
			const session = sessions.find((s) => s.id === sessionId) ?? sessions[0];
			if (!session) throw new Error("mock: no sessions");
			streams.set(streamId, sessionId);
			setTimeout(() => {
				frame(streamId, "lifecycle", { state: session.status === "external" ? "watching" : session.status, session });
				const history = [
					{ role: "user", content: [{ type: "text", text: "Why do the auth tests fail on CI only?" }] },
					{ role: "assistant", content: [{ type: "thinking", thinking: "CI runs with TZ=UTC..." }, { type: "text", text: "CI runs in **UTC** and the fixture tokens expire at local midnight." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "test/fixtures/tokens.json" } }] },
					{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: '{ "exp": 1760313600 }' }] },
					{ role: "assistant", content: [{ type: "text", text: "Fixed: the fixtures now use a relative expiry." }] },
				];
				for (const message of history) frame(streamId, "observed", { data: { type: "observed_message", message } });
				frame(streamId, "history_end", {});
				if (session.pendingDialogs) {
					frame(streamId, "ui_request", { dialog: { id: "d0", method: "confirm", title: "Approve tool call?", message: "write: public/index.html (12 lines changed)", timeout: 300000, openedAt: new Date().toISOString() } });
				}
			}, 150);
			return { streamId };
		},
		"api.request": async ({ method, path: rawPath, body: rawBody }) => {
			await wait(120);
			const path = str(rawPath);
			const body = isRecord(rawBody) ? rawBody : {};
			const parts = (path.split("?")[0] ?? "").split("/").filter(Boolean);
			if (path === "/api/sessions" && method === "GET") return { status: 200, json: { sessions } };
			if (path === "/api/sessions" && method === "POST") {
				const s: MockSession = { id: `new-${String(Date.now())}`, cwd: str(body.cwd) || "/work", status: "running", lastActivityAt: new Date().toISOString() };
				sessions.unshift(s);
				return { status: 201, json: { session: s } };
			}
			if (path === "/api/cwds") return { status: 200, json: { cwds: ["/work", "/work/src/api", "/work/src/site"] } };
			if (path === "/api/models" || parts[3] === "models") return { status: 200, json: { providers: [{ name: "anthropic", models: [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" }] }, { name: "ollama", models: [{ id: "qwen3:32b" }] }] } };
			if (path === "/api/agents") return { status: 200, json: { agents: [{ name: "reviewer", description: "Reviews diffs", source: "user" }] } };
			if (parts[3] === "stats") return { status: 200, json: { stats: { live: true, model: "claude-opus-5-5", provider: "anthropic", userMessages: 4, assistantMessages: 5, toolCalls: 7, totalMessages: 16, tokens: { input: 48200, output: 6100, total: 54300 }, cost: 0.42, contextUsage: { tokens: 54300, contextWindow: 200000, percent: 27 } } } };
			if (parts[3] === "todos") return { status: 200, json: { exists: true, todos: [{ state: "done", text: "Reproduce on CI" }, { state: "active", text: "Fix fixtures" }, { state: "todo", text: "Add regression test" }] } };
			if (parts[3] === "prompt") {
				const streamId = [...streams.entries()].find(([, id]) => id === parts[2])?.[0];
				if (streamId) void answer(streamId, String(parts[2]), str(body.message));
				return { status: 202, json: { queued: true } };
			}
			if (parts[3] === "ui-response") {
				const streamId = [...streams.entries()].find(([, id]) => id === parts[2])?.[0];
				if (streamId) setTimeout(() => frame(streamId, "ui_resolved", { id: body.dialogId, by: "phone" }), 200);
				return { status: 200, json: { answered: true } };
			}
			return { status: 200, json: {} };
		},
	};

	return {
		postMessage(raw) {
			const parsed: unknown = JSON.parse(raw);
			const { id, method, params } = isRecord(parsed) ? parsed : {};
			Promise.resolve()
				.then(() => {
					const route = routes[str(method)];
					if (!route) throw new Error(`mock: no ${String(method)}`);
					return route(isRecord(params) ? params : {});
				})
				.then(
					(result: unknown) => { emit({ id, ok: true, result }); },
					(error: unknown) => { emit({ id, ok: false, error: { message: error instanceof Error ? error.message : String(error) } }); },
				);
		},
		addEventListener(type, fn) {
			if (type === "message") listeners.add(fn);
		},
	};
}
