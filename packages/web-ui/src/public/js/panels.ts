// panels.ts — renderers for the inspector (stats / todos) and the Config view.
import { clear, el, type SessionSummary } from "./render.ts";
import { formatCost, formatTokens } from "./activity.ts";
import { asRecord, displayText, isArray, toText } from "./guards.ts";

// ------------------------------------------------------------ wire shapes --
// What the server sends for each panel, as the renderers read it. Untrusted JSON: every field is
// unknown and narrowed where it is read, so a parsed record satisfies these types as it is.

/** GET /api/sessions/:id/stats → `stats` (a live child's or one read from the session file). */
export interface StatsData {
	readonly live?: unknown;
	readonly model?: unknown;
	readonly provider?: unknown;
	readonly userMessages?: unknown;
	readonly assistantMessages?: unknown;
	readonly toolCalls?: unknown;
	readonly totalMessages?: unknown;
	/** {input, output, cacheRead, cacheWrite, total} */
	readonly tokens?: unknown;
	readonly cost?: unknown;
	/** {tokens, contextWindow, percent} */
	readonly contextUsage?: unknown;
}

/** GET /api/sessions/:id/todos: `todos` is a list of {state, text}. */
export interface TodoData {
	readonly exists?: unknown;
	readonly todos?: unknown;
}

/** GET /api/config: the installation's sections, each a record of display values. */
export interface ConfigData {
	readonly app?: unknown;
	readonly cli?: unknown;
	readonly settings?: unknown;
	readonly paths?: unknown;
	/** [{name, models: [...]}] */
	readonly models?: unknown;
}

/** A prompt template or skill. */
export interface ResourceItem {
	readonly name?: unknown;
	readonly description?: unknown;
}

type KvRow = { readonly section: string } | { readonly k: string; readonly v: string; readonly className?: string };

function kv(rows: readonly (KvRow | null)[]): HTMLElement {
	const list = el("dl", { class: "kv" });
	for (const row of rows) {
		if (!row) continue;
		if ("section" in row) {
			list.append(el("div", { class: "kv-section", text: row.section }));
			continue;
		}
		list.append(el("dt", { text: row.k }));
		list.append(el("dd", { class: row.className || "", text: row.v }));
	}
	return list;
}

function contextBar(percent: unknown): HTMLElement {
	if (typeof percent !== "number" || !Number.isFinite(percent))
		return el("div", { class: "bar unknown" });
	const clamped = Math.max(0, Math.min(100, percent));
	const cls = clamped >= 90 ? "high" : clamped >= 70 ? "mid" : "";
	return el("div", { class: "bar" }, [
		el("div", { class: "bar-fill " + cls, style: `width:${clamped}%` }),
	]);
}

/** Session token/cost/context statistics. */
export function renderStats(
	bodyNode: Element,
	stats: StatsData | null | undefined,
	summary?: SessionSummary | null,
): void {
	clear(bodyNode);
	if (!stats) {
		bodyNode.append(el("p", { class: "muted", text: "No statistics yet." }));
		return;
	}
	const tokens = asRecord(stats.tokens);
	const ctx = stats.contextUsage;
	const rows: (KvRow | null)[] = [
		{
			k: "source",
			v: stats.live ? "live child" : "session file",
			className: stats.live ? "good" : "",
		},
		summary ? { k: "session", v: displayText(summary.id) } : null,
		summary ? { k: "cwd", v: displayText(summary.cwd || "—") } : null,
		{
			k: "model",
			v: displayText(stats.model || summary?.model || "—"),
			className: "accent",
		},
		{ k: "provider", v: displayText(stats.provider || "—") },
		{ section: "messages" },
		{ k: "user", v: toText(stats.userMessages ?? 0) },
		{ k: "assistant", v: toText(stats.assistantMessages ?? 0) },
		{ k: "tool calls", v: toText(stats.toolCalls ?? 0) },
		{ k: "total", v: toText(stats.totalMessages ?? 0) },
		{ section: "tokens" },
		{ k: "input", v: formatTokens(tokens.input) },
		{ k: "output", v: formatTokens(tokens.output) },
		{ k: "cache read", v: formatTokens(tokens.cacheRead) },
		{ k: "cache write", v: formatTokens(tokens.cacheWrite) },
		{ k: "total", v: formatTokens(tokens.total) },
		{ k: "cost", v: formatCost(stats.cost) },
	];
	bodyNode.append(kv(rows));

	if (ctx) {
		const usage = asRecord(ctx);
		bodyNode.append(el("div", { class: "kv-section", text: "context window" }));
		bodyNode.append(
			el("div", { class: "muted mono-sm" }, [
				`${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}  (${toText(usage.percent ?? "?")}%)`,
			]),
		);
		bodyNode.append(contextBar(usage.percent));
	}
}

/** Session todo list with progress. */
export function renderTodos(listNode: Element, data: TodoData | null | undefined): void {
	clear(listNode);
	if (!data?.exists) {
		listNode.append(
			el("li", { class: "muted", text: "No todo file for this session." }),
		);
		return;
	}
	const todos = (isArray(data.todos) ? data.todos : []).map(asRecord);
	const done = todos.filter((t) => t.state === "done").length;
	const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;
	listNode.append(
		el("li", { class: "muted mono-sm", text: `${done}/${todos.length} done` }),
		el("li", {}, [
			el("div", { class: "progress" }, [
				el("div", { class: "progress-fill", style: `width:${pct}%` }),
			]),
		]),
	);
	for (const todo of todos) {
		const mark =
			todo.state === "done" ? "[x]" : todo.state === "active" ? "[~]" : "[ ]";
		listNode.append(
			el("li", { class: `todo-item todo-${toText(todo.state)}` }, [
				el("span", { class: "todo-mark", text: mark }),
				el("span", { class: "todo-text", text: displayText(todo.text) }),
			]),
		);
	}
}

/** Installation configuration cards. */
export function renderConfig(gridNode: Element, config: ConfigData | null | undefined): void {
	clear(gridNode);
	if (!config) return;
	const card = (title: string, rows: readonly (readonly [string, unknown])[]): HTMLElement => {
		const body = el("div", { class: "config-card" }, [
			el("h3", { text: title }),
		]);
		for (const [key, value] of rows) {
			body.append(
				el("div", { class: "mono-sm" }, [
					el("span", { class: "muted", text: `${key}: ` }),
					el("span", { text: displayText(value ?? "—") }),
				]),
			);
		}
		return body;
	};

	const app = asRecord(config.app);
	const cli = asRecord(config.cli);
	const settings = asRecord(config.settings);
	const paths = asRecord(config.paths);
	const agentDirs = isArray(paths.agentDirs) ? paths.agentDirs : [];
	const models = isArray(config.models) ? config.models : [];
	gridNode.append(
		card("console", [
			["version", app.version],
			["node", app.node],
			["platform", app.platform],
			["listening", `${toText(app.host)}:${toText(app.port)}`],
		]),
		card("pi cli", [
			["binary", cli.binary],
			["home", cli.piHome],
			["settings", cli.settingsFile],
			["models", cli.modelsFile],
			["sessions", cli.sessionsDir],
		]),
		card("defaults", [
			["provider", settings.defaultProvider],
			["model", settings.defaultModel],
			["thinking", settings.defaultThinkingLevel],
			["theme", settings.theme],
			["packages", settings.packages],
		]),
		card("paths", [
			["kit root", paths.kitRoot],
			["user agents", agentDirs[0]],
			["project agents", agentDirs[1]],
		]),
		card(
			"models",
			models.map((p): [string, unknown] => {
				const provider = asRecord(p);
				return [toText(provider.name), isArray(provider.models) ? provider.models.length : undefined];
			}),
		),
	);
}

/** Prompt templates / skills list. */
export function renderResourceList(
	listNode: Element,
	items: readonly ResourceItem[] | null | undefined,
): void {
	clear(listNode);
	if (!items?.length) {
		listNode.append(el("li", { class: "muted", text: "None found." }));
		return;
	}
	for (const item of items) {
		listNode.append(
			el("li", {}, [
				el("div", { class: "resource-name", text: displayText(item.name) }),
				item.description
					? el("div", { class: "resource-desc", text: displayText(item.description) })
					: null,
			]),
		);
	}
}
