import os from "node:os";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

// Skills live in the kit (packages/kit/skills), the operator's ~/.pi/agent/skills, or the
// project (.pi/skills, legacy ./skills). Only cwd/skills was checked before, which exists in
// neither a normal project nor this repo, so every requested skill was rejected. The old
// "/skill:<name>" instruction also named a slash command a model cannot invoke.
const KIT_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "kit", "skills");
function resolveSkillFile(cwd: string, skill: string): string | null {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  for (const dir of [path.join(cwd, ".pi", "skills"), path.join(cwd, "skills"), path.join(agentDir, "skills"), KIT_SKILLS_DIR]) {
    const file = path.join(dir, skill, "SKILL.md");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export type ModelTier = "hot_path" | "strong";

// Must stay identical to conductor's SPECIALIST_ALLOWED_TOOLS (conductor/index.ts): a
// synthesized agent carrying any other tool is rejected by agentDefinition/dispatch_specialist,
// so synthesis would otherwise report success for an undispatchable specialist. In particular
// `bash` is deliberately excluded, matching the conductor's read-only+write/edit specialist
// sandbox.
export const ALLOWED_TOOLS = ["read", "grep", "find", "ls", "write", "edit"] as const;
export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

export interface SynthesisInput {
  name: string;
  roleBrief: string;
  skills: string[];
  tools: string[];
  modelTier: ModelTier;
  scopeStanza: string;
}

export type SynthesisResult =
  | { ok: true; name: string; markdown: string }
  | { ok: false; reason: string };

interface TraceEntry {
  ts: string;
  turn: number;
  kind: "call" | "result";
  tool: string;
  target?: string;
  argsHash: string;
  status?: "ok" | "error";
}

const AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Kept local to preserve conductor's self-containment without changing Phase 1 exports.
function appendTrace(cwd: string, entry: TraceEntry): void {
  try {
    const file = path.join(cwd, ".pi", "trace.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* best effort: audit logging never breaks synthesis */
  }
}

function auditSynthesis(cwd: string, input: SynthesisInput, target: string, status: "ok" | "error"): void {
  let argsHash = "unhashable";
  try {
    argsHash = shortHash(JSON.stringify(input));
  } catch {
    /* best effort: pathological runtime input must not prevent auditing */
  }

  appendTrace(cwd, {
    ts: new Date().toISOString(),
    turn: 0,
    kind: "result",
    tool: "conductor:agent_synth",
    target,
    argsHash,
    status,
  });
}

function writeAtomically(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  fs.renameSync(temp, file);
}

export function synthesizeAgent(cwd: string, input: SynthesisInput): SynthesisResult {
  if (!AGENT_NAME.test(input.name)) return { ok: false, reason: `invalid agent name: ${input.name}` };
  if (!input.roleBrief.trim() || /[\r\n]/.test(input.roleBrief)) {
    return { ok: false, reason: `role brief must be non-empty and contain no newlines: ${input.roleBrief}` };
  }
  if (!input.scopeStanza.trim() || /[\r\n]/.test(input.scopeStanza)) {
    return { ok: false, reason: `scope stanza must be non-empty and contain no newlines: ${input.scopeStanza}` };
  }

  for (const tool of input.tools) {
    if (!(ALLOWED_TOOLS as readonly string[]).includes(tool)) {
      return { ok: false, reason: `unrecognized tool: ${tool}` };
    }
  }

  for (const skill of input.skills) {
    if (!AGENT_NAME.test(skill)) return { ok: false, reason: `invalid skill name: ${skill}` };
    if (!resolveSkillFile(cwd, skill)) return { ok: false, reason: `unknown skill: ${skill}` };
  }

  if (input.modelTier !== "hot_path" && input.modelTier !== "strong") {
    return { ok: false, reason: `invalid model tier: ${String(input.modelTier)}` };
  }

  const tools = input.tools.join(", ");
  const skills = input.skills.join(", ") || "none";
  const skillInstructions = input.skills.length
    ? input.skills.map((skill) => `- ${skill}: read its SKILL.md (listed in your available skills) when relevant.`).join("\n")
    : "None assigned.";
  const toolInstructions = tools || "none -- you have no tool access";

  return {
    ok: true,
    name: input.name,
    markdown: `---
name: ${input.name}
description: ${input.roleBrief}
tools: ${tools}
model_tier: ${input.modelTier}
skills: ${skills}
---

You are a ${input.roleBrief}.

## Scope

${input.scopeStanza}

Do not act outside this scope. If a requested action falls outside it, refuse and say why.

## Skills

${skillInstructions}

Work within your assigned tools only: ${toolInstructions}.
`,
  };
}

export function writeSynthesizedAgent(cwd: string, input: SynthesisInput): SynthesisResult {
  const result = synthesizeAgent(cwd, input);
  if (!result.ok) {
    auditSynthesis(cwd, input, result.reason, "error");
    return result;
  }

  try {
    writeAtomically(path.join(cwd, ".pi", "agents", `${result.name}.md`), result.markdown);
  } catch (error) {
    const reason = `failed to write synthesized agent ${result.name}: ${error instanceof Error ? error.message : String(error)}`;
    auditSynthesis(cwd, input, reason, "error");
    return { ok: false, reason };
  }

  auditSynthesis(cwd, input, result.name, "ok");
  return result;
}
