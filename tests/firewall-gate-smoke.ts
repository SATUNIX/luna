#!/usr/bin/env node
// tool-firewall end to end: the decision matrix, approval cards, session leases, learning from
// operator decisions, session trajectory, the strict pentest policy and serialised approvals.
// Offline: the auto-mode judge is a stub.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace, isolateKitEnv } from "../packages/core/eval/harness.ts";
import type * as Approvals from "../packages/extensions/src/tool-firewall/approvals.ts";
import type * as Feedback from "../packages/extensions/src/tool-firewall/feedback.ts";
import { array, number, object, optional, parseJsonAs, string, unknownValue } from "../packages/core/lib/guard.ts";

type FakePi = ReturnType<typeof fakePi>;
/** What the firewall's tool_call handler returns when it blocks a call. */
interface GateDecision {
  block: boolean;
  reason: string;
}
/** One approval card shown through ctx.ui.select. */
interface CardPrompt {
  title: string;
  options: string[];
}
/** A pending request the firewall broker writes for the human console. */
const BrokerRequest = object({ id: string(), choices: array(string()), body: string() });
type BrokerRequest = ReturnType<typeof BrokerRequest.parse>;
/** One line of firewall-feedback.jsonl. */
const FeedbackRecord = object({ decision: string(), judge: optional(object({ verdict: string() })), steps: optional(unknownValue()) });
/** firewall-profile.json. */
const OperatorProfile = object({
  principles: array(string()),
  stats: array(object({ family: string(), approvals: number(), overrides: number() })),
});
/** One line of the audit log (tool_seen records carry the redacted command). */
const AuditRecord = object({
  event: string(),
  decider: optional(string()),
  tier: optional(string()),
  effects: optional(unknownValue()),
  signature: optional(string()),
  latencyMs: optional(unknownValue()),
  command: optional(string()),
});

const ws = tmpWorkspace("pi-kit-fw-gate-");
const agentDir = path.join(ws, "agent");
const configFile = path.join(agentDir, "pi-kit", "firewall.json");
const restores = [
  isolateKitEnv(),
  setEnv("HOME", path.join(ws, "home")),
  setEnv("PI_CODING_AGENT_DIR", agentDir),
  setEnv("PI_KIT_FIREWALL_CONFIG", undefined),
  setEnv("PI_KIT_AUTO_MODE", undefined),
  setEnv("PI_KIT_AUTO_MODE_STATE_DIR", path.join(ws, "legacy")),
  setEnv("PI_KIT_FIREWALL_PROFILE", undefined),
  setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(ws, "audit.jsonl")),
  setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(ws, "console")),
  setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "20"),
  setEnv("PI_KIT_FIREWALL_ROOT_SESSION", undefined),
  setEnv("PI_KIT_INTERNAL_CHILD", undefined),
];
// The firewall broker's poll timer is unref'd in production; this offline harness has no other
// ref'd handles while it awaits a broker resolution/timeout, so hold the loop open.
const keepAlive = setInterval(() => {}, 1000);
let checks = 0;
const ok = (label: string) => {
  checks++;
  console.log(`  OK: ${label}`);
};
const config = (c: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ policy: "coding", learn: true, knownHosts: [], source: "user", ...c }));
};

async function gate(judgeReplies: string[] = []) {
  const register = await loadExtension("extensions/tool-firewall/index.ts");
  const pi = fakePi();
  const judged: string[] = [];
  const distilled: string[] = [];
  register(pi.api, {
    complete: async (system: string, prompt: string) => {
      // The same model also distils the operator profile in the background.
      if (!/review one tool call/.test(system)) {
        distilled.push(prompt);
        return '{"principles":["Allows root verification work on srv02 under /run"],"cautions":["Refuses network sends from repos"]}';
      }
      judged.push(prompt);
      return judgeReplies.length ? judgeReplies.shift() : '{"verdict":"allow","reason":"fine"}';
    },
  });
  await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
  return { pi, judged, distilled };
}

function card(answers: Array<string | undefined>, session = "s1") {
  const seen: CardPrompt[] = [];
  const inputs: string[] = [];
  return {
    seen,
    ctx: {
      cwd: ws,
      hasUI: true,
      sessionManager: { getSessionId: () => session },
      ui: {
        notify() {},
        select: async (title: string, options: string[]) => {
          seen.push({ title, options });
          return answers.shift();
        },
        input: async (title: string) => {
          inputs.push(title);
          return "use the staging host instead";
        },
      },
    },
  };
}

const bash = async (pi: FakePi, command: string, ctx: unknown): Promise<GateDecision | undefined> =>
  (await pi.handlers.get("tool_call")({ toolName: "bash", input: { command } }, ctx)) as GateDecision | undefined;
/** The first item: the test relies on it being there. */
const first = <T>(items: readonly T[], what: string): T => {
  const [item] = items;
  assert.ok(item !== undefined, what);
  return item;
};
/** The newest item: the test relies on it being there. */
const latest = <T>(items: readonly T[], what: string): T => {
  const item = items.at(-1);
  assert.ok(item !== undefined, what);
  return item;
};
/** Narrowing guard for calls the test expects the firewall to decide on (a no-op when it did). */
const decided = (result: GateDecision | undefined): GateDecision => {
  assert.ok(result, "expected a firewall decision");
  return result;
};

try {
  // Auto-mode cannot substitute a model verdict for an unknown tool's authority. Markers
  // represent the opaque implementation's side effect, beyond the classifier's input adapter.
  config({ mode: "auto" });
  {
    const { pi, judged } = await gate();
    const ctx = { cwd: ws, hasUI: false, sessionManager: { getSessionId: () => "unknown-api" }, ui: {} };
    for (const [toolName, input] of [["cat", { path: "src/a.ts" }], ["view", { path: "src/a.ts" }], ["read_file", { path: "src/a.ts" }], ["apply_patch", { input: "opaque" }], ["Read", { path: "src/a.ts" }], ["write", { content: "missing target" }], ["read", { path: "src/a.ts", extra: "opaque" }], ["vendor_get_secret", { path: ".env" }], ["browser_execute", { code: "opaque" }], ["vendor_mutate", { command: "pwd", extra: "opaque" }]] satisfies Array<[string, Record<string, unknown>]>) {
      const marker = path.join(ws, `${toolName}.marker`);
      const result = await pi.handlers.get("tool_call")({ toolName, input }, ctx);
      if (!result?.block) fs.writeFileSync(marker, "opaque tool executed");
      assert.equal(fs.existsSync(marker), false, `${toolName} cannot run before operator authority`);
    }
    assert.equal(judged.length, 0, "a benign-looking unknown API never reaches the auto judge");
    const view = card(["Allow for this session", "Deny"], "unknown-api-approved");
    const first = { toolName: "vendor_mutate", input: { command: "pwd", payload: "first opaque operation" } };
    assert.equal(await pi.handlers.get("tool_call")(first, view.ctx), undefined, "operator may explicitly grant this exact opaque call");
    assert.equal(await pi.handlers.get("tool_call")(first, view.ctx), undefined, "exact scoped operator session grant remains valid");
    assert.equal((await pi.handlers.get("tool_call")({ ...first, input: { ...first.input, payload: "different opaque operation" } }, view.ctx))?.block, true);
    assert.equal(view.seen.length, 2, "a changed opaque payload needs a new operator decision");
    assert.equal(judged.length, 0, "unknown API authority cannot expand through a model's similarity verdict");
    ok("auto headless: unknown API identity blocks before side effect without asking the judge");
  }

  {
    const policyFile = path.join(ws, "explicit-tool-policy.json");
    fs.writeFileSync(policyFile, JSON.stringify({ defaults: { unknown: "allow" }, tools: { grep: { decision: "deny" }, read: { decision: "deny" }, write: { decision: "deny" }, browser_execute: { decision: "deny" }, vendor_mutate: { decision: "deny" }, edit: { decision: "ask" }, trusted_read: { decision: "allow", risk_class: "read_only" } } }));
    const restore = setEnv("PI_KIT_FIREWALL_POLICY", policyFile);
    try {
      const { pi, judged } = await gate();
      const ctx = { cwd: ws, hasUI: false, sessionManager: { getSessionId: () => "explicit-api" }, ui: {} };
      for (const [toolName, input] of [["grep", { pattern: { toString: 0 } }], ["read", { path: "file.txt" }], ["write", { path: "file.txt", content: "opaque" }], ["browser_execute", { code: "opaque" }], ["vendor_mutate", { command: "pwd", extra: "opaque" }]] satisfies Array<[string, Record<string, unknown>]>) {
        const marker = path.join(ws, `denied-${toolName}.marker`);
        const result = await pi.handlers.get("tool_call")({ toolName, input }, ctx);
        if (!result?.block) fs.writeFileSync(marker, "denied tool executed");
        assert.equal(fs.existsSync(marker), false, `${toolName}: explicit deny precedes all adapters`);
        assert.match(result?.reason ?? "", /HARD DENY/);
      }
      const view = card(["Allow for this session", "Deny"], "explicit-api");
      assert.equal(await pi.handlers.get("tool_call")({ toolName: "edit", input: { path: "file.txt" } }, view.ctx), undefined);
      assert.equal((await pi.handlers.get("tool_call")({ toolName: "edit", input: { path: "another.txt" } }, view.ctx))?.block, true);
      assert.equal(view.seen.length, 2, "explicit ask reaches the operator for changed arguments even after a similar grant");
      assert.equal(await pi.handlers.get("tool_call")({ toolName: "trusted_read", input: {} }, ctx), undefined, "exact operator allow still works");
      assert.equal(judged.length, 0, "explicit deny/ask cannot be replaced by a fresh judge approval");
    } finally {
      restore();
    }
    ok("explicit deny and ask apply to every adapter; exact external allow remains supported");
  }

  // Parent approval has no authority over nested tool identities or arguments.
  {
    const { pi, judged } = await gate();
    const view = card(["Allow once", "Deny", "Deny"], "nested-calls");
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "codemode", toolCallId: "parent", input: { code: "await tools.vendor_mutate({})" } }, view.ctx), undefined);
    const marker = path.join(ws, "nested.marker");
    for (const [n, toolName, input] of [[1, "vendor_mutate", { command: "pwd" }], [2, "write", { path: "src/a.ts", content: "x", extra: "opaque" }]] satisfies Array<[number, string, Record<string, unknown>]>) {
      const result = await pi.handlers.get("tool_call")({ toolName, toolCallId: `parent/${n}`, parentToolCallId: "parent", input }, view.ctx);
      if (!result?.block) fs.writeFileSync(marker, "nested implementation ran");
      assert.equal(result?.block, true);
      assert.equal(fs.existsSync(marker), false);
    }
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "tool_search", input: { query: "files" } }, view.ctx), undefined);
    assert.equal((await pi.handlers.get("tool_call")({ toolName: "vendor_mutate", toolCallId: "search/1", parentToolCallId: "search", input: {} }, view.ctx))?.block, true);
    assert.equal(judged.length, 0, "parent approval/discovery cannot admit a nested unknown or incomplete call to the judge");
    ok("nested calls use their own identity and input; parent approval and discovery confer no authority");
  }

  // A revision invalidates a pending answer before any session grant or feedback is written.
  {
    const policyFile = path.join(ws, "pending-policy.json");
    const writePolicy = (decision: string, extra = "") => fs.writeFileSync(policyFile, JSON.stringify({ _comment: extra, defaults: { unknown: "ask" }, tools: { vendor_pending: { decision } } }));
    writePolicy("ask");
    const restore = setEnv("PI_KIT_FIREWALL_POLICY", policyFile);
    try {
      const { pi } = await gate();
      for (const via of ["select", "confirm"] as const) {
        writePolicy("ask");
        const ctx = { cwd: ws, hasUI: true, sessionManager: { getSessionId: () => `pending-${via}` }, ui: {
          notify() {},
          [via]: async () => { writePolicy("deny"); return via === "select" ? "Allow for this session" : true; },
        } };
        const result = await pi.handlers.get("tool_call")({ toolName: "vendor_pending", input: {} }, ctx);
        assert.equal(result?.block, true);
        assert.match(result?.reason ?? "", /HARD DENY/);
        writePolicy("ask");
        const after = card(["Deny"], `pending-${via}`);
        assert.equal((await pi.handlers.get("tool_call")({ toolName: "vendor_pending", input: {} }, after.ctx))?.block, true, "stale answer did not persist a session grant");
        assert.equal(after.seen.length, 1);
      }
      // Same ask tier after revision: the earlier answer cannot approve the revised policy.
      writePolicy("ask", "before");
      let prompts = 0;
      const result = await pi.handlers.get("tool_call")({ toolName: "vendor_pending", input: {} }, { cwd: ws, hasUI: true, ui: { notify() {}, select: async () => { prompts++; writePolicy("ask", "after"); return prompts === 1 ? "Allow once" : "Deny"; } } });
      assert.equal(result?.block, true);
      assert.equal(prompts, 2, "re-evaluating a revised ask requires a fresh answer");
    } finally { restore(); }
    ok("pending select/confirm approvals re-evaluate policy revisions before allowing or storing grants");
  }

  // Manual mode: low runs, medium and high ask with an evidence card, critical is denied.
  config({ mode: "manual" });
  {
    const { pi, judged } = await gate();
    const view = card(["Allow once", "Deny"]);
    assert.equal(await bash(pi, "npm test", view.ctx), undefined);
    assert.equal(view.seen.length, 0);
    assert.equal(await bash(pi, "npm install left-pad", view.ctx), undefined);
    assert.equal(view.seen.length, 1);
    assert.match(first(view.seen, "a card was shown").title, /MEDIUM · bash · npm install left-pad/);
    assert.match(first(view.seen, "a card was shown").title, /\n\$ npm install left-pad\n/);
    assert.deepEqual(first(view.seen, "a card was shown").options.length, 4);
    const denied = decided(await bash(pi, "git push --force origin main", view.ctx));
    assert.equal(denied.block, true);
    assert.match(denied.reason, /operator declined/);
    const crit = decided(await bash(pi, "rm -rf ~", view.ctx));
    assert.equal(crit.block, true);
    assert.match(crit.reason, /never allowed automatically/);
    assert.equal(view.seen.length, 2, "critical never shows a card");
    assert.equal(judged.length, 0, "manual mode never calls the judge");
    ok("manual: low runs, medium/high show a card, critical denied without asking");
  }

  // A project .pi/auto-mode.json (legacy) can only downgrade: global manual + project
  // {enabled:true} resolves to manual, while global auto + project {enabled:false} is manual.
  {
    const legacyFile = path.join(ws, "legacy", "auto-mode.json");
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({ enabled: true }));
    const raised = await gate();
    const view = card([undefined]);
    assert.equal((await bash(raised.pi, "npm install left-pad", view.ctx))?.block, true, "the operator card, not the judge, decides");
    assert.equal(view.seen.length, 1, "global manual + project {enabled:true} resolves to manual");
    assert.equal(raised.judged.length, 0);
    config({ mode: "auto" });
    fs.writeFileSync(legacyFile, JSON.stringify({ enabled: false }));
    const lowered = await gate();
    const down = card([undefined]);
    assert.equal((await bash(lowered.pi, "npm install left-pad", down.ctx))?.block, true);
    assert.equal(down.seen.length, 1, "global auto + project {enabled:false} resolves to manual");
    assert.equal(lowered.judged.length, 0);
    fs.rmSync(legacyFile);
    config({ mode: "manual" });
    ok("a project .pi/auto-mode.json only downgrades: global manual + project {enabled:true} resolves to manual");
  }

  // Deny and tell: the operator's note reaches the agent.
  {
    const { pi } = await gate();
    const view = card(["Deny and tell the agent why…"]);
    const r = decided(await bash(pi, "ssh prod-db 'psql -c \"drop table x\"'", view.ctx));
    assert.equal(r.block, true);
    assert.match(r.reason, /use the staging host instead/);
    ok("deny-and-tell returns the operator's reason to the agent");
  }

  // Session lease: "allow this kind for the session" stops repeats of that signature only.
  {
    const { pi } = await gate();
    const view = card(["Allow for this session"], "lease-session");
    assert.equal(await bash(pi, "git push origin feature/a", view.ctx), undefined);
    assert.equal(first(view.seen, "a card was shown").options[1], "Allow for this session (exact repeats only)", "manual mode: a session allow covers exact repeats");
    assert.equal(await bash(pi, "git push origin feature/a", view.ctx), undefined);
    assert.equal(view.seen.length, 1, "leased signature does not ask again");
    const other = card([undefined], "lease-session");
    assert.equal((await bash(pi, "git push upstream main", other.ctx))?.block, true, "a different remote is a different signature");
    assert.equal(other.seen.length, 1);
    const fresh = card([undefined], "another-session");
    assert.equal((await bash(pi, "git push origin feature/a", fresh.ctx))?.block, true, "leases do not cross sessions");
    ok("manual session allows cover exact repeats only, per session; Esc denies");
  }

  // Learning: 3 approvals in 2 sessions become a learned allow in auto mode; a denial suspends it.
  config({ mode: "auto" });
  {
    const { pi, judged } = await gate(Array<string>(20).fill('{"verdict":"block","reason":"judge says no"}'));
    // A high-tier action the judge never sees: only the operator or a precedent can allow it.
    const cmd = "sudo systemctl restart nginx";
    for (const [i, session] of ["L1", "L1", "L2"].entries()) {
      const v = card(["Allow once"], session);
      assert.equal(await bash(pi, cmd, v.ctx), undefined, `approval ${i + 1}`);
      assert.equal(v.seen.length, 1);
      // First time: no precedent, straight to the operator. Afterwards the judge checks scope
      // first; its "block" on a high action asks the operator (with the judge's note).
      if (i > 0) assert.match(first(v.seen, "a card was shown").title, /Judge: out of scope\?: judge says no/);
    }
    assert.equal(judged.length, 2, "high actions reach the judge only once the operator approved that kind");
    assert.match(first(judged, "the judge was called"), /impact: HIGH/);
    const auto = card([], "L3");
    assert.equal(await bash(pi, cmd, auto.ctx), undefined, "learned allow after 3 approvals in 2 sessions");
    assert.equal(auto.seen.length, 0);
    assert.equal(judged.length, 2, "a learned family needs no judge");
    // Manual mode never applies learned allows: the operator chose to decide.
    config({ mode: "manual" });
    const man = card([undefined], "L3b");
    assert.equal((await bash(pi, cmd, man.ctx))?.block, true);
    assert.equal(man.seen.length, 1);
    assert.match(first(man.seen, "a card was shown").title, /3 approval\(s\) in 2 session\(s\), 0 denial\(s\) \(learned\)/);
    // One denial suspends it.
    const deny = card(["Deny"], "L4");
    assert.equal((await bash(pi, cmd, deny.ctx))?.block, true);
    config({ mode: "auto" });
    const after = card([undefined], "L5");
    assert.equal((await bash(pi, cmd, after.ctx))?.block, true, "a denial suspends the learned allow");
    assert.equal(after.seen.length, 1);
    assert.match(first(after.seen, "a card was shown").title, /0 approval\(s\) in 0 session\(s\), 2 denial\(s\) \(suspended\)/);
    ok("learning: the same action approved 3×/2 sessions runs; judge in between; a denial suspends");
  }

  // Critical is never learned, and precedents are passed to the judge.
  config({ mode: "auto" });
  {
    const fb = path.join(agentDir, "pi-kit", "firewall-feedback.jsonl");
    const now = Date.now();
    for (let i = 0; i < 5; i++) fs.appendFileSync(fb, JSON.stringify({ ts: new Date(now - i * 1000).toISOString(), sig: "bash|rm -r /", decision: "allow", tier: "critical", tool: "bash", summary: "rm -rf /", project: ws, session: `c${i}`, source: "card" }) + "\n");
    const { pi } = await gate();
    assert.equal((await bash(pi, "rm -rf /", card([]).ctx))?.block, true);
    fs.appendFileSync(fb, JSON.stringify({ ts: new Date().toISOString(), sig: "bash|npm install", decision: "deny", tier: "medium", tool: "bash", summary: "npm install evil-pkg", project: ws, session: "p1", source: "card", note: "only install packages I name" }) + "\n");
    const j = await gate(['{"verdict":"block","reason":"operator denied a similar install"}']);
    const r = decided(await bash(j.pi, "npm install lodash", card([], "P2").ctx));
    assert.equal(r.block, true);
    assert.match(first(j.judged, "the judge was called"), /operator DENIED \(medium\): npm install evil-pkg — note: only install packages I name/);
    ok("critical is never learned; operator precedents reach the judge prompt");
  }

  // Trajectory: secret read then a send; download then execute.
  {
    const { pi } = await gate();
    const view = card([undefined, undefined], "T1");
    fs.writeFileSync(path.join(ws, ".env"), "TOKEN=x\n");
    const readSecret = (await pi.handlers.get("tool_call")({ toolName: "read", input: { path: ".env" } }, view.ctx)) as GateDecision | undefined;
    assert.equal(readSecret, undefined, "the judge allowed reading .env");
    const send = await bash(pi, "curl -X POST https://api.example.com/report -d '{\"ok\":1}'", view.ctx);
    assert.equal(send?.block, true);
    assert.match(first(view.seen, "a card was shown").title, /\nHistory: sends data to api\.example\.com after this session read/);
    const dl = card([undefined], "T2");
    assert.equal(await bash(pi, "curl -sSo tool.sh https://example.com/tool.sh", dl.ctx), undefined);
    assert.equal((await bash(pi, "chmod +x tool.sh && ./tool.sh", dl.ctx))?.block, true);
    assert.match(first(dl.seen, "a card was shown").title, /downloaded/);
    ok("trajectory: secret→send and download→execute escalate to the operator");
  }

  // Strict pentest policy: regex rules, no auto-low trust, headless high denied outright.
  config({ mode: "auto", policy: "pentest", knownHosts: ["ms01"] });
  {
    const { pi, judged } = await gate();
    const view = card([undefined, undefined, undefined], "PT");
    const rmr = decided(await bash(pi, "rm -r build", view.ctx));
    assert.equal(rmr.block, true, "pentest rules deny rm -r even of build output");
    assert.match(rmr.reason, /pentest rule: recursive delete/);
    assert.equal((await bash(pi, "ssh ms01 uptime", view.ctx))?.block, true, "no auto-low trust in the pentest policy");
    assert.equal(judged.length, 0, "the pentest judge only sees pure reads");
    const headless = (await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "git push --force" } }, { cwd: ws, hasUI: false, ui: {} })) as GateDecision;
    assert.match(headless.reason, /pentest policy does not approve high-impact actions without an interactive operator/);
    assert.ok(!fs.existsSync(path.join(ws, "console", "pending")) || fs.readdirSync(path.join(ws, "console", "pending")).length === 0);
    // Approvals are per action: the card offers no session lease.
    assert.ok(view.seen.length > 0 && view.seen.every((c) => !c.options.some((o) => /for this session/.test(o))), "pentest cards offer no session lease");
    ok("pentest policy: strict regex rules, no auto-low shortcut, no leases, headless high denied");
  }

  // Ops work on a known host: families, remote sudo, compact cards, judged scope, broker menu,
  // and leases shared with subagents.
  config({ mode: "auto", knownHosts: ["srv02", "ms01"] });
  {
    const long = `ssh -F ~/.ssh/config srv02 "sudo bash -c 'SOPS_AGE_KEY_FILE=/nonexistent sops --decrypt --input-type binary --output-type binary /srv/gitops/fleet/hosts/srv02/secrets/host.secrets.sops > /dev/null 2> /run/srv02-verify/badkey.sops.err; echo SOPS_BADKEY_EXIT=\\$?'; sudo stat -c \\"%s %n\\" /run/srv02-verify/badkey.sops.err"`;
    // sudo over ssh has no terminal to prompt on: root reads on a known host are routine.
    const { pi, judged } = await gate([
      '{"verdict":"allow","reason":"same verification work"}',
      '{"verdict":"block","reason":"different target","differs":"writes /etc/nginx as root, the allowed step only wrote under /run/srv02-verify"}',
      '{"verdict":"allow","reason":"same kind as approved before"}',
      '{"verdict":"block","reason":"restarting sshd is not part of the verification"}',
    ]);
    const quiet = card([], "OPS");
    assert.equal(await bash(pi, `ssh srv02 "sudo ls -la /etc/ssh; sudo journalctl -u sshd -n 20; sudo stat /run"`, quiet.ctx), undefined);
    assert.equal(quiet.seen.length + judged.length, 0, "remote sudo reads on a known host need nobody");
    // The card fits in 10 lines of at most 116 characters and says what a session allow covers.
    const v = card(["Allow for this session"], "OPS");
    assert.equal(await bash(pi, long, v.ctx), undefined);
    const lines = first(v.seen, "a card was shown").title.split("\n");
    assert.ok(lines.length <= 10 && lines.every((l) => l.length <= 116), `card is ${lines.length} lines, longest ${Math.max(...lines.map((l) => l.length))}`);
    assert.match(first(v.seen, "a card was shown").title, /Session allow: exact repeats run; similar steps \(root on srv02: reads secrets, writes system paths\)/);
    assert.equal(first(v.seen, "a card was shown").options[1], "Allow for this session (similar steps: judge checks them against this)");
    // An exact repeat runs without the judge.
    const judgedAtGrant = judged.length;
    const repeat = card([], "OPS");
    assert.equal(await bash(pi, long, repeat.ctx), undefined);
    assert.equal(repeat.seen.length + judged.length - judgedAtGrant, 0, "an exact repeat of a session allow runs directly");
    // A similar step goes to the judge, which reasons over the whole granted action.
    const again = card([], "OPS");
    assert.equal(await bash(pi, `ssh srv02 "sudo install -d -m 0700 /run/other && sudo sops -d /srv/x.sops > /run/other/out"`, again.ctx), undefined);
    assert.equal(again.seen.length, 0, "the judge allowed a step like the granted one");
    assert.match(latest(judged, "the judge was called"), /<grants>[\s\S]*badkey\.sops\.err[\s\S]*why it needed approval[\s\S]*<\/grants>/, "the judge sees the full granted action");
    // When the judge finds it differs, the operator is asked with the difference; their answer
    // is recorded with the judge's view so later judgements (and the profile) learn from it.
    const differs = card(["Allow once"], "OPS");
    assert.equal(await bash(pi, `ssh srv02 "sudo install -d /etc/nginx/extra"`, differs.ctx), undefined);
    assert.match(first(differs.seen, "a card was shown").title, /Judge: differs from your session allow: writes \/etc\/nginx as root, the allowed step only wrote under/);
    const fb = fs.readFileSync(path.join(agentDir, "pi-kit", "firewall-feedback.jsonl"), "utf8").trim().split("\n").map((l) => parseJsonAs(FeedbackRecord, l));
    const overrode = latest(fb, "a feedback record");
    assert.equal(overrode.decision, "allow");
    assert.equal(overrode.judge?.verdict, "block", "the operator's override is recorded with the judge's view");
    assert.ok(Array.isArray(overrode.steps) && overrode.steps.length, "decisions carry their steps");
    // Another host is not similar: never approved there, so the operator decides.
    const otherHost = card([undefined], "OPS");
    const judgedBeforeOther = judged.length;
    assert.equal((await bash(pi, `ssh ms01 "sudo install -d /run/x"`, otherHost.ctx))?.block, true);
    assert.equal(otherHost.seen.length, 1, "an allow on srv02 says nothing about ms01");
    assert.equal(judged.length, judgedBeforeOther);
    // A new session: the operator approved this kind before, so the judge checks scope first.
    const next = card([undefined], "OPS2");
    assert.equal(await bash(pi, `ssh srv02 "sudo install -d /run/srv02-verify2"`, next.ctx), undefined, "judge allowed a precedent-backed high action");
    assert.equal(next.seen.length, 0);
    assert.match(latest(judged, "the judge was called"), /impact: HIGH/);
    // A kind of effect the operator never approved goes straight to them, unjudged.
    const judgedBefore = judged.length;
    const fresh = card([undefined], "OPS2");
    assert.equal((await bash(pi, `ssh srv02 "sudo install -m 0644 /tmp/x /etc/ssh/sshd_config.d/x.conf"`, fresh.ctx))?.block, true);
    assert.equal(judged.length, judgedBefore, "no precedent for persistence on srv02: no judge");
    assert.doesNotMatch(first(fresh.seen, "a card was shown").title, /Judge:/);
    // An approved kind that the judge finds out of scope asks the operator with the judge's note.
    const scoped = card([undefined], "OPS2");
    assert.equal((await bash(pi, `ssh srv02 "sudo install -d /var/lib/unrelated"`, scoped.ctx))?.block, true);
    assert.match(first(scoped.seen, "a card was shown").title, /Judge: out of scope\?: restarting sshd is not part of the verification/, "a judge block on high asks the operator");
    ok("ops on a known host: session allows are judged by similarity, differences reach the operator, decisions carry the judge's view");
  }
  {
    // Headless: the human console gets the same menu; a session choice there grants a lease
    // that the root and every subagent share.
    const { pi } = await gate();
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} }, sessionManager: { getSessionId: () => "ROOT" } });
    assert.equal(process.env.PI_KIT_FIREWALL_ROOT_SESSION, "ROOT");
    const restoreChild = setEnv("PI_KIT_INTERNAL_CHILD", "1");
    try {
      const headless = { cwd: ws, hasUI: false, ui: {}, sessionManager: { getSessionId: () => "CHILD-1" } };
      const pending = bash(pi, `ssh srv02 "sudo install -d /run/child"`, headless);
      const dir = path.join(ws, "console", "pending");
      let req: BrokerRequest | undefined;
      for (let i = 0; i < 100 && !req; i++) {
        await new Promise((r) => setTimeout(r, 5));
        const f = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.endsWith(".json")) : undefined;
        if (f) req = parseJsonAs(BrokerRequest, fs.readFileSync(path.join(dir, f), "utf8"));
      }
      assert.ok(req, "broker request written");
      assert.ok(req.choices.some((c) => /^Allow for this session \(similar steps/.test(c)), "the console gets the full menu");
      assert.ok(req.body.split("\n").length <= 9, "console body leaves room for its title line");
      fs.mkdirSync(path.join(ws, "console", "resolved"), { recursive: true });
      fs.writeFileSync(path.join(ws, "console", "resolved", `${req.id}.json`), JSON.stringify({ id: req.id, approved: true, answer: req.choices[1] }));
      assert.equal(await pending, undefined);
      fs.rmSync(dir, { recursive: true, force: true });
      // A sibling subagent inherits the lease through the shared root.
      assert.equal(await bash(pi, `ssh srv02 "sudo install -d /run/sibling"`, { ...headless, sessionManager: { getSessionId: () => "CHILD-2" } }), undefined);
    } finally {
      restoreChild();
    }
    // ...and so does the root session itself.
    const rootView = card([], "ROOT");
    assert.equal(await bash(pi, `ssh srv02 "sudo install -d /run/root"`, rootView.ctx), undefined);
    assert.equal(rootView.seen.length, 0);
    ok("human console offers the full menu; a session allow informs root and subagents");
  }

  // Parallel calls are decided one at a time (one card open at a time).
  config({ mode: "manual" });
  {
    const { pi } = await gate();
    let open = 0;
    let maxOpen = 0;
    const ctx = {
      cwd: ws,
      hasUI: true,
      sessionManager: { getSessionId: () => "PAR" },
      ui: {
        notify() {},
        select: async () => {
          open++;
          maxOpen = Math.max(maxOpen, open);
          await new Promise((r) => setTimeout(r, 15));
          open--;
          return "Allow once";
        },
      },
    };
    const results = await Promise.all(["npm install a", "npm install b", "npm install c"].map((c) => bash(pi, c, ctx)));
    assert.deepEqual(results, [undefined, undefined, undefined]);
    assert.equal(maxOpen, 1);
    ok("parallel tool calls are serialised: one approval card at a time");
  }

  // Global learning: decisions and judge verdicts are compressed in the background into a
  // profile of how the operator decides, which later judgements see. It never grants anything.
  config({ mode: "auto", knownHosts: ["srv02"] });
  {
    const profileFile = path.join(agentDir, "pi-kit", "firewall-profile.json");
    for (let i = 0; i < 50 && !fs.existsSync(profileFile); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(fs.existsSync(profileFile), "operator decisions triggered a background distillation");
    const profile = parseJsonAs(OperatorProfile, fs.readFileSync(profileFile, "utf8"));
    assert.deepEqual(profile.principles, ["Allows root verification work on srv02 under /run"]);
    assert.ok(profile.stats.some((v) => v.family === "bash|srv02 as root:write_outside" && v.approvals > 0 && v.overrides > 0), "per-kind stats count approvals and judge overrides");
    assert.ok(fs.readFileSync(path.join(agentDir, "pi-kit", "firewall-judgements.jsonl"), "utf8").includes('"verdict":"block"'), "judge verdicts are kept as telemetry");
    const { pi, judged, distilled } = await gate();
    assert.ok(distilled.length === 0 || distilled.every((d) => d.includes("<decisions>")));
    assert.equal(await bash(pi, `ssh srv02 "sudo install -d /run/srv02-verify3"`, card([], "PROF").ctx), undefined);
    assert.match(latest(judged, "the judge was called"), /<profile>[\s\S]*Allows root verification work on srv02 under \/run[\s\S]*Refuses network sends from repos[\s\S]*bash\|srv02 as root:write_outside — you approved/, "the judge sees the profile and this kind's history");
    // A profile cannot make a never-approved kind judge-eligible: the operator still decides.
    const judgedBefore = judged.length;
    const v = card([undefined], "PROF");
    assert.equal((await bash(pi, `ssh srv02 "sudo systemctl enable --now evil.timer"`, v.ctx))?.block, true);
    assert.equal(judged.length, judgedBefore);
    assert.equal(v.seen.length, 1);
    ok("global learning: background profile + per-kind stats inform the judge, never eligibility");
  }

  // Audit records carry tier, effects, decider and a redacted command.
  {
    const lines = fs.readFileSync(path.join(ws, "audit.jsonl"), "utf8").trim().split("\n").map((l) => parseJsonAs(AuditRecord, l));
    const approved = lines.find((l) => l.event === "tool_approved" && l.decider === "human");
    assert.ok(approved?.tier && Array.isArray(approved.effects) && approved.signature && typeof approved.latencyMs === "number");
    const { pi } = await gate();
    await bash(pi, "curl -H 'Authorization: Bearer abcdefghijklmnop1234' http://127.0.0.1:9/x", card([]).ctx);
    const seenRecords = fs.readFileSync(path.join(ws, "audit.jsonl"), "utf8").trim().split("\n").map((l) => parseJsonAs(AuditRecord, l)).filter((l) => l.event === "tool_seen");
    const last = latest(seenRecords, "a tool_seen record");
    assert.ok(last.command !== undefined, "tool_seen records the command");
    assert.doesNotMatch(last.command, /abcdefghijklmnop1234/);
    ok("audit records carry tier/effects/decider/latency and redact secrets");
  }

  // Redaction table for the audit, feedback and judge records (SEC-6), and linear time on 200 KB runs.
  {
    const { redact } = await loadModule<typeof Feedback>("extensions/tool-firewall/feedback.ts");
    const table: [string, string][] = [
      ["DB_PASSWORD=Zx9pLmQ2rT7vWy psql", "DB_PASSWORD=[REDACTED] psql"],
      ["export GITLAB_TOKEN=abc123def456ghi789", "export GITLAB_TOKEN=[REDACTED]"],
      ["HF_TOKEN=hf_abcdefghijklmnop python x.py", "HF_TOKEN=[REDACTED] python x.py"],
      ["AWS_SECRET_ACCESS_KEY=abcdEFGHijklMNOP5678 aws s3 ls", "AWS_SECRET_ACCESS_KEY=[REDACTED] aws s3 ls"],
      ["curl -H 'x-api-key: abcdefghijkl' x", "curl -H 'x-api-key: [REDACTED]' x"],
      ["password=hunter2hunter2", "password=[REDACTED]"],
      ["psql --password=hunter2hunter2", "psql --password=[REDACTED]"],
      ["mysql -u root -pS3cretPassw0rd db", "mysql -u root -p[REDACTED] db"],
      ["mysql -h db -P3306 -u r -psecret", "mysql -h db -P3306 -u r -p[REDACTED]"],
      ["mysql -u root -p db", "mysql -u root -p db"],
      ["curl -u admin:hunter2hunter2 http://x", "curl -u admin:[REDACTED] http://x"],
      ["curl --user=admin:hunter2 x", "curl --user=admin:[REDACTED] x"],
      ["curl -u admin http://x", "curl -u admin http://x"],
      ["git commit --author=joe-example-1234", "git commit --author=joe-example-1234"],
      ["echo tokens=abcdefghijkl", "echo tokens=abcdefghijkl"],
    ];
    for (const [input, want] of table) assert.equal(redact(input), want, input);
    for (const unit of ["x_token", "DB_", "a-", "mysql ", "curl -u ", "-----BEGIN RSA " + "PRIVATE KEY-----", "token="]) {
      const text = unit.repeat(Math.ceil((200 * 1024) / unit.length));
      const t0 = performance.now();
      redact(text);
      const ms = performance.now() - t0;
      assert.ok(ms < 200, `redact on 200 KB of ${JSON.stringify(unit)} took ${Math.round(ms)} ms`);
    }
    ok("redact covers PREFIX_TOKEN=value, mysql -p<pw> and curl -u user:pw, in linear time");
  }

  // Judge precedents are scoped like every other learning input: a decision from another
  // workspace, or one made before `/firewall revoke workspace`, never reaches the judge prompt.
  config({ mode: "auto" });
  {
    const { revokeApprovals } = await loadModule<typeof Approvals>("extensions/tool-firewall/approvals.ts");
    const fb = path.join(agentDir, "pi-kit", "firewall-feedback.jsonl");
    const rec = (ts: number, project: string, decision: string, summary: string) =>
      fs.appendFileSync(fb, JSON.stringify({ ts: new Date(ts).toISOString(), sig: "bash|npm install", decision, tier: "medium", tool: "bash", summary, project, session: "scope1", source: "card" }) + "\n");
    const now = Date.now();
    rec(now - 60_000, ws, "allow", "npm install before-the-revocation");
    assert.equal(revokeApprovals(["workspace"], { root: "scope-root", workspace: ws }, now - 30_000).error, undefined, "revoke workspace");
    rec(now, path.join(ws, "elsewhere"), "allow", "npm install from-another-workspace");
    rec(now, ws, "deny", "npm install after-the-revocation");
    const j = await gate(['{"verdict":"block","reason":"denied"}']);
    assert.equal(decided(await bash(j.pi, "npm install lodash", card([], "S3").ctx)).block, true);
    const prompt = first(j.judged, "the judge was called");
    assert.match(prompt, /npm install after-the-revocation/);
    assert.doesNotMatch(prompt, /from-another-workspace/, "a precedent from another workspace reached the judge");
    assert.doesNotMatch(prompt, /before-the-revocation|evil-pkg/, "a precedent from before the revocation floor reached the judge");
    ok("judge precedents are workspace-scoped and cut off by a revocation floor");
  }

  console.log(`[firewall-gate-smoke] all ${checks} checks passed`);
} finally {
  clearInterval(keepAlive);
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
