import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple, type Api, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import path from "node:path";
import {
  MEMORY_TYPES,
  appendRecap,
  findMemory,
  forgetMemory,
  loadConfig,
  loadIndex,
  logError,
  migrateMemoryLocal,
  recentRecaps,
  resolveProject,
  saveMemory,
  searchMemories,
  type VaultConfig,
} from "./vault.ts";
import { AUTO_PROMOTE_TYPES, RECAP_SYSTEM, digestTurn, isTrivial, parseRecap, recapPrompt, type Completer } from "./recap.ts";

// memory-vault: durable memory in an Obsidian-compatible vault (default ~/.pi/vault).
//
//  - Agent-invoked memory: memory_save / memory_search / memory_forget tools, /remember and
//    /memory commands, and the `memory` skill that says when to use them.
//  - Automatic memory: after each substantive turn a small model writes a recap (what was
//    done, what is next) into Projects/<project>/Recaps/<date>.md; flagged decisions,
//    preferences and gotchas are promoted to memory notes (deduplicated).
//  - Recall: the first prompt of a session gets "where we left off" (recent recaps + pinned
//    memories); every prompt gets at most a few memories that clear a relevance floor. Both
//    are injected as a hidden message (never the system prompt, which would break caching),
//    and a memory is injected at most once per session.
//
// Subagent children never recap or recall: they are isolated from the operator's history.

const isChild = () => process.env.PI_KIT_INTERNAL_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "1";
const RECALL_CHARS = 2400; // ~600 tokens for the continuity + recall message

export interface MemoryVaultDeps {
  complete?: Completer;
  now?: () => Date;
}

function text(content: string, isError = false) {
  return { content: [{ type: "text" as const, text: content }], details: undefined, ...(isError ? { isError: true } : {}) };
}

// Default completer: the configured recap model ("provider/id"), else the session model.
function modelCompleter(ctx: ExtensionContext, cfg: VaultConfig): Completer | null {
  // ctx.model is Model<any> in pi's types; the registry's find() returns Model<Api>. Pin the
  // local to Model<Api> so the any does not flow into getApiKeyAndHeaders/completeSimple.
  let model: Model<Api> | undefined = ctx.model;
  if (cfg.recapModel) {
    const slash = cfg.recapModel.indexOf("/");
    const found = slash > 0 ? ctx.modelRegistry.find(cfg.recapModel.slice(0, slash), cfg.recapModel.slice(slash + 1)) : undefined;
    if (found) model = found;
  }
  if (!model) return null;
  const chosen = model;
  const registry = ctx.modelRegistry;
  return async (system, prompt, signal) => {
    const auth = await registry.getApiKeyAndHeaders(chosen);
    if (!auth.ok) throw new Error(`no request auth for ${chosen.provider}: ${auth.error}`);
    const headers = auth.headers ? Object.fromEntries(Object.entries(auth.headers).filter((e): e is [string, string] => typeof e[1] === "string")) : undefined;
    // exactOptionalPropertyTypes: omit the optional fields rather than assigning explicit undefined.
    const options: SimpleStreamOptions = {
      maxTokens: 1200,
      ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
    const reply = await completeSimple(
      chosen,
      { systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      options,
    );
    return reply.content
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n");
  };
}

function formatHits(hits: ReturnType<typeof searchMemories>): string {
  return hits.map((h) => `- **${h.meta.title}** (${h.meta.type}${h.meta.scope === "global" ? ", global" : ""}) — ${h.snippet.replace(/\s+/g, " ").slice(0, 300)} [${h.rel}]`).join("\n");
}

export function createMemoryVault(pi: ExtensionAPI, deps: MemoryVaultDeps = {}): void {
  let cfg: VaultConfig = loadConfig();
  let project = "default";
  let firstPrompt = true;
  const injected = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  const now = deps.now ?? (() => new Date());

  pi.on("session_start", async (_event, ctx) => {
    cfg = loadConfig();
    project = resolveProject(cfg.root, ctx.cwd, (message) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    });
    // A child (e.g. a workflow's "remember" step) may use the tools, which need the project;
    // it never recalls, recaps or migrates.
    if (isChild()) return;
    firstPrompt = true;
    injected.clear();
    try {
      const migrated = migrateMemoryLocal(cfg.root, project);
      if (migrated > 0 && ctx.hasUI) ctx.ui.notify(`memory-vault: imported ${migrated} memories from memory-local into ${cfg.root}`, "info");
    } catch (error) {
      logError(cfg.root, `migration failed: ${String(error)}`);
    }
  });

  pi.on("session_compact", async () => {
    // Injected memories may have been summarised away; allow them again.
    injected.clear();
  });

  pi.on("before_agent_start", async (event) => {
    if (isChild()) return undefined;
    const blocks: string[] = [];
    try {
      if (firstPrompt) {
        const recaps = recentRecaps(cfg.root, project, 3);
        const pinned = [...loadIndex(cfg.root).entries()].filter(([rel, e]) => e.meta.pinned && (e.meta.scope === "global" || rel.startsWith(path.join("Projects", project) + path.sep)));
        if (recaps.length) blocks.push(`### Where we left off (${project})\n\n${recaps.map((r) => `${r.date} ${r.text.replace(/^## /, "")}`).join("\n\n")}`);
        if (pinned.length) {
          blocks.push(`### Pinned memories\n\n${pinned.map(([rel, e]) => `- **${e.meta.title}** [${rel}]`).join("\n")}`);
          for (const [rel] of pinned) injected.add(rel);
        }
      }
      firstPrompt = false;
      // A run started by an extension's custom message (pi 1.2+) has no prompt to recall against.
      const hits = searchMemories(cfg.root, "prompt" in event ? event.prompt : "", { project, limit: cfg.recallLimit + injected.size, minScore: cfg.minScore, gate: true })
        .filter((h) => !injected.has(h.rel))
        .slice(0, cfg.recallLimit);
      if (hits.length) {
        blocks.push(`### Relevant memories\n\n${formatHits(hits)}`);
        for (const h of hits) injected.add(h.rel);
      }
    } catch (error) {
      logError(cfg.root, `recall failed: ${String(error)}`);
      return undefined;
    }
    if (blocks.length === 0) return undefined;
    let content = `[Memory vault ${cfg.root} — recalled automatically; verify before relying on it]\n\n${blocks.join("\n\n")}`;
    if (content.length > RECALL_CHARS) content = `${content.slice(0, RECALL_CHARS)}\n[… truncated; use memory_search for more]`;
    return { message: { customType: "memory-recall", content, display: false } };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (isChild() || !cfg.recaps) return;
    const messages: readonly unknown[] = event.messages ?? [];
    const digest = digestTurn(messages);
    if (!digest || isTrivial(digest)) return;
    if (pending >= 2) return; // a backlog means the recap model is slow or failing: drop, don't pile up
    const complete = deps.complete ?? modelCompleter(ctx, cfg);
    if (!complete) return;
    const root = cfg.root;
    const proj = project;
    const autoPromote = cfg.autoPromote;
    let sessionId: string | undefined;
    try {
      sessionId = ctx.sessionManager.getSessionId?.();
    } catch {
      /* optional */
    }
    pending++;
    queue = queue
      .then(async () => {
        const raw = await complete(RECAP_SYSTEM, recapPrompt(digest, proj), AbortSignal.timeout(90_000));
        const parsed = parseRecap(raw, digest);
        if (!parsed) {
          logError(root, `recap: unparseable model output: ${raw.slice(0, 200)}`);
          return;
        }
        appendRecap(root, proj, parsed.recap, now(), sessionId);
        // Model-derived candidates stay in this project: only an explicit save makes a memory global.
        if (autoPromote) {
          for (const c of parsed.candidates.filter((c) => AUTO_PROMOTE_TYPES.has(c.type))) {
            saveMemory(root, { title: c.title, body: c.body, type: c.type, scope: "project", project: proj, source: "recap" });
          }
        }
        try {
          if (ctx.hasUI) ctx.ui.setStatus("memory", `recap: ${parsed.recap.title}`);
        } catch {
          /* the session may have moved on */
        }
      })
      .catch((error: unknown) => logError(root, `recap failed: ${String(error)}`))
      .finally(() => {
        pending--;
      });
  });

  pi.on("session_shutdown", async () => {
    // Give an in-flight recap a moment to land instead of losing the last turn's recap.
    if (pending > 0) await Promise.race([queue, new Promise((r) => setTimeout(r, 5000))]);
  });

  const TypeEnum = Type.Union(MEMORY_TYPES.map((t) => Type.Literal(t)));

  pi.registerTool({
    name: "memory_save",
    label: "Memory save",
    description:
      "Save a durable memory to the vault (Obsidian-compatible markdown). Use when the user says to remember something, states a preference, or a non-obvious decision/gotcha should persist across sessions. Updates an existing memory instead of duplicating it. Do not save what the code or git history already records.",
    promptSnippet: "Save something to long-term memory (preferences, decisions, gotchas)",
    parameters: Type.Object({
      title: Type.String({ description: "Short title (becomes the note name)" }),
      content: Type.String({ description: "The memory itself: the fact, and for decisions/gotchas the why and how to apply it" }),
      type: Type.Optional(TypeEnum),
      tags: Type.Optional(Type.Array(Type.String())),
      scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")], { description: "project (default) or global (applies in every project, e.g. personal preferences)" })),
      pinned: Type.Optional(Type.Boolean({ description: "Show at the start of every session in this project" })),
    }),
    async execute(_id, params) {
      try {
        // exactOptionalPropertyTypes: omit optionals the caller left unset rather than passing undefined.
        const r = saveMemory(cfg.root, {
          title: params.title,
          body: params.content,
          project,
          source: "agent",
          ...(params.type !== undefined ? { type: params.type } : {}),
          ...(params.tags !== undefined ? { tags: params.tags } : {}),
          ...(params.scope !== undefined ? { scope: params.scope } : {}),
          ...(params.pinned !== undefined ? { pinned: params.pinned } : {}),
        });
        return text(`Memory ${r.action}: ${r.rel}`);
      } catch (error) {
        return text(`memory_save failed: ${String(error)}`, true);
      }
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory search",
    description: "Search saved memories (this project and global) by keywords. Returns titles, types, snippets and note paths.",
    promptSnippet: "Search long-term memory",
    parameters: Type.Object({
      query: Type.String(),
      scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global"), Type.Literal("all")])),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const hits = searchMemories(cfg.root, params.query, { project, limit: Math.max(1, Math.min(Number(params.limit) || 8, 25)), ...(params.scope !== undefined ? { scope: params.scope } : {}) });
      return text(hits.length ? formatHits(hits) : "No matching memories.");
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory forget",
    description: "Forget a memory by id, name or path (moved to the vault's .trash, recoverable). Use when the user says a memory is wrong or asks to forget it.",
    promptSnippet: "Forget a saved memory",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      const rel = forgetMemory(cfg.root, params.id, project);
      return rel ? text(`Forgot ${rel} (moved to .trash).`) : text(`No memory matches "${params.id}".`, true);
    },
  });

  pi.registerCommand("remember", {
    description: "Save a memory: /remember <text>. Prefix with 'global:' for a memory that applies in every project.",
    handler: async (args, ctx) => {
      let raw = args.trim();
      if (!raw) {
        ctx.ui.notify("Usage: /remember <text>   (e.g. /remember global: I prefer small commits)", "warning");
        return;
      }
      let scope: "project" | "global" = "project";
      if (/^global:\s*/i.test(raw)) {
        scope = "global";
        raw = raw.replace(/^global:\s*/i, "");
      }
      const title = (raw.split(/[.\n]/)[0] ?? "").split(/\s+/).slice(0, 10).join(" ");
      const r = saveMemory(cfg.root, { title, body: raw, scope, project, source: "user", type: /\b(prefer|always|never|don't|do not)\b/i.test(raw) ? "preference" : "fact" });
      ctx.ui.notify(`Memory ${r.action}: ${r.rel}`, "info");
    },
  });

  pi.registerCommand("memory", {
    description: "Memory vault: /memory [status|recent|search <q>|forget <id>|migrate]",
    getArgumentCompletions: (prefix: string) => ["status", "recent", "search ", "forget ", "migrate"].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v.trim() })),
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const arg = rest.join(" ");
      const show = (s: string) => ctx.ui.notify(s, "info");
      if (!sub || sub === "status") {
        const index = loadIndex(cfg.root);
        const mine = [...index.keys()].filter((rel) => rel.startsWith(path.join("Projects", project) + path.sep)).length;
        const global = [...index.values()].filter((e) => e.meta.scope === "global").length;
        show(
          [
            `Memory vault: ${cfg.root}  (open this folder in Obsidian)`,
            `Project: ${project} — ${mine} memories; global: ${global}; total: ${index.size}`,
            `Recaps: ${cfg.recaps ? `on (model: ${cfg.recapModel ?? "session model"})` : "off"} · auto-promote: ${cfg.autoPromote ? "on" : "off"} · recall: top ${cfg.recallLimit}, min score ${cfg.minScore}`,
            "Configure in ~/.pi/agent/pi-kit/memory.json: {vault, recaps, recapModel, autoPromote, recallLimit, minScore}",
          ].join("\n"),
        );
        return;
      }
      if (sub === "recent") {
        const recaps = recentRecaps(cfg.root, project, 5);
        show(recaps.length ? recaps.map((r) => `${r.date} ${r.text.replace(/^## /, "")}`).join("\n\n") : "No recaps yet for this project.");
        return;
      }
      if (sub === "search") {
        const hits = searchMemories(cfg.root, arg, { project, limit: 10 });
        show(hits.length ? formatHits(hits) : "No matching memories.");
        return;
      }
      if (sub === "forget") {
        const hit = findMemory(cfg.root, arg, project);
        if (!hit) {
          ctx.ui.notify(`No memory matches "${arg}".`, "warning");
          return;
        }
        if (ctx.hasUI && !(await ctx.ui.confirm("Forget memory?", `${hit.meta.title}\n${hit.rel}\n\nIt is moved to the vault's .trash.`))) return;
        forgetMemory(cfg.root, arg, project);
        show(`Forgot ${hit.rel}.`);
        return;
      }
      if (sub === "migrate") {
        const n = migrateMemoryLocal(cfg.root, project);
        show(n ? `Imported ${n} memories from memory-local.` : "Nothing to migrate (already migrated, or no memory-local store).");
        return;
      }
      ctx.ui.notify(`memory: unknown subcommand "${sub}"`, "error");
    },
  });
}

export default function (pi: ExtensionAPI) {
  createMemoryVault(pi);
}
