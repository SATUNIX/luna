// app.ts — pi-console client: state, views, session wiring, inspector, activity wheel.
import { api, ApiError, setUnauthorizedHandler } from "./api.ts";
import {
	clearToken,
	consumeFragmentToken,
	getToken,
	isPlausibleToken,
	setToken,
} from "./auth.ts";
import { SessionStream } from "./sse.ts";
import {
	ActivityWheel,
	formatElapsed,
	toolLabel,
} from "./activity.ts";
import { AgentEditor } from "./agentui.ts";
import { asRecord, byId, errorMessage, toText } from "./guards.ts";
import {
	renderConfig,
	renderLens,
	renderResourceList,
	renderStats,
	renderTodos,
} from "./panels.ts";
import { ChatRenderer, el, renderAgents, renderSessions } from "./render.ts";
import type * as Wire from "./wire.ts";

type View = "sessions" | "agents" | "config";
type InspectorPanel = "stats" | "todos" | "lens";
/** What the chat header reports: "watching" is a session another process runs. */
type Status = "idle" | "running" | "watching";

interface Panels {
	sidebar: boolean;
	inspector: boolean;
	composer: boolean;
}

interface AppState {
	view: View;
	sessions: readonly Wire.SessionSummary[];
	agents: readonly Wire.AgentSummary[];
	tools: readonly string[];
	models: Wire.ModelsResponse;
	cwds: readonly string[];
	config: Wire.ConfigResponse | null;
	prompts: readonly Wire.KitEntry[];
	skills: readonly Wire.KitEntry[];
	activeId: string | null;
	stream: SessionStream | null;
	renderer: ChatRenderer | null;
	status: Status;
	stats: Wire.SessionStats | null;
	panels: Panels;
	inspectorPanel: InspectorPanel;
	timers: Record<"sessions" | "stats" | "elapsed" | "health", ReturnType<typeof setInterval> | null>;
}

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** A select's value as a thinking level; anything else is not sent. */
function isThinkingLevel(value: string): value is Wire.ThinkingLevel {
	return THINKING_LEVELS.includes(value);
}

function isView(value: string | null): value is View {
	return value === "sessions" || value === "agents" || value === "config";
}

function isInspectorPanel(value: string | null): value is InspectorPanel {
	return value === "stats" || value === "todos" || value === "lens";
}

const state: AppState = {
	view: "sessions",
	sessions: [],
	agents: [],
	tools: [],
	models: { providers: [], default: { provider: "", model: "" } },
	cwds: [],
	config: null,
	prompts: [],
	skills: [],
	activeId: null,
	stream: null,
	renderer: null,
	status: "idle",
	stats: null,
	panels: { sidebar: true, inspector: true, composer: true },
	inspectorPanel: "stats",
	timers: { sessions: null, stats: null, elapsed: null, health: null },
};

// Assigned once by init() before anything reads it.
let dom: Dom;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------- helpers ---
function toast(message: string, isError = false): void {
	dom.toast.textContent = message;
	dom.toast.classList.toggle("is-error", isError);
	dom.toast.classList.remove("hidden");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => dom.toast.classList.add("hidden"), 2600);
}

/**
 * An event listener that starts an async handler and does not wait for it: each handler
 * reports its own failures (toast, dialog error or console), as the old listeners did.
 */
function detached<E>(handler: (event: E) => Promise<void>): (event: E) => void {
	return (event) => void handler(event);
}

function isNarrow(): boolean {
	return window.matchMedia("(max-width: 1000px)").matches;
}

function closeDrawer(): void {
	dom.sidebar.classList.remove("is-open");
	dom.drawerScrim.classList.add("hidden");
}

// ------------------------------------------------------------ panel toggles --
const PANEL_KEY = "pi-console.panels";

function loadPanels(): void {
	try {
		// A stored non-object (null, a number) reads as no saved choices, as it did before.
		const saved = asRecord(JSON.parse(localStorage.getItem(PANEL_KEY) || "{}"));
		state.panels = {
			sidebar: saved.sidebar !== false,
			inspector: saved.inspector !== false,
			composer: saved.composer !== false,
		};
	} catch {
		state.panels = { sidebar: true, inspector: true, composer: true };
	}
}

function applyPanels(): void {
	document.body.classList.toggle("hide-sidebar", !state.panels.sidebar);
	document.body.classList.toggle("hide-inspector", !state.panels.inspector);
	document.body.classList.toggle("hide-composer", !state.panels.composer);
	dom.toggleSidebar.classList.toggle("is-off", !state.panels.sidebar);
	dom.toggleInspector.classList.toggle("is-off", !state.panels.inspector);
	dom.toggleComposer.classList.toggle("is-off", !state.panels.composer);
	try {
		localStorage.setItem(PANEL_KEY, JSON.stringify(state.panels));
	} catch {
		/* storage may be unavailable */
	}
}

function togglePanel(name: keyof Panels): void {
	state.panels[name] = !state.panels[name];
	applyPanels();
}

// ------------------------------------------------------------ access token ----
let unlockPending: Promise<void> | null = null;

function showUnlockError(message: string | undefined): void {
	dom.unlockError.textContent = message || "";
	dom.unlockError.hidden = !message;
}

/**
 * Ask the operator for the access token and resolve once the server has accepted one.
 * Idempotent: concurrent callers share the same dialog.
 */
function promptForToken(reason?: string): Promise<void> {
	if (unlockPending) return unlockPending;
	unlockPending = new Promise<void>((resolve) => {
		showUnlockError(reason);
		dom.unlockInput.value = "";
		if (!dom.unlockDialog.open) dom.unlockDialog.showModal();
		dom.unlockInput.focus();
		const onSubmit = async (event: SubmitEvent): Promise<void> => {
			event.preventDefault();
			const value = dom.unlockInput.value.trim();
			if (!isPlausibleToken(value)) {
				showUnlockError(
					"That does not look like an access token (32-256 letters, digits, . _ ~ -).",
				);
				return;
			}
			setToken(value);
			try {
				await api.authCheck();
			} catch (err) {
				clearToken();
				showUnlockError(
					err instanceof ApiError && err.status === 401
						? "That token was not accepted."
						: errorMessage(err),
				);
				return;
			}
			// eslint-disable-next-line @typescript-eslint/no-misused-promises -- the same listener that was added below
			dom.unlockForm.removeEventListener("submit", onSubmit);
			dom.unlockInput.value = "";
			dom.unlockDialog.close();
			unlockPending = null;
			resolve();
		};
		// The listener returns its attempt's promise (it catches its own errors) so that a caller
		// invoking it directly, as the ui smoke does, can wait for the server's answer.
		// eslint-disable-next-line @typescript-eslint/no-misused-promises -- see above
		dom.unlockForm.addEventListener("submit", onSubmit);
	});
	return unlockPending;
}

/**
 * Establish access before any data is requested: take a `#token=` fragment if the operator
 * opened the console via its login link, otherwise ask for the token. Nothing to do when the
 * server reports authentication off, or cannot be reached (the health poll shows that).
 */
async function ensureAccess(): Promise<void> {
	consumeFragmentToken();
	let health: Wire.HealthResponse | null = null;
	try {
		health = await api.health();
	} catch {
		/* offline: pollHealth reports it */
	}
	if (health?.auth === "token") {
		if (getToken()) {
			try {
				await api.authCheck();
			} catch (err) {
				if (err instanceof ApiError && err.status === 401) {
					clearToken();
					await promptForToken(
						"The saved token is no longer valid (the console may have restarted). Paste the current one.",
					);
				}
			}
		} else {
			await promptForToken();
		}
	}
	// From here on, a 401 means the token went stale mid-session (e.g. a server restart).
	setUnauthorizedHandler(() => {
		clearToken();
		void promptForToken(
			"The access token was rejected or has expired. Paste the current one.",
		).then(() => location.reload());
	});
}

// --------------------------------------------------------------- health -----
async function pollHealth(): Promise<void> {
	try {
		const health = await api.health();
		dom.footerHealth.textContent = `server: ok v${health.version} · up ${health.uptimeSec}s`;
		dom.footerHealth.className = "mono-sm is-good";
	} catch {
		dom.footerHealth.textContent = "server: offline";
		dom.footerHealth.className = "mono-sm is-warn";
	}
}

// ------------------------------------------------------------- sessions -----
async function loadSessions(): Promise<void> {
	try {
		const data = await api.sessions();
		state.sessions = data.sessions ?? [];
		const filter = dom.sessionFilter.value.trim().toLowerCase();
		const shown = filter
			? state.sessions.filter((s) =>
					`${s.id} ${String(s.cwd)} ${s.preview} ${s.agent || ""}`
						.toLowerCase()
						.includes(filter),
				)
			: state.sessions;
		renderSessions(dom.sessionList, shown, state.activeId, openSession);
		const running = state.sessions.filter((s) => s.status === "running").length;
		dom.footerCount.textContent = `sessions: ${state.sessions.length} (${running} running)`;
	} catch (err) {
		console.error("failed to load sessions", err);
	}
}

async function loadAgents(): Promise<void> {
	try {
		const data = await api.agents();
		state.agents = data.agents ?? [];
		state.tools = data.tools ?? [];
		renderAgents(dom.agentGrid, state.agents, {
			onUse: (agent) => openDialog(agent),
			onEdit: (agent) => void agentEditor?.open(agent, state.tools),
			onDelete: (agent) => void deleteAgentQuick(agent),
		});
	} catch (err) {
		console.error("failed to load agents", err);
	}
}

async function deleteAgentQuick(agent: Wire.AgentSummary): Promise<void> {
	if (!window.confirm(`Delete agent "${agent.name}" (${agent.source})?`))
		return;
	try {
		await api.deleteAgent(agent.name, agent.source);
		toast(`agent deleted: ${agent.name}`);
		await loadAgents();
	} catch (err) {
		toast(errorMessage(err), true);
	}
}

async function loadModels(): Promise<void> {
	try {
		const data = await api.models();
		state.models = {
			providers: data?.providers ?? [],
			default: data?.default ?? { provider: "", model: "" },
		};
		const select = dom.ctlModel;
		select.replaceChildren();
		for (const provider of state.models.providers) {
			for (const model of provider.models) {
				select.append(
					el("option", {
						value: `${provider.name}|${model.id}`,
						text: model.id,
					}),
				);
			}
		}
		const preferred = `${state.models.default.provider}|${state.models.default.model}`;
		if ([...select.options].some((o) => o.value === preferred))
			select.value = preferred;
	} catch (err) {
		console.error("failed to load models", err);
	}
}

async function loadCwds(): Promise<void> {
	try {
		state.cwds = (await api.cwds()).cwds ?? [];
	} catch (err) {
		console.error("failed to load cwds", err);
	}
}

async function loadConfig(): Promise<void> {
	try {
		state.config = await api.config();
		renderConfig(dom.configGrid, state.config);
		dom.promptsCount.textContent = `${state.prompts.length}`;
		dom.skillsCount.textContent = `${state.skills.length}`;

		const select = dom.templateSelect;
		select.replaceChildren(
			el("option", { value: "", text: "prompt templates…" }),
		);
		for (const prompt of state.prompts)
			select.append(el("option", { value: prompt.name, text: prompt.name }));
	} catch (err) {
		console.error("failed to load config", err);
	}
}

async function loadResources(): Promise<void> {
	try {
		const [prompts, skills] = await Promise.all([api.prompts(), api.skills()]);
		state.prompts = prompts.prompts ?? [];
		state.skills = skills.skills ?? [];
		renderResourceList(dom.promptsList, state.prompts);
		renderResourceList(dom.skillsList, state.skills);
	} catch (err) {
		console.error("failed to load resources", err);
	}
}

// ----------------------------------------------------------- inspector ------
function setPanel(panel: InspectorPanel): void {
	state.inspectorPanel = panel;
	for (const tab of document.querySelectorAll(".inspector .tab[data-panel]")) {
		tab.classList.toggle("is-active", tab.getAttribute("data-panel") === panel);
	}
	dom.panelStats.classList.toggle("hidden", panel !== "stats");
	dom.panelTodos.classList.toggle("hidden", panel !== "todos");
	dom.panelLens.classList.toggle("hidden", panel !== "lens");
}

async function refreshInspector(): Promise<void> {
	if (!state.activeId) {
		dom.statsBody.replaceChildren(
			el("p", { class: "muted", text: "Open a session to see statistics." }),
		);
		dom.todosList.replaceChildren(
			el("li", { class: "muted", text: "Open a session to see its todos." }),
		);
		dom.lensBody.replaceChildren(
			el("p", {
				class: "muted",
				text: "Open a session to see pi-lens diagnostics.",
			}),
		);
		return;
	}
	const id = state.activeId;
	const summary = state.sessions.find((s) => s.id === id) ?? null;

	if (state.inspectorPanel === "stats") {
		try {
			const data = await api.sessionStats(id);
			state.stats = data.stats;
			renderStats(dom.statsBody, state.stats, summary);
			syncControlsFromStats();
		} catch (err) {
			dom.statsBody.replaceChildren(
				el("p", { class: "muted", text: errorMessage(err) }),
			);
		}
	} else if (state.inspectorPanel === "todos") {
		try {
			renderTodos(dom.todosList, await api.sessionTodos(id));
		} catch (err) {
			dom.todosList.replaceChildren(
				el("li", { class: "muted", text: errorMessage(err) }),
			);
		}
	} else {
		try {
			renderLens(dom.lensBody, (await api.sessionLens(id)).lens);
		} catch (err) {
			dom.lensBody.replaceChildren(
				el("p", { class: "muted", text: errorMessage(err) }),
			);
		}
	}
}

// ---------------------------------------------------------------- chat ------
/** A chat renderer wired to the "go to end" affordance. */
function makeRenderer(): ChatRenderer {
	const renderer = new ChatRenderer(dom.chatLog);
	renderer.onStickChange = (stick) => {
		if (dom.goEnd) dom.goEnd.classList.toggle("hidden", stick);
	};
	return renderer;
}

function setStatus(status: Status): void {
	state.status = status;
	const running = status === "running";
	const watching = status === "watching";
	// The status pill and composer hint were removed as duplicates: the activity wheel in the
	// chat header is the single place that reports what this session is doing.
	if (wheel) {
		if (watching) wheel.stop("watching");
		else if (!running) wheel.stop("idle");
	}
	dom.sendBtn.disabled = !state.activeId;
	dom.promptInput.disabled = !state.activeId;
	dom.abortBtn.disabled = !state.activeId || !running;
	dom.stopBtn.disabled = !state.activeId || watching;
}

function syncControlsFromStats(): void {
	// Reflect the session's real model/thinking in the header selects when known.
	const stats = state.stats;
	if (stats?.model) {
		const model = toText(stats.model);
		const option = [...dom.ctlModel.options].find((o) =>
			o.value.endsWith(`|${model}`),
		);
		if (option) dom.ctlModel.value = option.value;
	}
}

function openSession(id: string): void {
	if (state.stream) {
		state.stream.close();
		state.stream = null;
	}
	state.activeId = id;
	state.renderer = makeRenderer();
	state.renderer.reset();
	dom.chatId.textContent = id;
	dom.chatCwd.textContent = "";

	const summary = state.sessions.find((s) => s.id === id);
	if (summary) {
		dom.chatCwd.textContent = summary.cwd || "";
		setStatus(summary.status === "running" ? "running" : "idle");
	} else {
		setStatus("idle");
	}

	const stream = new SessionStream(id, {
		onEvent: (payload) => {
			if (payload.sessionId && payload.sessionId !== state.activeId) return;
			handlePiEvent(payload.data);
		},
		onLifecycle: (payload) => {
			if (payload.sessionId && payload.sessionId !== state.activeId) return;
			if (payload.state === "running") {
				setStatus("running");
			} else if (payload.state === "watching") {
				setStatus("watching");
				wheel?.stop("watching");
				state.renderer?.system(
					"live view — this session is running in another process; updates appear here as they happen",
				);
			} else if (payload.state === "exited" || payload.state === "error") {
				setStatus("idle");
				wheel?.stop(payload.state === "error" ? "error" : "idle");
				if (payload.state === "error")
					state.renderer?.error(payload.message || "pi child failed");
				else state.renderer?.system("pi child exited");
				if (payload.message && payload.state === "exited")
					state.renderer?.system(payload.message);
				void refreshInspector();
			} else {
				setStatus("idle");
				wheel?.stop("idle");
				state.renderer?.system("attached — send a prompt to resume");
			}
		},
		onError: () => {},
	});
	stream.open();
	state.stream = stream;

	closeDrawer();
	void refreshInspector();
	void loadSessions();
}

function handlePiEvent(event: Wire.PiEvent): void {
	if (!event || typeof event !== "object") return;
	state.renderer?.handle(event);
	const type = event.type;

	if (type === "observed_activity") {
		if (state.status !== "watching") setStatus("watching");
		return;
	}
	if (type.startsWith("observed")) return; // rendered; no live-child status change

	if (type === "agent_start") {
		setStatus("running");
		wheel?.start();
	} else if (type === "agent_end") {
		setStatus("idle");
		wheel?.stop("idle");
		void refreshInspector();
		void loadSessions();
	} else if (type === "tool_execution_start") {
		wheel?.note(toolLabel(event.toolName, event.args));
	} else if (type === "message_update") {
		const delta = asRecord(event.assistantMessageEvent);
		if (delta.type === "thinking_delta") wheel?.note("Thinking");
		else if (delta.type === "text_delta")
			wheel?.note("Writing the response", 2000);
		else if (delta.type === "toolcall_delta")
			wheel?.note("Preparing a tool call", 2000);
	} else if (type === "extension_error") {
		wheel?.fail("extension error");
	}
}

async function sendPrompt(message: string): Promise<void> {
	if (!state.activeId || !message.trim()) return;
	try {
		await api.prompt(state.activeId, message.trim());
	} catch (err) {
		state.renderer?.error(errorMessage(err));
		toast(errorMessage(err), true);
	}
}

// --------------------------------------------------------- session acts -----
async function applyModel(): Promise<void> {
	if (!state.activeId || !dom.ctlModel.value) return;
	const [provider = "", ...rest] = dom.ctlModel.value.split("|");
	try {
		await api.setModel(state.activeId, provider, rest.join("|"));
		toast(`model → ${rest.join("|")}`);
		void refreshInspector();
	} catch (err) {
		toast(errorMessage(err), true);
	}
}

async function applyThinking(): Promise<void> {
	const level = dom.ctlThinking.value;
	if (!state.activeId || !isThinkingLevel(level)) return;
	try {
		await api.setThinking(state.activeId, level);
		toast(`thinking → ${level}`);
	} catch (err) {
		toast(errorMessage(err), true);
	}
}

// ---------------------------------------------------------- new session -----
function populateModelOptions(): void {
	const entry = state.models.providers.find(
		(p) => p.name === dom.fProvider.value,
	);
	dom.fModel.replaceChildren();
	for (const model of entry ? entry.models : [])
		dom.fModel.append(el("option", { value: model.id, text: model.id }));
}

function openDialog(agent: Wire.AgentSummary | null): void {
	dom.fCwd.replaceChildren();
	for (const cwd of state.cwds)
		dom.fCwd.append(el("option", { value: cwd, text: cwd }));

	dom.fAgent.replaceChildren(
		el("option", { value: "", text: "default coding agent" }),
	);
	for (const a of state.agents)
		dom.fAgent.append(
			el("option", { value: a.name, text: `${a.name} (${a.source})` }),
		);
	if (agent) dom.fAgent.value = agent.name;

	dom.fProvider.replaceChildren();
	for (const p of state.models.providers)
		dom.fProvider.append(el("option", { value: p.name, text: p.name }));
	dom.fProvider.value = state.models.default.provider;
	populateModelOptions();
	if (state.models.default.model) dom.fModel.value = state.models.default.model;

	dom.dialogError.hidden = true;
	dom.newDialog.showModal();
}

async function submitDialog(event: SubmitEvent): Promise<void> {
	event.preventDefault();
	const thinking = dom.fThinking.value;
	const config: Wire.SpawnRequest = {
		cwd: dom.fCwd.value,
		agent: dom.fAgent.value || null,
		provider: dom.fProvider.value || null,
		model: dom.fModel.value || null,
		// Not a thinking level: left out (the server then uses its default).
		thinking: isThinkingLevel(thinking) ? thinking : undefined,
	};
	dom.dialogCreate.disabled = true;
	try {
		const data = await api.createSession(config);
		dom.newDialog.close();
		await loadSessions();
		if (data.session?.id) openSession(data.session.id);
		toast("session created");
	} catch (err) {
		dom.dialogError.textContent = errorMessage(err);
		dom.dialogError.hidden = false;
	} finally {
		dom.dialogCreate.disabled = false;
	}
}

// --------------------------------------------------------------- views ------
function setView(view: View): void {
	state.view = view;
	for (const item of document.querySelectorAll(".nav-item")) {
		item.classList.toggle("is-active", item.getAttribute("data-view") === view);
	}
	dom.sessionsView.classList.toggle("hidden", view !== "sessions");
	dom.agentsView.classList.toggle("hidden", view !== "agents");
	dom.configView.classList.toggle("hidden", view !== "config");
	if (view !== "sessions" && dom.sidebar.classList.contains("is-open"))
		closeDrawer();
}

// ---------------------------------------------------------------- init ------
/** The page's elements, looked up once by id (camel-cased: "chat-log" is `chatLog`). */
function cacheDom() {
	return {
		drawerToggle: byId("drawer-toggle", HTMLButtonElement),
		wheel: byId("wheel", HTMLElement),
		wheelLabel: byId("wheel-label", HTMLElement),
		chatElapsed: byId("chat-elapsed", HTMLElement),
		sidebar: byId("sidebar", HTMLElement),
		newSession: byId("new-session", HTMLButtonElement),
		sessionFilter: byId("session-filter", HTMLInputElement),
		sessionList: byId("session-list", HTMLElement),
		sessionsView: byId("sessions-view", HTMLElement),
		chatId: byId("chat-id", HTMLElement),
		chatCwd: byId("chat-cwd", HTMLElement),
		ctlModel: byId("ctl-model", HTMLSelectElement),
		ctlThinking: byId("ctl-thinking", HTMLSelectElement),
		btnFork: byId("btn-fork", HTMLButtonElement),
		btnNew: byId("btn-new", HTMLButtonElement),
		abortBtn: byId("abort-btn", HTMLButtonElement),
		stopBtn: byId("stop-btn", HTMLButtonElement),
		chatLog: byId("chat-log", HTMLElement),
		goEnd: byId("go-end", HTMLButtonElement),
		composer: byId("composer", HTMLFormElement),
		templateSelect: byId("template-select", HTMLSelectElement),
		templateInsert: byId("template-insert", HTMLButtonElement),
		promptInput: byId("prompt-input", HTMLTextAreaElement),
		sendBtn: byId("send-btn", HTMLButtonElement),
		agentsView: byId("agents-view", HTMLElement),
		newAgent: byId("new-agent", HTMLButtonElement),
		agentGrid: byId("agent-grid", HTMLElement),
		configView: byId("config-view", HTMLElement),
		configGrid: byId("config-grid", HTMLElement),
		promptsCount: byId("prompts-count", HTMLElement),
		promptsList: byId("prompts-list", HTMLElement),
		skillsCount: byId("skills-count", HTMLElement),
		skillsList: byId("skills-list", HTMLElement),
		inspector: byId("inspector", HTMLElement),
		panelStats: byId("panel-stats", HTMLElement),
		statsBody: byId("stats-body", HTMLElement),
		panelTodos: byId("panel-todos", HTMLElement),
		todosList: byId("todos-list", HTMLElement),
		panelLens: byId("panel-lens", HTMLElement),
		lensBody: byId("lens-body", HTMLElement),
		inspectorClose: byId("inspector-close", HTMLButtonElement),
		footerHealth: byId("footer-health", HTMLElement),
		footerCount: byId("footer-count", HTMLElement),
		newDialog: byId("new-dialog", HTMLDialogElement),
		newForm: byId("new-form", HTMLFormElement),
		fCwd: byId("f-cwd", HTMLSelectElement),
		fAgent: byId("f-agent", HTMLSelectElement),
		fProvider: byId("f-provider", HTMLSelectElement),
		fModel: byId("f-model", HTMLSelectElement),
		fThinking: byId("f-thinking", HTMLSelectElement),
		dialogError: byId("dialog-error", HTMLElement),
		dialogCreate: byId("dialog-create", HTMLButtonElement),
		unlockDialog: byId("unlock-dialog", HTMLDialogElement),
		unlockForm: byId("unlock-form", HTMLFormElement),
		unlockInput: byId("unlock-input", HTMLInputElement),
		unlockError: byId("unlock-error", HTMLElement),
		drawerScrim: byId("drawer-scrim", HTMLElement),
		toast: byId("toast", HTMLElement),
		toggleSidebar: byId("toggle-sidebar", HTMLButtonElement),
		toggleInspector: byId("toggle-inspector", HTMLButtonElement),
		toggleComposer: byId("toggle-composer", HTMLButtonElement),
	};
}

type Dom = ReturnType<typeof cacheDom>;

function wireEvents(): void {
	for (const item of document.querySelectorAll(".nav-item")) {
		item.addEventListener("click", () => {
			const view = item.getAttribute("data-view");
			if (isView(view)) setView(view);
		});
	}
	for (const tab of document.querySelectorAll(".inspector .tab[data-panel]")) {
		tab.addEventListener("click", () => {
			const panel = tab.getAttribute("data-panel");
			if (!isInspectorPanel(panel)) return;
			setPanel(panel);
			void refreshInspector();
		});
	}
	for (const button of document.querySelectorAll("[data-close-dialog]")) {
		button.addEventListener("click", () =>
			byId(button.getAttribute("data-close-dialog") ?? "", HTMLDialogElement).close(),
		);
	}

	dom.drawerToggle.addEventListener("click", () => {
		const open = dom.sidebar.classList.toggle("is-open");
		dom.drawerScrim.classList.toggle("hidden", !open);
	});
	dom.toggleSidebar.addEventListener("click", () => {
		if (isNarrow()) {
			const open = dom.sidebar.classList.toggle("is-open");
			dom.drawerScrim.classList.toggle("hidden", !open);
			return;
		}
		togglePanel("sidebar");
	});
	dom.toggleInspector.addEventListener("click", () => {
		if (isNarrow()) {
			dom.inspector.classList.toggle("is-open");
			return;
		}
		togglePanel("inspector");
	});
	dom.toggleComposer.addEventListener("click", () => togglePanel("composer"));
	dom.drawerScrim.addEventListener("click", closeDrawer);
	dom.inspectorClose.addEventListener("click", () =>
		dom.inspector.classList.remove("is-open"),
	);
	const statusbar = document.querySelector(".statusbar");
	if (!statusbar) throw new Error(".statusbar is missing");
	statusbar.addEventListener("click", () => {
		if (isNarrow()) dom.inspector.classList.toggle("is-open");
	});

	dom.newSession.addEventListener("click", () => openDialog(null));
	dom.newForm.addEventListener("submit", detached(submitDialog));
	dom.fProvider.addEventListener("change", populateModelOptions);
	dom.sessionFilter.addEventListener("input", detached(loadSessions));
	dom.newAgent.addEventListener("click", () =>
		void agentEditor?.open(null, state.tools),
	);

	dom.ctlModel.addEventListener("change", detached(applyModel));
	dom.ctlThinking.addEventListener("change", detached(applyThinking));

	dom.btnFork.addEventListener("click", detached(async () => {
		if (!state.activeId) return;
		try {
			await api.fork(state.activeId);
			toast("session forked");
			await loadSessions();
		} catch (err) {
			toast(errorMessage(err), true);
		}
	}));

	dom.btnNew.addEventListener("click", detached(async () => {
		if (!state.activeId) return;
		if (
			!window.confirm(
				"Start a fresh session in this child? The transcript view will reset.",
			)
		)
			return;
		try {
			await api.newSessionInPlace(state.activeId);
			state.renderer?.reset();
			toast("session reset");
		} catch (err) {
			toast(errorMessage(err), true);
		}
	}));

	dom.composer.addEventListener("submit", detached(async (event) => {
		event.preventDefault();
		const message = dom.promptInput.value;
		dom.promptInput.value = "";
		await sendPrompt(message);
	}));

	dom.promptInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			dom.composer.requestSubmit();
		}
	});

	dom.templateInsert.addEventListener("click", () => {
		const name = dom.templateSelect.value;
		if (!name) return;
		const value = dom.promptInput.value;
		dom.promptInput.value = `${value ? `${value.trimEnd()}\n` : ""}/${name} `;
		dom.promptInput.focus();
	});

	dom.abortBtn.addEventListener("click", detached(async () => {
		if (!state.activeId) return;
		try {
			await api.abort(state.activeId);
		} catch (err) {
			state.renderer?.error(errorMessage(err));
		}
	}));

	dom.stopBtn.addEventListener("click", detached(async () => {
		if (!state.activeId) return;
		try {
			await api.stop(state.activeId);
			state.renderer?.system("stop requested");
		} catch (err) {
			state.renderer?.error(errorMessage(err));
		}
	}));

	// "go to end": visible whenever the reader has scrolled away from the newest message.
	dom.goEnd.addEventListener("click", () => {
		if (state.renderer) state.renderer.goToEnd();
	});
}

let agentEditor: AgentEditor | undefined;

async function init(): Promise<void> {
	dom = cacheDom();
	// Escape must not dismiss the token prompt: nothing works until it is answered.
	dom.unlockDialog.addEventListener("cancel", (event) => event.preventDefault());
	await ensureAccess();
	state.renderer = makeRenderer();
	agentEditor = new AgentEditor({
		tools: state.tools,
		onSaved: loadAgents,
		toast,
	});
	wireEvents();
	setView("sessions");
	setPanel("stats");
	setStatus("idle");
	loadPanels();
	applyPanels();
	wheel = new ActivityWheel(dom.wheelLabel, dom.wheel);
	state.renderer.emptyState();

	await Promise.all([pollHealth(), loadCwds(), loadModels()]);
	await Promise.all([loadAgents(), loadSessions(), loadResources()]);
	await loadConfig();

	state.timers.health = setInterval(pollHealth, 10000);
	state.timers.sessions = setInterval(() => {
		if (state.view === "sessions" && !document.hidden) void loadSessions();
	}, 5000);
	state.timers.stats = setInterval(() => {
		if (state.activeId && !document.hidden) void refreshInspector();
	}, 4000);
	state.timers.elapsed = setInterval(() => {
		dom.chatElapsed.textContent = wheel?.busy ? formatElapsed(wheel.startedAt) : "";
	}, 1000);
}

let wheel: ActivityWheel | null = null;
void init();
