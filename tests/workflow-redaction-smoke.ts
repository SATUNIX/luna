#!/usr/bin/env node
// Workflow run-file redaction (third_party/subagent/redact.ts and workflow.ts), offline.
//   1. parity: redact.ts's copied rules are byte-identical to src/trace-ledger/index.ts targetOf()
//      and src/secret-guard/index.ts SECRET_CONTENT_PATTERNS, and redactTraceLedger() gives the same
//      text as the ledger's own targetOf() on a corpus.
//   2. every secret-guard content shape and a whole private key block are redacted.
//   3. linear time: adversarial inputs (the URL rule's quadratic case among them) at 4x the size
//      take under 10x the time, and 1 MB of each finishes quickly.
//   4. a workflow run writes state.json (inputs, outputs, errors) and steps/<id>.md redacted, sets
//      redacted:true, and makes the run directory 0700 and its files 0600.
// Secret-shaped fixtures are built by concatenation so this file holds no literal secret.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadModule, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type * as RedactModule from "../packages/extensions/third_party/subagent/redact.ts";
import type * as WorkflowModule from "../packages/extensions/third_party/subagent/workflow.ts";
import type { ExecuteOptions, RunState, WorkflowDef } from "../packages/extensions/third_party/subagent/workflow.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "packages", "extensions");
const read = (rel: string): string => fs.readFileSync(path.join(EXT, rel), "utf8");

const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

const ws = tmpWorkspace("pi-kit-workflow-redaction-");
const restores = [isolateKitEnv(), setEnv("HOME", path.join(ws, "home")), setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")), setEnv("PI_KIT_SUBAGENT_STATE_DIR", path.join(ws, "subagent-state"))];
fs.mkdirSync(path.join(ws, "home"), { recursive: true });
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

// Secret-shaped values, assembled at run time.
const SK = "sk" + "-" + "A1b2C3d4E5f6G7h8I9j0K1l2";
const GHP = "gh" + "p_" + "0123456789abcdefghijABCDEFGHIJ0123";
const PAT = "github" + "_pat_" + "11ABCDEFG0123456789_abcdefghijklmnop";
const AKIA = "AK" + "IA" + "ABCDEFGHIJKLMNOP";
const SLACK = "xo" + "xb-" + "12345678-abcdefgh9";
const PEM_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
const PEM = "-----BEGIN " + "PRIVATE KEY-----\n" + PEM_BODY + "\n-----END " + "PRIVATE KEY-----";
const URL_PASS = "hunter" + "2pass";

try {
  const R = await loadModule<typeof RedactModule>("vendor/subagent/redact.ts");
  type TargetOf = (input: unknown) => { target?: string | undefined };
  const ledger = await loadModule<{ targetOf: TargetOf }>("extensions/trace-ledger/index.ts");

  // 1. Parity with the source copies.
  {
    const traceSrc = read("src/trace-ledger/index.ts");
    const body = traceSrc.slice(traceSrc.indexOf("export function targetOf"), traceSrc.indexOf("function isReadish"));
    const sourceRules = [...body.matchAll(/^\s*\.replace\((\/.+\/[gimsuy]*), ("[^"]*")\);?$/gm)].map((m) => `${m[1]} -> ${m[2]}`);
    const copiedRules = R.TRACE_LEDGER_RULES.map(([re, to]) => `${String(re)} -> ${JSON.stringify(to)}`);
    assert.equal(sourceRules.length, 4, "the trace-ledger targetOf() rules were found");
    assert.deepEqual(copiedRules, sourceRules, "TRACE_LEDGER_RULES is byte-identical to targetOf()'s rules, in order");

    const guardSrc = read("src/secret-guard/index.ts");
    const block = guardSrc.slice(guardSrc.indexOf("const SECRET_CONTENT_PATTERNS"), guardSrc.indexOf("];", guardSrc.indexOf("const SECRET_CONTENT_PATTERNS")));
    const sourcePatterns = [...block.matchAll(/^\s*\{ re: (\/.+\/[gimsuy]*), label: "([^"]*)" \},$/gm)].map((m) => `${m[1]} ${m[2]}`);
    const copiedPatterns = R.SECRET_GUARD_CONTENT_PATTERNS.map(({ re, label }) => `${String(re)} ${label}`);
    assert.ok(sourcePatterns.length >= 8, "secret-guard SECRET_CONTENT_PATTERNS were found");
    assert.deepEqual(copiedPatterns, sourcePatterns, "SECRET_GUARD_CONTENT_PATTERNS is byte-identical to secret-guard's list, in order");

    const corpus = [
      "curl -H 'Authorization: Bearer abc.def' https://x",
      "export API_KEY=" + "abcdef123456 && run",
      "mysql --password \"p w\" db",
      "git clone https://user:" + URL_PASS + "@example.com/r.git",
      "git clone https://example.com/r.git; open http://a:b:c",
      "HTTP://U:" + URL_PASS + "@host and https://v:w@h2",
      "token: " + SK + " then " + GHP,
      "plain text with no secrets, colons: a:b:c and an @ sign",
      "db_passwd='x y' secret_token=zzz",
    ];
    for (const s of corpus) {
      assert.equal(R.redactTraceLedger(s), ledger.targetOf({ command: s }).target, `redactTraceLedger matches targetOf on: ${s.slice(0, 40)}`);
    }
    ok("the copied rules are byte-identical to trace-ledger and secret-guard, and redactTraceLedger() matches targetOf()");
  }

  // 2. Shapes.
  {
    const cases: Array<[string, string]> = [
      [PEM, PEM_BODY],
      ["key " + AKIA + " end", AKIA],
      ["aws_secret_access_key = " + "wJalrXUtnFEMIK7MDENGbPxRfiCY", "wJalrXUtnFEMIK7MDENG"],
      ["slack " + SLACK, SLACK],
      ["pat " + PAT, PAT],
      ["url https://me:" + URL_PASS + "@example.com/", URL_PASS],
      ["Authorization: Basic " + "dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ];
    for (const [input, secret] of cases) {
      const { text, redacted } = R.redactText(input);
      assert.ok(redacted, `redacted: ${input.slice(0, 30)}`);
      assert.ok(!text.includes(secret), `the secret is gone from: ${text}`);
      assert.match(text, /\[REDACTED\]/);
    }
    const unterminated = "before\n-----BEGIN " + "RSA PRIVATE KEY-----\n" + PEM_BODY + "\nmore";
    assert.equal(R.redact(unterminated), "before\n[REDACTED]", "an unterminated key block redacts to the end");
    assert.equal(R.redact("a " + PEM + " b " + PEM + " c"), "a [REDACTED] b [REDACTED] c", "two key blocks are each redacted");
    const clean = "Refactored parse() in src/a.ts: 3 tests pass. See https://example.com/docs.";
    assert.deepEqual(R.redactText(clean), { text: clean, redacted: false }, "ordinary text is unchanged");
    ok("secret-guard's content shapes, URL credentials and whole private key blocks are redacted; clean text is untouched");
  }

  // 3. Linear time.
  {
    const adversarial = (n: number): string[] => [
      "http://" + "a:".repeat(n / 2),
      "https://a:".repeat(n / 10),
      "token ".repeat(n / 6),
      "sk" + "-" + "a".repeat(n) + "_",
      "xo" + "xb-" + "a".repeat(n),
      "api_key=" + " ".repeat(n),
      "-----BEGIN " + "PRIVATE KEY-----".repeat(n / 27),
      "-----BEGIN " + "PRIVATE KEY----- -----END ".repeat(n / 37),
      "authorization: bearer ".repeat(n / 22),
      "password=\"".repeat(n / 10),
      " ".repeat(n),
      "a-".repeat(n / 2),
    ];
    // Best of three, so a GC pause or a busy CI runner does not read as quadratic growth.
    const time = (s: string): number => {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t = performance.now();
        R.redact(s);
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };
    const small = adversarial(64_000);
    const large = adversarial(256_000);
    small.forEach(time); // warm up
    small.forEach((s, i) => {
      const a = Math.max(time(s), 5); // a quadratic rule takes seconds at 256 KB, far past 10x this floor
      const big = large[i] ?? "";
      const b = time(big);
      assert.ok(b < a * 10, `input ${i}: 4x the size took ${b.toFixed(1)} ms vs ${a.toFixed(1)} ms (quadratic?)`);
    });
    for (const s of adversarial(1_000_000)) assert.ok(time(s) < 2000, "1 MB of adversarial input redacts in under 2 s");
    ok("redaction stays linear on adversarial inputs, including the URL rule's quadratic case");
  }

  // 4. A workflow run writes redacted, private files.
  {
    type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean };
    type FakeSpawn = (cmd: string, args: string[]) => FakeChild;
    type WorkflowView = Omit<typeof WorkflowModule, "executeWorkflow"> & {
      executeWorkflow(w: WorkflowDef, state: RunState, opts: Omit<ExecuteOptions, "spawnChild"> & { spawnChild: FakeSpawn }): Promise<RunState>;
    };
    const W = await loadModule<WorkflowView>("vendor/subagent/workflow.ts");
    const calls: string[] = [];
    const spawn: FakeSpawn = () => {
      const child: FakeChild = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: (): boolean => true,
      });
      let stdin = "";
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (d: string) => (stdin += d));
      child.stdin.on("end", () => {
        calls.push(stdin);
        const fail = stdin.includes("second");
        const text = fail ? "" : "found " + SK + " in config";
        child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: fail ? "error" : "stop", ...(fail ? { errorMessage: "auth failed for " + GHP } : {}) } }) + "\n");
        child.emit("close", fail ? 1 : 0);
      });
      return child;
    };
    const def = "---\nname: red\ninputs:\n  goal: { required: true }\nsteps:\n  - id: first\n    agent: scout\n    task: \"look at {{inputs.goal}}\"\n  - id: second\n    agent: scout\n    task: \"second {{steps.first.output}}\"\n---\n\nbody\n";
    const { workflow, errors } = W.parseWorkflow(def, path.join(ws, "w.md"), "user");
    assert.deepEqual(errors, []);
    assert.ok(workflow);
    const agents: AgentConfig[] = [{ name: "scout", description: "scout", systemPrompt: "", source: "kit", filePath: "scout" }];
    const keepalive = setInterval(() => {}, 1000);
    const state = W.newRunState(workflow, { goal: "use " + AKIA + " please" });
    const final = await W.executeWorkflow(workflow, state, { cwd: ws, agents, spawnChild: spawn });
    clearInterval(keepalive);
    assert.equal(final.status, "failed", "the second step fails (its error carries a token)");
    assert.ok(calls[0]?.includes(AKIA), "the child still gets the real input in its prompt");
    assert.ok(calls[1] !== undefined && !calls[1].includes(SK), "later steps read the redacted steps/<id>.md");
    const dir = path.join(W.runsRoot(ws), final.id);
    const files = ["state.json", path.join("steps", "first.md")];
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      for (const secret of [SK, GHP, AKIA]) assert.ok(!text.includes(secret), `${f} holds no secret`);
      assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, `${f} is 0600`);
    }
    for (const d of [dir, path.join(dir, "steps")]) assert.equal(fs.statSync(d).mode & 0o777, 0o700, `${path.basename(d)} is 0700`);
    const saved: unknown = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.ok(saved !== null && typeof saved === "object" && "redacted" in saved && saved.redacted === true, "state.json carries redacted:true");
    const loaded = W.loadState(ws, final.id);
    assert.ok(loaded, "a redacted state.json still loads");
    assert.match(loaded.inputs.goal ?? "", /^use \[REDACTED\] please$/);
    assert.match(loaded.steps.first?.output ?? "", /\[REDACTED\]/);
    assert.match(loaded.steps.second?.error ?? "", /\[REDACTED\]/);
    ok("state.json and steps/<id>.md are redacted and marked redacted:true; the run dir is 0700 and its files 0600");
  }

  console.log(`workflow-redaction-smoke: ${checks} checks passed`);
} finally {
  for (const restore of restores.reverse()) restore();
  rmWorkspace(ws);
}
