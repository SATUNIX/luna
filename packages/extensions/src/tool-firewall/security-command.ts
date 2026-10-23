import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./config.ts";
import { DESCRIPTIONS, isLevel, LEVELS, OFF_REASON, rank, saveSecurity, type SecurityLevel, type SecuritySnapshot } from "./security-level.ts";

// remote-control mirrors dialogs to a linked phone and keeps the terminal's own dialog functions on
// the UI object under this process-wide key (remote-control/bridge.ts). Weakening is confirmed at
// the terminal only, like phone pairing, without importing another extension.
const REMOTE_MIRROR = Symbol.for("pi-system.remote-control.mirror");
type Select = ExtensionUIContext["select"];
const hasSelect = (value: unknown): value is { select: Select } => isRecord(value) && typeof value.select === "function";
function terminalSelect(ui: ExtensionUIContext): Select {
  const original: unknown = Reflect.get(ui, REMOTE_MIRROR);
  return hasSelect(original) ? (title, options, opts) => original.select(title, options, opts) : (title, options, opts) => ui.select(title, options, opts);
}
/**
 * A weakening choice at the terminal. pi's confirm starts on "Yes", so this is a two-option
 * select whose first (highlighted) option keeps things as they are. True only when the operator
 * picks `change`; No, dismissing and a timeout all keep the current state.
 */
export async function chooseAtTerminal(ui: ExtensionUIContext, title: string, keep: string, change: string, timeout: number): Promise<boolean> {
  return (await terminalSelect(ui)(title, [`No, ${keep}`, `Yes, ${change}`], { timeout })) === `Yes, ${change}`;
}
// An RPC session may be driven by a phone or the web console. pi before ctx.mode: any UI.
export function atTerminal(ctx: ExtensionContext): boolean {
  const mode: string | undefined = ctx.mode;
  return ctx.hasUI && (mode ? mode === "tui" : true);
}
// The terminal of an interactive root session: never a delegated or child session. The child
// markers are delegation-guard's launcher marker and effort's ledger, which children inherit.
// session-helpers/security-guard.ts keeps a copy (extensions do not import each other);
// tests/security-level-smoke.ts pins the two equal.
export function atRootTerminal(ctx: ExtensionContext): boolean {
  const child = Boolean(process.env.PI_KIT_INTERNAL_CHILD || process.env.PI_KIT_EFFORT_LEDGER?.trim());
  return !child && atTerminal(ctx);
}

export function registerSecurityCommand(pi: ExtensionAPI, current: (ctx?: ExtensionContext) => SecuritySnapshot, defaultLevel: (ctx: ExtensionContext) => SecurityLevel, changed: (ctx: ExtensionContext) => void, say: (ctx: ExtensionContext, text: string, level?: "info" | "warning" | "error") => void, timeoutMs: () => number): void {
  const help = "/security [off|relaxed|balanced|guarded|strict] | status | explain [level] | reset. Changes apply immediately. Weakening needs a confirmation at the terminal of an interactive root session. off is unavailable.";
  const status = (ctx: ExtensionContext): string => {
    const s = current(ctx);
    return [`Security: ${s.effective} (requested ${s.requested}; ${s.source}; revision ${s.revision})`,
      DESCRIPTIONS[s.effective], ...s.floors.map((f) => `floor: ${f.level} — ${f.reason}`),
      ...(s.effective === "strict" ? ["approval strategy pinned to operator by strict"] : []),
      ...s.warnings.map((w) => `WARNING: ${w}`), `unavailable: ${s.unavailable.join("; ")}`, help].join("\n");
  };
  pi.registerCommand("security", {
    description: help,
    getArgumentCompletions: (prefix: string) => [...LEVELS, "status", "explain", "reset", "help"].filter((v) => v.startsWith(prefix.trim().toLowerCase())).map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const words = args.trim().toLowerCase().split(/\s+/);
      let arg = words[0] ?? "";
      if (arg === "status" || arg === "help") { say(ctx, status(ctx)); return; }
      if (arg === "explain") {
        const level = words[1] ?? current(ctx).effective;
        if (!isLevel(level)) { say(ctx, help, "error"); return; }
        say(ctx, `${level}: ${DESCRIPTIONS[level]}\nAlways enforced: critical denials, protected paths, credential disclosure, unattended hard denials, pentest engagement/domain gates and unknown-tool escalation.\nUnavailable: ${current(ctx).unavailable.join("; ")}\nLocal confirmation is not an authenticated operator event.`);
        return;
      }
      if (!arg) {
        if (!ctx.hasUI) { say(ctx, status(ctx)); return; }
        const s = current(ctx);
        const options = LEVELS.map((l) => `${l}${l === s.effective ? " (current)" : ""} — ${DESCRIPTIONS[l]}`);
        // A dialog nobody answers (the web console cannot) times out as a cancel.
        const choice = await ctx.ui.select("Security — implemented tool protections", options, { timeout: timeoutMs() });
        if (choice === undefined) return;
        arg = LEVELS[options.indexOf(choice)] ?? "";
        if (!arg) return;
      }
      const reset = arg === "reset";
      const level = reset ? defaultLevel(ctx) : arg;
      if (!isLevel(level)) { say(ctx, help, "error"); return; }
      if (level === "off") { say(ctx, OFF_REASON, "warning"); return; }
      const before = current(ctx);
      const below = before.floors.filter((f) => rank(level) < rank(f.level));
      if (below.length > 0) {
        say(ctx, `Security cannot be set to ${level}, below an active floor: ${below.map((f) => `${f.level} (${f.reason})`).join("; ")}.`, "warning");
        return;
      }
      if (rank(level) < rank(before.effective)) {
        if (!atRootTerminal(ctx)) { say(ctx, "Weakening security needs a confirmation at the terminal of an interactive root session; refused in headless, RPC and delegated/child sessions. Change it at the terminal.", "warning"); return; }
        const confirmed = await chooseAtTerminal(ctx.ui, `Weaken security? ${before.effective} → ${level}. Reusable approvals and the judge cache will be revoked. This is a local confirmation, not an authenticated operator event.`, `keep ${before.effective}`, `weaken to ${level}`, timeoutMs());
        if (!confirmed) return;
        // A floor or level may have changed while the confirmation was open. Never apply a
        // stale confirmation to a different state (including a higher strict pin).
        if (JSON.stringify(current(ctx)) !== JSON.stringify(before)) { say(ctx, "Security changed while confirmation was pending; nothing changed. Review /security status and choose again.", "warning"); return; }
      }
      try {
        saveSecurity(level, reset ? "profile" : "operator");
        changed(ctx);
        say(ctx, status(ctx));
      } catch (error) { say(ctx, `Security could not be saved: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });
}
