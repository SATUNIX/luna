#!/usr/bin/env node
/**
 * B-005 regression coverage: context-contribution files are shared per directory across
 * concurrent sessions; they must be scoped to a per-session subdirectory with a legacy
 * flat fallback. Fully offline — no live pi, no network.
 *
 * Layout under test:
 *   <cwd>/.pi/ctx-contributions/sessions/<safe-id>/<name>.json   (session id known)
 *   <cwd>/.pi/ctx-contributions/<name>.json                      (legacy fallback)
 */
import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  loadExtension,
  fakePi,
  tmpWorkspace,
  rmWorkspace,
  isolateKitEnv,
  setEnv,
} from "../packages/core/eval/harness.ts";
import { number, object, optional, parseJsonAs, string, unknownValue } from "../packages/core/lib/guard.ts";

type FakePi = ReturnType<typeof fakePi>;

/** context-sieve's before_agent_start result: always the system prompt, plus a text message when per-turn blocks changed. */
type SieveTurn = BeforeAgentStartEventResult & { systemPrompt: string; message?: { content: string } };
const sieveTurn = async (pi: FakePi, event: object, ctx?: object): Promise<SieveTurn> => (await pi.handlers.get("before_agent_start")(event, ctx)) as SieveTurn;

const restoreEnv = isolateKitEnv();

async function loadSieve(ws: string, sessionId?: string): Promise<FakePi> {
  const register = await loadExtension("extensions/context-sieve/index.ts");
  const pi = fakePi();
  register(pi.api);
  const ctx = sessionId === undefined ? { cwd: ws } : { cwd: ws, sessionManager: { getSessionId: () => sessionId } };
  await pi.handlers.get("session_start")({}, ctx);
  return pi;
}

async function loadProducer(rel: string, ws: string, sessionId?: string): Promise<FakePi> {
  const register = await loadExtension(rel);
  const pi = fakePi();
  register(pi.api);
  const ctx = sessionId === undefined ? { cwd: ws } : { cwd: ws, sessionManager: { getSessionId: () => sessionId } };
  await pi.handlers.find("session_start")?.({}, ctx);
  return pi;
}

// Load and register an extension without invoking its session_start handler, so a test can
// control the exact order in which producers and the reader start.
async function registerOnly(rel: string): Promise<FakePi> {
  const register = await loadExtension(rel);
  const pi = fakePi();
  register(pi.api);
  return pi;
}

/** A contribution file as producers write it; `includeInCompact` is read only to prove it is gone. */
const Contribution = object({
  id: optional(string()),
  priority: optional(number()),
  content: string(),
  includeInCompact: optional(unknownValue()),
});

function readContrib(file: string) {
  return parseJsonAs(Contribution, fs.readFileSync(file, "utf8"), file);
}

function contribDir(ws: string): string {
  return path.join(ws, ".pi", "ctx-contributions");
}

function writeContrib(dir: string, id: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, priority: 50, budgetTokens: 500, content }));
}

// 1. Reader isolation: two sessions sharing one cwd, each with its own contribution file,
// must not see each other's content. context-sieve reads only its session subdirectory.
async function testReaderIsolation() {
  const ws = tmpWorkspace("pi-kit-ctxcontrib-isolation-");
  try {
    const piA = await loadSieve(ws, "sess-a");
    const piB = await loadSieve(ws, "sess-b");
    // Producers write after session_start (as they do in production).
    writeContrib(path.join(contribDir(ws), "sessions", "sess-a"), "orch", "A_ONLY_MARKER");
    writeContrib(path.join(contribDir(ws), "sessions", "sess-b"), "orch", "B_ONLY_MARKER");

    const rA = await sieveTurn(piA, { systemPrompt: "base" });
    assert.ok(rA?.systemPrompt.includes("A_ONLY_MARKER"), "session A must admit its own contribution");
    assert.ok(!rA.systemPrompt.includes("B_ONLY_MARKER"), "session A must not admit session B's contribution");

    const rB = await sieveTurn(piB, { systemPrompt: "base" });
    assert.ok(rB?.systemPrompt.includes("B_ONLY_MARKER"), "session B must admit its own contribution");
    assert.ok(!rB.systemPrompt.includes("A_ONLY_MARKER"), "session B must not admit session A's contribution");
    // A session-id reader must ignore the legacy flat directory entirely: a sibling writing
    // there (or a stale leftover) must not be admitted into the session's prompt.
    writeContrib(contribDir(ws), "flat", "FLAT_LEAK_MARKER");
    const rFlat = await sieveTurn(piA, { systemPrompt: "base" });
    assert.ok(!rFlat?.systemPrompt.includes("FLAT_LEAK_MARKER"), "a session-id reader must not admit flat-directory contributions");
  } finally {
    rmWorkspace(ws);
  }
}

// 2. Producer/reader agreement: a real producer (goal-core) with a session id writes into
// the session subdirectory, and context-sieve with the same id admits it; another id does not.
async function testProducerReaderAgreement() {
  const ws = tmpWorkspace("pi-kit-ctxcontrib-agree-");
  try {
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".pi", "GOAL.yaml"), "goal: Ship the session-scoped fix\n");

    // context-sieve's session_start runs first (it loads earlier in extensions/), snapshotting
    // an empty directory; goal-core then materializes the goal into the same session dir.
    const sieveA = await loadSieve(ws, "prod-1");
    await loadProducer("extensions/goal-core/index.ts", ws, "prod-1");

    const goalContrib = path.join(contribDir(ws), "sessions", "prod-1", "goal-core.json");
    assert.ok(fs.existsSync(goalContrib), "goal-core must write into sessions/<id>/goal-core.json");

    const rSame = await sieveTurn(sieveA, { systemPrompt: "base" });
    assert.ok(rSame?.systemPrompt.includes("Ship the session-scoped fix"), "context-sieve with the same session id must admit the producer's content");

    const sieveOther = await loadSieve(ws, "prod-2");
    const rOther = await sieveTurn(sieveOther, { systemPrompt: "base" });
    assert.ok(!rOther?.systemPrompt.includes("Ship the session-scoped fix"), "a different session id must not admit the contribution");
  } finally {
    rmWorkspace(ws);
  }
}

// 2b. Load-order independence (B-045): register a session_start-writing producer BEFORE
// context-sieve, then run the producer's session_start before the reader's. The reader's
// module-load epoch predates the producer's write, so the fresh contribution must be
// included even though the reader's session_start sees the file already present. Pre-fix,
// context-sieve snapshotted the fresh file and dropped it for the whole session.
async function testProducerFirstSessionStart() {
  const ws = tmpWorkspace("pi-kit-ctxcontrib-order-");
  try {
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".pi", "GOAL.yaml"), "goal: Order-independent goal\n");
    const ctx = { cwd: ws, sessionManager: { getSessionId: () => "order-1" } };

    // Producer registered first; context-sieve's module-load epoch is captured before the
    // producer's session_start writes goal-core.json.
    const producer = await registerOnly("extensions/goal-core/index.ts");
    const sieve = await registerOnly("extensions/context-sieve/index.ts");

    await producer.handlers.get("session_start")({}, ctx);
    await sieve.handlers.get("session_start")({}, ctx);

    const result = await sieveTurn(sieve, { systemPrompt: "base" });
    assert.ok(result?.systemPrompt.includes("Order-independent goal"),
      "a contribution written by an earlier-registered producer during session_start must be included");
  } finally {
    rmWorkspace(ws);
  }
}

// 2c. B-019: a pasted multi-line goal must survive the /goal -> GOAL.yaml -> session_start
// -> contribution round trip. Previously the second line was silently truncated because the
// scalar was written verbatim and read back with a single-line regex.
async function testGoalMultilineRoundTrip() {
  const ws = tmpWorkspace("pi-kit-goal-multiline-");
  try {
    const ctx = { cwd: ws, sessionManager: { getSessionId: () => "goal-ml" }, ui: { notify() {} } };
    const producer = await loadProducer("extensions/goal-core/index.ts", ws, "goal-ml");
    await producer.commands.get("goal").handler("Ship v2\nsecond line", ctx);

    // `goal:` must keep the first line verbatim so the naive single-line readers in
    // verify-gate/verifier-board stay correct; `goal_full:` must carry the whole goal.
    const yaml = fs.readFileSync(path.join(ws, ".pi", "GOAL.yaml"), "utf8");
    const line = yaml.match(/^goal:\s*(.*)$/m)?.[1];
    assert.equal(line, "Ship v2", "the goal: scalar must keep the first line for naive readers");
    const fullLine = yaml.match(/^goal_full:\s*(.*)$/m)?.[1];
    assert.equal(typeof fullLine === "string" ? JSON.parse(fullLine) : undefined, "Ship v2\nsecond line",
      "goal_full: must persist the full multi-line goal as a JSON scalar");

    // A fresh instance must re-materialize the complete goal at session_start.
    await loadProducer("extensions/goal-core/index.ts", ws, "goal-ml");
    const contrib = readContrib(path.join(contribDir(ws), "sessions", "goal-ml", "goal-core.json"));
    assert.ok(contrib.content.includes("Ship v2"), "the contribution must include the first line");
    assert.ok(contrib.content.includes("second line"), "the contribution must include the second line");
  } finally {
    rmWorkspace(ws);
  }
}

// 2d. B-019 legacy compatibility: a file written by the old code (`goal: Ship it`, unquoted)
// must still read back and materialize unchanged.
async function testGoalLegacyUnquotedRead() {
  const ws = tmpWorkspace("pi-kit-goal-legacy-");
  try {
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".pi", "GOAL.yaml"), `goal: Ship it\ncreated: ${new Date().toISOString()}\n`);
    await loadProducer("extensions/goal-core/index.ts", ws, "goal-legacy");
    const contrib = readContrib(path.join(contribDir(ws), "sessions", "goal-legacy", "goal-core.json"));
    assert.ok(contrib.content.includes("Ship it"), "a legacy unquoted goal must still be materialized");
  } finally {
    rmWorkspace(ws);
  }
}

// 3. Legacy fallback: with no session id, producers and the reader keep using the flat
// directory (mirrors the existing context-budget harness style).
async function testLegacyFallback() {
  const ws = tmpWorkspace("pi-kit-ctxcontrib-legacy-");
  try {
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".pi", "GOAL.yaml"), "goal: Legacy flat goal\n");

    const sieve = await loadSieve(ws, undefined);
    await loadProducer("extensions/goal-core/index.ts", ws, undefined);

    const flat = path.join(contribDir(ws), "goal-core.json");
    assert.ok(fs.existsSync(flat), "with no session id the flat goal-core.json must still be written");
    assert.ok(!fs.existsSync(path.join(contribDir(ws), "sessions")), "no session subdirectory should be created without an id");

    const result = await sieveTurn(sieve, { systemPrompt: "base" });
    assert.ok(result?.systemPrompt.includes("Legacy flat goal"), "the flat fallback contribution must still be read");
  } finally {
    rmWorkspace(ws);
  }
}

// 4. Traversal safety: an id that fails the safe-id regex is ignored and falls back flat,
// and never escapes .pi/ctx-contributions.
async function testTraversalSafety() {
  const ws = tmpWorkspace("pi-kit-ctxcontrib-traversal-");
  try {
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".pi", "GOAL.yaml"), "goal: Traversal-safe goal\n");

    // Load the reader first so its session_start snapshot predates the producer's write.
    const sieve = await loadSieve(ws, "../../evil");
    await loadProducer("extensions/goal-core/index.ts", ws, "../../evil");

    const flat = path.join(contribDir(ws), "goal-core.json");
    assert.ok(fs.existsSync(flat), "a malicious session id must fall back to the flat directory");
    assert.ok(!fs.existsSync(path.join(ws, ".pi", "evil")), "a malicious session id must not escape ctx-contributions");
    for (const escaped of [path.join(ws, "evil"), path.join(ws, ".pi", "ctx-contributions", "evil")]) {
      assert.ok(!fs.existsSync(escaped), `a malicious session id must not create ${escaped}`);
    }

    // The reader must use the same fallback, so the flat contribution is still admitted.
    const result = await sieveTurn(sieve, { systemPrompt: "base" });
    assert.ok(result?.systemPrompt.includes("Traversal-safe goal"), "the reader must fall back to the flat directory for a malicious id");
  } finally {
    rmWorkspace(ws);
  }
}

// 5. Session-scoped producer coverage: guidelines writes its contribution under
// sessions/<id>/ (and must not land in the legacy flat directory).
async function testGuidelinesProducer() {
  const ws = tmpWorkspace("pi-kit-ctxcontrib-guidelines-");
  try {
    fs.writeFileSync(path.join(ws, "GUIDELINES.md"), "Always run the verification loop.\n");

    await loadProducer("extensions/guidelines/index.ts", ws, "guide-1");

    const scoped = path.join(contribDir(ws), "sessions", "guide-1", "guidelines.json");
    const flat = path.join(contribDir(ws), "guidelines.json");
    assert.ok(fs.existsSync(scoped), "guidelines must write into sessions/<id>/guidelines.json");
    assert.ok(!fs.existsSync(flat), "a session-id guidelines contribution must not land in the legacy flat directory");
    const body = readContrib(scoped);
    assert.equal(body.id, "guidelines", "the contribution id must stay guidelines");
    assert.ok(body.content.includes("Always run the verification loop."), "the guidelines file content must be materialized");
  } finally {
    rmWorkspace(ws);
  }
}

// 6. Session-scoped producer coverage: autonomous-loop's /loop command writes its
// contribution under sessions/<id>/ (and must not land in the legacy flat directory).
async function testAutonomousLoopProducer() {
  const ws = tmpWorkspace("pi-kit-ctxcontrib-loop-");
  try {
    const pi = await loadProducer("extensions/autonomous-loop/index.ts", ws, "loop-1");
    const ctx = { cwd: ws, sessionManager: { getSessionId: () => "loop-1" }, ui: { notify() {}, setStatus() {} } };
    await pi.commands.get("loop").handler("finish the migration", ctx);

    const scoped = path.join(contribDir(ws), "sessions", "loop-1", "autonomous-loop.json");
    const flat = path.join(contribDir(ws), "autonomous-loop.json");
    assert.ok(fs.existsSync(scoped), "autonomous-loop must write into sessions/<id>/autonomous-loop.json");
    assert.ok(!fs.existsSync(flat), "a session-id autonomous-loop contribution must not land in the legacy flat directory");
    const body = readContrib(scoped);
    assert.equal(body.id, "autonomous-loop", "the contribution id must stay autonomous-loop");
    assert.equal(body.priority, 100, "the contribution priority must be 100");
    assert.match(body.content, /finish the migration/, "the loop goal must be materialized in the contribution content");
  } finally {
    rmWorkspace(ws);
  }
}

// 7. Session-scoped producer coverage: recovery-orchestrator's /recover command writes its
// contribution under sessions/<id>/ (not flat), and scaffolds the recovery report.
async function testRecoveryOrchestratorProducer() {
  const ws = tmpWorkspace("pi-kit-ctxcontrib-recovery-");
  try {
    const pi = await loadProducer("extensions/recovery-orchestrator/index.ts", ws, "rec-1");
    const ctx = { cwd: ws, sessionManager: { getSessionId: () => "rec-1" }, ui: { notify() {}, setStatus() {} } };
    await pi.commands.get("recover").handler("same-task", ctx);

    const scoped = path.join(contribDir(ws), "sessions", "rec-1", "recovery-orchestrator.json");
    const flat = path.join(contribDir(ws), "recovery-orchestrator.json");
    assert.ok(fs.existsSync(scoped), "recovery-orchestrator must write into sessions/<id>/recovery-orchestrator.json");
    assert.ok(!fs.existsSync(flat), "a session-id recovery-orchestrator contribution must not land in the legacy flat directory");
    const body = readContrib(scoped);
    assert.equal(body.id, "recovery-orchestrator", "the contribution id must stay recovery-orchestrator");
    assert.equal(body.priority, 90, "the contribution priority must be 90");
    assert.equal(body.includeInCompact, undefined, "the removed compact opt-in field must be absent");
    assert.match(body.content, /Recovery/i, "the recovery content must be materialized");
    assert.ok(fs.existsSync(path.join(ws, ".pi", "recovery", "1-same-task.md")), "the recovery report scaffold must be written");
  } finally {
    rmWorkspace(ws);
  }
}

// 8. Session-scoped producer coverage: orchestrator's /orchestrate on writes its
// contribution under sessions/<id>/ (and must not land in the legacy flat directory).
async function testOrchestratorProducer() {
  const ws = tmpWorkspace("pi-kit-ctxcontrib-orchestrator-");
  try {
    const pi = await loadProducer("extensions/orchestrator/index.ts", ws, "orch-1");
    const ctx = { cwd: ws, sessionManager: { getSessionId: () => "orch-1" }, ui: { notify() {}, setStatus() {} } };
    await pi.commands.get("orchestrate").handler("on", ctx);

    const scoped = path.join(contribDir(ws), "sessions", "orch-1", "orchestrator.json");
    const flat = path.join(contribDir(ws), "orchestrator.json");
    assert.ok(fs.existsSync(scoped), "orchestrator must write into sessions/<id>/orchestrator.json");
    assert.ok(!fs.existsSync(flat), "a session-id orchestrator contribution must not land in the legacy flat directory");
    const body = readContrib(scoped);
    assert.equal(body.id, "orchestrator", "the contribution id must stay orchestrator");
    assert.equal(body.priority, 80, "the contribution priority must be 80");
  } finally {
    rmWorkspace(ws);
  }
}

// 9. Session-scoped producer coverage: conductor resolves the session id in
// before_agent_start (not session_start); /engagement start writes under sessions/<id>/.
async function testConductorProducer() {
  const ws = tmpWorkspace("pi-kit-ctxcontrib-conductor-");
  try {
    const pi = await loadProducer("extensions/conductor/index.ts", ws, "con-1");
    const ctx = { cwd: ws, sessionManager: { getSessionId: () => "con-1" }, ui: { notify() {}, setStatus() {} } };
    await pi.handlers.get("before_agent_start")({}, ctx);
    await pi.commands.get("engagement").handler("start", ctx);

    const scoped = path.join(contribDir(ws), "sessions", "con-1", "conductor.json");
    const flat = path.join(contribDir(ws), "conductor.json");
    assert.ok(fs.existsSync(scoped), "conductor must write into sessions/<id>/conductor.json");
    assert.ok(!fs.existsSync(flat), "a session-id conductor contribution must not land in the legacy flat directory");
    const body = readContrib(scoped);
    assert.equal(body.id, "conductor", "the contribution id must stay conductor");
    assert.equal(body.priority, 80, "the contribution priority must be 80");
    assert.equal(body.includeInCompact, undefined, "the removed compact opt-in field must be absent");
    assert.match(body.content, /Engagement/, "the engagement content must be materialized");
  } finally {
    rmWorkspace(ws);
  }
}

// 10. Session-scoped producer coverage: memory-local's interactive recall hook writes
// under sessions/<id>/. MEMORY_DIR is captured at module load, so set it before loading.
async function testMemoryLocalProducer() {
  const ws = tmpWorkspace("pi-kit-ctxcontrib-memory-local-");
  const restoreMemDir = setEnv("PI_KIT_MEMORY_DIR", path.join(ws, "memory"));
  try {
    const pi = await loadProducer("extensions/memory-local/index.ts", ws, "mem-1");
    const ctx = { cwd: ws, sessionManager: { getSessionId: () => "mem-1" }, ui: { notify() {}, setStatus() {} } };
    await pi.tools.get("memory_store").execute("s", { text: "read-replica lag slows reporting queries" }, undefined, undefined, ctx);
    await pi.handlers.get("input")({ source: "interactive", text: "why are reporting queries slow?" }, ctx);

    const scoped = path.join(contribDir(ws), "sessions", "mem-1", "memory-local.json");
    const flat = path.join(contribDir(ws), "memory-local.json");
    assert.ok(fs.existsSync(scoped), "memory-local must write into sessions/<id>/memory-local.json");
    assert.ok(!fs.existsSync(flat), "a session-id memory-local contribution must not land in the legacy flat directory");
    const body = readContrib(scoped);
    assert.equal(body.id, "memory-local", "the contribution id must stay memory-local");
    assert.equal(body.priority, 60, "the contribution priority must be 60");
    assert.match(body.content, /Recalled memory/, "the recalled memory content must be materialized");
  } finally {
    restoreMemDir();
    rmWorkspace(ws);
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["reader isolation: concurrent sessions do not see each other's contributions", testReaderIsolation],
  ["producer/reader agreement: goal-core writes sessions/<id>/ and context-sieve reads it", testProducerReaderAgreement],
  ["load-order independence: a producer writing before context-sieve is still included", testProducerFirstSessionStart],
  ["multi-line goal survives /goal -> GOAL.yaml -> session_start -> contribution", testGoalMultilineRoundTrip],
  ["legacy unquoted goal still reads back after the JSON-scalar change", testGoalLegacyUnquotedRead],
  ["legacy fallback: no session id keeps the flat directory", testLegacyFallback],
  ["traversal safety: a malicious session id falls back flat and never escapes", testTraversalSafety],
  ["session-scoped guidelines producer writes sessions/<id>/guidelines.json, not flat", testGuidelinesProducer],
  ["session-scoped autonomous-loop producer writes sessions/<id>/autonomous-loop.json, not flat", testAutonomousLoopProducer],
  ["session-scoped recovery-orchestrator producer writes sessions/<id>/recovery-orchestrator.json, not flat", testRecoveryOrchestratorProducer],
  ["session-scoped orchestrator producer writes sessions/<id>/orchestrator.json, not flat", testOrchestratorProducer],
  ["session-scoped conductor producer writes sessions/<id>/conductor.json, not flat", testConductorProducer],
  ["session-scoped memory-local producer writes sessions/<id>/memory-local.json, not flat", testMemoryLocalProducer],
];

let failed = 0;
try {
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
} finally {
  restoreEnv();
}

if (failed > 0) {
  console.error(`\n[ctx-contributions-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[ctx-contributions-smoke] all ${tests.length} checks passed`);
