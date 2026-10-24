import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async (_event, ctx) => {
    if (process.env.PI_KIT_INTERNAL_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "1") return;
    const { stdout: status, code } = await pi.exec("git", ["status", "--porcelain"]);
    if (code !== 0 || status.trim().length === 0) return;

    const entries = ctx.sessionManager.getEntries();
    let lastAssistantText = "";
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type === "message" && entry.message.role === "assistant") {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          lastAssistantText = content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map(c => c.text)
            .join("\n");
        }
        break;
      }
    }

    const firstLine = lastAssistantText.split("\n")[0] || "Work in progress";
    const commitMessage = `[pi] ${firstLine.slice(0, 50)}${firstLine.length > 50 ? "..." : ""}`;

    // Kit artefacts (save snapshots, compaction copies, audit logs) live under <cwd>/.pi;
    // they are session data, never project changes, so they are excluded from staging.
    await pi.exec("git", ["add", "-A", "--", ".", ":(exclude).pi"]);
    const { code: commitCode } = await pi.exec("git", ["commit", "-m", commitMessage]);
    if (commitCode === 0 && ctx.hasUI) {
      ctx.ui.notify(`Auto-committed: ${commitMessage}`, "info");
    }
  });
}
