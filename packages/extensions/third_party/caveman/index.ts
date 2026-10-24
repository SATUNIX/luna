import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

type Level = "off" | "lite" | "full" | "ultra" | "micro";

interface CavemanConfig {
  defaultLevel: Level;
  detailTriggers: string[];
}

const STATUS_KEY = "caveman";
const CONTRIB_ID = "caveman";
const LEVELS: Level[] = ["off", "lite", "full", "ultra", "micro"];

const BASE =
  "Write terse. Drop articles (a/an/the) and filler (just/really/basically/actually/simply). " +
  "Cut pleasantries and hedging. Prefer the shape: [thing] [action] [reason].";

const INTENSITY: Record<Exclude<Level, "off">, string> = {
  lite: "Keep full sentences and articles, but no filler and no hedging. Professional and tight.",
  full: "Drop articles. Sentence fragments are fine. Use short synonyms.",
  ultra:
    "Abbreviate common terms (DB, auth, config, req, res, fn, impl). Strip conjunctions. Use arrows (->) for causality.",
  micro:
    "Maximum compression: symbols, arrows, and abbreviations throughout. Keystrokes over grammar. Accuracy first.",
};

// Always-on scope guard: caveman only shapes conversation, never artifacts.
const CONTENT_GUARD =
  "Scope: this applies ONLY to your conversational replies to the human and to messages you send " +
  "to sub-agents. NEVER compress or abbreviate file contents, code you write, commit messages, " +
  "security findings, reports, or any document artifact — those stay complete and verbose.";

const SAFETY =
  "Auto-clarity: drop compression for security warnings, irreversible-action confirmations, or " +
  "when the user seems confused; resume after.";

const DEFAULT_DETAIL_TRIGGERS = [
  "/skill:finding-writing",
  "/skill:report-export-review",
  "/skill:documentation-workflow",
  "/pentest-report-finding",
  "/report-export-review",
  "/docs-*",
];

function configPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "caveman.json");
}

function loadConfig(): CavemanConfig {
  const fallback: CavemanConfig = { defaultLevel: "full", detailTriggers: DEFAULT_DETAIL_TRIGGERS };
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback;
    const detailTriggers: unknown = Reflect.get(raw, "detailTriggers");
    const defaultLevel: unknown = Reflect.get(raw, "defaultLevel");
    const triggers = Array.isArray(detailTriggers)
      ? detailTriggers.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      defaultLevel: LEVELS.find((level) => level === defaultLevel) ?? fallback.defaultLevel,
      detailTriggers: triggers.length > 0 ? triggers : fallback.detailTriggers,
    };
  } catch {
    return fallback;
  }
}

function envLevel(): Level | null {
  const v = process.env.PI_KIT_CAVEMAN_LEVEL as Level | undefined;
  return v && LEVELS.includes(v) ? v : null;
}

// B-005: contribution files are scoped per session so concurrent sessions sharing a cwd
// (child agents do) cannot overwrite each other. The resolver is duplicated in each producer
// (not imported) because every extension must stay independently extractable
// (packages/core/verify.ts self-containment lint).
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
let currentSessionId: string | undefined;

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

function resolveSessionId(sessionManager?: unknown): string | undefined {
  try {
    const id = (sessionManager as { getSessionId?: () => unknown } | undefined)?.getSessionId?.();
    return isSessionId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function contribDir(cwd: string, sessionId: string | undefined = currentSessionId): string {
  const base = path.join(cwd, ".pi", "ctx-contributions");
  return isSessionId(sessionId) ? path.join(base, "sessions", sessionId) : base;
}

function contribFile(cwd: string): string {
  return path.join(contribDir(cwd), `${CONTRIB_ID}.json`);
}

function buildDirective(level: Exclude<Level, "off">): string {
  return [
    `## Response Style (caveman: ${level})`,
    "",
    BASE,
    INTENSITY[level],
    "",
    CONTENT_GUARD,
    "",
    SAFETY,
  ].join("\n");
}

function writeContribution(cwd: string, level: Exclude<Level, "off">): void {
  try {
    const dir = contribDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      contribFile(cwd),
      JSON.stringify({
        id: CONTRIB_ID,
        priority: 3, // low: yields to guidelines/goal under the sieve budget
        budgetTokens: 512,
        content: buildDirective(level),
      }),
      "utf8",
    );
  } catch {
    // Style is best-effort; never break the session.
  }
}

function removeContribution(cwd: string): void {
  try {
    fs.rmSync(contribFile(cwd), { force: true });
  } catch {
    // ignore
  }
}

function firstToken(text: string): string {
  return text.trim().split(/\s+/)[0] ?? "";
}

function matchesTrigger(token: string, triggers: string[]): boolean {
  const t = token.toLowerCase();
  for (const raw of triggers) {
    if (typeof raw !== "string") continue;
    const trig = raw.toLowerCase();
    if (trig.endsWith("*")) {
      if (t.startsWith(trig.slice(0, -1))) return true;
    } else if (t === trig) {
      return true;
    }
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  let cwd = "";
  let level: Level = envLevel() ?? config.defaultLevel;
  // Session-flip: once a report/doc resource is invoked, caveman stays off for the session.
  let detailMode = false;

  function persist(): void {
    pi.appendEntry("caveman-state", { level, detailMode });
  }

  function apply(): void {
    if (!cwd) return;
    const effective: Level = detailMode ? "off" : level;
    if (effective === "off") removeContribution(cwd);
    else writeContribution(cwd, effective);
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    currentSessionId = resolveSessionId(ctx.sessionManager);
    // Restore prior session state if present (survives /reload).
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "caveman-state") {
        const data = entry.data as { level?: Level; detailMode?: boolean } | undefined;
        if (data?.level && LEVELS.includes(data.level)) level = envLevel() ?? data.level;
        if (typeof data?.detailMode === "boolean") detailMode = data.detailMode;
      }
    }
    // Runs after context-sieve's session_start wipe (vendor/ loads after extensions/).
    apply();
    ctx.ui.setStatus(STATUS_KEY, detailMode ? "off (detail)" : level);
  });

  // Session-flip detection happens in `input`, which precedes `before_agent_start`
  // (where context-sieve reads contributions), so the current turn reflects the decision.
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return;
    if (detailMode) return;
    if (matchesTrigger(firstToken(event.text), config.detailTriggers)) {
      detailMode = true;
      apply();
      persist();
      ctx.ui.setStatus(STATUS_KEY, "off (detail)");
      ctx.ui.notify("caveman: off for this session (detailed writing detected)", "info");
    }
  });

  pi.registerCommand("caveman", {
    description: "Toggle/set output compression: /caveman [on|off|lite|full|ultra|micro|status]",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "status") {
        ctx.ui.notify(
          `caveman: ${detailMode ? "off (detail mode)" : level}\n` +
            `default: ${config.defaultLevel}\ndetail triggers: ${config.detailTriggers.join(", ")}`,
          "info",
        );
        return;
      }

      if (arg === "off" || arg === "stop" || arg === "quit") {
        level = "off";
      } else if (arg === "on") {
        detailMode = false; // clear session-flip suppression
        level = config.defaultLevel === "off" ? "full" : config.defaultLevel;
      } else if (LEVELS.includes(arg as Level)) {
        detailMode = false;
        level = arg as Level;
      } else if (arg === "") {
        // bare toggle
        level = level === "off" ? (config.defaultLevel === "off" ? "full" : config.defaultLevel) : "off";
        if (level !== "off") detailMode = false;
      } else {
        ctx.ui.notify(`caveman: unknown option "${arg}"`, "error");
        return;
      }

      apply();
      persist();
      const shown = detailMode ? "off (detail)" : level;
      ctx.ui.setStatus(STATUS_KEY, shown);
      ctx.ui.notify(`caveman: ${shown}`, "info");
    },
  });
}
