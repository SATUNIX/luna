import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { matchTriggers, parseSkillFile, searchSkills, type SkillEntry } from "./match.ts";

// skill-router: progressive disclosure for skills.
//
// Only a handful of core skills are listed in the system prompt; the rest are marked
// `disable-model-invocation: true` (still loaded, still available as /skill:<name>). This
// extension makes the hidden ones reachable:
//   - skill_search: the model searches every loaded skill (name/description/triggers) and
//     reads the SKILL.md it picks — the "search for relevant skills and run them" path.
//   - automatic hints: when a prompt contains one of a hidden skill's declared triggers, a
//     one-line hint (name + path, never the body) is injected for that request. At most two
//     per prompt, never repeated in a session, never for a skill the model already read.
//
// Before this, all ~40 skill descriptions (~4k tokens) were in every prompt of every session.

const isChild = () => process.env.PI_KIT_INTERNAL_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "1";

export function loadCatalog(pi: ExtensionAPI): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const cmd of pi.getCommands()) {
    if (cmd.source !== "skill") continue;
    const file = cmd.sourceInfo?.path;
    const name = cmd.name.replace(/^skill:/, "");
    if (!file) continue;
    try {
      out.push(parseSkillFile(fs.readFileSync(file, "utf8"), file, name, cmd.description));
    } catch {
      out.push({ name, description: cmd.description ?? "", path: file, hidden: false, triggers: [], whenToUse: "" });
    }
  }
  return out;
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }], details: undefined };
}

export default function (pi: ExtensionAPI) {
  let catalog: SkillEntry[] | null = null;
  const seen = new Set<string>(); // hinted or read this session
  const getCatalog = () => (catalog ??= loadCatalog(pi));

  pi.on("session_start", async () => {
    catalog = null;
    seen.clear();
  });

  pi.on("session_compact", async () => {
    seen.clear(); // hints and reads may have been summarised away
  });

  // A skill the model reads on its own needs no hint afterwards.
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "read") return undefined;
    const p = (event.input as { path?: unknown })?.path;
    if (typeof p !== "string" || !p.endsWith("SKILL.md")) return undefined;
    const hit = getCatalog().find((s) => path.resolve(s.path) === path.resolve(p));
    if (hit) seen.add(hit.name);
    return undefined;
  });

  pi.on("before_agent_start", async (event) => {
    if (isChild()) return undefined;
    // A run started by an extension's custom message (pi 1.2+) has no prompt to route.
    const prompt = "prompt" in event ? event.prompt : "";
    if (!prompt.trim() || prompt.trim().startsWith("/")) return undefined;
    const hits = matchTriggers(prompt, getCatalog(), seen);
    if (!hits.length) return undefined;
    const byName = new Map(getCatalog().map((s) => [s.name, s]));
    for (const h of hits) seen.add(h.name);
    const lines = hits.map((h) => {
      const s = byName.get(h.name);
      if (!s) throw new Error(`skill-router: matched skill missing from the catalogue: ${h.name}`);
      return `- ${s.name}: ${s.description.slice(0, 160)} → read ${s.path}`;
    });
    return {
      message: {
        customType: "skill-router",
        content: `[Skills matching this request — read the SKILL.md before acting if it applies; ignore it if not]\n${lines.join("\n")}`,
        display: false,
      },
    };
  });

  pi.registerTool({
    name: "skill_search",
    label: "Skill search",
    description:
      "Search all installed skills (runbooks for specific kinds of work) — including ones not listed in the system prompt. Returns the best matches with their SKILL.md paths; read the one that fits before doing the work.",
    promptSnippet: "Find a runbook skill for the current task, then read its SKILL.md",
    promptGuidelines: [
      "Before non-trivial work in an area you have no listed skill for (security review, docs, dependencies, delegation, context resets, local models, recovery), call skill_search and read the best match.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "What you are about to do, in a few words" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
    }),
    async execute(_id, params) {
      const results = searchSkills(params.query, getCatalog(), Math.max(1, Math.min(Number(params.limit) || 5, 10)));
      if (!results.length) return text(`No skill matches "${params.query}". ${getCatalog().length} skills are installed; try different words.`);
      return text(results.map(({ skill }) => `- ${skill.name}: ${skill.description}\n  read: ${skill.path}`).join("\n"));
    },
  });

  pi.registerCommand("skills", {
    description: "List installed skills: which are listed in the prompt, which are on-demand (skill_search / hints), and their triggers.",
    handler: async (args, ctx) => {
      const q = args.trim();
      const all = getCatalog();
      const shown = q ? searchSkills(q, all, 20).map((r) => r.skill) : all;
      const fmt = (s: SkillEntry) => `  ${s.name}${s.triggers.length ? `  [${s.triggers.slice(0, 4).join(", ")}${s.triggers.length > 4 ? ", …" : ""}]` : ""}`;
      ctx.ui.notify(
        [
          `Listed in the system prompt (${shown.filter((s) => !s.hidden).length}):`,
          ...shown.filter((s) => !s.hidden).map(fmt),
          "",
          `On demand via skill_search / automatic hints (${shown.filter((s) => s.hidden).length}):`,
          ...shown.filter((s) => s.hidden).map(fmt),
          "",
          "Load any skill directly with /skill:<name>.",
        ].join("\n"),
        "info",
      );
    },
  });
}
