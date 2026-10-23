#!/usr/bin/env node
// spec-plan smoke: the guard must count the live `edit` payload (edits[].newText) and the
// PI_KIT_SPEC_PLAN_STRICT off switch must actually disable it. Deterministic and offline.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, loadExtension, fakePi, setEnv, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.ts";

const MIN_LINES = 30;

type FakePi = ReturnType<typeof fakePi>;

/** A notification the guard raised through ctx.ui.notify. */
interface Note {
  message: string;
  level?: string;
}

/** The tool_call handler's decision (undefined when it lets the call through). */
interface ToolCallDecision {
  block?: boolean;
  reason?: string;
}

/** The slice of the extension context the guard reads. */
interface GuardCtx {
  cwd: string;
  hasUI: boolean;
  ui: { notify: (message: string, level?: string) => number };
}

function bigText(lines: number = MIN_LINES): string {
  return Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n");
}

// The extension reads PI_KIT_SPEC_PLAN_STRICT at module load, so re-import after setting it.
async function loadGuard(): Promise<FakePi> {
  const factory = await loadExtension("extensions/spec-plan/index.ts");
  const pi = fakePi();
  factory(pi.api);
  return pi;
}

function ctxWith(cwd: string, notes: Note[]): GuardCtx {
  return {
    cwd,
    hasUI: true,
    ui: { notify: (message, level) => notes.push(level === undefined ? { message } : { message, level }) },
  };
}

async function call(pi: FakePi, toolName: string, input: Record<string, unknown>, ctx: GuardCtx): Promise<ToolCallDecision | undefined> {
  return pi.handlers.get("tool_call")({ toolName, input }, ctx);
}

async function run(): Promise<void> {
  const restoreIsolation = isolateKitEnv();
  const ws = tmpWorkspace("pi-kit-spec-plan-");
  try {
    // (a) A >=MIN_LINES write with no spec file notifies (default warn) and does not block.
    {
      const restore = setEnv("PI_KIT_SPEC_PLAN_STRICT", undefined);
      const pi = await loadGuard();
      const notes: Note[] = [];
      const result = await call(pi, "write", { path: "src/big.ts", content: bigText() }, ctxWith(ws, notes));
      assert.equal(result, undefined, "warn mode must not block a large write");
      assert.equal(notes.length, 1, "a large write without a spec file must notify");
      restore();
    }

    // (b) A >=MIN_LINES edit (edits[].newText) with no spec file notifies. This failed before
    // the fix because only content/new_string were read, so the edit looked like one line.
    {
      const restore = setEnv("PI_KIT_SPEC_PLAN_STRICT", undefined);
      const pi = await loadGuard();
      const notes: Note[] = [];
      const result = await call(
        pi,
        "edit",
        { path: "src/big.ts", edits: [{ oldText: "a", newText: bigText() }] },
        ctxWith(ws, notes),
      );
      assert.equal(result, undefined, "warn mode must not block a large edit");
      assert.equal(notes.length, 1, "a large edit without a spec file must notify (fails on pre-fix code)");
      restore();
    }

    // (c) STRICT=1 blocks an edit and returns a block decision.
    {
      const restore = setEnv("PI_KIT_SPEC_PLAN_STRICT", "1");
      const pi = await loadGuard();
      const notes: Note[] = [];
      const result = await call(
        pi,
        "edit",
        { path: "src/big.ts", edits: [{ oldText: "a", newText: bigText() }] },
        ctxWith(ws, notes),
      );
      assert.equal(result?.block, true, "STRICT=1 must block a large edit");
      assert.equal(notes.length, 1, "a blocked edit still notifies");
      restore();
    }

    // (d) STRICT=0 fully disables the check: no block, no notification.
    {
      const restore = setEnv("PI_KIT_SPEC_PLAN_STRICT", "0");
      const pi = await loadGuard();
      const notes: Note[] = [];
      const result = await call(
        pi,
        "edit",
        { path: "src/big.ts", edits: [{ oldText: "a", newText: bigText() }] },
        ctxWith(ws, notes),
      );
      assert.equal(result, undefined, "STRICT=0 must not block");
      assert.equal(notes.length, 0, "STRICT=0 must not notify");
      restore();
    }

    // (e) A small edit (below MIN_LINES) is ignored.
    {
      const restore = setEnv("PI_KIT_SPEC_PLAN_STRICT", undefined);
      const pi = await loadGuard();
      const notes: Note[] = [];
      const result = await call(
        pi,
        "edit",
        { path: "src/big.ts", edits: [{ oldText: "a", newText: "const x = 1;" }] },
        ctxWith(ws, notes),
      );
      assert.equal(result, undefined, "a small edit must not block");
      assert.equal(notes.length, 0, "a small edit must not notify");
      restore();
    }

    // (f) With a SPEC.md present, a large edit is ignored.
    {
      const restore = setEnv("PI_KIT_SPEC_PLAN_STRICT", undefined);
      fs.writeFileSync(path.join(ws, "SPEC.md"), "# Spec\n");
      const pi = await loadGuard();
      const notes: Note[] = [];
      const result = await call(
        pi,
        "edit",
        { path: "src/big.ts", edits: [{ oldText: "a", newText: bigText() }] },
        ctxWith(ws, notes),
      );
      assert.equal(result, undefined, "a spec file must satisfy the check");
      assert.equal(notes.length, 0, "a spec file must suppress the notification");
      restore();
    }

    // (g) F2: deletion-only edits (newText: "") must not count as written lines. With 30 such
    // entries the pre-fix code counted 30 phantom lines and notified; a pure deletion writes none.
    {
      fs.rmSync(path.join(ws, "SPEC.md"), { force: true }); // case (f) created it; these cases need no spec
      const restore = setEnv("PI_KIT_SPEC_PLAN_STRICT", undefined);
      const pi = await loadGuard();
      const notes: Note[] = [];
      const deletions = Array.from({ length: MIN_LINES }, () => ({ oldText: "a", newText: "" }));
      const result = await call(
        pi,
        "edit",
        { path: "src/big.ts", edits: deletions },
        ctxWith(ws, notes),
      );
      assert.equal(result, undefined, "a deletion-only edit must not block");
      assert.equal(notes.length, 0, "a deletion-only edit must not notify (fails on pre-fix code)");
      restore();
    }

    // (h) A normal large write still blocks under STRICT=1 (regression guard for the F2 fix).
    {
      const restore = setEnv("PI_KIT_SPEC_PLAN_STRICT", "1");
      const pi = await loadGuard();
      const notes: Note[] = [];
      const result = await call(
        pi,
        "write",
        { path: "src/big.ts", content: bigText() },
        ctxWith(ws, notes),
      );
      assert.equal(result?.block, true, "STRICT=1 must still block a large write");
      assert.equal(notes.length, 1, "a blocked write still notifies");
      restore();
    }

    // (j) PRO-11: tool input of the wrong shape (a non-string content or path, no input object) is
    // counted as no lines instead of throwing a TypeError that blocks the call with an opaque error.
    {
      const restore = setEnv("PI_KIT_SPEC_PLAN_STRICT", "1");
      const pi = await loadGuard();
      const notes: Note[] = [];
      assert.equal(await call(pi, "write", { path: "src/big.ts", content: 12345 }, ctxWith(ws, notes)), undefined, "a non-string content is no lines");
      assert.equal(await call(pi, "write", { path: 7, content: bigText() }, ctxWith(ws, notes)), undefined, "a non-string path is not a source file");
      assert.equal(await pi.handlers.get("tool_call")({ toolName: "write", input: null }, ctxWith(ws, notes)), undefined, "a missing input passes through");
      assert.equal(notes.length, 0, "nothing to warn about");
      restore();
    }

    // (i) F4: a non-numeric PI_KIT_SPEC_PLAN_MIN_LINES must fall back to 30, not become NaN.
    // Pre-fix, `count < NaN` is false so STRICT=1 blocked even a one-line write.
    {
      const restoreStrict = setEnv("PI_KIT_SPEC_PLAN_STRICT", "1");
      const restoreMin = setEnv("PI_KIT_SPEC_PLAN_MIN_LINES", "abc");
      const pi = await loadGuard();
      const notes: Note[] = [];
      const result = await call(
        pi,
        "write",
        { path: "src/small.ts", content: "const x = 1;" },
        ctxWith(ws, notes),
      );
      assert.equal(result, undefined, "a non-numeric minimum must fall back to 30 and not block a small write (fails on pre-fix code)");
      assert.equal(notes.length, 0, "a small write below the fallback minimum must not notify");
      restoreMin();
      restoreStrict();
    }

    // (j) F4: a single trailing newline must not inflate the count. Content with MIN_LINES-1
    // real lines and a trailing newline has a raw split length of MIN_LINES, but is below the
    // threshold, so it must not notify. Pre-fix it counted MIN_LINES and fired.
    {
      const restore = setEnv("PI_KIT_SPEC_PLAN_STRICT", undefined);
      const pi = await loadGuard();
      const notes: Note[] = [];
      const result = await call(
        pi,
        "write",
        { path: "src/big.ts", content: `${bigText(MIN_LINES - 1)}\n` },
        ctxWith(ws, notes),
      );
      assert.equal(result, undefined, "a trailing-newline write one line below the minimum must not block");
      assert.equal(notes.length, 0, "a trailing-newline write one line below the minimum must not notify (fails on pre-fix code)");
      restore();
    }

    // (k) F4: MIN_LINES+1 real lines is at/over the threshold and must notify.
    {
      const restore = setEnv("PI_KIT_SPEC_PLAN_STRICT", undefined);
      const pi = await loadGuard();
      const notes: Note[] = [];
      const result = await call(
        pi,
        "write",
        { path: "src/big.ts", content: bigText(MIN_LINES + 1) },
        ctxWith(ws, notes),
      );
      assert.equal(result, undefined, "warn mode must not block a write over the minimum");
      assert.equal(notes.length, 1, "a write over the minimum without a spec file must notify");
      restore();
    }

    // (l) F4: a non-positive minimum is clamped to 1. With MIN_LINES=0 a one-line write still
    // blocks (threshold is 1), but a zero-line (deletion-only) edit must not: pre-fix the raw
    // 0 threshold treated 0 lines as "at threshold" and blocked.
    {
      const restoreStrict = setEnv("PI_KIT_SPEC_PLAN_STRICT", "1");
      const restoreMin = setEnv("PI_KIT_SPEC_PLAN_MIN_LINES", "0");
      const piLine = await loadGuard();
      const lineNotes: Note[] = [];
      const lineResult = await call(
        piLine,
        "write",
        { path: "src/small.ts", content: "const x = 1;" },
        ctxWith(ws, lineNotes),
      );
      assert.equal(lineResult?.block, true, "a one-line write must block when the minimum is clamped to 1");

      const piEmpty = await loadGuard();
      const emptyNotes: Note[] = [];
      const emptyResult = await call(
        piEmpty,
        "edit",
        { path: "src/small.ts", edits: [{ oldText: "a", newText: "" }] },
        ctxWith(ws, emptyNotes),
      );
      assert.equal(emptyResult, undefined, "a zero-line edit must not block when the minimum is clamped to 1 (fails pre-fix)");
      assert.equal(emptyNotes.length, 0, "a zero-line edit must not notify when the minimum is clamped to 1");
      restoreMin();
      restoreStrict();
    }

    console.log("[test:smoke spec-plan] OK");
  } finally {
    rmWorkspace(ws);
    restoreIsolation();
  }
}

await run();
