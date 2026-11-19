#!/usr/bin/env node
// Operator delegation (board item F-02): an entry in firewall.json lets the session run named verbs of one
// delegate program without a prompt, until it expires. Both sides: the delegated calls run and are audited
// with the delegation, and everything else around them still asks the operator.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace, isolateKitEnv } from "../packages/core/eval/harness.ts";
import type * as DelegationModule from "../packages/extensions/src/tool-firewall/delegation.ts";
import { object, optional, parseJsonAs, string, unknownValue } from "../packages/core/lib/guard.ts";

/** What the firewall's tool_call handler returns when it blocks a call. */
interface GateDecision {
  block: boolean;
  reason: string;
}
/** One line of the audit log. */
const AuditRecord = object({ event: string(), decider: optional(string()), delegate: optional(unknownValue()), effects: optional(unknownValue()), command: optional(string()), entries: optional(unknownValue()), warnings: optional(unknownValue()) });
type AuditRecord = ReturnType<typeof AuditRecord.parse>;

const ws = fs.realpathSync(tmpWorkspace("pi-kit-fw-delegation-"));
const home = path.join(ws, "home");
const repo = path.join(ws, "repo");
const agentDir = path.join(ws, "agent");
const configFile = path.join(agentDir, "pi-kit", "firewall.json");
const auditFile = path.join(ws, "audit.jsonl");
const restores = [
  isolateKitEnv(),
  setEnv("HOME", home),
  setEnv("PI_CODING_AGENT_DIR", agentDir),
  setEnv("PI_KIT_FIREWALL_CONFIG", undefined),
  setEnv("PI_KIT_AUTO_MODE", undefined),
  setEnv("PI_KIT_AUTO_MODE_STATE_DIR", path.join(ws, "legacy")),
  setEnv("PI_KIT_FIREWALL_PROFILE", undefined),
  setEnv("PI_KIT_FIREWALL_AUDIT_LOG", auditFile),
  setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(ws, "console")),
  setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "20"),
  setEnv("PI_KIT_FIREWALL_ROOT_SESSION", undefined),
  setEnv("PI_KIT_INTERNAL_CHILD", undefined),
];
let checks = 0;
const ok = (label: string) => {
  checks++;
  console.log(`  OK: ${label}`);
};

// The delegate: a real executable in the operator's home, a link to it, and a copy that is not the delegate.
const binDir = path.join(home, "bin");
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(repo, { recursive: true });
const delegate = path.join(binDir, "runctl");
fs.writeFileSync(delegate, "#!/bin/sh\necho \"$@\"\n", { mode: 0o755 });
fs.chmodSync(delegate, 0o755);
const link = path.join(binDir, "rc");
fs.symlinkSync(delegate, link);
// A workspace link to the delegate: what `~root/../tmp/x` would wrongly resolve to if `~user` were read as a
// relative path (bash expands it to root's home instead).
fs.mkdirSync(path.join(repo, "tmp"), { recursive: true });
fs.symlinkSync(delegate, path.join(repo, "tmp", "x"));
const copy = path.join(binDir, "runctl-copy");
fs.copyFileSync(delegate, copy);
fs.chmodSync(copy, 0o755);
const DAY = 24 * 60 * 60 * 1000;
const isoIn = (days: number): string => new Date(Date.now() + days * DAY).toISOString();
const entry = (over: Record<string, unknown> = {}) => ({ operator: "op", path: delegate, verbs: ["status", "pause", "steer"], expires: isoIn(30), ...over });
const config = (c: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ policy: "coding", learn: true, knownHosts: [], source: "user", ...c }));
};

async function gate() {
  const register = await loadExtension("extensions/tool-firewall/index.ts");
  const pi = fakePi();
  register(pi.api, { complete: async () => { throw new Error("the judge must not be asked"); } });
  await pi.handlers.get("session_start")({}, { cwd: repo, ui: { notify() {} } });
  return pi;
}
function attended(session = "s1") {
  const seen: string[] = [];
  const notes: string[] = [];
  return {
    seen,
    notes,
    ctx: { cwd: repo, hasUI: true, sessionManager: { getSessionId: () => session }, ui: { notify: (m: string) => { notes.push(m); }, select: async (title: string) => { seen.push(title); return undefined; } } },
  };
}
const headless = { cwd: repo, hasUI: false, sessionManager: { getSessionId: () => "h1" }, ui: { notify() {} } };
type Pi = Awaited<ReturnType<typeof gate>>;
const bash = async (pi: Pi, command: string, ctx: unknown): Promise<GateDecision | undefined> =>
  (await pi.handlers.get("tool_call")({ toolName: "bash", input: { command } }, ctx)) as GateDecision | undefined;
const auditLines = (): AuditRecord[] => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => parseJsonAs(AuditRecord, l, "audit line")) : []);
const delegatedLines = () => auditLines().filter((l) => l.decider === "delegate");

try {
  config({ delegations: [entry()] });
  const pi = await gate();

  // --- Delegated: the listed verbs of the delegate program, by path, through a link and from ~, attended and headless.
  for (const command of [`${delegate} pause run1`, `${delegate} status`, `${link} steer run1 "slow down"`, "~/bin/runctl pause run1"]) {
    const v = attended();
    assert.equal(await bash(pi, command, v.ctx), undefined, `${command}: delegated, runs`);
    assert.deepEqual(v.seen, [], `${command}: no card`);
  }
  assert.equal(await bash(pi, `${delegate} status`, headless), undefined, "headless: delegated too");
  const lines = delegatedLines();
  assert.equal(lines.length, 5, "every delegated call is audited with the delegation");
  for (const l of lines) {
    assert.equal(l.event, "tool_approved");
    const d = parseJsonAs(object({ operator: string(), path: string(), verb: string(), expires: string() }), JSON.stringify(l.delegate), "delegate");
    assert.equal(d.operator, "op");
    assert.equal(d.path, delegate, "the audit names the delegate's real path");
    assert.ok(["pause", "status", "steer"].includes(d.verb));
  }
  assert.ok(!fs.existsSync(path.join(agentDir, "pi-kit", "firewall-feedback.jsonl")), "a delegated call teaches nothing: no feedback");
  assert.ok(!fs.existsSync(path.join(agentDir, "pi-kit", "firewall-approvals.json")), "and stores no approval");
  ok("delegated verbs of the delegate run with no prompt, attended and headless, each audited with operator, path, verb and expiry; nothing is learned");

  // --- Still the operator's: everything around the delegation.
  const asked = [
    `${delegate} backlog run1 next`, // delegable, but not in this entry
    `${delegate} start run1`, `${delegate} promote run1`, `${delegate} cancel run1`, // never delegable
    delegate, `${delegate} --verbose pause run1`, // no verb first
    "node packages/autonomy/cli.ts pause --run run1", "pi-autonomy steer --run run1 --message x", "./packages/autonomy/cli.ts pause --run run1", // the raw CLI
    "systemctl --user enable luna-run@x", "systemctl enable luna-run@x",
    `${delegate} status; touch ${home}/x`, `${delegate} status | sh`, `${delegate} $(echo pause) run1`, `${delegate} pause run1 > ${home}/out.txt`,
    `X=1 ${delegate} pause run1`, `sudo ${delegate} pause run1`, `bash -c '${delegate} pause run1'`, `env ${delegate} pause run1`, `${delegate} pause run1 &`,
    `${copy} pause run1`, "runctl pause run1", // another program, and a bare name PATH resolves
    `bash ${delegate} start run1`, `sh ${delegate} promote run1`, `bash ${delegate} pause run1`, // the delegate as a script is not the delegation
    "~root/../tmp/x status", `~+/${path.relative(repo, delegate)} pause run1`, // tilde forms bash expands elsewhere
  ];
  const before = delegatedLines().length;
  for (const command of asked) {
    const v = attended();
    const r = await bash(pi, command, v.ctx);
    assert.equal(r?.block, true, `${command}: not run unasked`);
  }
  assert.equal(delegatedLines().length, before, "none of them was decided by the delegation");
  ok(`${asked.length} calls around the delegation (other verbs, never-delegable verbs, the raw CLI, systemctl enable, chains, pipes, substitutions, redirects, sudo, bash -c, env, a copy, a bare name) still need the operator`);

  // --- The delegate is part of the boundary: writing it is a safety-control action.
  for (const command of [`echo x > ${delegate}`, `chmod 777 ${delegate}`, `cp /bin/sh ${delegate}`]) {
    const v = attended();
    assert.equal((await bash(pi, command, v.ctx))?.block, true, `${command}: not run unasked`);
    const seen = auditLines().filter((l) => l.event === "tool_seen" && l.command?.includes("runctl")).at(-1);
    assert.ok(Array.isArray(seen?.effects) && seen.effects.includes("security_control"), `${command}: a safety-control write`);
  }
  ok("writing, chmod-ing or replacing the delegate is a safety-control action");

  // --- Two entries for one path: each verb is found in whichever entry lists it.
  config({ delegations: [entry({ verbs: ["status"] }), entry({ verbs: ["pause"] })] });
  for (const command of [`${delegate} status`, `${delegate} pause run1`]) assert.equal(await bash(pi, command, attended().ctx), undefined, `${command}: delegated by its own entry`);
  ok("two entries for one delegate: each verb is honoured by the entry that lists it");

  // --- A dropped entry still protects its delegate: it cannot be replaced while the entry is invalid.
  config({ delegations: [entry({ expires: isoIn(-1) })] });
  {
    const v = attended();
    assert.equal((await bash(pi, `echo x > ${delegate}`, v.ctx))?.block, true, "an expired entry's delegate: not rewritten unasked");
    const seen = auditLines().filter((l) => l.event === "tool_seen" && l.command?.includes("runctl")).at(-1);
    assert.ok(Array.isArray(seen?.effects) && seen.effects.includes("security_control"), "still a safety-control write");
  }
  config({ delegations: [entry()] });
  ok("the delegate stays protected while its entry is dropped");

  // --- Sessions the delegation never covers: a kit child, the engagement policy.
  const child = setEnv("PI_KIT_INTERNAL_CHILD", "1");
  assert.equal((await bash(pi, `${delegate} pause run1`, attended().ctx))?.block, true, "a child session: not delegated");
  child();
  config({ policy: "engagement", delegations: [entry()] });
  assert.equal((await bash(pi, `${delegate} pause run1`, attended().ctx))?.block, true, "the engagement policy: not delegated");
  ok("a child session and the engagement policy never use a delegation");

  // --- DE-115 (2): only day-to-day verbs, and never with an option that changes what the verb authorises or reads.
  config({ delegations: [entry({ verbs: ["status", "pause", "steer", "backlog"] })] });
  for (const command of [`${delegate} pause run1 --yes`, `${delegate} pause --approve run1`, `${delegate} steer run1 --file ${home}/.ssh/id_rsa`, `${delegate} status -y`, `${delegate} backlog run1 --answer=x`]) {
    assert.equal((await bash(pi, command, attended().ctx))?.block, true, `${command}: an option is never delegated`);
  }
  for (const verb of ["resume", "restart", "answer", "raise-budget", "units", "tick", "board-push"]) {
    config({ delegations: [entry({ verbs: ["pause", verb] })] });
    const v = attended();
    assert.equal((await bash(pi, `${delegate} pause run1`, v.ctx))?.block, true, `an entry naming ${verb} is dropped`);
    await pi.commands.get("firewall").handler("status", v.ctx);
    assert.ok(v.notes.some((n) => new RegExp(`never delegated: ${verb}`).test(n)), `${verb}: never delegable, and /firewall status says so`);
  }
  {
    // Defence in depth at match time: an entry that somehow lists a never-delegable or unknown verb matches nothing.
    const D = await loadModule<typeof DelegationModule>("extensions/tool-firewall/delegation.ts");
    const forged = [{ operator: "op", path: delegate, verbs: ["resume", "start", "answer", "frob", "pause"], expires: isoIn(1) }];
    for (const verb of ["resume", "start", "answer", "frob"]) assert.equal(D.matchDelegation(`${delegate} ${verb} run1`, repo, home, forged), null, `${verb}: never matched`);
    assert.ok(D.matchDelegation(`${delegate} pause run1`, repo, home, forged), "a day-to-day verb still matches");
  }
  config({ delegations: [entry()] });
  ok("delegation covers only status, pause, steer, backlog and metrics, never with an option; resume, restart, answer, raise-budget and the service verbs are refused");

  // --- DE-115 (5): strict security, another finding above low and a delegate another user owns are not delegated.
  {
    const strict = setEnv("PI_KIT_SECURITY_LEVEL", "strict");
    assert.equal((await bash(pi, `${delegate} pause run1`, attended().ctx))?.block, true, "strict security: not delegated");
    strict();
    const policyFile = path.join(ws, "ask-policy.json");
    fs.writeFileSync(policyFile, JSON.stringify({ defaults: { unknown: "ask" }, tools: { bash: { decision: "allow" } }, command_rules: { deny: [], ask: [{ pattern: "\\bpause\\b", reason: "pauses need a person" }] } }));
    const policy = setEnv("PI_KIT_FIREWALL_POLICY", policyFile);
    assert.equal((await bash(pi, `${delegate} pause run1`, attended().ctx))?.block, true, "a call with another finding above low (the policy's own ask) is decided as usual");
    policy();
    const realUid = process.getuid;
    assert.ok(typeof realUid === "function", "a POSIX process has a uid");
    const myUid = realUid.call(process);
    process.getuid = () => myUid + 4242;
    try {
      assert.equal((await bash(pi, `${delegate} pause run1`, attended().ctx))?.block, true, "a delegate owned by another user: not delegated");
    } finally {
      process.getuid = realUid;
    }
    assert.equal(await bash(pi, `${delegate} pause run1`, attended().ctx), undefined, "and with every guard satisfied it is");
  }
  ok("strict security, another finding above low and a delegate owned by another user each stop a delegation");

  // --- firewall.json is part of the boundary wherever PI_KIT_FIREWALL_CONFIG puts it, and a change is audited.
  {
    const elsewhere = path.join(ws, "elsewhere", "firewall.json");
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.copyFileSync(configFile, elsewhere);
    const moved = setEnv("PI_KIT_FIREWALL_CONFIG", elsewhere);
    try {
      const v = attended();
      assert.equal((await bash(pi, `echo '{}' > ${elsewhere}`, v.ctx))?.block, true, "writing the configured firewall.json is not run unasked");
      const seen = auditLines().filter((l) => l.event === "tool_seen" && l.command?.includes("elsewhere")).at(-1);
      assert.ok(Array.isArray(seen?.effects) && seen.effects.includes("security_control"), "it is a safety-control write");
    } finally {
      moved();
    }
    const changes = () => auditLines().filter((l) => l.event === "delegations_changed").length;
    const before = changes();
    config({ delegations: [entry({ verbs: ["status"] })] });
    await bash(pi, `${delegate} status`, attended().ctx);
    assert.equal(changes(), before + 1, "a changed delegation set is audited when it is loaded");
    await bash(pi, `${delegate} status`, attended().ctx);
    assert.equal(changes(), before + 1, "an unchanged one is not audited again");
    config({ delegations: [entry()] });
  }
  ok("firewall.json is protected wherever it is configured, and each change of the delegations is audited");

  // --- Entries that are not honoured, each with a warning in /firewall status.
  const linkEntry = entry({ path: link });
  const writable = path.join(binDir, "runctl-gw");
  fs.copyFileSync(delegate, writable);
  fs.chmodSync(writable, 0o775);
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ["an expired entry", entry({ expires: isoIn(-1) }), /expired/],
    ["an expiry too far ahead", entry({ expires: isoIn(400) }), /more than 90 days/],
    ["a never-delegable verb", entry({ verbs: ["pause", "start"] }), /never delegated: start/],
    ["a verb that grants", entry({ verbs: ["pause", "resume"] }), /never delegated: resume/],
    ["a verb outside the delegable set", entry({ verbs: ["pause", "rm"] }), /outside the delegable set: rm/],
    ["a path that is a link", linkEntry, /is not its own real path/],
    ["a group-writable program", entry({ path: writable }), /writable by its group/],
    ["an unknown key", { ...entry(), allowAll: true }, /unknown key\(s\) allowAll/],
    ["a relative path", entry({ path: "bin/runctl" }), /absolute path/],
  ];
  for (const [label, e, why] of bad) {
    config({ delegations: [e] });
    const v = attended();
    assert.equal((await bash(pi, `${delegate} pause run1`, v.ctx))?.block, true, `${label}: not delegated`);
    await pi.commands.get("firewall").handler("status", v.ctx);
    assert.ok(v.notes.some((n) => /WARNING: delegation dropped/.test(n) && why.test(n)), `${label}: /firewall status says why (${v.notes.join(" | ").slice(0, 400)})`);
  }
  config({ delegations: "everything" });
  assert.equal((await bash(pi, `${delegate} pause run1`, attended().ctx))?.block, true, "a delegations value that is not a list: none");
  ok(`${bad.length + 1} malformed or out-of-date entries are dropped with a warning; a valid one is listed`);

  config({ delegations: [entry()] });
  const v = attended();
  await pi.commands.get("firewall").handler("status", v.ctx);
  assert.ok(v.notes.some((n) => n.includes(`delegation: op delegates status, pause, steer of ${delegate}`)), "/firewall status lists the live delegation");
  ok("/firewall status lists the live delegation");
} finally {
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
console.log(`[firewall-delegation-smoke] all ${checks} checks passed`);
