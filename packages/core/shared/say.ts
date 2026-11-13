/**
 * Operator-facing output for slash commands: one way to say something and one way to refuse a bad
 * argument, so a command never prints nothing in a run without a UI and never words a usage error
 * its own way.
 *
 * ctx.ui.notify is fire-and-forget and a no-op in print/JSON runs, where a command used to print
 * nothing at all. Without a UI the message goes to stderr (stdout stays reserved for the run's own
 * output); notify is still called best-effort so a UI-less host that implements it keeps working.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SayLevel = "info" | "warning" | "error";

export function say(ctx: ExtensionContext, content: string, level: SayLevel = "info"): void {
  let hasUI: boolean;
  try {
    hasUI = ctx.hasUI;
  } catch {
    return; // pi throws on any use of a ctx that a reload replaced: nothing left to tell
  }
  if (hasUI) {
    try {
      ctx.ui.notify(content, level);
    } catch {
      /* stale ctx after a reload: nothing left to tell */
    }
    return;
  }
  try {
    process.stderr.write(`[pi-kit] ${content}\n`);
  } catch {
    /* no stderr */
  }
  try {
    ctx.ui?.notify?.(content, level);
  } catch {
    /* no-op UI */
  }
}

/** Refuse an argument the command does not take: what was given, the usage, and that nothing changed. */
export function usageError(ctx: ExtensionContext, command: string, usage: string, given?: string): void {
  const got = given !== undefined && given.trim() !== "" ? ` got "${given.trim()}".` : "";
  say(ctx, `/${command}:${got} Usage: /${command} ${usage}. Nothing was changed.`, "error");
}
