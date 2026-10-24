// Generated from packages/web-ui/src/public/js/panels.ts by `npm run build:web` (internal/docs/adr/0002).
// Edit the TypeScript source, not this file.
// panels.ts — renderers for the inspector (stats / todos / lens) and the Config view.
import { clear, el } from "./render.js";
import { formatCost, formatTokens } from "./activity.js";
import { asRecord, displayText, isArray, isObject, toText } from "./guards.js";
function kv(rows) {
    const list = el("dl", { class: "kv" });
    for (const row of rows) {
        if (!row)
            continue;
        if ("section" in row) {
            list.append(el("div", { class: "kv-section", text: row.section }));
            continue;
        }
        list.append(el("dt", { text: row.k }));
        list.append(el("dd", { class: row.className || "", text: row.v }));
    }
    return list;
}
function contextBar(percent) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    const cls = clamped >= 90 ? "high" : clamped >= 70 ? "mid" : "";
    return el("div", { class: "bar" }, [
        el("div", { class: "bar-fill " + cls, style: `width:${clamped}%` }),
    ]);
}
/** Session token/cost/context statistics. */
export function renderStats(bodyNode, stats, summary) {
    clear(bodyNode);
    if (!stats) {
        bodyNode.append(el("p", { class: "muted", text: "No statistics yet." }));
        return;
    }
    const tokens = asRecord(stats.tokens);
    const ctx = stats.contextUsage;
    const rows = [
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
        bodyNode.append(el("div", { class: "muted mono-sm" }, [
            `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}  (${toText(usage.percent ?? "?")}%)`,
        ]));
        bodyNode.append(contextBar(usage.percent));
    }
}
/** Session todo list with progress. */
export function renderTodos(listNode, data) {
    clear(listNode);
    if (!data?.exists) {
        listNode.append(el("li", { class: "muted", text: "No todo file for this session." }));
        return;
    }
    const todos = (isArray(data.todos) ? data.todos : []).map(asRecord);
    const done = todos.filter((t) => t.state === "done").length;
    const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;
    listNode.append(el("li", { class: "muted mono-sm", text: `${done}/${todos.length} done` }), el("li", {}, [
        el("div", { class: "progress" }, [
            el("div", { class: "progress-fill", style: `width:${pct}%` }),
        ]),
    ]));
    for (const todo of todos) {
        const mark = todo.state === "done" ? "[x]" : todo.state === "active" ? "[~]" : "[ ]";
        listNode.append(el("li", { class: `todo-item todo-${toText(todo.state)}` }, [
            el("span", { class: "todo-mark", text: mark }),
            el("span", { class: "todo-text", text: displayText(todo.text) }),
        ]));
    }
}
/** pi-lens diagnostics for this session. */
/** A lens timestamp (ISO string or epoch ms) as a local time. */
function lensTime(value) {
    if (!value || (typeof value !== "string" && typeof value !== "number"))
        return "—";
    return new Date(value).toLocaleTimeString();
}
export function renderLens(bodyNode, lens) {
    clear(bodyNode);
    if (!lens?.available) {
        bodyNode.append(el("p", {
            class: "muted",
            text: "No pi-lens state recorded for this session yet.",
        }));
        return;
    }
    const totals = asRecord(lens.totals);
    const files = isArray(lens.files) ? lens.files : [];
    const cache = asRecord(lens.cache);
    bodyNode.append(kv([
        {
            k: "captured",
            v: lensTime(lens.savedAt),
        },
        { k: "files", v: String(files.length) },
        { section: "diagnostics" },
        {
            k: "blocking",
            v: displayText(totals.blocking || 0),
            className: totals.blocking ? "warn" : "good",
        },
        {
            k: "errors",
            v: displayText(totals.errors || 0),
            className: totals.errors ? "warn" : "good",
        },
        {
            k: "warnings",
            v: displayText(totals.warnings || 0),
            className: totals.warnings ? "warn" : "good",
        },
        { section: "cache" },
        {
            k: "quality files",
            v: displayText(cache.qualityWarnings || 0),
        },
        { k: "findings", v: displayText(cache.findings || 0) },
    ]));
    const dirty = files
        .filter(isObject)
        .filter((f) => f.blocking || f.errors || f.warnings);
    if (dirty.length) {
        bodyNode.append(el("div", { class: "kv-section", text: "files with findings" }));
        const list = el("ul", { class: "todo-list" });
        for (const file of dirty.slice(0, 40)) {
            list.append(el("li", { class: "todo-item" }, [
                el("span", { class: "todo-mark", text: `${displayText(file.errors || 0)}E` }),
                el("span", {
                    class: "todo-text",
                    text: `${displayText(file.filePath).split("/").slice(-2).join("/")}  (${displayText(file.warnings || 0)}W)`,
                }),
            ]));
        }
        bodyNode.append(list);
    }
}
/** Installation configuration cards. */
export function renderConfig(gridNode, config) {
    clear(gridNode);
    if (!config)
        return;
    const card = (title, rows) => {
        const body = el("div", { class: "config-card" }, [
            el("h3", { text: title }),
        ]);
        for (const [key, value] of rows) {
            body.append(el("div", { class: "mono-sm" }, [
                el("span", { class: "muted", text: `${key}: ` }),
                el("span", { text: displayText(value ?? "—") }),
            ]));
        }
        return body;
    };
    const app = asRecord(config.app);
    const cli = asRecord(config.cli);
    const settings = asRecord(config.settings);
    const paths = asRecord(config.paths);
    const agentDirs = isArray(paths.agentDirs) ? paths.agentDirs : [];
    const lens = asRecord(config.lens);
    const turn = lens.turn ? asRecord(lens.turn) : null;
    const models = isArray(config.models) ? config.models : [];
    gridNode.append(card("console", [
        ["version", app.version],
        ["node", app.node],
        ["platform", app.platform],
        ["listening", `${toText(app.host)}:${toText(app.port)}`],
    ]), card("pi cli", [
        ["binary", cli.binary],
        ["home", cli.piHome],
        ["settings", cli.settingsFile],
        ["models", cli.modelsFile],
        ["sessions", cli.sessionsDir],
    ]), card("defaults", [
        ["provider", settings.defaultProvider],
        ["model", settings.defaultModel],
        ["thinking", settings.defaultThinkingLevel],
        ["theme", settings.theme],
        ["packages", settings.packages],
    ]), card("paths", [
        ["kit root", paths.kitRoot],
        ["user agents", agentDirs[0]],
        ["project agents", agentDirs[1]],
        ["lens", paths.lensDir],
    ]), card("pi-lens", [
        ["present", lens.present ? "yes" : "no"],
        ["session files", lens.sessionCount],
        ["turn cycles", turn ? turn.cycles : "—"],
        ["tracked files", turn ? turn.files : "—"],
    ]), card("models", models.map((p) => {
        const provider = asRecord(p);
        return [toText(provider.name), isArray(provider.models) ? provider.models.length : undefined];
    })));
}
/** Prompt templates / skills list. */
export function renderResourceList(listNode, items) {
    clear(listNode);
    if (!items?.length) {
        listNode.append(el("li", { class: "muted", text: "None found." }));
        return;
    }
    for (const item of items) {
        listNode.append(el("li", {}, [
            el("div", { class: "resource-name", text: displayText(item.name) }),
            item.description
                ? el("div", { class: "resource-desc", text: displayText(item.description) })
                : null,
        ]));
    }
}
