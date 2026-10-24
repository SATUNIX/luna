import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  resolveSessionId,
  todoFilePath,
  readTodos,
  writeTodos,
  renderTodos,
} from "./todo-file.ts";

// Todo lists are per-session. Each pi session gets its own file under
// <cwd>/.pi/todos/<session-id>.md (see ./todo-file.ts), so several sessions in
// the same workspace keep independent lists and never inherit one another's.
// The file resolves live from the session manager on every action, so /new,
// /resume, and /fork each follow the active session. PI_KIT_TODO_FILE still
// forces a single shared file (legacy), and headless runs without a session id
// fall back to <cwd>/TODO.md.
// States: "[ ]" open, "[~]" in progress, "[x]" done. Every action returns the
// whole list with progress, so the transcript shows the plan and state. The
// custom-footer renders the same file as a checklist above the editor.

function currentFile(ctx?: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
  const cwd = ctx?.cwd ?? process.cwd();
  return todoFilePath(cwd, resolveSessionId(ctx?.sessionManager));
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage the task todo list for this session (stored in a per-session file, so parallel sessions in the same workspace don't share lists). Actions: list; add (text, or items for several at once); start (id) marks one item in progress; done (id) marks it complete; toggle (id) flips done/open; remove (id); clear. Add the plan before you start work. Mark an item in progress when you start it and done when you finish it. Every action returns the whole list.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"), Type.Literal("add"), Type.Literal("start"), Type.Literal("done"),
        Type.Literal("toggle"), Type.Literal("remove"), Type.Literal("clear"),
      ]),
      text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
      items: Type.Optional(Type.Array(Type.String(), { description: "Several todo texts to add at once (for add)" })),
      id: Type.Optional(Type.Number({ description: "Todo ID (for start, done, toggle, remove)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const todoFile = currentFile(ctx);
      const { todos, nextId } = readTodos(todoFile);
      const find = () => {
        if (params.id === undefined) return { error: "Error: id required" };
        const todo = todos.find((t) => t.id === params.id);
        return todo ? { todo } : { error: `#${params.id} not found\n${renderTodos(todos)}` };
      };

      switch (params.action) {
        case "list":
          return text(renderTodos(todos));
        case "add": {
          const texts = [...(params.items ?? []), ...(params.text ? [params.text] : [])].map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
          if (!texts.length) return text("Error: text or items required");
          let id = nextId;
          for (const t of texts) todos.push({ id: id++, text: t, state: "open" });
          writeTodos(todoFile, todos);
          return text(renderTodos(todos, texts.length === 1 ? `Added #${nextId}: ${texts[0]}` : `Added #${nextId}-#${id - 1}`));
        }
        case "start": {
          const r = find();
          if (!r.todo) return text(r.error);
          // One item in progress at a time keeps the plan readable.
          for (const t of todos) if (t.state === "active") t.state = "open";
          r.todo.state = "active";
          writeTodos(todoFile, todos);
          return text(renderTodos(todos, `Started #${r.todo.id}: ${r.todo.text}`));
        }
        case "done": {
          const r = find();
          if (!r.todo) return text(r.error);
          r.todo.state = "done";
          writeTodos(todoFile, todos);
          return text(renderTodos(todos, `Done #${r.todo.id}: ${r.todo.text}`));
        }
        case "toggle": {
          const r = find();
          if (!r.todo) return text(r.error);
          r.todo.state = r.todo.state === "done" ? "open" : "done";
          writeTodos(todoFile, todos);
          return text(renderTodos(todos, `#${r.todo.id} ${r.todo.state === "done" ? "done" : "undone"}: ${r.todo.text}`));
        }
        case "remove": {
          const r = find();
          if (!r.todo) return text(r.error);
          writeTodos(todoFile, todos.filter((t) => t !== r.todo));
          return text(renderTodos(todos.filter((t) => t !== r.todo), `Removed #${r.todo.id}`));
        }
        case "clear": {
          writeTodos(todoFile, []);
          return text(`Cleared ${todos.length} todos`);
        }
        default:
          return text("Unknown action");
      }
    },
  });

  pi.registerCommand("todos", {
    description: "Show this session's todo list and its file path",
    handler: async (_args, ctx) => {
      const file = currentFile(ctx);
      if (ctx.hasUI) ctx.ui.notify(`${renderTodos(readTodos(file).todos)}\nFile: ${file}\nThe checklist above the editor can be hidden with /footer todos off (and shown again with /footer todos on).`, "info");
    },
  });
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}
