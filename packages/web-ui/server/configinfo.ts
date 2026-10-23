// configinfo.ts — expose how this pi installation is configured (read-only).
// Powers the web UI's Config view: what the CLI is using, where things live, and
// which prompt templates / skills are available.
import * as fs from "node:fs";
import * as path from "node:path";
import {
	AGENT_DIRS,
	HOST,
	KIT_ROOT,
	MODELS_FILE,
	PI_BIN,
	PI_HOME,
	PORT,
	PROMPTS_DIR,
	PUBLIC_DIR,
	RUNTIME_DIR,
	SESSIONS_DIR,
	SETTINGS_FILE,
	SKILLS_DIR,
} from "./config.ts";
import { listAgents, parseFrontmatter } from "./agents.ts";
import { KNOWN_TOOLS } from "./agentstore.ts";
import { listModels, readConsoleSettings, type ProviderInfo } from "./models.ts";
import { lensStatus, LENS_DIR, type LensStatus } from "./lens.ts";

const VERSION = "0.1.0";

/** What /api/config returns: how this installation is configured. */
export interface ConfigInfo {
	app: {
		version: string;
		node: string;
		platform: NodeJS.Platform;
		host: string;
		port: number;
		publicDir: string;
		runtimeDir: string;
	};
	cli: {
		binary: string;
		piHome: string;
		settingsFile: string;
		modelsFile: string;
		sessionsDir: string;
		sessionFormat: string;
	};
	settings: {
		defaultProvider: string;
		defaultModel: string;
		theme: string | null;
		defaultThinkingLevel: string | null;
		packages: number;
	};
	paths: {
		agentDirs: readonly string[];
		kitRoot: string;
		promptsDir: string;
		skillsDir: string;
		lensDir: string | null;
	};
	models: ProviderInfo[];
	agentCount: number;
	tools: readonly string[];
	lens: LensStatus;
}

/** A prompt template or a skill shipped in the kit. */
export interface KitEntry {
	name: string;
	file: string;
	description: string;
}

/** Everything the Config view needs about this installation. */
export function configInfo(): ConfigInfo {
	const settings = readConsoleSettings();
	const models = listModels();
	return {
		app: {
			version: VERSION,
			node: process.version,
			platform: process.platform,
			host: HOST,
			port: PORT,
			publicDir: PUBLIC_DIR,
			runtimeDir: RUNTIME_DIR,
		},
		cli: {
			binary: PI_BIN,
			piHome: PI_HOME,
			settingsFile: SETTINGS_FILE,
			modelsFile: MODELS_FILE,
			sessionsDir: SESSIONS_DIR,
			sessionFormat: "jsonl (json lines) per cwd-encoded directory",
		},
		settings: {
			defaultProvider: settings.defaultProvider || models.default.provider,
			defaultModel: settings.defaultModel || models.default.model,
			theme: settings.theme || null,
			defaultThinkingLevel: settings.defaultThinkingLevel || null,
			packages: settings.packages ? settings.packages.length : 0,
		},
		paths: {
			agentDirs: AGENT_DIRS,
			kitRoot: KIT_ROOT,
			promptsDir: PROMPTS_DIR,
			skillsDir: SKILLS_DIR,
			lensDir: LENS_DIR || null,
		},
		models: models.providers,
		agentCount: listAgents().length,
		tools: KNOWN_TOOLS,
		lens: lensStatus(),
	};
}

/** Prompt templates shipped in the kit. */
export function listPrompts(): KitEntry[] {
	const prompts: KitEntry[] = [];
	try {
		for (const name of fs.readdirSync(PROMPTS_DIR)) {
			if (!name.endsWith(".md")) continue;
			const file = path.join(PROMPTS_DIR, name);
			let description = "";
			try {
				const text = fs.readFileSync(file, "utf8");
				const fm = parseFrontmatter(text);
				description =
					fm.get("description") ||
					text.split("\n").find((l) => l.trim() && !l.startsWith("---")) ||
					"";
			} catch {
				/* ignore */
			}
			prompts.push({
				name: name.replace(/\.md$/, ""),
				file,
				description: description.slice(0, 200),
			});
		}
	} catch {
		/* directory may not exist */
	}
	return prompts.sort((a, b) => a.name.localeCompare(b.name));
}

/** Skills shipped in the kit (directories containing SKILL.md). */
export function listSkills(): KitEntry[] {
	const skills: KitEntry[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
	} catch {
		return skills;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const file = path.join(SKILLS_DIR, entry.name, "SKILL.md");
		if (!fs.existsSync(file)) continue;
		let description = "";
		try {
			description =
				parseFrontmatter(fs.readFileSync(file, "utf8")).get("description") || "";
		} catch {
			/* ignore */
		}
		skills.push({
			name: entry.name,
			file,
			description: description.slice(0, 240),
		});
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}
