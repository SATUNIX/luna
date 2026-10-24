// agentstore.ts — create / read / update / delete agent definition files.
//
// Agents are YAML-frontmatter markdown files. This module is the ONLY place that writes
// them, and it refuses any path that escapes the configured agent directories.
import * as fs from "node:fs";
import * as path from "node:path";
import { array, isRecord, object, optional, safeParse, string, type Infer } from "../../core/lib/guard.ts";
import { AGENT_DIRS } from "./config.ts";
import { agentBody, resolveAgent, type AgentDefinition, type AgentSource } from "./agents.ts";
import { HttpError } from "./validate.ts";

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const NAME_HELP = "invalid agent name (use lowercase letters, digits, dot, dash, underscore)";

/** An agent with its raw system-prompt body, as the editor reads it. */
export interface AgentRecord extends AgentDefinition {
	body: string;
}

/**
 * The fields of a create or update request (an HTTP body: untrusted). Every field is checked
 * and none is coerced: a value of the wrong type is refused before anything reaches the file.
 */
const AgentInputSchema = object({
	name: optional(string()),
	description: optional(string()),
	tools: optional(array(string())),
	model: optional(string()),
	body: optional(string()),
	source: optional(string()),
	moveTo: optional(string()),
});
export type AgentInput = Infer<typeof AgentInputSchema>;

function parseInput(input: unknown): AgentInput {
	if (!isRecord(input)) throw new HttpError(400, "JSON object body required");
	const result = safeParse(AgentInputSchema, input, "agent");
	if (result.ok) return result.value;
	if (result.error.path === "agent.name") throw new HttpError(400, NAME_HELP);
	throw new HttpError(400, `invalid ${result.error.path.replace(/^agent\./, "agent ")}`);
}

/** Directory for a source ("user" = first configured dir, "project" = second). */
export function agentDirFor(source: string | null | undefined): string {
	return source === "project" ? AGENT_DIRS[1] : AGENT_DIRS[0];
}

function assertName(name: unknown): asserts name is string {
	if (typeof name !== "string" || !NAME_RE.test(name) || name.length > 64) {
		throw new HttpError(400, NAME_HELP);
	}
}

/** Resolve the on-disk path for an agent name, refusing escapes. */
function agentPath(name: unknown, source: string): string {
	assertName(name);
	const dir = path.resolve(agentDirFor(source));
	const resolved = path.resolve(dir, `${name}.md`);
	if (!resolved.startsWith(dir + path.sep))
		throw new HttpError(400, "invalid agent path");
	return resolved;
}

function frontmatterLine(key: string, value: string): string {
	// Keep values on one line so the frontmatter stays trivially parseable: any line break
	// (\r, \n, U+2028/9) folds to a space, so a value cannot start a new key.
	return `${key}: ${value
		.replace(/\s*[\r\n\u2028\u2029]\s*/g, " ")
		.trim()}`;
}

interface AgentDocument {
	name: string;
	description?: string | undefined;
	tools?: readonly string[] | undefined;
	model?: string | undefined;
	body?: string | undefined;
}

function serialize({ name, description, tools, model, body }: AgentDocument): string {
	const lines = ["---", frontmatterLine("name", name)];
	if (description) lines.push(frontmatterLine("description", description));
	if (tools?.length)
		lines.push(frontmatterLine("tools", tools.join(", ")));
	if (model) lines.push(frontmatterLine("model", model));
	lines.push("---", "", (body ?? "").trim(), "");
	return lines.join("\n");
}

/** Full agent record including the raw system-prompt body. */
export function getAgent(name: string, source?: string | null): AgentRecord | null {
	const known = resolveAgent(name, source);
	if (!known) return null;
	const text = fs.readFileSync(known.path, "utf8");
	return { ...known, body: agentBody(text) };
}

/** Create a new agent file. Fails if one already exists at that name+source. */
export function createAgent(rawInput: unknown): AgentRecord | null {
	const input = parseInput(rawInput);
	const source: AgentSource = input.source === "project" ? "project" : "user";
	const { name } = input;
	assertName(name);
	const filePath = agentPath(name, source);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const doc = serialize({
		name,
		description: input.description,
		tools: input.tools,
		model: input.model,
		body: input.body,
	});
	try {
		// "wx": created only if it does not exist, in one step (no window between the check and the write).
		fs.writeFileSync(filePath, doc, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if (isRecord(error) && error.code === "EEXIST")
			throw new HttpError(409, `agent already exists: ${name}`);
		throw error;
	}
	return getAgent(name, source);
}

/**
 * Update an existing agent. Pass `previousName` to rename; the old file is removed only
 * after the new one is written successfully.
 */
export function updateAgent(name: string, rawInput: unknown): AgentRecord | null {
	const input = parseInput(rawInput);
	const source: AgentSource = input.source === "project" ? "project" : "user";
	// moveTo names a directory: anything but "user" or "project" is refused, not mapped to one.
	if (input.moveTo && input.moveTo !== "user" && input.moveTo !== "project") {
		throw new HttpError(400, "invalid agent moveTo");
	}
	const existing = resolveAgent(name, source);
	if (!existing) throw new HttpError(404, `agent not found: ${name}`);
	const renameTo = input.name && input.name !== name ? input.name : null;
	const targetSource = input.moveTo || source;
	const targetPath = agentPath(renameTo || name, targetSource);
	const doc = serialize({
		name: renameTo || name,
		description: input.description ?? existing.description,
		tools: input.tools ?? existing.tools,
		model: input.model ?? existing.model,
		body: input.body ?? agentBody(fs.readFileSync(existing.path, "utf8")),
	});
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	if (targetPath !== existing.path && fs.existsSync(targetPath)) {
		throw new HttpError(409, `cannot rename: ${renameTo ?? name} already exists`);
	}
	fs.writeFileSync(targetPath, doc, "utf8");
	if (targetPath !== existing.path) fs.unlinkSync(existing.path);
	return getAgent(input.name || name, targetSource);
}

export function deleteAgent(
	name: string,
	source?: string | null,
): { deleted: true; name: string; source: AgentSource } {
	const existing = resolveAgent(name, source);
	if (!existing) throw new HttpError(404, `agent not found: ${name}`);
	const resolved = path.resolve(existing.path);
	const allowed = AGENT_DIRS.map((d) => path.resolve(d));
	if (!allowed.some((dir) => resolved.startsWith(dir + path.sep))) {
		throw new HttpError(400, "refusing to delete outside the agent directories");
	}
	fs.unlinkSync(resolved);
	return { deleted: true, name, source: existing.source };
}

/** Tool names offered in the agent editor (built-ins + kit extras). */
export const KNOWN_TOOLS: readonly string[] = [
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
	"todo",
	"subagent",
	"verify_completion",
	"memory_store",
	"memory_search",
];
