// Read-only copy of the per-session todo file location + format that
// vendor/todo/todo-file.ts owns and writes. Duplicated here (not imported)
// because packages/core/verify.ts's self-containment lint forbids an extension from
// importing another extension/vendor package's internals — every extension
// must stay independently extractable. Keep this in sync with
// vendor/todo/todo-file.ts if the on-disk format ever changes; only vendor/todo
// itself writes the file.

import fs from "node:fs";
import path from "node:path";

export type TodoState = "open" | "active" | "done";

export interface Todo {
  id: number;
  text: string;
  state: TodoState;
}

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
