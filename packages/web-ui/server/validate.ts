// validate.ts — input validation for the HTTP API.
//
// Everything that arrives in a request body or URL and is later used as a file name, a
// child-process argument or an RPC field is checked here first. Failures are HttpErrors with a
// statusCode, which routes.ts turns into a JSON error response.
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "../../core/lib/guard.ts";
import type { AgentSource } from "./agents.ts";

export class HttpError extends Error {
	readonly statusCode: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.statusCode = status;
	}
}

/** Session ids are pi UUIDs, session-file basenames or `local-<hex>`: never a path. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
/** Provider and model identifiers, e.g. `openrouter-custom`, `deepseek/deepseek-v4.1-flash:free`. */
export const MODEL_ARG_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,199}$/;
export const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh"] as const);
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const STREAMING_BEHAVIOURS = Object.freeze(["steer", "followUp"] as const);
export type StreamingBehaviour = (typeof STREAMING_BEHAVIOURS)[number];

/** True only for a string that is one of THINKING_LEVELS (never a coerced value). */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** True only for a string that is one of STREAMING_BEHAVIOURS. */
export function isStreamingBehaviour(value: unknown): value is StreamingBehaviour {
	return typeof value === "string" && (STREAMING_BEHAVIOURS as readonly string[]).includes(value);
}

export interface StringRule {
	/** Longest accepted value (default 200). */
	readonly max?: number;
	readonly pattern?: RegExp;
}

/** A spawn request after validation: the only shape createSession accepts. */
export interface SpawnConfig {
	cwd: string;
	agent?: string;
	agentSource?: AgentSource;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	resumeSessionFile?: string;
}

/** Decode one URL path segment into a session id, refusing anything path-like. */
export function parseSessionId(rawSegment: string | null | undefined): string {
	let id: string;
	try {
		id = decodeURIComponent(rawSegment ?? "");
	} catch {
		throw new HttpError(400, "invalid session id");
	}
	if (!SESSION_ID_RE.test(id)) throw new HttpError(400, "invalid session id");
	return id;
}

/** An optional string bounded by length and (optionally) a pattern. */
export function optionalString(value: unknown, name: string, { max = 200, pattern }: StringRule = {}): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.length > max || (pattern && !pattern.test(value))) {
		throw new HttpError(400, `invalid ${name}`);
	}
	return value;
}

export function requireString(value: unknown, name: string, options?: StringRule): string {
	const out = optionalString(value, name, options);
	if (out === undefined) throw new HttpError(400, `${name} is required`);
	return out;
}

/** Body of a bare JSON object (never null, an array or a primitive). */
export function requireObject(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new HttpError(400, "JSON object body required");
	}
	return value;
}

/**
 * Validate the fields of a spawn request. The returned object is what createSession uses,
 * so nothing unvalidated ever reaches argv.
 */
export function sanitizeSpawnConfig(input: unknown, { defaultCwd }: { defaultCwd: string }): SpawnConfig {
	const config = requireObject(input);
	const cwdRaw = config.cwd === undefined || config.cwd === null || config.cwd === "" ? defaultCwd : config.cwd;
	if (typeof cwdRaw !== "string" || cwdRaw.length > 4096 || cwdRaw.includes("\0") || !path.isAbsolute(cwdRaw)) {
		throw new HttpError(400, "cwd must be an absolute directory path");
	}
	let stat: fs.Stats | null = null;
	try {
		stat = fs.statSync(cwdRaw);
	} catch {
		/* handled below */
	}
	if (!stat?.isDirectory()) throw new HttpError(400, `cwd does not exist: ${cwdRaw}`);

	const thinking = optionalString(config.thinking, "thinking level", { max: 10 });
	if (thinking !== undefined && !isThinkingLevel(thinking)) {
		throw new HttpError(400, "invalid thinking level");
	}
	const agentSource = optionalString(config.agentSource, "agent source", { max: 10 });
	if (agentSource !== undefined && agentSource !== "user" && agentSource !== "project") {
		throw new HttpError(400, "invalid agent source");
	}
	let resumeSessionFile: string | undefined;
	if (config.resumeSessionFile !== undefined) {
		if (typeof config.resumeSessionFile !== "string" || config.resumeSessionFile.includes("\0")) {
			throw new HttpError(400, "invalid session file");
		}
		resumeSessionFile = config.resumeSessionFile;
	}
	const agent = optionalString(config.agent, "agent", { max: 64 });
	const provider = optionalString(config.provider, "provider", { pattern: MODEL_ARG_RE });
	const model = optionalString(config.model, "model", { pattern: MODEL_ARG_RE });
	// Absent fields are omitted, not set to undefined.
	return {
		cwd: cwdRaw,
		...(agent === undefined ? {} : { agent }),
		...(agentSource === undefined ? {} : { agentSource }),
		...(provider === undefined ? {} : { provider }),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		...(resumeSessionFile === undefined ? {} : { resumeSessionFile }),
	};
}
