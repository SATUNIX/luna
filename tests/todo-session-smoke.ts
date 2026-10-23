#!/usr/bin/env node
/**
 * Offline checks for session-tied todo lists: each pi session gets its own file
 * under <cwd>/.pi/todos/<session-id>.md so parallel sessions in the same
 * workspace keep independent lists and never inherit one another's. Covers path
 * resolution (per-session, legacy fallback, env overrides, traversal safety),
 * two-session isolation, tool writes landing in the right file, and the readers
 * (footer, verify-gate, verifier-board) resolving the session's file.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace, textOf } from "../packages/core/eval/harness.ts";
import type * as TodoFile from "../packages/extensions/third_party/todo/todo-file.ts";
import type * as Todo from "../packages/extensions/third_party/todo/index.ts";
import type * as CustomFooter from "../packages/extensions/third_party/custom-footer/index.ts";
import type * as VerifyGate from "../packages/extensions/src/verify-gate/index.ts";
import type * as VerifierBoard from "../packages/extensions/src/verifier-board/index.ts";

interface SessionCtx {
  cwd: string;
  sessionManager: { getSessionId: () => string };
}
interface TodoItem {
  id: number;
  text: string;
  state: string;
}

// An extension module as this test drives it: registered against the harness's fakePi() api.
type RegisteredOnFakePi<M> = Omit<M, "default"> & { default: (pi: ReturnType<typeof fakePi>["api"]) => void };

const tf = await loadModule<typeof TodoFile>("vendor/todo/todo-file.ts");
const todo = await loadModule<RegisteredOnFakePi<typeof Todo>>("vendor/todo/index.ts");
const footer = await loadModule<typeof CustomFooter>("vendor/custom-footer/index.ts");
const vg = await loadModule<typeof VerifyGate>("extensions/verify-gate/index.ts");
const vb = await loadModule<RegisteredOnFakePi<typeof VerifierBoard>>("extensions/verifier-board/index.ts");

const tests = {
  pathResolution() {
    const ws = tmpWorkspace("pi-kit-todo-path-");
    try {
      // No session id -> legacy TODO.md.
      assert.equal(tf.todoFilePath(ws), path.join(ws, "TODO.md"));
      // Session id -> per-session file under .pi/todos.
      assert.equal(tf.todoFilePath(ws, "01a0a27c-abc"), path.join(ws, ".pi", "todos", "01a0a27c-abc.md"));
      // PI_KIT_TODO_FILE wins over everything.
      const restore = setEnv("PI_KIT_TODO_FILE", path.join(ws, "shared.md"));
      assert.equal(tf.todoFilePath(ws, "01a0a27c-abc"), path.join(ws, "shared.md"));
      assert.equal(tf.todoFilePath(ws), path.join(ws, "shared.md"));
      restore();
      // PI_KIT_TODO_DIR overrides the storage root.
      const restoreDir = setEnv("PI_KIT_TODO_DIR", path.join(ws, "alt-todos"));
      assert.equal(tf.todoFilePath(ws, "s1"), path.join(ws, "alt-todos", "s1.md"));
      restoreDir();
    } finally {
      rmWorkspace(ws);
    }
  },

  resolveSessionId() {
    assert.equal(tf.resolveSessionId({ getSessionId: () => "abc-123" }), "abc-123");
    assert.equal(tf.resolveSessionId({ getSessionId: () => "has/slash" }), undefined);
    assert.equal(tf.resolveSessionId({ getSessionId: () => ".." }), undefined);
    assert.equal(tf.resolveSessionId({ getSessionId: () => "" }), undefined);
    assert.equal(tf.resolveSessionId({}), undefined);
    assert.equal(tf.resolveSessionId(undefined), undefined);
    assert.equal(tf.resolveSessionId(null), undefined);
    // A manager that throws must not blow up resolution.
    assert.equal(tf.resolveSessionId({ getSessionId: () => { throw new Error("boom"); } }), undefined);
  },

  traversalSafety() {
    const ws = tmpWorkspace("pi-kit-todo-trav-");
    try {
      const root = tf.todoStorageRoot(ws);
      // A session id is validated to a filename-safe charset, so it cannot escape the root.
      for (const bad of ["../../etc", "../..", "a/b", "x..y..", "."]) {
        assert.equal(tf.isSessionId(bad), false, `${bad} should be rejected`);
        const file = tf.todoFilePath(ws, bad); // falls back to legacy TODO.md (no crash)
        assert.ok(file.startsWith(ws), `path must stay under workspace: ${file}`);
      }
      // Valid ids resolve under the root.
      const good = tf.todoFilePath(ws, "019ed91d-00a7");
      assert.ok(good.startsWith(root), "valid id resolves under the storage root");
    } finally {
      rmWorkspace(ws);
    }
  },

  twoSessionIsolation() {
    const ws = tmpWorkspace("pi-kit-todo-iso-");
    const A = "01a0a27c-sessionA";
    const B = "01b1b18d-sessionB";
    try {
      // Session A builds a plan; session B is empty and independent.
      tf.writeTodos(tf.todoFilePath(ws, A), [
        { id: 1, text: "A step one", state: "done" },
        { id: 2, text: "A step two", state: "active" },
        { id: 3, text: "A step three", state: "open" },
      ]);
      assert.deepEqual(tf.readTodos(tf.todoFilePath(ws, B)).todos, [], "B starts empty (no inheritance)");

      // B adds its own; A is untouched.
      tf.writeTodos(tf.todoFilePath(ws, B), [
        { id: 1, text: "B only step", state: "open" },
      ]);
      assert.equal(tf.readTodos(tf.todoFilePath(ws, A)).todos.length, 3, "A unchanged by B");
      assert.equal(tf.readTodos(tf.todoFilePath(ws, B)).todos.length, 1, "B has its own");
      // IDs are independent per file (both start at 1).
      assert.equal(tf.readTodos(tf.todoFilePath(ws, B)).todos[0]?.id, 1);

      // Legacy TODO.md is not created and not shared.
      assert.ok(!fs.existsSync(path.join(ws, "TODO.md")), "no legacy TODO.md is written");

      // Persistence: "resuming" A (same id) finds its list again.
      const resumed = tf.readTodos(tf.todoFilePath(ws, A));
      assert.equal(resumed.todos.length, 3);
      assert.equal(resumed.todos[1]?.state, "active");
    } finally {
      rmWorkspace(ws);
    }
  },

  async todoToolWritesToSessionFile() {
    const ws = tmpWorkspace("pi-kit-todo-tool-");
    try {
      const pi = fakePi();
      todo.default(pi.api);
      const tool = pi.tools.get("todo");
      const ctxA: SessionCtx = { cwd: ws, sessionManager: { getSessionId: () => "01a0a27c-A" } };
      const ctxB: SessionCtx = { cwd: ws, sessionManager: { getSessionId: () => "01b1b18d-B" } };
      const call = (ctx: SessionCtx, params: Record<string, unknown>): Promise<string> => (async () => {
        const r = await tool.execute("id", params, undefined, undefined, ctx);
        return textOf(r);
      })();

      await call(ctxA, { action: "add", items: ["A plan", "more A"] });
      await call(ctxB, { action: "add", text: "B plan" });

      // Each tool wrote to its own session file.
      const aFile = path.join(ws, ".pi", "todos", "01a0a27c-A.md");
      const bFile = path.join(ws, ".pi", "todos", "01b1b18d-B.md");
      assert.match(fs.readFileSync(aFile, "utf8"), /A plan/);
      assert.doesNotMatch(fs.readFileSync(aFile, "utf8"), /B plan/);
      assert.match(fs.readFileSync(bFile, "utf8"), /B plan/);
      assert.doesNotMatch(fs.readFileSync(bFile, "utf8"), /A plan/);
      // A's list only sees A's items.
      const listA = await call(ctxA, { action: "list" });
      assert.match(listA, /Todos: 0\/2 done/);
      assert.doesNotMatch(listA, /B plan/);
    } finally {
      rmWorkspace(ws);
    }
  },

  async readersResolveSessionFile() {
    const ws = tmpWorkspace("pi-kit-todo-readers-");
    const A = "01a0a27c-A";
    try {
      tf.writeTodos(tf.todoFilePath(ws, A), [
        { id: 1, text: "read me done", state: "done" },
        { id: 2, text: "read me active", state: "active" },
      ]);

      // Footer reader: session A sees its list; no id -> legacy (empty).
      const fa: TodoItem[] = footer.readTodoItems(ws, A);
      assert.deepEqual(fa.map((t) => t.state), ["done", "active"]);
      assert.deepEqual(footer.readTodoItems(ws), [], "no session id -> legacy TODO.md (empty here)");

      // verify-gate reader: collectDoneContext honors the session id.
      const done: { todos: Array<{ done: boolean }> } = await vg.collectDoneContext(ws, [], undefined, A);
      assert.equal(done.todos.length, 2);
      assert.deepEqual(done.todos.map((t) => t.done), [true, false]);

      // verifier-board reader: statusText shows the session's open todos once a
      // verdict exists (the "what done means here" section only renders with verdicts).
      const pi = fakePi();
      vb.default(pi.api);
      const record = pi.tools.get("record_verdict");
      await record.execute("id", { source: "reviewer", pass: false, summary: "still open" }, undefined, undefined, { cwd: ws });
      const status = vb.statusText(ws, A);
      assert.match(status.text, /Todos: 1\/2 done/);
      assert.match(status.text, /#2 read me active \(in progress\)/);
      assert.doesNotMatch(vb.statusText(ws).text, /read me/); // no id -> no session todos
    } finally {
      rmWorkspace(ws);
    }
  },

  async legacyOverrideStillShared() {
    const ws = tmpWorkspace("pi-kit-todo-legacy-");
    const restore = setEnv("PI_KIT_TODO_FILE", path.join(ws, "TODO.md"));
    try {
      const pi = fakePi();
      todo.default(pi.api);
      const tool = pi.tools.get("todo");
      // With the env override, both "sessions" write to the same TODO.md.
      await tool.execute("id", { action: "add", text: "shared item" }, undefined, undefined, { cwd: ws, sessionManager: { getSessionId: () => "01a0a27c-A" } });
      const list = await tool.execute("id", { action: "list" }, undefined, undefined, { cwd: ws, sessionManager: { getSessionId: () => "01b1b18d-B" } });
      assert.match(textOf(list), /shared item/);
      assert.ok(fs.existsSync(path.join(ws, "TODO.md")));
    } finally {
      restore();
      rmWorkspace(ws);
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n${err instanceof Error ? err.stack : String(err)}`);
  }
}
const total = Object.keys(tests).length;
if (failed) {
  console.error(`todo-session-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
console.log(`todo-session-smoke: ${total}/${total} passed`);
