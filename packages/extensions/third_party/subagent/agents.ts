/**
 * Agent discovery and configuration.
 *
 * Roles come from three places, later sources overriding earlier ones by name:
 *   1. kit      — packages/kit/agents/*.md shipped with this kit (trusted, always available)
 *   2. user     — ~/.pi/agent/agents/*.md (trusted: the operator's own files)
 *   3. project  — the nearest .pi/agents/*.md (untrusted until approved; only with
 *                 agentScope "project" or "both")
 *
 * The kit source is what makes `subagent({ agent: "planner" })` work out of the box, headless
 * children included. Before it existed the shipped roles were only copied into each project's
 * .pi/agents, so the default "user" scope found no roles at all and every "both" call needed an
 * interactive trust prompt — which a headless delegator child can never answer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { toText } from "./config.ts";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "kit" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[] | undefined;
	model?: string | undefined;
	// Thinking level passed to the child (`--thinking`), e.g. "low" | "medium" | "high".
	thinking?: string | undefined;
	// Skill names whose SKILL.md bodies are preloaded into the child's system prompt.
	skills?: string[] | undefined;
	// Extra kit extensions (names or paths) to load in the isolated child.
	extensions?: string[] | undefined;
	// Per-role wall-clock ceiling, overriding PI_KIT_SUBAGENT_MAX_RUNTIME_MS.
	maxRuntimeMs?: number | undefined;
	// Effort tier the child works at (minimal..exhaustive, E1..E5). Clamped to the parent's tier at launch:
	// a child never runs above its parent. Effort never grants permissions.
	effort?: string | undefined;
	// Counts against the scout limit of the effort budget (the built-in `scout` role always does).
	scout?: boolean | undefined;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	// Project roles that shadow a kit or user role of the same name (stale copies are the
	// usual cause: older kits materialized the shipped roles into .pi/agents).
	shadowed: string[];
}

const SUBAGENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// packages/extensions/third_party/subagent -> packages/kit/agents
export function kitAgentsDir(): string {
	const override = process.env.PI_KIT_AGENTS_DIR?.trim();
	return override ? path.resolve(override) : path.resolve(SUBAGENT_DIR, "..", "..", "..", "kit", "agents");
}

function list(value: string | undefined): string[] | undefined {
	const items = value
		?.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	return items && items.length > 0 ? items : undefined;
}

// Accepts "90s", "30m", "2h" or a bare millisecond count.
function parseDuration(value: string | undefined): number | undefined {
	const m = value?.trim().match(/^(\d+)\s*(ms|s|m|h)?$/i);
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = (m[2] ?? "ms").toLowerCase();
	const factor = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
	return n * factor;
}

export function parseAgentFile(content: string, source: AgentSource, filePath: string): AgentConfig | null {
	const { frontmatter, body } = parseFrontmatter(content);
	const str = (key: string): string | undefined => {
		const v = frontmatter[key];
		if (Array.isArray(v)) return v.map(String).join(",");
		return v === undefined || v === null ? undefined : toText(v);
	};
	const name = str("name");
	const description = str("description");
	if (!name || !description) return null;
	return {
		name,
		description,
		tools: list(str("tools")),
		model: str("model")?.trim() || undefined,
		thinking: str("thinking")?.trim() || undefined,
		skills: list(str("skills")),
		extensions: list(str("extensions")),
		maxRuntimeMs: parseDuration(str("max_runtime") ?? str("maxRuntime")),
		effort: str("effort")?.trim() || undefined,
		scout: /^(true|yes|1)$/i.test(str("scout")?.trim() ?? "") || undefined,
		systemPrompt: body,
		source,
		filePath,
	};
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const agent = parseAgentFile(content, source, filePath);
		if (agent) agents.push(agent);
	}
	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const kitAgents = loadAgentsFromDir(kitAgentsDir(), "kit");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();
	const shadowed: string[] = [];
	for (const agent of kitAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) {
		if (agentMap.has(agent.name)) shadowed.push(agent.name);
		agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir, shadowed };
}

// Project role files that would shadow a kit role if agentScope "project"/"both" were used,
// found without loading them as agents. Used for a one-time stale-copy notice.
// Only copies whose raw bytes differ from the same-named kit role are reported: an identical
// copy is harmless (it carries no customisation), so it should not prompt the operator to delete
// it. If either file cannot be read we cannot prove identity, so we report the copy (conservative:
// matches the old name-only behaviour on I/O errors) rather than silently dropping a real shadow.
export function staleProjectRoleCopies(cwd: string): string[] {
	const dir = findNearestProjectAgentsDir(cwd);
	if (!dir) return [];
	const kitByName = new Map(loadAgentsFromDir(kitAgentsDir(), "kit").map((a) => [a.name, a]));
	return loadAgentsFromDir(dir, "project")
		.filter((a) => {
			const kit = kitByName.get(a.name);
			if (!kit) return false;
			return !sameFileBytes(a.filePath, kit.filePath);
		})
		.map((a) => a.name);
}

function sameFileBytes(a: string, b: string): boolean {
	try {
		return fs.readFileSync(a).equals(fs.readFileSync(b));
	} catch {
		return false;
	}
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
