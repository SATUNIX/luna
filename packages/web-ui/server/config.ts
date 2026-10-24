// config.ts — central paths and server settings for pi-console.
// All paths resolve from this module's own directory, never from process.cwd().
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = os.homedir();

const env = process.env; // node:os exposes homedir; process.env exposes getenv semantics
export const PI_HOME =
	env.PI_CODING_AGENT_DIR || path.join(HOME, ".pi", "agent");

export const SESSIONS_DIR =
	env.PI_CODING_AGENT_SESSION_DIR || path.join(PI_HOME, "sessions");

// Default working directory for new sessions, and the candidate working directories.
export const DEFAULT_CWD = env.PI_CONSOLE_DEFAULT_CWD || HOME;

// User-level and project-level agent directories (YAML-frontmatter .md files).
// User agents live in <agent dir>/agents, the directory the subagent tool reads its user roles from.
// Project agents ship with the kit package; override with PI_CONSOLE_PROJECT_AGENTS.
export const USER_AGENT_DIR = path.join(PI_HOME, "agents");
export const PROJECT_AGENT_DIR =
	env.PI_CONSOLE_PROJECT_AGENTS ||
	path.join(APP_ROOT, "..", "kit", "agents");
// A fixed pair: index 0 is the user-level directory, index 1 the project-level one.
export const AGENT_DIRS: readonly [user: string, project: string] = [USER_AGENT_DIR, PROJECT_AGENT_DIR];

// Kit root (used for prompt templates and skills listings).
export const KIT_ROOT = path.join(APP_ROOT, "..", "kit");
export const PROMPTS_DIR = path.join(KIT_ROOT, "prompts");
export const SKILLS_DIR = path.join(KIT_ROOT, "skills");

export const SETTINGS_FILE = path.join(PI_HOME, "settings.json");
export const MODELS_FILE = path.join(PI_HOME, "models.json");

// Scratch state (temp agent prompts, a generated token file). Overridable so an automated test
// can run a server without touching the runtime directory of a console the developer has open.
export const RUNTIME_DIR =
	env.PI_CONSOLE_RUNTIME_DIR || path.join(APP_ROOT, ".runtime");
export const PUBLIC_DIR = path.join(APP_ROOT, "public");
// Where a server that generated its own access token leaves it (mode 0600) when stdout is
// not a terminal. `/console` uses the same file name for the token it hands to the server.
export const TOKEN_FILE = path.join(RUNTIME_DIR, "console.token");

// The pi entrypoint: resolved from PATH (works for nvm and system installs alike).
export const PI_BIN = env.PI_BIN || "pi";

export const HOST = env.PI_CONSOLE_HOST || "127.0.0.1";
export const PORT = Number(env.PI_CONSOLE_PORT || "8123");

export function ensureRuntimeDir(): void {
	// Owner-only: the directory can hold the access token file and the server log.
	fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
}
