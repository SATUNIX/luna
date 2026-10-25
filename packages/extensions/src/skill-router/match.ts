/**
 * skill-router — pure matching logic (no pi API), so the routing eval can drive it directly.
 *
 * Two mechanisms with different jobs:
 *  - Triggers (automatic hints): each skill declares explicit phrases (or `re:` regexes) in its
 *    frontmatter. A hint fires only on an exact phrase/regex hit — no fuzzy scoring — so what
 *    gets hinted is predictable and pinned by tests/skill-routing-fixtures.jsonl. A hint is one
 *    line (name + path), never the skill body, so even a wrong hint costs ~30 tokens.
 *  - Search (skill_search tool): BM25 over name, description, triggers and the "When to use"
 *    section, for when the model decides it needs a runbook. Fuzzy is fine here: the model
 *    reads the results and chooses.
 */

// node:vm is not a sandbox here: it runs only the fixed script "re.test(s)", for its timeout
// (eslint.config.ts allows node:vm in this file and the schema validators only).
import { Script, createContext } from "node:vm";
import { compileCheckedRegex } from "./shared/safe-regex.ts";

export interface SkillEntry {
  name: string;
  description: string;
  path: string;
  hidden: boolean; // disable-model-invocation: not listed in the system prompt
  triggers: string[];
  whenToUse: string;
}

export interface TriggerHit {
  name: string;
  trigger: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A project skill's `re:` trigger is text from the opened repository, tested against every prompt,
 * so it is untrusted. It is compiled only when the shared safe-regex check accepts it
 * (./shared/safe-regex.ts: no nested quantifiers, no backreferences, a length and choice cap), and
 * each test runs under a time limit; a trigger that hits the limit is switched off for the
 * session. tests/skill-routing-smoke.ts pins both.
 */
export const TRIGGER_TEST_MS = 50;
const triggerScript = new Script("re.test(s)");
const triggerContext = createContext({ re: /(?:)/, s: "" });
/** `re:` triggers refused or switched off, with the reason (for diagnostics and tests). */
export const refusedTriggers = new Map<string, string>();

function timedTest(re: RegExp, text: string): boolean | "slow" {
  triggerContext.re = re;
  triggerContext.s = text;
  try {
    return triggerScript.runInContext(triggerContext, { timeout: TRIGGER_TEST_MS }) === true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return "slow";
    throw error;
  } finally {
    triggerContext.re = /(?:)/;
    triggerContext.s = "";
  }
}

const compiled = new Map<string, RegExp | null>();
export function triggerRegex(trigger: string): RegExp | null {
  const cached = compiled.get(trigger);
  if (cached !== undefined) return cached;
  let re: RegExp | null = null;
  try {
    if (trigger.startsWith("re:")) {
      const checked = compileCheckedRegex(trigger.slice(3), "i");
      if (checked.ok) re = checked.re;
      else refusedTriggers.set(trigger, checked.problem);
    } else {
      const phrase = trigger.trim().toLowerCase();
      if (phrase) re = new RegExp(`(?<![\\w/-])${escapeRe(phrase).replace(/\s+/g, "\\s+")}(?![\\w-])`, "i");
    }
  } catch {
    re = null; // a malformed regex in one skill must not break routing for the rest
  }
  compiled.set(trigger, re);
  return re;
}

// Hidden skills whose triggers occur in the prompt, most specific (longest trigger) first.
export function matchTriggers(prompt: string, skills: SkillEntry[], exclude: Set<string> = new Set(), limit = 2): TriggerHit[] {
  const text = prompt.replace(/`[^`]*`/g, " ").slice(0, 8000); // code spans are content, not intent
  const hits: Array<TriggerHit & { weight: number }> = [];
  for (const s of skills) {
    if (!s.hidden || exclude.has(s.name)) continue;
    let best: { trigger: string; weight: number } | null = null;
    for (const t of s.triggers) {
      const re = triggerRegex(t);
      if (!re) continue;
      if (t.startsWith("re:")) {
        const hit = timedTest(re, text);
        if (hit === "slow") {
          compiled.set(t, null);
          refusedTriggers.set(t, `took longer than ${TRIGGER_TEST_MS} ms on a prompt; switched off for this session`);
          continue;
        }
        if (!hit) continue;
      } else if (!re.test(text)) continue;
      const weight = t.startsWith("re:") ? 40 : t.length;
      if (!best || weight > best.weight) best = { trigger: t, weight };
    }
    if (best) hits.push({ name: s.name, trigger: best.trigger, weight: best.weight });
  }
  return hits.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name)).slice(0, limit).map(({ name, trigger }) => ({ name, trigger }));
}

// --- search (BM25) ---------------------------------------------------------------

const STOP = new Set("a an and are as at be by can do for from how i in is it me my of on or please should so that the this to use using we what when where which with you your want need help".split(" "));

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [])
    .flatMap((t) => (t.includes("-") ? [t, ...t.split("-")] : [t]))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, "") : t));
}

export function searchSkills(query: string, skills: SkillEntry[], limit = 5): Array<{ skill: SkillEntry; score: number }> {
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  const docs = skills.map((s) => {
    const tf = new Map<string, number>();
    const add = (text: string, w: number) => {
      for (const t of tokens(text)) tf.set(t, (tf.get(t) ?? 0) + w);
    };
    add(s.name, 3);
    add(s.description, 2);
    add(s.triggers.filter((t) => !t.startsWith("re:")).join(" "), 2);
    add(s.whenToUse, 1);
    const len = [...tf.values()].reduce((a, b) => a + b, 0) || 1;
    return { s, tf, len };
  });
  const avg = docs.reduce((a, d) => a + d.len, 0) / docs.length;
  const scored = docs.map(({ s, tf, len }) => {
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const n = docs.filter((d) => d.tf.has(t)).length;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + (0.75 * len) / avg)));
    }
    return { skill: s, score };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

// Parse the frontmatter fields the router needs from a SKILL.md.
export function parseSkillFile(text: string, path: string, fallbackName: string, fallbackDescription = ""): SkillEntry {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const field = (key: string) => fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim();
  let triggers: string[] = [];
  const raw = field("triggers");
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) triggers = parsed.filter((t): t is string => typeof t === "string" && t.trim() !== "");
    } catch {
      triggers = raw.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
  }
  const body = text.slice(text.indexOf("---", 3) + 3);
  const when = body.match(/##\s*When to use[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] ?? "";
  return {
    name: field("name") || fallbackName,
    description: (field("description") || fallbackDescription).replace(/^["']|["']$/g, ""),
    path,
    hidden: field("disable-model-invocation") === "true",
    triggers,
    whenToUse: when.trim().slice(0, 1000),
  };
}
