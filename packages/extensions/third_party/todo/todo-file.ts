// Session-aware todo file location + format, shared by the todo tool, the
// custom-footer checklist widget, verify-gate, and verifier-board.
//
// Per-session storage: each pi session gets its own file under
// `<cwd>/.pi/todos/<session-id>.md`, so multiple sessions running from the same
// workspace keep separate todo lists and never inherit or clobber each other's.
// The files persist on disk (backed up; `.pi/todos/` is git-ignorable by the
// operator), so a resumed session finds its list again.
//
// Backward compatibility:
//   - PI_KIT_TODO_FILE set  -> that exact file (legacy behavior, wins).
//   - no session id         -> legacy <cwd>/TODO.md (headless/sub-agent runs,
//     or when the session manager is unavailable).
// Session ids are validated (pi's assertValidSessionId character set) so a
// session can never produce a path traversal.

import fs from "node:fs";
import path from "node:path";

export type TodoState = "open" | "active" | "done";

export interface Todo {
  id: number;
  text: string;
  state: TodoState;
}

const MARK: Record<TodoState, string> = { open: " ", active: "~", done: "x" };

const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

/** Resolve a session id from a (read-only) session manager, if present. */
export function resolveSessionId(sessionManager?: unknown): string | undefined {
  try {
    const id = (sessionManager as { getSessionId?: () => unknown } | undefined)?.getSessionId?.();
    return isSessionId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Directory holding per-session todo files. */
export function todoStorageRoot(cwd: string): string {
  return process.env.PI_KIT_TODO_DIR ?? path.join(cwd, ".pi", "todos");
}

/**
 * The todo file for a session in this workspace.
 * Priority: PI_KIT_TODO_FILE (explicit override) > per-session file > legacy
 * <cwd>/TODO.md when no session id is known.
 */
export function todoFilePath(cwd: string, sessionId?: string): string {
  if (process.env.PI_KIT_TODO_FILE) return process.env.PI_KIT_TODO_FILE;
  if (isSessionId(sessionId)) return path.join(todoStorageRoot(cwd), `${sessionId}.md`);
  return path.join(cwd, "TODO.md");
}

export function readTodos(filePath: string): { todos: Todo[]; nextId: number } {
  if (!fs.existsSync(filePath)) return { todos: [], nextId: 1 };
  const content = fs.readFileSync(filePath, "utf8");
  const todos: Todo[] = [];
  let nextId = 1;
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^- \[([ xX~])\] #(\d+): (.+)$/);
    if (m) {
      const id = parseInt(m[2] ?? "", 10);
      todos.push({ id, text: m[3] ?? "", state: m[1] === "~" ? "active" : m[1] === " " ? "open" : "done" });
      if (id >= nextId) nextId = id + 1;
    }
  }
  return { todos, nextId };
}

export function writeTodos(filePath: string, todos: Todo[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = todos.map((t) => `- [${MARK[t.state]}] #${t.id}: ${t.text}`);
  fs.writeFileSync(filePath, `# TODO\n\n${lines.join("\n")}\n`);
}

export function renderTodos(todos: Todo[], headline?: string): string {
  if (todos.length === 0) return headline ? `${headline}\nNo todos.` : "No todos.";
  const done = todos.filter((t) => t.state === "done").length;
  const active = todos.find((t) => t.state === "active");
  const lines = [
    ...(headline ? [headline] : []),
    `Todos: ${done}/${todos.length} done${active ? ` · in progress: #${active.id}` : ""}`,
    ...todos.map((t) => `[${MARK[t.state]}] #${t.id}: ${t.text}${t.state === "active" ? "  (in progress)" : ""}`),
  ];
  return lines.join("\n");
}
