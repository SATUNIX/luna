// What a run says about itself outside its own directory: the shared agent-state file
// (core/shared/agent-state.ts, the schema herdr and the web console read) and, whenever the run
// is not working, an `outcome.md` in the run directory that says in plain words how it ended and
// where to look next. Both are reports: a failure to write either is ignored, never a run failure.
import path from "node:path";
import { agentStateDir, buildAgentState, readAgentStates, writeAgentState, type AgentStateName } from "../../core/shared/agent-state.ts";
import { writeFileSafe } from "../../core/shared/safe-fs.ts";
import { stateHome } from "./paths.ts";
import type { RunState, RunStatus } from "./lifecycle.ts";

/** The agent-state name for a run status. A run that waits for nobody and may be resumed is parked. */
export function agentStateFor(status: RunStatus): AgentStateName {
  switch (status) {
    case "succeeded": return "done";
    case "failed": return "failed";
    case "cancelled": return "stopped";
    case "blocked": return "blocked";
    case "paused": case "budget_exhausted": return "parked";
    default: return "working"; // setup, ready, running, recovering
  }
}

const NEXT: Partial<Record<RunStatus, string>> = {
  succeeded: "Review the result and merge or export it.",
  failed: "failed is terminal. Export what exists and start a new run from it if you want to go on.",
  cancelled: "cancelled is terminal. Export what exists if you want to keep it.",
  blocked: "Answer the question above with `resume --answer \"<your answer>\"`.",
  paused: "Resume when you are ready.",
  budget_exhausted: "Raise the limits with `reconfigure`, then resume; or stop here and export.",
};

/** The text of outcome.md for a run that is not working. */
export function outcomeMarkdown(s: RunState): string {
  const lines = [
    `# Run ${s.run}: ${s.status}`,
    "",
    ...(s.outcome ? [`Reason: ${s.outcome.reason}${s.outcome.detail ? ` (${s.outcome.detail})` : ""}`] : s.lastError ? [`Last error: ${s.lastError}`] : []),
    ...(s.blocker ? [`Waiting for: ${s.blocker.question}`] : []),
    `Spent: $${s.usage.usd.toFixed(2)}, ${s.usage.steps} steps, ${Math.round(s.usage.minutes)} minutes`,
    `Updated: ${s.updatedAt}`,
    "",
    NEXT[s.status] ?? "",
    "",
  ];
  return lines.join("\n");
}

/** Write the agent-state file for the run's current state, and outcome.md when it is not working. */
export function reportRun(s: RunState, paths: { root: string; work: string }, env: NodeJS.ProcessEnv = process.env): void {
  try {
    // A run in the configured home reports to the shared directory; one a caller put elsewhere (a test)
    // reports beside it, so it never writes into the user's state. LUNA_AGENT_STATE_DIR overrides both.
    const home = path.dirname(paths.root);
    const dir = (env.LUNA_AGENT_STATE_DIR?.trim() || home === stateHome(env)) ? agentStateDir(env) : path.join(home, ".agents");
    const id = `autonomy-${s.run}`;
    const state = agentStateFor(s.status);
    const previous = readAgentStates(dir).find((a) => a.id === id);
    const note = s.blocker?.question ?? s.outcome?.reason ?? s.lastError;
    writeAgentState(dir, buildAgentState({ id, state, source: "autonomy", waitingFor: s.blocker?.question, tail: note, worktree: paths.work, costUsd: s.usage.usd, previous }));
    if (state !== "working") writeFileSafe(path.join(paths.root, "outcome.md"), outcomeMarkdown(s), { root: paths.root });
  } catch { /* a report never fails the run */ }
}
