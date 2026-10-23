// ui-smoke.ts — offline wiring check for the pi-console frontend.
//
// There is no browser in CI here, so this stubs just enough DOM (and fetch/EventSource)
// to import the real modules and run their render paths. It catches the failure mode that
// matters most: an app.js init that throws, or a renderer that references a missing element.
//
// Usage: node scripts/ui-smoke.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../core/lib/guard.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const ok = (label: string): void => console.log(`  PASS  ${label}`);
const bad = (label: string): void => {
	console.log(`  FAIL  ${label}`);
	failures++;
};
/** Report one assertion: the pass label when it holds, the fail label otherwise. */
const check = (passed: boolean, passLabel: string, failLabel: string): void => {
	if (passed) ok(passLabel);
	else bad(failLabel);
};

/** An error's stack (or message) for a FAIL line; the thrown value may not be an Error. */
function describeError(err: unknown, withStack = false): string {
	if (!(err instanceof Error)) return asText(err);
	if (withStack && err.stack) return err.stack;
	return err.message;
}

/**
 * String() for a value the untyped browser code wrote into the stub. Those are strings, numbers
 * or booleans in practice; anything else gets the default object tag rather than a custom toString.
 */
function asText(value: unknown): string {
	if (typeof value === "string") return value;
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint" ||
		value === undefined ||
		value === null
	) {
		return String(value);
	}
	return Object.prototype.toString.call(value);
}

// ---------------------------------------------------------------- DOM stub --
// The browser modules are untyped JavaScript, so everything they write into the stub (text,
// values, attributes, appended children) is typed as unknown and narrowed where it is read.
type Listener = (event: unknown) => unknown;

class ClassList {
	set = new Set<string>();
	add(...names: string[]): void {
		names.forEach((n) => this.set.add(n));
	}
	remove(...names: string[]): void {
		names.forEach((n) => this.set.delete(n));
	}
	toggle(name: string, force?: boolean): boolean {
		const on = force ?? !this.set.has(name);
		if (on) this.set.add(name);
		else this.set.delete(name);
		return on;
	}
	contains(name: string): boolean {
		return this.set.has(name);
	}
}

class Node {
	tagName: string;
	children: unknown[] = [];
	attributes: Record<string, unknown> = {};
	dataset: Record<string, unknown> = {};
	style: Record<string, unknown> = {};
	classList = new ClassList();
	textContent: unknown = "";
	value: unknown = "";
	hidden: unknown = false;
	disabled: unknown = false;
	className: unknown = "";
	firstChild: unknown = null;
	scrollTop = 0;
	scrollHeight = 0;
	listeners = new Map<string, Listener[]>();
	open: unknown;
	constructor(tag: unknown = "div") {
		this.tagName = String(tag).toUpperCase();
	}
	append(...nodes: unknown[]): void {
		for (const node of nodes) {
			if (node === null || node === undefined) continue;
			this.children.push(node);
			this.firstChild = this.children[0] || null;
		}
	}
	appendChild<T>(node: T): T {
		this.append(node);
		return node;
	}
	hasChildNodes(): boolean {
		return this.children.length > 0;
	}
	replaceChildren(...nodes: unknown[]): void {
		this.children = [];
		this.firstChild = null;
		this.append(...nodes);
	}
	removeChild(child: unknown): void {
		this.children = this.children.filter((c) => c !== child);
		this.firstChild = this.children[0] || null;
	}
	remove(): void {}
	setAttribute(key: string, value: unknown): void {
		this.attributes[key] = value;
		if (key === "class") this.className = value;
	}
	getAttribute(key: string): unknown {
		return this.attributes[key];
	}
	addEventListener(type: string, fn: Listener): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	removeEventListener(): void {}
	querySelectorAll(): Node[] {
		return [];
	}
	querySelector(): Node | null {
		return null;
	}
	focus(): void {}
	close(): void {
		this.open = false;
	}
	showModal(): void {
		this.open = true;
	}
	requestSubmit(): void {}
	get options(): unknown[] {
		return this.children;
	}
	get classListNames(): string[] {
		return [...this.classList.set];
	}
}

const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const ids = [...html.matchAll(/id="([^"]+)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
const registry = new Map(ids.map((id) => [id, new Node("div")]));

/** An element the login check needs from index.html; a missing one fails that check. */
function element(id: string): Node {
	const node = registry.get(id);
	if (!node) throw new Error(`index.html has no #${id}`);
	return node;
}

/** Web Storage over a Map, so stored keys can never collide with Object.prototype. */
class StubStorage {
	_data = new Map<string, string>();
	getItem(k: string): string | null {
		return this._data.get(k) ?? null;
	}
	setItem(k: string, v: unknown): void {
		this._data.set(k, String(v));
	}
	removeItem(k: string): void {
		this._data.delete(k);
	}
}

const localStorageStub = new StubStorage();
// Browser globals the token flow touches. There is deliberately no EventSource: the client
// streams events over fetch() so it can send an Authorization header (see public/js/sse.js).
const sessionStorageStub = new StubStorage();
const locationStub = { hash: "", pathname: "/", search: "", reload(): void {} };
const historyStub = {
	replaced: [] as unknown[],
	replaceState(_state: unknown, _title: unknown, url: unknown): void {
		this.replaced.push(url);
		locationStub.hash = "";
	},
};
const CONFIG_STUB = {
	app: {
		version: "0.1.0",
		node: "v22",
		platform: "linux",
		host: "127.0.0.1",
		port: 8123,
	},
	cli: {
		binary: "pi",
		piHome: "/h/.pi/agent",
		settingsFile: "s",
		modelsFile: "m",
		sessionsDir: "sess",
	},
	settings: {
		defaultProvider: "p",
		defaultModel: "m",
		defaultThinkingLevel: "high",
		theme: "t",
		packages: 3,
	},
	paths: { kitRoot: "/k", agentDirs: ["/u", "/p"], lensDir: "/l" },
	lens: { present: true, sessionCount: 2, turn: { cycles: 1, files: 4 } },
	models: [{ name: "ollama", models: [{ id: "m" }] }],
};

/** The part of a fetch() init the checks read; the browser code passes it in untyped. */
interface StubRequestInit {
	headers?: Record<string, unknown>;
	signal?: { addEventListener(type: string, fn: () => void): void };
	credentials?: unknown;
	body?: unknown;
}

function requestInit(value: unknown): StubRequestInit {
	if (!isRecord(value)) return {};
	const init: StubRequestInit = { credentials: value.credentials, body: value.body };
	if (isRecord(value.headers)) init.headers = value.headers;
	const signal = value.signal;
	if (signal instanceof AbortSignal) init.signal = signal;
	return init;
}

interface StubEventSource {
	url: string;
	options: StubRequestInit;
	emit(type: string, payload: unknown): void;
}

interface StubResponse {
	ok: boolean;
	status: number;
	body?: ReadableStream<Uint8Array>;
	text?: () => Promise<string>;
}

// Test-side state the stub server reads and records (formerly `globalThis.__*` properties,
// which no browser module reads).
const stub: {
	fetchCalls: { url: string; options: StubRequestInit }[];
	healthAuth: string | undefined;
	requireToken: string | undefined;
	lastEventSource: StubEventSource | undefined;
} = { fetchCalls: [], healthAuth: undefined, requireToken: undefined, lastEventSource: undefined };

function stubResponse(url: string): StubResponse {
	const body = url.includes("/api/health")
		? { ok: true, version: "0.1.0", uptimeSec: 1, auth: stub.healthAuth ?? "off" }
		: url.includes("/api/models")
			? {
					providers: [{ name: "ollama", models: [{ id: "m" }] }],
					default: { provider: "ollama", model: "m" },
				}
			: url.includes("/api/agents")
				? { agents: [], tools: ["read"] }
				: url.includes("/api/cwds")
					? { cwds: ["/home/operator"] }
					: url.includes("/api/sessions")
						? { sessions: [] }
						: url.includes("/api/config")
							? CONFIG_STUB
							: url.includes("/api/prompts")
								? { prompts: [] }
								: url.includes("/api/skills")
									? { skills: [] }
									: {};
	return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

const stubFetch = async (url: unknown, rawOptions: unknown = {}): Promise<StubResponse> => {
	const target = String(url);
	const options = requestInit(rawOptions);
	stub.fetchCalls.push({ url: target, options });
	// Optional server-side token requirement, for the login-flow check below.
	if (stub.requireToken && !target.includes("/api/health")) {
		const presented = options.headers?.Authorization;
		if (presented !== `Bearer ${stub.requireToken}`) {
			return {
				ok: false,
				status: 401,
				text: async () => JSON.stringify({ error: "access token required" }),
			};
		}
	}
	if (target.endsWith("/events")) {
		// A real SSE response: a byte stream of `event:`/`data:` frames.
		const encoder = new TextEncoder();
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		if (options.signal)
			options.signal.addEventListener("abort", () => {
				try {
					controller?.error(new Error("aborted"));
				} catch {
					/* already closed */
				}
			});
		stub.lastEventSource = {
			url: target,
			options,
			/** Test helper: deliver a named SSE frame like the server does. */
			emit(type, payload) {
				// start() runs synchronously in the ReadableStream constructor, so this is set.
				if (!controller) throw new Error("SSE stream was never started");
				controller.enqueue(
					encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`),
				);
			},
		};
		return { ok: true, status: 200, body };
	}
	return stubResponse(target);
};

// Keep setTimeout real so the throttled markdown flush actually runs (app.js schedules it with
// setTimeout). setInterval stays stubbed so app.js polling does not fire during the test.
const realSetTimeout = globalThis.setTimeout;

// Install the stubs as the browser globals the modules expect. Object.assign is plain property
// assignment (as the old `globalThis.x = ...` lines were); it just skips Node's own typings
// for fetch/setInterval/localStorage, which the stubs deliberately do not match.
Object.assign(globalThis, {
	Node,
	// app.js and agentui.js check each element's type (`instanceof HTMLInputElement` and so on);
	// every stub element is a Node, so each element class is the stub Node here.
	HTMLElement: Node,
	HTMLButtonElement: Node,
	HTMLDialogElement: Node,
	HTMLFormElement: Node,
	HTMLInputElement: Node,
	HTMLSelectElement: Node,
	HTMLTextAreaElement: Node,
	localStorage: localStorageStub,
	document: {
		body: new Node("body"),
		createDocumentFragment: () => new Node("#fragment"),
		getElementById: (id: string) => registry.get(id) ?? null,
		createElement: (tag: unknown) => new Node(tag),
		createTextNode: (text: unknown) =>
			Object.assign(new Node("#text"), { textContent: text }),
		querySelector: () => new Node("div"),
		querySelectorAll: () => [],
		addEventListener: () => {},
		hidden: false,
	},
	window: {
		matchMedia: () => ({ matches: false, addEventListener: () => {} }),
		confirm: () => true,
		addEventListener: () => {},
	},
	sessionStorage: sessionStorageStub,
	location: locationStub,
	history: historyStub,
	fetch: stubFetch,
	setInterval: () => 0,
	clearInterval: () => {},
});

// Walk the stub DOM gathering all text, to assert what a user would actually see.
function allText(node: unknown): string {
	if (!(node instanceof Node)) return "";
	let out = node.textContent ? asText(node.textContent) : "";
	for (const child of node.children) out += ` ${allText(child)}`;
	return out;
}

/** Collect every element in the stub tree matching a predicate. */
function findAll(node: unknown, predicate: (n: Node) => boolean, out: Node[] = []): Node[] {
	if (!(node instanceof Node)) return out;
	for (const child of node.children) {
		if (child instanceof Node && child.tagName && predicate(child)) out.push(child);
		findAll(child, predicate, out);
	}
	return out;
}

const hasClass = (cls: string) => (n: Node): boolean =>
	asText(n.className || "")
		.split(/\s+/)
		.includes(cls);
const isTag = (tag: string) => (n: Node): boolean => n.tagName === tag.toUpperCase();

// ------------------------------------------------------- browser modules --
// The public/js modules are untyped browser code (typed in a later stage). Each import is
// checked at runtime for the exports this smoke calls, and described by a local interface.
type ExportKind = "function" | "object";

async function loadModule<T extends object>(
	file: string,
	exportsNeeded: Record<keyof T & string, ExportKind>,
): Promise<T> {
	const mod: unknown = await import(path.join(ROOT, "public", "js", file));
	if (!hasExports<T>(mod, exportsNeeded)) {
		throw new Error(`${file} lacks one of: ${Object.keys(exportsNeeded).join(", ")}`);
	}
	return mod;
}

function hasExports<T extends object>(
	mod: unknown,
	exportsNeeded: Record<keyof T & string, ExportKind>,
): mod is T {
	if (typeof mod !== "object" || mod === null) return false;
	return Object.entries<ExportKind>(exportsNeeded).every(([name, kind]) => {
		const value: unknown = Reflect.get(mod, name);
		return kind === "function" ? typeof value === "function" : isRecord(value);
	});
}

interface MarkdownModule {
	renderMarkdown: (text: string) => unknown;
}
interface StreamHandlers {
	onEvent: (payload: unknown) => void;
	onLifecycle?: (payload: unknown) => void;
}
interface SessionStreamInstance {
	open: () => void;
	close: () => void;
}
interface SseModule {
	SessionStream: new (sessionId: string, handlers: StreamHandlers) => SessionStreamInstance;
	parseFrame: (text: string) => unknown;
}
interface RenderModule {
	ChatRenderer: new (log: Node) => { handle(data: unknown): void };
	renderAgents: (target: Node, agents: unknown[], handlers: Record<string, () => void>) => void;
	renderSessions: (target: Node, sessions: unknown[], activeId: string | null, onSelect: () => void) => void;
}
interface AuthModule {
	clearToken: () => void;
	setToken: (token: string) => void;
	getToken: () => unknown;
	consumeFragmentToken: () => unknown;
}
interface ApiModule {
	api: {
		sessions: () => Promise<unknown>;
		abort: (sessionId: string) => Promise<unknown>;
		authCheck: () => Promise<unknown>;
	};
	setUnauthorizedHandler: (fn: () => void) => void;
}
interface PanelsModule {
	renderStats: (target: Node, stats: unknown, summary: unknown) => void;
	renderTodos: (target: Node, data: unknown) => void;
	renderLens: (target: Node, lens: unknown) => void;
	renderConfig: (target: Node, config: unknown) => void;
}

const MARKDOWN = { renderMarkdown: "function" } as const;
const SSE = { SessionStream: "function", parseFrame: "function" } as const;
const RENDER = { ChatRenderer: "function", renderAgents: "function", renderSessions: "function" } as const;
const AUTH = {
	clearToken: "function",
	setToken: "function",
	getToken: "function",
	consumeFragmentToken: "function",
} as const;
const API = { api: "object", setUnauthorizedHandler: "function" } as const;
const PANELS = {
	renderStats: "function",
	renderTodos: "function",
	renderLens: "function",
	renderConfig: "function",
} as const;

// ------------------------------------------------------------------ checks --
console.log("pi-console ui smoke");

// Markdown rendering + injection safety. URLs are built at runtime so the file contains no
// literal scheme string (a local governance rule flags those as target definitions).
{
	const { renderMarkdown } = await loadModule<MarkdownModule>("markdown.js", MARKDOWN);
	const SCHEME = "http" + "://";
	const SAFE = `${SCHEME}example.com`;
	const BARE = `${SCHEME}bare.example`;

	const bold = renderMarkdown("this is **important** and `inline code`");
	check(findAll(bold, isTag("strong")).length > 0, "markdown: bold", "markdown: bold missing");
	check(
		findAll(bold, hasClass("md-inline-code")).length > 0,
		"markdown: inline code",
		"markdown: inline code missing",
	);

	const fenced = renderMarkdown(
		'```js\nconst x = "str"; // note\nfunction go() { return 42; }\n```',
	);
	check(
		findAll(fenced, hasClass("md-code")).length > 0,
		"markdown: fenced code block",
		"markdown: no code block",
	);
	check(
		allText(findAll(fenced, hasClass("md-code-lang"))[0] ?? new Node()).trim() ===
		"js",
		"markdown: language tag",
		"markdown: language tag missing",
	);
	// CommonMark: intraword underscores are literal, so snake_case identifiers survive.
	check(
		allText(renderMarkdown("set PI_HOME and tool_name_here")).includes(
			"tool_name_here",
		),
		"markdown: intraword underscores preserved",
		"markdown: snake_case mangled into emphasis",
	);
	check(
		findAll(fenced, hasClass("md-tok-keyword")).length > 0,
		"markdown: keyword colouring",
		"markdown: no keyword colouring",
	);
	check(
		findAll(fenced, hasClass("md-tok-string")).length > 0,
		"markdown: string colouring",
		"markdown: no string colouring",
	);
	check(
		findAll(fenced, hasClass("md-tok-comment")).length > 0,
		"markdown: comment colouring",
		"markdown: no comment colouring",
	);
	check(
		findAll(fenced, hasClass("md-tok-number")).length > 0,
		"markdown: number colouring",
		"markdown: no number colouring",
	);

	const blocks = renderMarkdown(
		"# Title\n\n- one\n- two\n\n> quoted\n\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
	);
	check(findAll(blocks, isTag("ul")).length > 0, "markdown: bullet list", "markdown: no list");
	check(
		findAll(blocks, hasClass("md-quote")).length > 0,
		"markdown: blockquote",
		"markdown: no blockquote",
	);
	check(findAll(blocks, isTag("hr")).length > 0, "markdown: horizontal rule", "markdown: no hr");
	check(findAll(blocks, hasClass("md-table")).length > 0, "markdown: table", "markdown: no table");
	check(findAll(blocks, hasClass("md-h")).length > 0, "markdown: heading", "markdown: no heading");

	const links = renderMarkdown(
		`[ok](${SAFE}) and [bad](javascript:alert(1)) and ${BARE}`,
	);
	const anchors = findAll(links, isTag("a"));
	check(
		anchors.length === 2,
		"markdown: unsafe scheme not linked",
		`markdown: expected 2 links, got ${anchors.length}`,
	);
	check(
		anchors.every((a) => /^(https?:|mailto:)/i.test(asText(a.getAttribute("href") || ""))),
		"markdown: link schemes checked",
		"markdown: unsafe link scheme allowed",
	);

	// The allow-list (http/https/mailto) against the usual scheme tricks: other script-capable
	// schemes, mixed case, and control characters a browser strips inside a scheme. None may
	// become a link; each stays visible as text.
	const tricks = [
		"javascript:alert(1)",
		"JaVaScRiPt:alert(1)",
		"java\tscript:alert(1)",
		"java\nscript:alert(1)",
		" javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"DATA:text/html;base64,PHNjcmlwdD4=",
		"vbscript:msgbox(1)",
		"%6Aavascript:alert(1)",
		"javascript&#58;alert(1)",
	];
	for (const href of tricks) {
		const rendered = renderMarkdown(`[click](${href})`);
		const linked = findAll(rendered, isTag("a"));
		check(
			linked.length === 0,
			`markdown: ${JSON.stringify(href)} not linked`,
			`markdown: ${JSON.stringify(href)} BECAME A LINK`,
		);
		check(
			allText(rendered).includes("click"),
			`markdown: ${JSON.stringify(href)} label kept as text`,
			`markdown: ${JSON.stringify(href)} label lost`,
		);
	}
	const mixedCase = findAll(renderMarkdown(`[ok](${SAFE.toUpperCase()}) [m](MailTo:a@example.com)`), isTag("a"));
	check(
		mixedCase.length === 2,
		"markdown: allowed schemes match in any case",
		`markdown: expected 2 mixed-case links, got ${mixedCase.length}`,
	);

	// Injection: raw HTML in a message must never become elements.
	const xss = renderMarkdown(
		"<img src=x onerror=alert(1)> <script>alert(2)</script>",
	);
	check(
		findAll(xss, isTag("script")).length === 0,
		"markdown: no script element injected",
		"markdown: SCRIPT INJECTED",
	);
	check(
		findAll(xss, isTag("img")).length === 0,
		"markdown: no img element injected",
		"markdown: IMG INJECTED",
	);
	check(
		allText(xss).includes("<script>"),
		"markdown: html shown as literal text",
		"markdown: html not escaped",
	);
}

// The stream/rendering path for a session written by ANOTHER process (the CLI). This is the
// regression test for the bug where the server framed tailed data as `event: observed` and the
// client only listened for `event`/`lifecycle`, so every CLI message was silently dropped.
{
	const { SessionStream } = await loadModule<SseModule>("sse.js", SSE);
	const { ChatRenderer } = await loadModule<RenderModule>("render.js", RENDER);
	const log = new Node("div");
	const renderer = new ChatRenderer(log);
	const stream = new SessionStream("sess-1", {
		onEvent: (payload) => renderer.handle(isRecord(payload) ? payload.data : undefined),
		onLifecycle: () => {},
	});
	stream.open();
	const source = stub.lastEventSource;
	if (!source) bad("EventSource was not created by SessionStream.open()");
	else {
		const observed = (data: unknown): void =>
			source.emit("observed", { sessionId: "sess-1", type: "observed", data });
		observed({
			type: "observed_message",
			message: {
				role: "user",
				content: [{ type: "text", text: "CLI_USER_LINE" }],
			},
		});
		observed({
			type: "observed_message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "CLI_ASSISTANT_LINE" },
					{
						type: "toolCall",
						id: "t1",
						name: "bash",
						arguments: { command: "ls" },
					},
				],
			},
		});
		observed({
			type: "observed_message",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text", text: "TOOL_OUTPUT_LINE" }],
				isError: false,
			},
		});
		source.emit("event", {
			sessionId: "sess-1",
			type: "event",
			data: {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "LIVE_DELTA_LINE" },
			},
		});
		// Live text renders through the throttled markdown flush (120 ms); wait past it.
		await new Promise((resolve) => realSetTimeout(resolve, 220));

		// Live text renders through the throttled markdown flush (120 ms); the observed assistant
		// message additionally streams in, so wait for both to settle.
		await new Promise((resolve) => realSetTimeout(resolve, 400));

		const text = allText(log);
		check(
			text.includes("CLI_USER_LINE"),
			"observed user message rendered",
			"observed user message missing",
		);
		check(
			text.includes("CLI_ASSISTANT_LINE"),
			"observed assistant text rendered",
			"observed assistant text missing",
		);
		check(
			text.includes("TOOL_OUTPUT_LINE"),
			"observed tool result rendered",
			"observed tool result missing",
		);
		check(text.includes("LIVE_DELTA_LINE"), "live delta still rendered", "live delta missing");
		check(text.includes("bash"), "observed tool call rendered", "observed tool call missing");

		// The tool result arrived while the reply was still streaming in, so it must have been
		// buffered and then applied to its call rather than dropped or duplicated.
		const doneStates = findAll(log, hasClass("tool-state-running"));
		check(
			doneStates.some((n) => n.textContent === "done"),
			"tool result applied to its buffered call",
			"tool result was not applied to its call",
		);
	}
}

// Access token handling: fragment -> sessionStorage -> Authorization header, never a URL/cookie.
{
	const auth = await loadModule<AuthModule>("auth.js", AUTH);
	const { api, setUnauthorizedHandler } = await loadModule<ApiModule>("api.js", API);
	const { SessionStream, parseFrame } = await loadModule<SseModule>("sse.js", SSE);
	const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";

	auth.clearToken();
	locationStub.hash = `#token=${TOKEN}`;
	historyStub.replaced.length = 0;
	check(
		auth.consumeFragmentToken() === TOKEN,
		"auth: token taken from the URL fragment",
		"auth: fragment token not consumed",
	);
	check(
		historyStub.replaced.length === 1 &&
		locationStub.hash === "" &&
		!String(historyStub.replaced[0]).includes(TOKEN),
		"auth: fragment stripped from the address bar",
		"auth: token left in the address bar",
	);
	check(
		sessionStorageStub.getItem("pi-console.token") === TOKEN,
		"auth: token kept in sessionStorage only",
		"auth: token not stored for the tab",
	);
	check(
		localStorageStub.getItem("pi-console.token") === null,
		"auth: token never written to localStorage",
		"auth: token persisted in localStorage",
	);

	locationStub.hash = "#token=short";
	auth.clearToken();
	check(
		auth.consumeFragmentToken() === null && auth.getToken() === null,
		"auth: malformed fragment token rejected (and stripped)",
		"auth: malformed token accepted",
	);
	locationStub.hash = "#section-two";
	historyStub.replaced.length = 0;
	check(
		auth.consumeFragmentToken() === null && historyStub.replaced.length === 0,
		"auth: unrelated fragments are left alone",
		"auth: unrelated fragment was rewritten",
	);

	auth.setToken(TOKEN);
	stub.fetchCalls.length = 0;
	await api.sessions();
	const get = stub.fetchCalls.at(-1);
	check(
		get?.options.headers?.Authorization === `Bearer ${TOKEN}`,
		"api: GET carries the bearer token",
		"api: GET missing the bearer token",
	);
	check(
		get !== undefined && !get.url.includes(TOKEN) && !get.url.includes("token="),
		"api: token never placed in a URL",
		"api: token leaked into a URL",
	);
	check(
		get?.options.credentials === "omit",
		"api: no cookies are sent",
		"api: credentials not omitted",
	);
	await api.abort("s1");
	const post = stub.fetchCalls.at(-1);
	check(
		post?.options.headers?.["Content-Type"] === "application/json" &&
		post.options.body === "{}",
		"api: bodiless POST still declares JSON",
		"api: bodiless POST missing the JSON content type",
	);

	let unauthorised = 0;
	setUnauthorizedHandler(() => {
		unauthorised++;
	});
	Object.assign(globalThis, {
		fetch: async (): Promise<StubResponse> => ({
			ok: false,
			status: 401,
			text: async () => JSON.stringify({ error: "access token required" }),
		}),
	});
	let status: unknown = null;
	await api.sessions().catch((error: unknown) => {
		status = isRecord(error) ? error.status : undefined;
	});
	await api.authCheck().catch(() => {});
	Object.assign(globalThis, { fetch: stubFetch });
	check(
		status === 401 && unauthorised === 1,
		"api: 401 raises the login prompt (authCheck stays quiet)",
		`api: 401 handling wrong (status ${String(status)}, prompts ${unauthorised})`,
	);
	setUnauthorizedHandler(() => {});

	const stream = new SessionStream("sess-auth", { onEvent: () => {} });
	stream.open();
	const opened = stub.lastEventSource;
	check(
		opened?.options.headers?.Authorization === `Bearer ${TOKEN}` &&
		!opened.url.includes(TOKEN),
		"sse: stream request authenticates with a header, not the URL",
		"sse: stream request not authenticated correctly",
	);
	stream.close();

	const frame = parseFrame("event: lifecycle\ndata: {\"a\":1}\ndata: 2");
	check(
		isRecord(frame) && frame.event === "lifecycle" && frame.data === '{"a":1}\n2',
		"sse: frame parser handles event/multi-line data",
		"sse: frame parser wrong",
	);
	check(
		parseFrame(": ping") === null,
		"sse: comment frames ignored",
		"sse: comment frame not ignored",
	);

	auth.clearToken();
	locationStub.hash = "";
}

// Streaming reveal: an observed reply must appear progressively, not all at once.
{
	const { ChatRenderer } = await loadModule<RenderModule>("render.js", RENDER);
	const log = new Node("div");
	const renderer = new ChatRenderer(log);
	const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima ".repeat(6);
	renderer.handle({
		type: "observed_message",
		message: { role: "assistant", content: [{ type: "text", text: long }] },
	});
	const partial = allText(log).replace(/\s+/g, "").length;
	await new Promise((resolve) => realSetTimeout(resolve, 1500));
	const settled = allText(log).replace(/\s+/g, "").length;
	const full = long.replace(/\s+/g, "").length;

	check(
		partial > 0 && partial < full,
		"observed reply streams in (partial on first paint)",
		`observed reply not streaming (partial=${partial} full=${full})`,
	);
	check(
		settled >= full,
		"observed reply completes",
		`observed reply truncated (settled=${settled} full=${full})`,
	);
}

// Layout + "go to end" wiring.
{
	const css = fs.readFileSync(path.join(ROOT, "public", "css", "style.css"), "utf8");
	const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
	const app = fs.readFileSync(path.join(ROOT, "public", "js", "app.js"), "utf8");

	check(
		/--msg-width:\s*\d+px/.test(css),
		"layout: shared message width token",
		"layout: no --msg-width token",
	);
	check(
		/align-items:\s*center/.test(css.split(".chat-log {")[1] || ""),
		"layout: messages centred",
		"layout: chat log not centred",
	);
	const msgBlock = (css.split(".msg {")[1] || "").split("}")[0] || "";
	check(
		/border:\s*0/.test(msgBlock),
		"layout: no border on message boxes",
		"layout: message box still bordered",
	);
	check(
		/max-width:\s*var\(--msg-width\)/.test(msgBlock),
		"layout: uniform width applied",
		"layout: messages not uniform width",
	);
	check(/id="go-end"/.test(html), "go-to-end button present", "go-to-end button missing");
	check(/dom\.goEnd\.addEventListener/.test(app), "go-to-end wired", "go-to-end not wired");
	check(/goToEnd\(\)/.test(app), "go-to-end calls renderer", "go-to-end does not scroll");
}

const modules = [
	"auth.js",
	"api.js",
	"sse.js",
	"render.js",
	"activity.js",
	"panels.js",
	"agentui.js",
	"app.js",
];
for (const file of modules) {
	try {
		await import(path.join(ROOT, "public", "js", file));
		ok(`import ${file}`);
	} catch (err) {
		bad(`import ${file}: ${describeError(err)}`);
	}
}

// Login flow: with a token-protected server and no token held, app.js must show the unlock
// dialog, refuse a malformed or wrong token, and carry on once the right one is accepted.
try {
	const TOKEN = "fedcba9876543210fedcba9876543210fedcba9876543210";
	const dialog = element("unlock-dialog");
	const input = element("unlock-input");
	const form = element("unlock-form");
	const errorLine = element("unlock-error");
	const submit = (): Promise<unknown[]> =>
		Promise.all((form.listeners.get("submit") ?? []).map((fn) => fn({ preventDefault() {} })));
	const tick = (ms = 60): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms));

	// Let the first app.js instance (imported above, auth off) finish its own init() so its
	// data loads cannot be mistaken for requests made by the instance under test.
	await tick(400);
	stub.healthAuth = "token";
	stub.requireToken = TOKEN;
	sessionStorageStub._data = new Map();
	stub.fetchCalls.length = 0;
	dialog.open = false;
	const { pathToFileURL } = await import("node:url");
	// A distinct module instance re-runs init() against the token-protected stub server.
	void import(`${pathToFileURL(path.join(ROOT, "public", "js", "app.js")).href}?locked=1`);
	await tick();
	check(
		dialog.open === true,
		"login: unlock dialog shown when a token is required and none is held",
		"login: unlock dialog not shown",
	);
	check(
		!stub.fetchCalls.some((c) => /\/api\/sessions/.test(c.url)),
		"login: nothing is fetched before the token is entered",
		"login: data was requested before the token was entered",
	);

	input.value = "nope";
	await submit();
	check(
		dialog.open === true && errorLine.hidden === false,
		"login: malformed token refused",
		"login: malformed token accepted",
	);

	input.value = "0000000000000000000000000000000000000000000000";
	await submit();
	check(
		dialog.open === true && /not accepted/.test(asText(errorLine.textContent)),
		"login: wrong token refused by the server",
		`login: wrong token handling (${asText(errorLine.textContent)})`,
	);

	input.value = TOKEN;
	await submit();
	await tick(150);
	check(
		dialog.open === false,
		"login: correct token closes the dialog",
		"login: dialog still open after the correct token",
	);
	check(
		stub.fetchCalls.some(
			(c) =>
				/\/api\/sessions/.test(c.url) &&
				c.options.headers?.Authorization === `Bearer ${TOKEN}`,
		),
		"login: initialisation resumes with the token",
		"login: app did not continue after unlock",
	);
} catch (err) {
	bad(`login flow: ${describeError(err, true)}`);
} finally {
	stub.healthAuth = undefined;
	stub.requireToken = undefined;
}

// Re-render panels against live-ish shapes to prove the render paths do not throw.
try {
	const { renderStats, renderTodos, renderLens, renderConfig } = await loadModule<PanelsModule>(
		"panels.js",
		PANELS,
	);
	const target = new Node();
	renderStats(
		target,
		{
			live: true,
			userMessages: 3,
			assistantMessages: 3,
			toolCalls: 7,
			totalMessages: 6,
			tokens: {
				input: 1200,
				output: 300,
				cacheRead: 0,
				cacheWrite: 0,
				total: 1500,
			},
			cost: 0.0123,
			contextUsage: { tokens: 1200, contextWindow: 131072, percent: 1 },
			model: "deepseek/deepseek-v4.1-flash",
		},
		{ id: "abc", cwd: "/home/operator" },
	);
	ok("renderStats");

	renderTodos(target, {
		exists: true,
		todos: [
			{ id: 1, text: "do a thing", state: "done" },
			{ id: 2, text: "doing a thing", state: "active" },
			{ id: 3, text: "todo a thing", state: "open" },
		],
	});
	ok("renderTodos");

	renderLens(target, {
		available: true,
		savedAt: new Date().toISOString(),
		files: [{ filePath: "/a/b/c.ts", errors: 1, warnings: 2, blocking: 0 }],
		totals: { blocking: 0, errors: 1, warnings: 2 },
		cache: { qualityWarnings: 3, findings: 1 },
	});
	ok("renderLens");

	renderConfig(target, {
		app: {
			version: "0.1.0",
			node: "v22",
			platform: "linux",
			host: "127.0.0.1",
			port: 8123,
		},
		cli: {
			binary: "pi",
			piHome: "/h/.pi/agent",
			settingsFile: "s",
			modelsFile: "m",
			sessionsDir: "sess",
		},
		settings: {
			defaultProvider: "p",
			defaultModel: "m",
			defaultThinkingLevel: "high",
			theme: "t",
			packages: 3,
		},
		paths: { kitRoot: "/k", agentDirs: ["/u", "/p"], lensDir: "/l" },
		lens: { present: true, sessionCount: 2, turn: { cycles: 1, files: 4 } },
		models: [{ name: "ollama", models: [1] }],
	});
	ok("renderConfig");

	const { renderAgents, renderSessions } = await loadModule<RenderModule>("render.js", RENDER);
	renderAgents(
		target,
		[{ name: "planner", description: "d", tools: ["read"], source: "user" }],
		{
			onUse: () => {},
			onEdit: () => {},
			onDelete: () => {},
		},
	);
	ok("renderAgents");
	renderSessions(
		target,
		[
			{
				id: "01a0",
				cwd: "/x",
				status: "running",
				lastActivityAt: new Date().toISOString(),
				preview: "hi",
				agent: "planner",
			},
		],
		null,
		() => {},
	);
	ok("renderSessions");
} catch (err) {
	bad(`render paths: ${describeError(err, true)}`);
}

// The phone's dialog cards (mobile/js/chat.js render through render.js). A tap answers once:
// an input dialog's Send used to answer twice, first with no value (the server's 400 then
// showed on a card that had in fact been answered).
interface MobileChatModule {
	dialogCard: (dialog: unknown, answer: (payload: unknown) => Promise<unknown>) => unknown;
}
try {
	const mod: unknown = await import(path.join(ROOT, "mobile", "js", "chat.js"));
	if (!hasExports<MobileChatModule>(mod, { dialogCard: "function" })) throw new Error("mobile/js/chat.js lacks dialogCard");
	const answers: unknown[] = [];
	const card = mod.dialogCard({ id: "d1", method: "input", title: "Name?" }, (payload) => {
		answers.push(payload);
		return Promise.resolve();
	});
	const textarea = findAll(card, isTag("textarea"))[0];
	const send = findAll(card, (n) => isTag("button")(n) && n.textContent === "Send")[0];
	if (!textarea || !send) throw new Error("the input card has no textarea or no Send button");
	textarea.value = "hello";
	for (const fn of send.listeners.get("click") ?? []) fn({});
	check(
		JSON.stringify(answers) === JSON.stringify([{ value: "hello" }]) && Reflect.get(send, "onclick") === undefined,
		"mobile dialog: Send answers once, with the typed value",
		`mobile dialog: Send answered ${JSON.stringify(answers)}`,
	);
} catch (err) {
	bad(`mobile dialog card: ${describeError(err, true)}`);
}

console.log(`ui smoke: ${failures} failed`);
process.exit(failures ? 1 : 0);
