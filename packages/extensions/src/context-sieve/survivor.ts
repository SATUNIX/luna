// The compaction survivor record: what must still be in front of the model after a compaction,
// whatever the summary kept. pi's summariser is goal-agnostic, so a long task's plan,
// the runs it has in flight and the files it was working on can be summarised away. The record is
// rebuilt from the stores that own that state (never from the summary), once per compaction, and
// injected on the next prompt like any other per-turn contribution.
//
// Sources, all read-only and best effort:
//   plan           the session's todo list, <cwd>/.pi/todos/<session>.md (the todo tool)
//   running runs   <cwd>/.pi/workflows/runs/<id>/{state,run}.json with status "running"
//   files          the paths of the last edit/write tool calls on the session branch
// The goal is not pinned here: goal-core injects its session-scoped goal on every prompt, so it
// never needs to survive a summary. There is no store of standing constraints, so none are pinned.
import fs from "node:fs";
import path from "node:path";

const MAX_FILES = 8;
const MAX_RUNS = 5;
const MAX_TODOS = 12;
const MAX_LINE = 200;

export const SURVIVOR_ID = "compaction-survivor";

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, MAX_LINE);

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function openTodos(cwd: string, sessionId: string | undefined): string[] {
  const root = process.env.PI_KIT_TODO_DIR ?? path.join(cwd, ".pi", "todos");
  const file = process.env.PI_KIT_TODO_FILE ?? (sessionId ? path.join(root, `${sessionId}.md`) : path.join(cwd, "TODO.md"));
  const rows: string[] = [];
  for (const line of readText(file).split(/\r?\n/)) {
    const m = /^- \[([ xX~])\] #(\d+): (.+)$/.exec(line);
    if (m && m[1]?.toLowerCase() !== "x") rows.push(`#${m[2] ?? ""} ${m[1] === "~" ? "(in progress) " : ""}${oneLine(m[3] ?? "")}`);
  }
  return rows.slice(0, MAX_TODOS);
}

function runningRuns(cwd: string): string[] {
  const root = path.join(cwd, ".pi", "workflows", "runs");
  let ids: string[];
  try {
    ids = fs.readdirSync(root);
  } catch {
    return [];
  }
  const running: string[] = [];
  for (const id of ids) {
    for (const name of ["state.json", "run.json"]) {
      try {
        const parsed: unknown = JSON.parse(readText(path.join(root, id, name)));
        if (typeof parsed === "object" && parsed !== null && (parsed as { status?: unknown }).status === "running") running.push(id);
      } catch {
        /* no such file, or not JSON */
      }
    }
  }
  return running.slice(-MAX_RUNS);
}

/** The paths of the newest edit/write tool calls in a branch's entries, newest last, without repeats. */
export function lastTouchedFiles(entries: readonly unknown[]): string[] {
  const seen: string[] = [];
  for (const entry of entries) {
    const message = (entry as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null)?.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as unknown[]) {
      const call = part as { type?: unknown; name?: unknown; arguments?: { path?: unknown; file_path?: unknown } } | null;
      if (call?.type !== "toolCall" || (call.name !== "edit" && call.name !== "write")) continue;
      const file = call.arguments?.path ?? call.arguments?.file_path;
      if (typeof file !== "string" || file === "") continue;
      const at = seen.indexOf(file);
      if (at >= 0) seen.splice(at, 1);
      seen.push(file);
    }
  }
  return seen.slice(-MAX_FILES);
}

/** The record as injected text, or "" when there is nothing to pin. */
export function buildSurvivor(input: { cwd: string; sessionId: string | undefined; files: readonly string[] }): string {
  const todos = openTodos(input.cwd, input.sessionId);
  const runs = runningRuns(input.cwd);
  const sections = [
    todos.length ? `Open plan items:\n${todos.map((t) => `- ${t}`).join("\n")}` : "",
    runs.length ? `Runs still in flight: ${runs.join(", ")} (workflow_status shows each)` : "",
    input.files.length ? `Last files edited: ${input.files.join(", ")}` : "",
  ].filter(Boolean);
  if (sections.length === 0) return "";
  return `State to carry across the compaction just done (rebuilt from the workspace, not from the summary):\n${sections.join("\n")}`;
}
