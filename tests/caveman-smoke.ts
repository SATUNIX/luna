#!/usr/bin/env node
/**
 * Offline checks for caveman's config root and parsing of `detailTriggers`.
 *
 * A malformed `~/.pi/agent/caveman.json` such as `{"detailTriggers":[null]}` used to be
 * accepted verbatim because loadConfig() only checked the array was non-empty. The shipped
 * `pi.on("input", ...)` handler then called `raw.toLowerCase()` on the null element and threw
 * on the next interactive prompt. These checks pin that:
 *   1. Non-string trigger elements are dropped; the malformed config still loads and an
 *      interactive input event does not throw.
 *   2. Valid triggers are unchanged: `/docs-*` still flips the session into detail mode.
 *   3. PI_CODING_AGENT_DIR selects preferences without reading another agent directory;
 *      the ordinary HOME-based path remains the fallback.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.ts";

const restoreEnv = isolateKitEnv();

interface StatusEntry {
  key: string;
  value: string | undefined;
}
interface NoticeEntry {
  msg: string;
  level: string | undefined;
}
interface FakeCtx {
  cwd: string;
  ui: {
    setStatus: (key: string, value: string | undefined) => number;
    notify: (msg: string, level?: string) => number;
  };
  sessionManager: { getEntries: () => unknown[] };
  statuses: StatusEntry[];
  notices: NoticeEntry[];
}

function fakeCtx(cwd: string): FakeCtx {
  const statuses: StatusEntry[] = [];
  const notices: NoticeEntry[] = [];
  return {
    cwd,
    ui: {
      setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
      notify: (msg: string, level?: string) => notices.push({ msg, level }),
    },
    sessionManager: { getEntries: () => [] },
    statuses,
    notices,
  };
}

async function withAgentHome(fn: (agentDir: string) => Promise<void>): Promise<void> {
  const home = tmpWorkspace("pi-kit-caveman-home-");
  const restoreHome = setEnv("HOME", home);
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", undefined);
  const restoreLevel = setEnv("PI_KIT_CAVEMAN_LEVEL", undefined);
  try {
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    await fn(agentDir);
  } finally {
    restoreLevel();
    restoreAgentDir();
    restoreHome();
    rmWorkspace(home);
  }
}

function writeConfig(agentDir: string, config: { detailTriggers: unknown[] }): void {
  fs.writeFileSync(path.join(agentDir, "caveman.json"), JSON.stringify(config), "utf8");
}

async function testMalformedTriggersDoNotThrow(): Promise<void> {
  await withAgentHome(async (agentDir: string) => {
    writeConfig(agentDir, { detailTriggers: [null, "/docs-*"] });
    const pi = fakePi();
    (await loadExtension("vendor/caveman/index.ts"))(pi.api);

    const ws = tmpWorkspace("pi-kit-caveman-ws-");
    try {
      const ctx = fakeCtx(ws);
      await pi.handlers.get("session_start")(undefined, ctx);
      // Pre-fix this threw: matchesTrigger() ran null.toLowerCase() while iterating triggers.
      await pi.handlers.get("input")({ source: "interactive", text: "hello world" }, ctx);
      assert.equal(
        ctx.statuses.some((s) => s.value === "off (detail)"),
        false,
        "a non-matching prompt must not flip detail mode",
      );
    } finally {
      rmWorkspace(ws);
    }
  });
}

async function testValidTriggerFlipsDetailMode(): Promise<void> {
  await withAgentHome(async (agentDir: string) => {
    writeConfig(agentDir, { detailTriggers: ["/docs-*"] });
    const pi = fakePi();
    // caveman persists state via appendEntry; fakePi does not model it, and the flip is
    // best-effort, so a no-op stand-in keeps the handler on the happy path.
    Object.assign(pi.api, { appendEntry: () => {} });
    (await loadExtension("vendor/caveman/index.ts"))(pi.api);

    const ws = tmpWorkspace("pi-kit-caveman-ws-");
    try {
      const ctx = fakeCtx(ws);
      await pi.handlers.get("session_start")(undefined, ctx);
      await pi.handlers.get("input")({ source: "interactive", text: "/docs-abc" }, ctx);
      assert.equal(
        ctx.statuses.some((s) => s.value === "off (detail)"),
        true,
        "/docs-abc must flip the session into detail mode",
      );
      assert.equal(
        ctx.notices.some((n) => /detailed writing detected/.test(n.msg)),
        true,
        "flipping detail mode must notify the user",
      );
    } finally {
      rmWorkspace(ws);
    }
  });
}

async function testConfiguredAgentDirectoriesStayIsolated(): Promise<void> {
  await withAgentHome(async (fallbackDir: string) => {
    const firstDir = path.join(fallbackDir, "..", "first-agent");
    const secondDir = path.join(fallbackDir, "..", "second-agent");
    const roots = [
      { dir: firstDir, level: "lite", trigger: "/first-doc" },
      { dir: secondDir, level: "micro", trigger: "/second-doc" },
      { dir: fallbackDir, level: "ultra", trigger: "/fallback-doc" },
    ];
    for (const root of roots) {
      fs.mkdirSync(root.dir, { recursive: true });
      fs.writeFileSync(path.join(root.dir, "caveman.json"), JSON.stringify({
        defaultLevel: root.level, detailTriggers: [root.trigger],
      }));
    }
    const ws = tmpWorkspace("pi-kit-caveman-roots-");
    try {
      for (const root of roots) {
        const restoreDir = setEnv("PI_CODING_AGENT_DIR", root.dir === fallbackDir ? undefined : root.dir);
        try {
          const pi = fakePi();
          Object.assign(pi.api, { appendEntry: () => {} });
          (await loadExtension("vendor/caveman/index.ts"))(pi.api);
          const ctx = fakeCtx(ws);
          await pi.handlers.get("session_start")(undefined, ctx);
          assert.equal(ctx.statuses.at(-1)?.value, root.level, `load the preference from ${root.dir}`);
          for (const other of roots.filter((candidate) => candidate !== root)) {
            await pi.handlers.get("input")({ source: "interactive", text: other.trigger }, ctx);
          }
          assert.equal(ctx.statuses.at(-1)?.value, root.level, "other agent directories cannot supply detail triggers");
          await pi.handlers.get("input")({ source: "interactive", text: root.trigger }, ctx);
          assert.equal(ctx.statuses.at(-1)?.value, "off (detail)", "the selected root supplies detail triggers");
        } finally {
          restoreDir();
        }
      }
    } finally {
      rmWorkspace(ws);
    }
  });
}

const tests: Array<[string, () => Promise<void>]> = [
  ["malformed detailTriggers (null element) does not crash the input handler", testMalformedTriggersDoNotThrow],
  ["valid /docs-* trigger still flips detail mode", testValidTriggerFlipsDetailMode],
  ["configured agent directories and HOME fallback keep preferences isolated", testConfiguredAgentDirectoriesStayIsolated],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

restoreEnv();
if (failed > 0) {
  console.error(`\n[caveman-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[caveman-smoke] all ${tests.length} checks passed`);
