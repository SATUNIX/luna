import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

function handoffFilePath(cwd: string): string {
  return process.env.PI_KIT_HANDOFF_FILE ?? path.join(cwd, "HANDOFF.md");
}

function appendHandoff(filePath: string, note: string): void {
  const timestamp = new Date().toISOString();
  const entry = `\n## ${timestamp}\n\n${note.trim()}\n`;
  const appendFlags = fs.constants.O_WRONLY | fs.constants.O_APPEND;
  let fd: number;
  let created = false;
  try {
    fd = fs.openSync(filePath, appendFlags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Native no-follow blocks final-component symlinks where supported. Non-blocking
    // open lets the regular-file check reject a FIFO without waiting for a reader.
    fd = fs.openSync(filePath, appendFlags | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Handoff notes require a regular file");
    // Keep the opened file even if another process replaces the path. Never truncate
    // existing notes, including a file created concurrently with the exclusive open.
    fs.writeFileSync(fd, created ? `# Handoff Notes\n${entry}` : entry);
  } finally {
    fs.closeSync(fd);
  }
}

export default function (pi: ExtensionAPI) {
  // The automatic note ("Session ended. Recent tools: bash, read.") carries no resumable
  // information, yet it created/appended HANDOFF.md in every directory pi was ever started
  // in. It is now opt-in (PI_KIT_HANDOFF_AUTO=1); /handoff <note> is the deliberate path, and
  // the memory vault's per-turn recaps cover automatic continuity.
  pi.on("session_shutdown", async (_event, ctx) => {
    if (process.env.PI_KIT_INTERNAL_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "1") return;
    if (process.env.PI_KIT_HANDOFF_AUTO !== "1") return;
    const entries = ctx.sessionManager.getEntries();
    // Collect last few tool results as a brief summary
    const recentTools: string[] = [];
    for (let i = entries.length - 1; i >= 0 && recentTools.length < 5; i--) {
      const e = entries[i];
      if (e?.type === "message" && e.message.role === "toolResult") {
        const msg = e.message as { toolName?: string };
        if (msg.toolName) recentTools.unshift(msg.toolName);
      }
    }

    const note = recentTools.length > 0
      ? `Session ended. Recent tools: ${recentTools.join(", ")}.`
      : "Session ended.";

    const filePath = handoffFilePath(ctx.cwd);
    appendHandoff(filePath, note);
    if (ctx.hasUI) ctx.ui.notify(`Handoff note written to ${path.basename(filePath)}`, "info");
  });

  pi.registerCommand("handoff", {
    description: "Write a handoff note to HANDOFF.md. Usage: /handoff <note>",
    handler: async (args, ctx) => {
      const note = args.trim();
      if (!note) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /handoff <note>", "warning");
        return;
      }
      const filePath = handoffFilePath(ctx.cwd);
      appendHandoff(filePath, note);
      if (ctx.hasUI) ctx.ui.notify(`Handoff note written to ${path.basename(filePath)}`, "info");
    },
  });
}
