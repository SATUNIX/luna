#!/usr/bin/env node
/**
 * Workspace writes never follow a symlink a repository committed.
 *
 * A cloned repository may hold `.pi -> <elsewhere>`, `.pi/trace.jsonl -> <a file elsewhere>`,
 * `AGENTS.md -> <a file elsewhere>` and so on. This test plants such links, pointing into an
 * "outside" directory of sentinel files, drives the kit's workspace writers through their real
 * entry points (events, commands, tools and exported functions), and asserts that nothing outside
 * the workspace changed: no sentinel was modified and no file was created there. A writer may
 * refuse (the helper throws, the extension reports or ignores it); it must never redirect.
 *
 * Part 1 checks the helper itself (packages/core/shared/safe-fs.ts) and that every generated copy
 * is byte-identical to it; part 2 drives the extensions. Fully offline, hermetic (isolateKitEnv).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fakePi, isolateKitEnv, loadExtension, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { appendFileSafe, createFileExclusive, ensureDirSafe, openFileExclusive, piWorkspaceOf, rotateFileSafe, UnsafePathError, writeFileSafe } from "../packages/core/shared/safe-fs.ts";
import { checkSharedCopies } from "../packages/core/gen-shared.ts";
import type * as SelfImprovement from "../packages/extensions/src/self-improvement/index.ts";
import type * as Save from "../packages/extensions/src/save/index.ts";
import type * as TodoFile from "../packages/extensions/third_party/todo/todo-file.ts";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const SENTINEL = "SENTINEL: must never change\n";

/** Every file under `dir` (relative path -> sha256), symlinks recorded as their target. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      const rel = path.relative(dir, p);
      if (st.isSymbolicLink()) out.set(rel, `link:${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) {
        out.set(rel, "dir");
        walk(p);
      } else out.set(rel, crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

function assertUnchanged(outside: string, before: Map<string, string>, what: string): void {
  assert.deepEqual([...snapshot(outside)].sort(), [...before].sort(), `${what}: something outside the workspace changed`);
}

/** An outside directory with one sentinel file per name. */
function makeOutside(base: string, names: readonly string[]): string {
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(outside, "dotpi"), { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(outside, n), SENTINEL);
  fs.writeFileSync(path.join(outside, "dotpi", "trace.jsonl"), SENTINEL);
  return outside;
}

const throwsUnsafe = (fn: () => unknown, what: string): void => {
  assert.throws(fn, (error: unknown) => error instanceof UnsafePathError, what);
};

const restoreEnv = isolateKitEnv();
const base = tmpWorkspace("pi-kit-symlink-");
const restores = [
  restoreEnv,
  setEnv("HOME", path.join(base, "home")),
  setEnv("PI_CODING_AGENT_DIR", path.join(base, "agent")),
  setEnv("PI_KIT_FIREWALL_AUDIT_LOG", undefined),
  setEnv("PI_KIT_AUTO_MODE_STATE_DIR", undefined),
  setEnv("PI_KIT_AUTO_MODE", undefined),
  setEnv("PI_KIT_TODO_FILE", undefined),
  setEnv("PI_KIT_TODO_DIR", undefined),
  setEnv("PI_KIT_SAVE_DIR", undefined),
  setEnv("PI_KIT_SAVE_VAULT", undefined),
  setEnv("PI_KIT_VAULT", path.join(base, "no-vault")),
];
const startCwd = process.cwd();

try {
  // --- Part 1: the helper --------------------------------------------------------------------
  await check("every generated copy of safe-fs.ts is byte-identical to packages/core/shared/safe-fs.ts", () => {
    assert.deepEqual(checkSharedCopies().filter((p) => p.includes("safe-fs")), []);
  });

  await check("helper: a symlinked final component is refused for append, replace, exclusive create and rotate", () => {
    const ws = path.join(base, "h1");
    const outside = makeOutside(path.join(base, "h1-out"), ["target"]);
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    const link = path.join(ws, ".pi", "state.json");
    fs.symlinkSync(path.join(outside, "target"), link);
    const before = snapshot(outside);
    throwsUnsafe(() => appendFileSafe(link, "x\n", { root: ws }), "append");
    throwsUnsafe(() => writeFileSafe(link, "x", { root: ws }), "replace");
    assert.equal(createFileExclusive(link, "x", { root: ws }), false, "an exclusive create sees the name as taken");
    assert.equal(openFileExclusive(link, { root: ws }), null);
    fs.writeFileSync(path.join(outside, "big"), "y".repeat(64));
    const bigLink = path.join(ws, ".pi", "big.jsonl");
    fs.symlinkSync(path.join(outside, "big"), bigLink);
    const withBig = snapshot(outside);
    throwsUnsafe(() => rotateFileSafe(bigLink, 8, { root: ws }), "rotate");
    assertUnchanged(outside, withBig, "helper final component");
    assert.ok(before.size > 0);
  });

  await check("helper: a symlinked directory anywhere between the root and the file is refused, and nothing is created through it", () => {
    const ws = path.join(base, "h2");
    const outside = makeOutside(path.join(base, "h2-out"), []);
    fs.mkdirSync(ws, { recursive: true });
    fs.symlinkSync(path.join(outside, "dotpi"), path.join(ws, ".pi"));
    const before = snapshot(outside);
    throwsUnsafe(() => appendFileSafe(path.join(ws, ".pi", "trace.jsonl"), "x\n", { root: ws }), "append through .pi");
    throwsUnsafe(() => writeFileSafe(path.join(ws, ".pi", "deep", "new.json"), "x", { root: ws }), "replace through .pi");
    throwsUnsafe(() => ensureDirSafe(path.join(ws, ".pi", "deep"), { root: ws }), "mkdir through .pi");
    const ws2 = path.join(base, "h2b");
    fs.mkdirSync(path.join(ws2, ".pi"), { recursive: true });
    fs.symlinkSync(path.join(outside, "dotpi"), path.join(ws2, ".pi", "recovery"));
    throwsUnsafe(() => writeFileSafe(path.join(ws2, ".pi", "recovery", "escalation.json"), "x", { root: ws2 }), "a nested directory link");
    assertUnchanged(outside, before, "helper directory component");
  });

  await check("helper: outside the root, a second hard link and another directory type are refused", () => {
    const ws = path.join(base, "h3");
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    throwsUnsafe(() => writeFileSafe(path.join(ws, "..", "escape.json"), "x", { root: ws }), "a path outside the root");
    const outside = makeOutside(path.join(base, "h3-out"), ["hard"]);
    fs.linkSync(path.join(outside, "hard"), path.join(ws, ".pi", "hard.jsonl"));
    const before = snapshot(outside);
    throwsUnsafe(() => appendFileSafe(path.join(ws, ".pi", "hard.jsonl"), "x\n", { root: ws }), "append to a file with two links");
    throwsUnsafe(() => writeFileSafe(path.join(ws, ".pi", "hard.jsonl"), "x", { root: ws }), "replace a file with two links");
    fs.mkdirSync(path.join(ws, ".pi", "adir"));
    throwsUnsafe(() => writeFileSafe(path.join(ws, ".pi", "adir"), "x", { root: ws }), "a directory at the file's name");
    assertUnchanged(outside, before, "helper hard link");
  });

  await check("helper: ordinary writes work; new files are 0600, new directories 0700, a replacement keeps the file's mode", () => {
    const ws = path.join(base, "h4");
    fs.mkdirSync(ws, { recursive: true });
    const file = path.join(ws, ".pi", "sub", "a.json");
    writeFileSafe(file, "one", { root: ws });
    assert.equal(fs.readFileSync(file, "utf8"), "one");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(ws, ".pi", "sub")).mode & 0o777, 0o700);
      fs.chmodSync(file, 0o640);
    }
    writeFileSafe(file, "two", { root: ws });
    assert.equal(fs.readFileSync(file, "utf8"), "two");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o640, "a replacement keeps the mode");
    appendFileSafe(path.join(ws, ".pi", "log.jsonl"), "a\n", { root: ws });
    appendFileSafe(path.join(ws, ".pi", "log.jsonl"), "b\n", { root: ws });
    assert.equal(fs.readFileSync(path.join(ws, ".pi", "log.jsonl"), "utf8"), "a\nb\n");
    assert.equal(createFileExclusive(path.join(ws, ".pi", "once.md"), "x", { root: ws }), true);
    assert.equal(createFileExclusive(path.join(ws, ".pi", "once.md"), "y", { root: ws }), false);
    assert.deepEqual(fs.readdirSync(path.join(ws, ".pi", "sub")), ["a.json"], "no temporary file is left behind");
    assert.equal(piWorkspaceOf(path.join(ws, ".pi", "workflows", "runs", "x", "state.json")), ws);
    assert.equal(piWorkspaceOf(path.join(ws, "elsewhere", "x")), undefined);
  });

  // --- Part 2: the extensions ----------------------------------------------------------------
  // The state files the kit writes under <workspace>/.pi (and at the workspace root) that the
  // drivers below reach. Each is planted as a link to its own outside sentinel.
  const STATE_FILES = [
    "AGENTS.md",
    "TODO.md",
    ".pi/trace.jsonl",
    ".pi/tool-firewall-audit.jsonl",
    ".pi/auto-mode.json",
    ".pi/GOAL.yaml",
    ".pi/task-graph.json",
    ".pi/verdicts.json",
    ".pi/recovery/escalation.json",
    ".pi/snapshots/Latest Compact.md",
    ".pi/ctx-contributions/goal-core.json",
    ".pi/ctx-contributions/caveman.json",
    ".pi/ctx-contributions/plan-mode.json",
    ".pi/ctx-contributions/recovery-orchestrator.json",
  ] as const;
  const sentinelName = (rel: string): string => rel.replace(/[/. ]/g, "_");

  type Driver = { name: string; run: (ws: string) => Promise<void> };
  const quietCtx = (ws: string) => ({ cwd: ws, hasUI: true, ui: { notify() {}, setStatus() {}, select: async () => undefined, confirm: async () => false }, sessionManager: { getSessionId: () => undefined, getEntries: () => [] } });
  const drivers: Driver[] = [
    {
      name: "trace-ledger (tool_call and tool_result events)",
      run: async (ws) => {
        const pi = fakePi();
        (await loadExtension("extensions/trace-ledger/index.ts"))(pi.api);
        const ctx = quietCtx(ws);
        await pi.handlers.get("session_start")({}, ctx);
        await pi.handlers.get("tool_call")({ toolName: "read", input: { path: "a.ts" } }, ctx);
        await pi.handlers.get("tool_result")({ toolName: "read", input: { path: "a.ts" }, isError: false }, ctx);
      },
    },
    {
      name: "tool-firewall (audit log on a tool call, and /auto off)",
      run: async (ws) => {
        process.chdir(ws);
        try {
          const pi = fakePi();
          (await loadExtension("extensions/tool-firewall/index.ts"))(pi.api, { complete: async () => '{"verdict":"block","reason":"test"}' });
          const ctx = { ...quietCtx(ws), cwd: ws };
          await pi.handlers.get("session_start")({}, ctx);
          try { await pi.handlers.get("tool_call")({ toolName: "read", toolCallId: "t1", input: { path: "README.md" } }, ctx); } catch { /* a refusal is fine */ }
          await pi.commands.get("auto").handler("off", ctx);
        } finally {
          process.chdir(startCwd);
        }
      },
    },
    {
      name: "goal-core (/goal sets GOAL.yaml and its contribution)",
      run: async (ws) => {
        const pi = fakePi();
        (await loadExtension("extensions/goal-core/index.ts"))(pi.api);
        await pi.commands.get("goal").handler("ship the safe-write helper", quietCtx(ws));
      },
    },
    {
      name: "task-graph (task_create)",
      run: async (ws) => {
        const pi = fakePi();
        (await loadExtension("extensions/task-graph/index.ts"))(pi.api);
        await pi.tools.get("task_create").execute("t", { title: "a task" }, undefined, undefined, quietCtx(ws));
      },
    },
    {
      name: "verifier-board (record_verdict)",
      run: async (ws) => {
        const pi = fakePi();
        (await loadExtension("extensions/verifier-board/index.ts"))(pi.api);
        await pi.tools.get("record_verdict").execute("t", { source: "tests", pass: true, summary: "ok" }, undefined, undefined, quietCtx(ws));
      },
    },
    {
      name: "recovery-orchestrator (/recover writes an escalation, a report and a contribution)",
      run: async (ws) => {
        const pi = fakePi();
        (await loadExtension("extensions/recovery-orchestrator/index.ts"))(pi.api);
        await pi.commands.get("recover").handler("stuck", quietCtx(ws));
      },
    },
    {
      name: "caveman and plan-mode (context contributions)",
      run: async (ws) => {
        const cave = fakePi();
        // caveman records its state with pi.appendEntry, which the fake API leaves out.
        (await loadExtension("vendor/caveman/index.ts"))({ ...cave.api, appendEntry() {} });
        await cave.handlers.get("session_start")(undefined, quietCtx(ws));
        await cave.commands.get("caveman").handler("full", quietCtx(ws));
        const plan = fakePi();
        (await loadExtension("vendor/plan-mode/index.ts"))(plan.api);
        await plan.commands.get("plan").handler("", quietCtx(ws));
      },
    },
    {
      name: "self-improvement (/improve arm writes AGENTS.md)",
      run: async (ws) => {
        const mod = await loadModule<typeof SelfImprovement>("extensions/self-improvement/index.ts");
        try { mod.applyProposal(ws, { hasSignal: true, notes: ["- Prefer small diffs."], summary: "", diff: "" }); } finally { mod.writeProposal(ws, { hasSignal: false, notes: [], summary: "none", diff: "" }, "proposal-test"); }
      },
    },
    {
      name: "save (/save snapshot files under .pi/snapshots)",
      run: async (ws) => {
        const mod = await loadModule<typeof Save>("extensions/save/index.ts");
        mod.writeSnapshot(mod.resolveTarget(ws), "# snapshot\n", "save", new Date(0));
      },
    },
    {
      name: "todo (TODO.md at the workspace root)",
      run: async (ws) => {
        const mod = await loadModule<typeof TodoFile>("vendor/todo/todo-file.ts");
        mod.writeTodos(path.join(ws, "TODO.md"), [{ id: 1, text: "echo hello", state: "open" }], ws);
      },
    },
  ];

  /** Runs every driver; returns the drivers that threw (a refusal may surface as an exception). */
  const runAll = async (ws: string): Promise<string[]> => {
    const threw: string[] = [];
    for (const d of drivers) {
      try {
        await d.run(ws);
      } catch (error) {
        threw.push(`${d.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return threw;
  };

  await check("extensions: with every state file a link to a file outside, no sentinel changes", async () => {
    const ws = path.join(base, "ext-files");
    const outside = makeOutside(path.join(base, "ext-files-out"), STATE_FILES.map(sentinelName));
    for (const rel of STATE_FILES) {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.symlinkSync(path.join(outside, sentinelName(rel)), path.join(ws, rel));
    }
    const before = snapshot(outside);
    await runAll(ws);
    assertUnchanged(outside, before, "state-file links");
    for (const rel of STATE_FILES) assert.ok(fs.lstatSync(path.join(ws, rel)).isSymbolicLink(), `${rel} was not replaced or followed`);
  });

  await check("extensions: with .pi itself a link to a directory outside, nothing is written there", async () => {
    const ws = path.join(base, "ext-dir");
    const outside = makeOutside(path.join(base, "ext-dir-out"), []);
    fs.mkdirSync(ws, { recursive: true });
    fs.symlinkSync(path.join(outside, "dotpi"), path.join(ws, ".pi"));
    const before = snapshot(outside);
    await runAll(ws);
    assertUnchanged(outside, before, ".pi directory link");
  });

  await check("extensions: in a plain workspace the same drivers do write their state (the drivers reach the writers)", async () => {
    const ws = path.join(base, "ext-plain");
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    // A project's own legacy auto-mode file is repository content: /auto reads it but never
    // rewrites it (docs/autonomy-gate.md).
    const legacy = '{ "enabled": false, "kept": "as committed" }\n';
    fs.writeFileSync(path.join(ws, ".pi", "auto-mode.json"), legacy);
    assert.deepEqual(await runAll(ws), [], "no driver fails in a plain workspace");
    assert.equal(fs.readFileSync(path.join(ws, ".pi", "auto-mode.json"), "utf8"), legacy, "/auto off leaves a project .pi/auto-mode.json as committed");
    for (const rel of [".pi/trace.jsonl", ".pi/tool-firewall-audit.jsonl", ".pi/GOAL.yaml", ".pi/task-graph.json", ".pi/verdicts.json", "AGENTS.md", "TODO.md", ".pi/snapshots/Latest Compact.md", ".pi/ctx-contributions/goal-core.json", ".pi/ctx-contributions/caveman.json", ".pi/ctx-contributions/plan-mode.json", ".pi/ctx-contributions/recovery-orchestrator.json"]) {
      assert.ok(fs.statSync(path.join(ws, rel)).isFile(), `${rel} is written in a plain workspace`);
    }
  });

  console.log(`workspace-symlink smoke: ${passed} checks passed`);
} finally {
  process.chdir(startCwd);
  for (const r of restores.reverse()) r();
  rmWorkspace(base);
}
