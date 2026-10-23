import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// skill-forge (Epic 6 Sprint 6.1): mine the trace-ledger and DETERMINISTICALLY synthesise a
// candidate SKILL.md, score a skill against the eval harness, and archive superseded skills.
// It never calls a model — synthesis is a heuristic distillation of recorded action patterns,
// written to .pi/skill-proposals/ for human review (never auto-installed into skills/).
// Self-contained: node builtins only; scoring shells out to packages/core/eval/run.ts at runtime.

interface TraceEntry {
  kind?: "call" | "result";
  tool?: string;
  target?: string;
  status?: "ok" | "error";
}

/** A trace line's well-typed fields; null for a non-object. Fields of the wrong type are dropped. */
function toTraceEntry(value: unknown): TraceEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { kind, tool, target, status }: { kind?: unknown; tool?: unknown; target?: unknown; status?: unknown } = value;
  const entry: TraceEntry = {};
  if (kind === "call" || kind === "result") entry.kind = kind;
  if (typeof tool === "string") entry.tool = tool;
  if (typeof target === "string") entry.target = target;
  if (status === "ok" || status === "error") entry.status = status;
  return entry;
}

interface Mined {
  totalCalls: number;
  topTools: Array<{ tool: string; count: number }>;
  topSequences: Array<{ seq: string; count: number }>;
  repeatedReads: Array<{ target: string; count: number }>;
  errorRate: number;
}

function tracePath(cwd: string): string {
  return path.join(cwd, ".pi", "trace.jsonl");
}

// Bounded tail read (mirrors trace-ledger's /trace window): the shared ledger can grow
// without limit, so mining must not load the whole file into memory. Read at most the last
// 1MB and drop the partial first line.
const TRACE_TAIL_BYTES = 1024 * 1024;

function readTraceTail(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TRACE_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytes).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } catch {
    return null;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function readTrace(cwd: string, tracePathOverride?: string): TraceEntry[] {
  const text = readTraceTail(tracePathOverride || tracePath(cwd));
  if (text === null) return [];
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return toTraceEntry(JSON.parse(l));
      } catch {
        return null;
      }
    })
    .filter((e): e is TraceEntry => !!e);
}

const READ_HINT = /^(read|grep|glob|ls|find|cat|search|rg)/i;

export function mineTrace(entries: TraceEntry[]): Mined {
  const calls = entries.filter((e): e is TraceEntry & { tool: string } => e.kind === "call" && Boolean(e.tool));
  const results = entries.filter((e) => e.kind === "result");
  const toolCounts = new Map<string, number>();
  for (const e of calls) toolCounts.set(e.tool, (toolCounts.get(e.tool) ?? 0) + 1);

  // Adjacent tool bigrams (the recurring micro-workflow).
  const seqCounts = new Map<string, number>();
  let previous: string | undefined;
  for (const e of calls) {
    if (previous !== undefined) {
      const seq = `${previous} → ${e.tool}`;
      seqCounts.set(seq, (seqCounts.get(seq) ?? 0) + 1);
    }
    previous = e.tool;
  }

  const readCounts = new Map<string, number>();
  for (const e of calls) {
    if (e.target && READ_HINT.test(e.tool)) readCounts.set(e.target, (readCounts.get(e.target) ?? 0) + 1);
  }

  const errors = results.filter((e) => e.status === "error").length;
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  return {
    totalCalls: calls.length,
    topTools: top(toolCounts, 5).map(([tool, count]) => ({ tool, count })),
    topSequences: top(seqCounts, 3).map(([seq, count]) => ({ seq, count })),
    repeatedReads: top(readCounts, 3).filter(([, n]) => n >= 2).map(([target, count]) => ({ target, count })),
    errorRate: results.length ? Number((errors / results.length).toFixed(2)) : 0,
  };
}

export function synthesiseSkillMd(name: string, category: string, mined: Mined): string {
  const seqLine =
    mined.topSequences.length > 0
      ? mined.topSequences.map((s) => `${s.seq} (${s.count}×)`).join("; ")
      : "no dominant sequence observed";
  const desc =
    `Runbook distilled from ${mined.totalCalls} recorded tool calls. Use when the task matches the ` +
    `observed pattern: ${seqLine}. Prefer the fewest calls to a verified result.`;
  const procedure =
    mined.topSequences.length > 0
      ? mined.topSequences.map((s, i) => `${i + 1}. Recurring step: ${s.seq} — do it once, deliberately (seen ${s.count}×).`)
      : ["1. Orient, act, verify — the trace showed no dominant sequence to distil."];
  const antiReads =
    mined.repeatedReads.length > 0
      ? mined.repeatedReads.map((r) => `- Re-reading \`${r.target}\` (${r.count}×) — read it once; you have enough to act.`)
      : ["- Re-reading files you already have in context."];

  return [
    "---",
    `name: ${name}`,
    `category: ${category}`,
    `description: ${desc}`,
    "---",
    "",
    `# ${name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`,
    "",
    "> Synthesised by skill-forge from trace-ledger. Review before promoting into `skills/`.",
    "",
    "## When to use",
    `- When the current task resembles the recurring pattern below (mined from ${mined.totalCalls} calls, error rate ${mined.errorRate}).`,
    "",
    "## Procedure",
    ...procedure,
    "",
    "## Anti-patterns",
    ...antiReads,
    "",
    "## Done",
    "- The recurring work is completed with fewer redundant calls than the mined baseline, and verified.",
    "",
  ].join("\n");
}

function proposalDir(cwd: string, name: string): string {
  return path.join(cwd, ".pi", "skill-proposals", name);
}

// Shared skill-name sanitizer: kebab-case only. skill_synthesise already applied this;
// skill_archive did not (H-05) — a raw `skill_name` like "../../victim" was joined
// straight into both the source and destination paths, and the destination was then
// recursively removed before the (now-traversed) source was renamed into it, letting a
// model-visible tool delete an arbitrary reachable path.
function sanitizeSkillName(raw: string): string {
  return raw.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

// Defense in depth beyond sanitization: the resolved path must actually stay inside its
// intended base directory. Catches anything sanitizeSkillName might miss (e.g. an
// all-dash/all-dot name colliding with "." or "..") rather than trusting the regex alone.
function isContained(candidate: string, base: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(resolvedBase + path.sep);
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}

// The kit's own eval harness and checkout root, resolved from this file
// (<root>/packages/extensions/src/skill-forge/index.ts), never from the session's working directory:
// running <cwd>/packages/core/eval/run.ts would let any opened repository supply the code that this
// auto-allowed tool executes (CRT-1).
const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const EVAL_HARNESS = path.join(KIT_ROOT, "packages", "core", "eval", "run.ts");

// Runs the kit's eval harness and returns its pass rate — a real, eval-tied number.
function evalPassRate(): { rate: number; passed: number; total: number } | null {
  if (!fs.existsSync(EVAL_HARNESS)) return null;
  try {
    const out = execFileSync("node", [EVAL_HARNESS, "--json"], { cwd: KIT_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed === "object" && parsed !== null && "passed" in parsed && "total" in parsed && typeof parsed.passed === "number" && typeof parsed.total === "number" && parsed.total > 0) {
      return { rate: Number((parsed.passed / parsed.total).toFixed(3)), passed: parsed.passed, total: parsed.total };
    }
  } catch {
    /* eval harness not present (e.g. a stripped surface) or failed to run */
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "skill_synthesise",
    label: "Skill Forge: synthesise",
    description: "Mine the trace-ledger and synthesise a candidate SKILL.md into .pi/skill-proposals/ for review.",
    parameters: Type.Object({
      skill_name: Type.String({ description: "Name for the synthesised skill (kebab-case)" }),
      category: Type.Optional(Type.String({ description: "Skill category (default: efficiency)" })),
      trace_path: Type.Optional(Type.String({ description: "Path to a trace JSONL to mine (default: .pi/trace.jsonl)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
      const name = params.skill_name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
      const category = params.category || "efficiency";
      const entries = readTrace(cwd, params.trace_path);
      if (entries.length === 0) {
        return text(`skill-forge: no trace entries found (looked in ${params.trace_path || ".pi/trace.jsonl"}). Run some work first.`);
      }
      const mined = mineTrace(entries);
      const md = synthesiseSkillMd(name, category, mined);
      const dir = proposalDir(cwd, name);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "SKILL.md");
      fs.writeFileSync(file, md, "utf8");
      return text(
        `skill-forge: wrote candidate skill to ${path.relative(cwd, file)} (mined ${mined.totalCalls} calls, ` +
          `${mined.topSequences.length} sequences). Review, then move into skills/<name>/ and run 'npm run catalog'.`,
      );
    },
  });

  pi.registerTool({
    name: "skill_score",
    label: "Skill Forge: score",
    description: "Score the kit against its own eval harness (real, eval-tied number) as the skill's regression baseline.",
    parameters: Type.Object({
      skill_name: Type.String({ description: "Skill name being evaluated (recorded in the score record)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
      const result = evalPassRate();
      if (!result) {
        return text(`skill-forge: could not run the eval harness (packages/core/eval is not present in this kit install). Score unavailable for ${params.skill_name}.`);
      }
      // Persist a score record so scores are auditable over time.
      try {
        const p = path.join(cwd, ".pi", "skill-scores.jsonl");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, JSON.stringify({ skill: params.skill_name, ...result, at: new Date().toISOString() }) + "\n");
      } catch {
        /* best-effort */
      }
      return text(`skill-forge: ${params.skill_name} eval baseline = ${result.rate} (${result.passed}/${result.total} fixtures passing).`);
    },
  });

  pi.registerTool({
    name: "skill_archive",
    label: "Skill Forge: archive",
    description: "Archive a superseded skill proposal or skill into .pi/skill-archive/ (non-destructive move; an existing archive of the same name is kept and the new one gets a <name>-<timestamp> directory).",
    parameters: Type.Object({
      skill_name: Type.String({ description: "Skill name to archive" }),
      reason: Type.Optional(Type.String({ description: "Reason for archiving" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
      const name = sanitizeSkillName(params.skill_name);
      if (!name || name.replace(/-/g, "") === "") {
        return text(`skill-forge: '${params.skill_name}' is not a valid skill name (kebab-case, alphanumeric).`);
      }
      const proposalsBase = path.join(cwd, ".pi", "skill-proposals");
      // Project skills only (.pi/skills, legacy ./skills): archiving never moves files out of
      // an installed kit or the operator's global skills.
      const skillsBase = fs.existsSync(path.join(cwd, ".pi", "skills", name)) ? path.join(cwd, ".pi", "skills") : path.join(cwd, "skills");
      const archiveBase = path.join(cwd, ".pi", "skill-archive");
      const candidates = [proposalDir(cwd, name), path.join(skillsBase, name)];
      const src = candidates.find((c) => fs.existsSync(c));
      if (!src) {
        return text(`skill-forge: nothing to archive — no proposal or skill named '${name}'.`);
      }
      if (!isContained(src, proposalsBase) && !isContained(src, skillsBase)) {
        return text(`skill-forge: refusing to archive '${name}' — resolved source escapes its base directory.`);
      }
      // Non-destructive (PRO-12): an existing archive of the same name is never removed; the new
      // one goes to <name>-<epoch ms>, with a counter if that is taken too.
      let dest = path.join(archiveBase, name);
      if (fs.existsSync(dest)) {
        const stamped = `${dest}-${Date.now()}`;
        dest = stamped;
        for (let n = 2; fs.existsSync(dest); n++) dest = `${stamped}-${n}`;
      }
      if (!isContained(dest, archiveBase)) {
        return text(`skill-forge: refusing to archive '${name}' — resolved destination escapes .pi/skill-archive/.`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      try {
        fs.writeFileSync(path.join(dest, "ARCHIVE_REASON.txt"), `${params.reason || "superseded"} (${new Date().toISOString()})\n`);
      } catch {
        /* best-effort */
      }
      return text(`skill-forge: archived '${name}' -> ${path.relative(cwd, dest)} (${params.reason || "superseded"}).`);
    },
  });
}
