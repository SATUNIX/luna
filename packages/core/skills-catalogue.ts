#!/usr/bin/env node
/**
 * Generate docs/skills-catalogue.md from each skill's SKILL.md frontmatter.
 * Modeled on packages/core/registry.ts. Deterministic so verify.ts can diff a fresh regen
 * against the committed doc.
 *
 * Usage:
 *   node packages/core/skills-catalogue.ts            # write docs/skills-catalogue.md
 *   node packages/core/skills-catalogue.ts --check    # exit 1 if committed doc is stale
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_ROOT, PROFILES_DIR, SKILLS_DIR } from "./lib/paths.ts";
import { loadProfileDef } from "./lib/profiles.ts";

const ROOT = WORKSPACE_ROOT;
const DOC_PATH = path.join(ROOT, "docs", "skills-catalogue.md");
const LITE_PROFILE = path.join(PROFILES_DIR, "lite.json");

// Ordered categories -> display headings. A skill with an unknown/missing category is
// surfaced under "Uncategorised" so it can't silently vanish from the catalogue.
const CATEGORY_ORDER: readonly (readonly [category: string, heading: string])[] = [
  ["coding-workflow", "Coding & general workflow"],
  ["efficiency", "Efficiency & anti-loop"],
  ["context-and-small-models", "Context & small models"],
  ["memory", "Memory"],
  ["orchestration-recovery", "Orchestration & recovery"],
  ["mcp-governance", "MCP & governance operations"],
  ["pentest", "Pentest assessment"],
  ["evidence-reporting", "Evidence & reporting"],
  ["documentation", "Documentation"],
  ["maintainer", "Kit maintainers"],
  ["uncategorised", "Uncategorised"],
];

/** One catalogue line's worth of a skill, from its SKILL.md frontmatter. */
export interface SkillSummary {
  name: string;
  category: string;
  description: string;
  disableModelInvocation: boolean;
}

function parseFrontmatter(text: string): Map<string, string> {
  const fm = new Map<string, string>();
  if (!text.startsWith("---")) return fm;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return fm;
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m?.[1] !== undefined) fm.set(m[1], (m[2] ?? "").trim());
  }
  return fm;
}

function firstSentence(description: string): string {
  if (!description) return "";
  // Keep up to the first sentence-ending period followed by a space (or end of string).
  const m = description.match(/^(.*?\.)(?:\s|$)/);
  const sentence = m?.[1] ?? description;
  return sentence.replace(/\s+/g, " ").trim();
}

function collectSkills(): SkillSummary[] {
  const skills: SkillSummary[] = [];
  for (const name of fs.readdirSync(SKILLS_DIR).sort()) {
    const mp = path.join(SKILLS_DIR, name, "SKILL.md");
    if (!fs.existsSync(mp)) continue;
    const fm = parseFrontmatter(fs.readFileSync(mp, "utf8"));
    skills.push({
      name: fm.get("name") || name,
      category: fm.get("category") || "uncategorised",
      description: fm.get("description") || "",
      // A skill with `disable-model-invocation: true` does NOT keep its description
      // always in context; it is discovered on demand (skill_search / trigger hints).
      disableModelInvocation: fm.get("disable-model-invocation") === "true",
    });
  }
  return skills;
}

// Skills whose one-line description stays in context (no disable-model-invocation flag),
// vs. those surfaced on demand. Derived from frontmatter so the rendered wording can't
// drift from the actual skill set.
function visibleSkillCount(skills: readonly SkillSummary[]): number {
  return skills.filter((s) => !s.disableModelInvocation).length;
}

// Deterministic prose describing which descriptions are always in context. Counts come
// from frontmatter (never hardcoded) so adding a skill regenerates the doc correctly.
function visibilitySentences(skills: readonly SkillSummary[]): string[] {
  const visible = visibleSkillCount(skills);
  const hidden = skills.length - visible;
  const visibleNoun = visible === 1 ? "skill" : "skills";
  const hiddenVerb = hidden === 1 ? "is" : "are";
  return [
    `Skills are on-demand runbooks. The ${visible} ${visibleNoun} without \`disable-model-invocation: true\` keep`,
    `their one-line description in context; the other ${hidden} ${hiddenVerb} surfaced on demand by`,
    "`skill_search` and trigger hints, and any `SKILL.md` body loads when the task matches",
    "(or via `/skill:<name>`). See",
  ];
}

function render(): string {
  const skills = collectSkills();
  const knownCategories = new Set(CATEGORY_ORDER.map(([cat]) => cat));
  const byCategory = new Map<string, SkillSummary[]>();
  for (const s of skills) {
    // Previously the render loop below only walked the FIXED CATEGORY_ORDER
    // list, so a skill with an unrecognized/misspelled category (present, but not one
    // of the known values - unlike a missing category, which already fell back to
    // "uncategorised") was silently absent from byCategory's iteration entirely: it
    // never printed here, but also never showed under "Uncategorised". Fold unrecognized
    // categories into "uncategorised" too, and warn loudly so a typo is caught at
    // generation time instead of a skill silently vanishing from the catalogue.
    const cat = knownCategories.has(s.category) ? s.category : "uncategorised";
    if (cat !== s.category) {
      console.warn(`[skills-catalogue] WARNING: skill '${s.name}' has unrecognized category '${s.category}' — filed under "Uncategorised". Valid categories: ${[...knownCategories].join(", ")}`);
    }
    const list = byCategory.get(cat) ?? [];
    list.push(s);
    byCategory.set(cat, list);
  }

  const lines = [
    "# Skills Catalogue",
    "",
    "> Auto-generated by `packages/core/skills-catalogue.ts` from each `SKILL.md` frontmatter.",
    "> Do not hand-edit; run `npm run catalog` after adding or recategorising a skill.",
    "",
    ...visibilitySentences(skills),
    "[Writing skills](WRITING_EXTENSIONS.md#writing-skills) for the format and rationale.",
    "",
  ];

  for (const [cat, heading] of CATEGORY_ORDER) {
    const items = byCategory.get(cat);
    if (!items || items.length === 0) continue;
    lines.push(`## ${heading}`);
    for (const s of items.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- **${s.name}** — ${firstSentence(s.description)}`);
    }
    lines.push("");
  }

  // Lite profile subset (read from the profile's allowlist so it can't drift).
  if (fs.existsSync(LITE_PROFILE)) {
    const lite = loadProfileDef("lite", PROFILES_DIR);
    const liteSkills: string[] = (lite.skills?.only ?? []).slice().sort();
    lines.push("## Lite profile subset", "");
    lines.push(
      `The lite profile enables ${liteSkills.length} of ${skills.length} skills, for small local models:`,
    );
    lines.push(liteSkills.map((s: string) => `\`${s}\``).join(", ") + ".");
    lines.push("");
  }

  return lines.join("\n");
}

export function skillsCatalogueContent(): string {
  return render();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const content = skillsCatalogueContent();
  if (check) {
    const current = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, "utf8") : "";
    if (current !== content) {
      console.error("[skills-catalogue] STALE: docs/skills-catalogue.md differs from a fresh regen.");
      console.error("[skills-catalogue] Run: npm run catalog");
      process.exit(1);
    }
    console.log("[skills-catalogue] OK: docs/skills-catalogue.md is up to date.");
  } else {
    fs.writeFileSync(DOC_PATH, content);
    console.log(`[skills-catalogue] Wrote ${path.relative(ROOT, DOC_PATH)} (${collectSkills().length} skills).`);
  }
}
