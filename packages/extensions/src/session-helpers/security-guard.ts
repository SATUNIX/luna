// A /profile switch writes the target profile's securityLevel (source "profile"). When that is
// lower than the level in force, the switch weakens security exactly as `/security <lower>` would,
// so it takes the same path: a choice at the terminal of an interactive root session, never on a
// linked phone, and a refusal everywhere else. The choice starts on "No".
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// LEVELS, securityFilePath, atRootTerminal and promptTimeoutMs copy tool-firewall's
// (security-level.ts, security-command.ts, index.ts): extensions do not import each other, so
// tests/security-level-smoke.ts pins each copy equal to the firewall's.
export const LEVELS = ["off", "relaxed", "balanced", "guarded", "strict"] as const;
type Level = (typeof LEVELS)[number];
const isLevel = (v: unknown): v is Level => LEVELS.some((l) => l === v);
const rank = (l: Level): number => LEVELS.indexOf(l);

export interface Lowering { from: Level; to: Level }

/**
 * The lowering a switch to `target` would apply, or null. An operator-chosen level survives
 * profile switches (lib/profiles.ts writeSecurityConfig), so only a profile-sourced or missing
 * level can be lowered. A missing or unreadable file counts as the current profile's default.
 */
export function securityLowering(securityFile: string, currentDefault: unknown, targetLevel: unknown): Lowering | null {
  if (!isLevel(targetLevel)) return null; // runSwitch refuses unknown levels itself
  let from: Level = isLevel(currentDefault) ? currentDefault : "balanced";
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(securityFile, "utf8"));
    if (saved && typeof saved === "object") {
      if (Reflect.get(saved, "source") === "operator") return null;
      const level: unknown = Reflect.get(saved, "level");
      if (isLevel(level)) from = level;
    }
  } catch { /* missing or unreadable: the firewall uses the profile default */ }
  return rank(targetLevel) < rank(from) ? { from, to: targetLevel } : null;
}

export function securityFilePath(agentDir: string): string {
  return process.env.PI_KIT_SECURITY_CONFIG?.trim() || path.join(agentDir, "pi-kit", "security.json");
}

// remote-control records the terminal's own dialogs on the UI object under this key (bridge.ts).
const MIRROR = Symbol.for("pi-system.remote-control.mirror");
type Select = (...args: Parameters<ExtensionUIContext["select"]>) => Promise<unknown>;
// The choice is only compared with LOWER, so whatever the mirrored select resolves to is kept unknown.
function terminalSelect(ui: ExtensionUIContext): Select {
  const original: unknown = Reflect.get(ui, MIRROR);
  const select: unknown = original && typeof original === "object" ? Reflect.get(original, "select") : undefined;
  if (typeof select !== "function") return (...args) => ui.select(...args);
  return async (...args) => {
    const choice: unknown = await Reflect.apply(select, original, args);
    return choice;
  };
}

export function atRootTerminal(ctx: ExtensionContext): boolean {
  const child = Boolean(process.env.PI_KIT_INTERNAL_CHILD || process.env.PI_KIT_EFFORT_LEDGER?.trim());
  const mode: string | undefined = ctx.mode;
  return !child && ctx.hasUI && (mode ? mode === "tui" : true);
}

export function promptTimeoutMs(): number {
  const n = Number(process.env.PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 900000;
}

export const KEEP = "No, keep the current security level (nothing changes)";
export const LOWER = "Yes, switch and lower security";

/** "refused" outside an interactive root terminal; "declined" unless the operator picks LOWER. */
export async function confirmLowering(ctx: ExtensionContext, target: string, l: Lowering): Promise<"confirmed" | "declined" | "refused"> {
  if (!atRootTerminal(ctx)) return "refused";
  const choice = await terminalSelect(ctx.ui)(`Switching to "${target}" lowers security: ${l.from} → ${l.to}`, [KEEP, LOWER], { timeout: promptTimeoutMs() });
  return choice === LOWER ? "confirmed" : "declined";
}
