#!/usr/bin/env node
/**
 * What /clear and /status do, and the shared say/usageError helper.
 *
 *   - /clear asks, then starts a new session; a refusal or a bad argument starts nothing;
 *   - /clear --handoff writes HANDOFF.md (PI_KIT_HANDOFF_FILE) before the new session starts;
 *   - /status prints one line per doctor check.
 *
 * Hermetic: temporary agent directory and workspace, fake pi and fake context.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, type FakePiApi, isolateKitEnv, loadModule, rmWorkspace, tmpWorkspace } from "../packages/core/eval/harness.ts";
import type * as ControlModule from "../packages/extensions/src/control-center/index.ts";
import type * as SessionHelpersModule from "../packages/extensions/src/session-helpers/index.ts";

const restoreEnv = isolateKitEnv();
const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-session-cmds-"));
process.env.PI_CODING_AGENT_DIR = agent;
const ws = tmpWorkspace("session-cmds");

interface Note {
  message: string;
  level: string | undefined;
}

/** A command context: records notifications and new-session requests, answers confirm. */
function context(answer: boolean) {
  const notes: Note[] = [];
  const order: string[] = [];
  const entries = [
    { type: "message", message: { role: "user", content: "fix the parser" } },
    { type: "message", message: { role: "toolResult", toolName: "bash" } },
  ];
  const ctx = {
    hasUI: true,
    cwd: ws,
    sessionManager: { getEntries: () => entries },
    ui: {
      notify: (message: string, level?: string) => notes.push({ message, level }),
      confirm: async () => answer,
    },
    newSession: async () => {
      order.push(fs.existsSync(path.join(ws, "HANDOFF.md")) ? "handoff-then-new" : "new");
      return { cancelled: false };
    },
  };
  return { ctx, notes, order };
}

const sessionHelpers = (await loadModule<{ default: (api: unknown) => void } & typeof SessionHelpersModule>("extensions/session-helpers/index.ts")).default;
const pi = fakePi();
sessionHelpers(pi.api);
const clear = pi.commands.get("clear").handler;

try {
  {
    const { ctx, order } = context(true);
    await clear("", ctx);
    assert.deepEqual(order, ["new"], "a confirmed /clear starts one new session");
    assert.equal(fs.existsSync(path.join(ws, "HANDOFF.md")), false, "no handoff unless asked");
  }
  {
    const { ctx, order, notes } = context(true);
    await clear("", { ...ctx, hasUI: false });
    assert.deepEqual(order, [], "without a UI there is nobody to confirm, so nothing starts");
    assert.match(notes[0]?.message ?? "", /interactive/);
  }
  {
    const { ctx, order } = context(false);
    await clear("", ctx);
    assert.deepEqual(order, [], "declining the confirm starts nothing");
  }
  {
    const { ctx, order, notes } = context(true);
    await clear("--bogus", ctx);
    assert.deepEqual(order, [], "an unknown argument starts nothing");
    assert.equal(notes[0]?.level, "error");
    assert.match(notes[0]?.message ?? "", /Usage: \/clear/);
  }
  {
    const { ctx, order } = context(true);
    (ctx.sessionManager.getEntries() as unknown[]).push({ type: "message", message: { role: "user", content: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" } });
    await clear("--handoff", ctx);
    assert.deepEqual(order, ["handoff-then-new"], "the note is written before the session is replaced");
    const note = fs.readFileSync(path.join(ws, "HANDOFF.md"), "utf8");
    assert.ok(note.includes("fix the parser") && note.includes("bash"), "the note carries the last ask and tool");
    assert.ok(!note.includes("abcdefghijklmnopqrstuvwxyz0123456789"), "a pasted secret is redacted from the note");
  }

  // /status: one line per doctor check.
  const control = (await loadModule<Omit<typeof ControlModule, "default"> & { default: (api: FakePiApi) => void }>("extensions/control-center/index.ts")).default;
  const hub = fakePi();
  control(hub.api);
  const { ctx, notes } = context(true);
  await hub.commands.get("status").handler("", ctx);
  const lines = (notes[0]?.message ?? "").split("\n");
  assert.ok(lines.length >= 3, "status reports several checks");

  console.log("[session-commands-smoke] all checks passed");
} finally {
  rmWorkspace(ws);
  fs.rmSync(agent, { recursive: true, force: true });
  restoreEnv();
}
