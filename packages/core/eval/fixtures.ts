// Eval fixtures v1. Each fixture is deterministic and offline: it drives a real extension
// with fixture inputs and asserts the observable behaviour. Add fixtures here; run.ts
// executes all of them and fails the suite on any regression.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadExtension, loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace, assert, ROOT, isolateKitEnv } from "./harness.ts";
import { call, callMethod, dig, firstText, prop } from "./dynamic.ts";
import { parseJson } from "../lib/guard.ts";

export type FixtureCategory = "security" | "verification" | "orchestration" | "recovery" | "memory";

/** One offline eval case: `run` throws (fails) on a regression. */
export interface Fixture {
  readonly name: string;
  readonly category: FixtureCategory;
  run(): Promise<void>;
}

const readJson = (file: string): unknown => parseJson(fs.readFileSync(file, "utf8"));

// A small deterministic trace fixture used by the memory/self-improvement fixtures.
function seedTrace(ws: string): void {
  fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(JSON.stringify({ kind: "call", tool: "read", target: "src/app.ts", argsHash: "a" }));
    lines.push(JSON.stringify({ kind: "result", tool: "read", target: "src/app.ts", status: "ok" }));
    lines.push(JSON.stringify({ kind: "call", tool: "grep", target: "TODO", argsHash: "b" }));
    lines.push(JSON.stringify({ kind: "result", tool: "grep", target: "TODO", status: "ok" }));
  }
  fs.writeFileSync(path.join(ws, ".pi", "trace.jsonl"), lines.join("\n") + "\n");
}

export const fixtures: readonly Fixture[] = [
  // ---- Safety: attended ask_human returns the operator's selected answer ----
  {
    name: "human-console/attended-question",
    category: "security",
    async run(): Promise<void> {
      const register: unknown = await loadExtension("extensions/human-console/index.ts");
      const pi = fakePi(); call(register, "extension", pi.api);
      const ws = tmpWorkspace("pi-kit-eval-human-");
      try {
        const result = await callMethod(pi.tools.get("ask_human"), "execute", "1", { question: "Continue?", options: ["continue"] }, undefined, undefined, { cwd: ws, hasUI: true, ui: { select: async () => "continue" } });
        assert(/continue/.test(firstText(result)), "attended question must return the selected answer");
      } finally { rmWorkspace(ws); }
    },
  },
  // ---- Security: tool-firewall default-deny + destructive-command layer (Epic 2) ----
  {
    name: "firewall/destructive-denied-benign-allowed",
    category: "security",
    async run(): Promise<void> {
      const ws = tmpWorkspace("pi-kit-eval-fw-");
      const restoreIsolation = isolateKitEnv();
      const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent"));
      const restoreAudit = setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(ws, "a.jsonl"));
      const restorePolicy = setEnv("PI_KIT_FIREWALL_POLICY", undefined); // shipped policy
      const restoreHumanTimeout = setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "1");
      // The firewall broker's poll timer is unref'd in production; this offline fixture has no
      // other ref'd handle while it awaits the headless broker timeout, so hold the loop open.
      const keepAlive = setInterval(() => {}, 1000);
      try {
        const register: unknown = await loadExtension("extensions/tool-firewall/index.ts");
        const pi = fakePi();
        call(register, "extension", pi.api);
        await call(pi.handlers.get("session_start"), "session_start handler", {}, { hasUI: true, ui: { notify() {} } });
        const headless = { hasUI: false, ui: {} };
        const callTool = (t: string, i: Record<string, unknown>): unknown => call(pi.handlers.get("tool_call"), "tool_call handler", { toolName: t, input: i }, headless);
        assert(prop(await callTool("bash", { command: "rm -rf /tmp/x" }), "block") === true, "rm -rf must deny");
        assert((await callTool("bash", { command: "echo hi" })) === undefined, "echo must allow");
        assert(prop(await callTool("weird_unknown_tool", {}), "block") === true, "unknown tool must fail closed");
      } finally {
        clearInterval(keepAlive);
        restorePolicy();
        restoreAudit();
        restoreHumanTimeout();
        restoreAgentDir();
        restoreIsolation();
        rmWorkspace(ws);
      }
    },
  },
  // ---- Security: secret-guard content + bash-bypass (Epic 2) ----
  {
    name: "secret-guard/blocks-secrets-and-exfil",
    category: "security",
    async run(): Promise<void> {
      const register: unknown = await loadExtension("extensions/secret-guard/index.ts");
      const pi = fakePi();
      call(register, "extension", pi.api);
      const ctx = { hasUI: false, ui: { notify() {} } };
      const callTool = (t: string, i: Record<string, unknown>): unknown => call(pi.handlers.get("tool_call"), "tool_call handler", { toolName: t, input: i }, ctx);
      assert(prop(await callTool("write", { path: ".env", content: "X=1" }), "block") === true, ".env write must block");
      assert(
        prop(await callTool("write", { path: "a.js", content: "AKIAIOSFODNN7EXAMPLE" }), "block") === true,
        "AWS key content must block",
      );
      assert(prop(await callTool("bash", { command: "base64 config/.env" }), "block") === true, "base64 .env must block");
      assert((await callTool("bash", { command: "ls -la" })) === undefined, "ls must allow");
    },
  },
  // ---- Verification: verify-gate auto-records a verdict (Epic 4 Sprint 4.1) ----
  {
    name: "verify-gate/records-pass-and-fail-verdicts",
    category: "verification",
    async run(): Promise<void> {
      const mod: unknown = await loadModule("extensions/verify-gate/index.ts");
      assert(typeof prop(mod, "recordVerifyVerdict") === "function", "recordVerifyVerdict must be exported");
      const ws = tmpWorkspace("pi-kit-eval-vg-");
      try {
        callMethod(mod, "recordVerifyVerdict", ws, "verify", false, "type check failed");
        let board = readJson(path.join(ws, ".pi", "verdicts.json"));
        assert(dig(board, "verdicts", "verify", "pass") === false, "failing verdict must be recorded");
        callMethod(mod, "recordVerifyVerdict", ws, "verify", true, "npm run verify passed");
        board = readJson(path.join(ws, ".pi", "verdicts.json"));
        assert(dig(board, "verdicts", "verify", "pass") === true, "passing verdict must overwrite");
      } finally {
        rmWorkspace(ws);
      }
    },
  },
  // ---- Verification: finish-reason-retry rewrite actually matches pi's retry regex ----
  {
    name: "finish-reason-retry/rewrite-matches-pi-retry-regex",
    category: "verification",
    async run(): Promise<void> {
      const mod: unknown = await loadModule("extensions/finish-reason-retry/index.ts");
      assert(typeof prop(mod, "toRetryableErrorMessage") === "function", "toRetryableErrorMessage must be exported");
      const rewritten = String(callMethod(mod, "toRetryableErrorMessage", "Provider finish_reason: error"));
      const retryable = prop(mod, "RETRYABLE_PROVIDER_ERROR");
      // pi's _isRetryableError regex (agent-session.js) must classify the rewritten message as retryable.
      assert(retryable instanceof RegExp && retryable.test(rewritten), "rewritten errorMessage must match pi's retryable regex");
      assert(/provider returned error/i.test(rewritten), "must carry the retryable marker");
      const pi = fakePi();
      callMethod(mod, "default", pi.api);
      const out = await call(pi.handlers.get("message_end"), "message_end handler", { message: { role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: error" } });
      const errorMessage = dig(out, "message", "errorMessage");
      assert(typeof errorMessage === "string" && /provider returned error/i.test(errorMessage), "handler must rewrite the retryable finish_reason");
      const untouched = await call(pi.handlers.get("message_end"), "message_end handler", { message: { role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: content_filter" } });
      assert(untouched === undefined, "other finish_reasons must not be rewritten");
    },
  },
  // ---- Verification: record_verdict cannot forge independent (trusted) verdict sources ----
  {
    name: "verifier-board/record-verdict-refuses-trusted-sources",
    category: "verification",
    async run(): Promise<void> {
      const mod: unknown = await loadModule("extensions/verifier-board/index.ts");
      assert(typeof prop(mod, "isTrustedVerdictSource") === "function", "isTrustedVerdictSource must be exported");
      for (const s of ["review", "verify", "validator:exp-1"]) assert(callMethod(mod, "isTrustedVerdictSource", s), `${s} must be trusted`);
      for (const s of ["tests", "reviewer", "manual-check"]) assert(!callMethod(mod, "isTrustedVerdictSource", s), `${s} must not be trusted`);
      const ws = tmpWorkspace("pi-kit-eval-trusted-");
      try {
        const pi = fakePi();
        callMethod(mod, "default", pi.api);
        const record = (source: string): unknown => callMethod(pi.tools.get("record_verdict"), "execute", "id", { source, pass: true, summary: "forged" }, undefined, undefined, { cwd: ws });
        for (const source of ["review", "verify", "validator:exp-1"]) {
          const res = await record(source);
          assert(/Refused/.test(firstText(res)), `record_verdict must refuse trusted source ${source}`);
        }
        assert(!fs.existsSync(path.join(ws, ".pi", "verdicts.json")), "no board write for a refused source");
        const ok = await record("tests");
        assert(/Recorded tests: PASS/.test(firstText(ok)), "non-trusted source must still record");
        const board = readJson(path.join(ws, ".pi", "verdicts.json"));
        assert(dig(board, "verdicts", "tests", "pass") === true && dig(board, "verdicts", "review") === undefined, "only the non-trusted verdict is stored");
      } finally {
        rmWorkspace(ws);
      }
    },
  },
  // ---- End-to-end: a failing /verify auto-records a FAIL verdict and blocks completion ----
  // (Epic 4 Sprint 4.1 DoD — a broken verify is the deterministic stand-in for a broken tsc.)
  {
    name: "verify-gate+orchestrator/failing-verify-blocks-mission-complete",
    category: "verification",
    async run(): Promise<void> {
      const vg: unknown = await loadModule("extensions/verify-gate/index.ts");
      const orch: unknown = await loadModule("extensions/orchestrator/index.ts");
      const ws = tmpWorkspace("pi-kit-eval-e2e-");
      try {
        // A fixture project whose `verify` script deterministically fails (stands in for a broken tsc).
        fs.writeFileSync(
          path.join(ws, "package.json"),
          JSON.stringify({ name: "eval-fixture", scripts: { verify: 'node -e "process.exit(1)"' } }),
        );
        const pi = fakePi();
        callMethod(vg, "default", pi.api);
        await call(pi.handlers.get("session_start"), "session_start handler", {}, { cwd: ws });
        await callMethod(pi.commands.get("verify"), "handler", "", { cwd: ws, ui: { setStatus() {}, notify() {} } });

        const board = readJson(path.join(ws, ".pi", "verdicts.json"));
        assert(dig(board, "verdicts", "verify", "pass") === false, "failing /verify must auto-record a FAIL verdict");
        assert(prop(callMethod(orch, "missionCompleteBlocked", ws), "blocked") === true, "failing verdict must block mission-complete");
      } finally {
        rmWorkspace(ws);
      }
    },
  },
  // ---- Orchestration: mission-complete gate refuses done on failing verdict (Epic 4 4.1) ----
  {
    name: "orchestrator/refuses-mission-complete-on-failing-verdict",
    category: "orchestration",
    async run(): Promise<void> {
      const restoreIsolation = isolateKitEnv();
      const mod: unknown = await loadModule("extensions/orchestrator/index.ts");
      assert(typeof prop(mod, "missionCompleteBlocked") === "function", "missionCompleteBlocked must be exported");
      const ws = tmpWorkspace("pi-kit-eval-orch-");
      const restore = setEnv("PI_KIT_ORCH_DISABLE", undefined);
      const restoreVerify = setEnv("PI_KIT_VERIFY_ON_TURN", "1");
      try {
        fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
        const verdicts = path.join(ws, ".pi", "verdicts.json");
        fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { verify: "node test.mjs" } }));

        // Failing verdict -> blocked + a diagnostic fires at the final turn.
        fs.writeFileSync(verdicts, JSON.stringify({ verdicts: { verify: { pass: false, summary: "tsc broke", at: "t" } } }));
        assert(prop(callMethod(mod, "missionCompleteBlocked", ws), "blocked") === true, "failing verdict must block completion");
        const pi = fakePi();
        callMethod(mod, "default", pi.api);
        await call(pi.handlers.get("session_start"), "session_start handler", {}, { cwd: ws, ui: { notify() {} } });
        await call(pi.handlers.get("tool_result"), "tool_result handler", { toolName: "edit", isError: false }, { cwd: ws });
        await call(pi.handlers.get("turn_end"), "turn_end handler", { message: { role: "assistant", stopReason: "stop" } }, { cwd: ws, ui: { notify() {}, setStatus() {} } });
        assert(pi.steers.length === 1, "final turn must diagnose unverified work");
        const steer = dig(pi.steers[0], "message", "content");
        assert(typeof steer === "string" && /verification diagnostic/.test(steer), "diagnostic must explain the block");

        // All-pass -> not blocked, no steer.
        fs.writeFileSync(verdicts, JSON.stringify({ verdicts: { verify: { pass: true, summary: "ok", at: new Date().toISOString() } } }));
        assert(prop(callMethod(mod, "missionCompleteBlocked", ws), "blocked") === false, "all-pass must allow completion");
        const pi2 = fakePi();
        callMethod(mod, "default", pi2.api);
        await call(pi2.handlers.get("session_start"), "session_start handler", {}, { cwd: ws, ui: { notify() {} } });
        await call(pi2.handlers.get("tool_result"), "tool_result handler", { toolName: "edit", isError: false }, { cwd: ws });
        await call(pi2.handlers.get("turn_end"), "turn_end handler", { message: { role: "assistant", stopReason: "stop" } }, { cwd: ws, ui: { notify() {}, setStatus() {} } });
        assert(pi2.steers.length === 0, "no steer when the board is all-PASS");
      } finally {
        restoreVerify();
        restore();
        restoreIsolation();
        rmWorkspace(ws);
      }
    },
  },
  // ---- Recovery: arming autonomous-loop flips progress-guard to auto (Epic 5 Sprint 5.1) ----
  {
    name: "progress-guard/autonomous-arm-flips-mode-to-auto",
    category: "recovery",
    async run(): Promise<void> {
      const mod: unknown = await loadModule("extensions/progress-guard/index.ts");
      assert(typeof prop(mod, "resolveMode") === "function", "resolveMode must be exported");
      const ws = tmpWorkspace("pi-kit-eval-arm-");
      const restore = setEnv("PI_KIT_GUARD_MODE", undefined); // no operator env var
      try {
        fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
        assert(callMethod(mod, "resolveMode", ws, null) === "suggest", "no marker + no env -> suggest");
        const marker = path.join(ws, ".pi", "autonomous-loop.armed.json");
        // A legacy marker with no heartbeat (WU-11) must not pin auto mode: only a fresh,
        // parseable `at` within the TTL keeps the loop armed.
        fs.writeFileSync(marker, JSON.stringify({ armed: true }));
        assert(callMethod(mod, "resolveMode", ws, null) === "suggest", "legacy marker without `at` -> suggest");
        fs.writeFileSync(marker, JSON.stringify({ armed: true, at: new Date().toISOString() }));
        assert(callMethod(mod, "resolveMode", ws, null) === "auto", "fresh arm marker present -> auto with no env var");
      } finally {
        restore();
        rmWorkspace(ws);
      }
    },
  },
  // ---- Recovery: A→B→A oscillation detection (Epic 5 Sprint 5.2) ----
  {
    name: "progress-guard/oscillation-detected",
    category: "recovery",
    async run(): Promise<void> {
      const mod: unknown = await loadModule("extensions/progress-guard/index.ts");
      assert(typeof prop(mod, "findOscillation") === "function", "findOscillation must be exported");
      assert(callMethod(mod, "findOscillation", ["read|a", "read|b", "read|a"]) !== null, "A→B→A must be flagged");
      assert(callMethod(mod, "findOscillation", ["read|a", "read|b", "read|c"]) === null, "A→B→C is not oscillation");
      assert(callMethod(mod, "findOscillation", ["read|a", "read|a", "read|a"]) === null, "repeat (not alternating) is not oscillation");
    },
  },
  // ---- Recovery: progress-guard escalation drives recovery-orchestrator (Epic 5 Sprint 5.3) ----
  {
    name: "recovery-orchestrator/escalation-enters-recovery-flow",
    category: "recovery",
    async run(): Promise<void> {
      const mod: unknown = await loadModule("extensions/recovery-orchestrator/index.ts");
      assert(typeof prop(mod, "planRecovery") === "function", "planRecovery must be exported");
      const ws = tmpWorkspace("pi-kit-eval-rec-");
      try {
        // Simulate progress-guard escalation for a stuck signature.
        fs.mkdirSync(path.join(ws, ".pi", "recovery"), { recursive: true });
        fs.writeFileSync(
          path.join(ws, ".pi", "recovery", "escalation.json"),
          JSON.stringify({ signature: "repeat:abc", reason: "repeated action", count: 3, at: "t" }),
        );
        const pi = fakePi();
        callMethod(mod, "default", pi.api);
        await call(pi.handlers.get("session_start"), "session_start handler", {}, { cwd: ws, ui: { notify() {} } });
        // session_start clears escalation; re-arm it (as progress-guard would mid-session).
        fs.writeFileSync(
          path.join(ws, ".pi", "recovery", "escalation.json"),
          JSON.stringify({ signature: "repeat:abc", reason: "repeated action", count: 3, at: "t" }),
        );
        await call(pi.handlers.get("turn_end"), "turn_end handler", {}, { cwd: ws, ui: { notify() {} } });

        // A steering contribution was written and a recovery report scaffold created.
        const contrib = path.join(ws, ".pi", "ctx-contributions", "recovery-orchestrator.json");
        assert(fs.existsSync(contrib), "recovery must write a context-sieve contribution");
        assert(/fresh scouts|top 10|primary/.test(fs.readFileSync(contrib, "utf8")), "steer must describe the §2 flow");
        const reports = fs.readdirSync(path.join(ws, ".pi", "recovery")).filter((f) => f.endsWith(".md"));
        assert(reports.length === 1, "recovery must write exactly one report scaffold");
        // Escalation consumed (won't re-enter for the same marker).
        assert(!fs.existsSync(path.join(ws, ".pi", "recovery", "escalation.json")), "escalation marker must be consumed");
      } finally {
        rmWorkspace(ws);
      }
    },
  },
  // ---- Memory: skill-forge synthesises a CONFORMING SKILL.md from a trace (Epic 6 Sprint 6.1) ----
  {
    name: "skill-forge/synthesises-conforming-skill",
    category: "memory",
    async run(): Promise<void> {
      const mod: unknown = await loadModule("extensions/skill-forge/index.ts");
      assert(typeof prop(mod, "mineTrace") === "function" && typeof prop(mod, "synthesiseSkillMd") === "function", "miner/synthesiser exported");
      const ws = tmpWorkspace("pi-kit-eval-forge-");
      try {
        seedTrace(ws);
        const pi = fakePi();
        callMethod(mod, "default", pi.api);
        const res = await callMethod(pi.tools.get("skill_synthesise"), "execute", "1", { skill_name: "read-once-flow", category: "efficiency" }, null, null, { cwd: ws });
        assert(/wrote candidate skill/.test(firstText(res)), "synthesise must write a candidate");
        const skillMd = fs.readFileSync(path.join(ws, ".pi", "skill-proposals", "read-once-flow", "SKILL.md"), "utf8");
        // Must pass Epic 3's frontmatter lint: name + description + category.
        const fm = skillMd.slice(0, skillMd.indexOf("\n---", 3));
        for (const key of ["name", "description", "category"]) {
          assert(new RegExp(`\\n?${key}:\\s*\\S`).test(fm), `synthesised SKILL.md must have ${key}`);
        }
        assert(/## Procedure/.test(skillMd) && /## Done/.test(skillMd), "runbook sections present");
      } finally {
        rmWorkspace(ws);
      }
    },
  },
  // ---- Memory: skill_score returns a real eval-tied number (Epic 6 Sprint 6.1) ----
  {
    name: "skill-forge/score-is-eval-tied",
    category: "memory",
    async run(): Promise<void> {
      // Verify the harness the scorer relies on exposes --json with passed/total.
      const out = execFileSync("node", ["packages/core/eval/run.ts", "--json", "--category", "security"], { cwd: ROOT, encoding: "utf8" });
      let parsed: unknown;
      try {
        parsed = parseJson(out);
      } catch (error) {
        throw new Error(`eval --json produced invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      const passed = prop(parsed, "passed"), total = prop(parsed, "total");
      assert(typeof passed === "number" && typeof total === "number" && total > 0, "eval --json must expose passed/total for scoring");
      assert(passed === total, "security fixtures must pass (score baseline)");
    },
  },
  // ---- Self-improvement: /improve proposes a reviewable diff, applies only when armed (6.2) ----
  {
    name: "self-improvement/proposes-diff-without-autocommit",
    category: "memory",
    async run(): Promise<void> {
      const mod: unknown = await loadModule("extensions/self-improvement/index.ts");
      assert(typeof prop(mod, "buildProposal") === "function", "buildProposal exported");
      const ws = tmpWorkspace("pi-kit-eval-improve-");
      const restoreArm = setEnv("PI_KIT_SELF_IMPROVE_ARM", undefined);
      try {
        seedTrace(ws);
        fs.writeFileSync(path.join(ws, "AGENTS.md"), "# AGENTS.md\n");
        const proposal = callMethod(mod, "buildProposal", ws);
        const diff = prop(proposal, "diff");
        assert(prop(proposal, "hasSignal") === true, "seeded repeated reads must yield a signal");
        assert(typeof diff === "string" && /^--- a\/AGENTS\.md/m.test(diff), "proposal must include a unified diff preview");

        // Unarmed /improve: writes a proposal artifact but does NOT touch AGENTS.md.
        const pi = fakePi();
        callMethod(mod, "default", pi.api);
        await callMethod(pi.commands.get("improve"), "handler", "", { cwd: ws, ui: { notify() {} } });
        assert(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8") === "# AGENTS.md\n", "unarmed /improve must NOT modify AGENTS.md");
        const proposals = fs.readdirSync(path.join(ws, ".pi", "self-improvement"));
        assert(proposals.length >= 1, "a reviewable proposal artifact must be written");

        // Armed /improve: applies to AGENTS.md.
        await callMethod(pi.commands.get("improve"), "handler", "arm", { cwd: ws, ui: { notify() {} } });
        assert(/Learned notes/.test(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8")), "armed /improve must append to AGENTS.md");
      } finally {
        restoreArm();
        rmWorkspace(ws);
      }
    },
  },
  // ---- Dream mode: only allowlisted paths are modified, enforced via protected-paths (6.3) ----
  {
    name: "dream-mode/touches-only-allowlisted-paths",
    category: "memory",
    async run(): Promise<void> {
      const ws = tmpWorkspace("pi-kit-eval-dream-");
      try {
        seedTrace(ws);
        fs.writeFileSync(path.join(ws, "AGENTS.md"), "# AGENTS.md\n");
        fs.mkdirSync(path.join(ws, "src"), { recursive: true });
        fs.writeFileSync(path.join(ws, "src", "app.ts"), "export const x = 1;\n");
        const srcBefore = fs.readFileSync(path.join(ws, "src", "app.ts"), "utf8");

        execFileSync("node", ["packages/core/dream.ts", "--cwd", ws], { cwd: ROOT, encoding: "utf8" });

        // Allowlisted paths updated; non-allowlisted source untouched. AGENTS.md is loaded into the
        // model's context and committed, so dream mode must leave it alone.
        assert(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8") === "# AGENTS.md\n", "dream must NOT write trace-derived notes into AGENTS.md");
        assert(fs.existsSync(path.join(ws, ".pi", "memory", "dream-notes.md")), "dream must write a memory note");
        assert(fs.readFileSync(path.join(ws, "src", "app.ts"), "utf8") === srcBefore, "dream must NOT touch src/");

        // Verify via protected-paths that the same allowlist blocks a stray write.
        const pp: unknown = await loadExtension("vendor/protected-paths/index.ts");
        const restore = setEnv("PI_KIT_WRITE_ALLOWLIST", "AGENTS.md;.pi/memory;GOAL.yaml");
        try {
          const pi = fakePi();
          call(pp, "extension", pi.api);
          const blocked = await call(pi.handlers.get("tool_call"), "tool_call handler", { toolName: "write", input: { path: "src/app.ts" } }, { hasUI: false, ui: {} });
          assert(prop(blocked, "block") === true, "protected-paths allowlist must block a non-allowlisted write");
          const allowed = await call(pi.handlers.get("tool_call"), "tool_call handler", { toolName: "write", input: { path: "AGENTS.md" } }, { hasUI: false, ui: {} });
          assert(allowed === undefined, "protected-paths allowlist must permit an allowlisted write");
        } finally {
          restore();
        }
      } finally {
        rmWorkspace(ws);
      }
    },
  },
  // ---- Orchestration: delegation trigger fires on complex, not trivial, input (Epic 4 4.2) ----
  {
    name: "orchestrator/delegation-trigger-on-complex-only",
    category: "orchestration",
    async run(): Promise<void> {
      const restoreIsolation = isolateKitEnv();
      const register: unknown = await loadExtension("extensions/orchestrator/index.ts");
      const ws = tmpWorkspace("pi-kit-eval-orch2-");
      const restore = setEnv("PI_KIT_ORCH_DISABLE", undefined);
      try {
        const pi = fakePi();
        call(register, "extension", pi.api);
        const ctx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
        await call(pi.handlers.get("session_start"), "session_start handler", {}, ctx);
        const contrib = path.join(ws, ".pi", "ctx-contributions", "orchestrator.json");

        await call(pi.handlers.get("input"), "input handler",
          { source: "interactive", text: "Implement a new authentication system across multiple services and refactor the whole billing module thoroughly." },
          ctx,
        );
        assert(fs.existsSync(contrib), "complex task must write a delegation directive");

        await call(pi.handlers.get("input"), "input handler", { source: "interactive", text: "hi there" }, ctx);
        assert(!fs.existsSync(contrib), "trivial task must not delegate");
      } finally {
        restore();
        restoreIsolation();
        rmWorkspace(ws);
      }
    },
  },
];
