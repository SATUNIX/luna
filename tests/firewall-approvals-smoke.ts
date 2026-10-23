#!/usr/bin/env node
// Remembered approvals are predictable, inspectable and revocable (tool-firewall approvals.ts).
//   - every silent allow is backed by an entry in firewall-approvals.json (schemaVersion, creation
//     time, scope, who/what granted it, expiry), bound to ONE exact action, workspace, working
//     directory and (for session approvals) root session;
//   - an approval given in one workspace never applies in another; learned exact actions are scoped
//     the same way; expired, malformed or unknown-shape entries are ignored (fail closed) and reported;
//   - /firewall lists them with their scope and revokes one or all; invalid arguments change nothing;
//     revocation applies to the very next tool call, in the same session and after a /reload;
//   - known hosts are inspectable and revocable, and a host that only ~/.ssh/config names stops being
//     trusted when the agent changes that file during the session;
//   - manual mode never applies the auto-mode trust shortcuts.
// Offline: the judge is a stub, HOME and the agent dir are temporary.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace, isolateKitEnv } from "../packages/core/eval/harness.ts";
import { array, nullable, number, object, optional, parseJsonAs, record, string, unknownValue } from "../packages/core/lib/guard.ts";
import type * as ApprovalsModule from "../packages/extensions/src/tool-firewall/approvals.ts";
import type { Approval, Floors, NewApproval } from "../packages/extensions/src/tool-firewall/approvals.ts";

type FakePi = ReturnType<typeof fakePi>;

/** firewall-approvals.json as written by approvals.ts (read back as a test fixture). */
interface ApprovalsFile {
  schemaVersion: number;
  updated: string;
  approvals: Approval[];
  floors: Floors;
}

/** The envelope of firewall-approvals.json; each entry is then checked with approvals.ts's own validateApproval. */
const ApprovalsEnvelope = object({
  schemaVersion: number(),
  updated: string(),
  approvals: array(unknownValue()),
  floors: object({ all: nullable(string()), workspaces: record(string()), actions: record(string()) }),
});

/** An audit log line; this test reads only the event name. */
const AuditLine = object({ event: string() });

/** firewall.json as the test reads it back after a host revoke. */
const HostsConfig = object({ knownHosts: optional(array(string())), untrustedHosts: optional(array(string())) });

const approvalsModule = await loadModule<typeof ApprovalsModule>("extensions/tool-firewall/approvals.ts");

/** Reads an approvals file and checks it: the envelope by schema, every entry with validateApproval. */
function readApprovalsFile(file: string): ApprovalsFile {
  const raw = parseJsonAs(ApprovalsEnvelope, fs.readFileSync(file, "utf8"), file);
  const approvals = raw.approvals.map((entry, i) => {
    const approval = approvalsModule.validateApproval(entry);
    if (typeof approval === "string") throw new Error(`${file}: approvals[${i}] is invalid: ${approval}`);
    return approval;
  });
  return { ...raw, approvals };
}

const root = tmpWorkspace("pi-kit-fw-appr-");
const mk = (...p: string[]) => {
  const dir = path.join(root, ...p);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const wsA = mk("wsA");
const wsB = mk("wsB");
const wsSub = mk("wsA", "sub");
for (const w of [wsA, wsB]) fs.mkdirSync(path.join(w, ".git"), { recursive: true });
const home = mk("home");
const agentDir = mk("agent");
const configFile = path.join(agentDir, "pi-kit", "firewall.json");
const approvalsFile = path.join(agentDir, "pi-kit", "firewall-approvals.json");
const restores = [
  isolateKitEnv(),
  setEnv("HOME", home),
  setEnv("PI_CODING_AGENT_DIR", agentDir),
  setEnv("PI_KIT_AUTO_MODE_STATE_DIR", path.join(root, "legacy")),
  setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(root, "audit.jsonl")),
  setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(root, "console")),
  setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "40"),
];
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
const readStore = () => readApprovalsFile(approvalsFile);
const auditLines = () => fs.readFileSync(path.join(root, "audit.jsonl"), "utf8").trim().split("\n").map((l) => parseJsonAs(AuditLine, l));

async function gate(judgeReplies: string[] = []) {
  const register = await loadExtension("extensions/tool-firewall/index.ts");
  const pi = fakePi();
  const judged: string[] = [];
  register(pi.api, {
    complete: async (system: string, prompt: string) => {
      if (!/review one tool call/.test(system)) return '{"principles":["p"],"cautions":["c"]}';
      judged.push(prompt);
      return judgeReplies.length ? judgeReplies.shift() : '{"verdict":"allow","confidence":"high","reason":"fine"}';
    },
  });
  await pi.handlers.get("session_start")({}, { cwd: wsA, ui: { notify() {} } });
  return { pi, judged };
}

// An interactive session: `answers` are the card answers in order; `notes` collects notices.
function ui(answers: Array<string | undefined>, session = "s1", cwd = wsA) {
  const seen: Array<{ title: string; options: string[] }> = [];
  const notes: Array<{ message: string; level: string }> = [];
  return {
    seen,
    notes,
    ctx: {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => session },
      ui: {
        notify: (message: string, level: string) => notes.push({ message, level }),
        select: async (title: string, options: string[]) => {
          seen.push({ title, options });
          return answers.shift();
        },
        input: async () => "no",
      },
    },
  };
}
type UiView = ReturnType<typeof ui>;
const bash = (pi: FakePi, command: string, ctx: object) => pi.handlers.get("tool_call")({ toolName: "bash", input: { command } }, ctx);
const cmd = (pi: FakePi, name: string, args: string, ctx: object) => pi.commands.get(name).handler(args, ctx);
const lastNote = (view: UiView) => view.notes.at(-1)?.message ?? "";
function captureStderr<T>(fn: () => T | Promise<T>): Promise<{ value: T; stderr: string }> {
  const chunks: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  type WriteCallback = (err?: Error | null) => void;
  process.stderr.write = (c: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback) => {
    chunks.push(String(c));
    (typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .then(
      (v) => ({ value: v, stderr: chunks.join("") }),
      (e: unknown) => {
        throw e;
      },
    )
    .finally(() => {
      process.stderr.write = write;
    });
}

const PUSH = "git push origin feature/a";

try {
  // 1. A session allow is an inspectable, versioned, scoped, expiring entry. -----------------------
  config({ mode: "manual" });
  {
    const { pi } = await gate();
    const v = ui(["Allow for this session (exact repeats only)"], "S1");
    assert.equal(await bash(pi, PUSH, v.ctx), undefined);
    const store = readStore();
    assert.equal(store.schemaVersion, 1);
    assert.equal(store.approvals.length, 1);
    const a = store.approvals[0];
    assert.ok(a, "the session allow is stored");
    assert.match(a.id, /^apr_[0-9a-f]{8}$/);
    assert.ok(Number.isFinite(Date.parse(a.createdAt)));
    const ttl = Date.parse(a.expiresAt ?? "") - Date.parse(a.createdAt);
    assert.ok(Math.abs(ttl - 24 * 3_600_000) < 60_000, `session approvals expire after 24h (${ttl})`);
    assert.deepEqual([a.context, a.session, a.workspace, a.cwd, a.policy, a.tool], ["session", "S1", wsA, wsA, "coding", "bash"]);
    assert.match(a.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual([a.grantedBy.actor, a.grantedBy.via, a.grantedBy.session, a.grantedBy.mode], ["operator", "card", "S1", "manual"]);
    assert.match(a.grantedBy.choice ?? "", /^Allow for this session/);
    assert.equal(a.action.command, PUSH);
    assert.equal(a.tier, "medium");
    assert.equal(fs.statSync(approvalsFile).mode & 0o777, 0o600, "the approvals file is private");
    // The card says how far the allow reaches.
    const card = v.seen[0];
    assert.ok(card, "the operator was shown a card");
    assert.match(card.title, /session allow: this session \+ workspace, 24h/);
    ok("a session allow is stored with schemaVersion, creation time, scope, grantor and a 24h expiry");
  }

  // 2. Scope: same session, but another workspace or working directory is asked again. ------------
  {
    const { pi } = await gate();
    const same = ui([], "S1");
    assert.equal(await bash(pi, PUSH, same.ctx), undefined, "an exact repeat in the same session, workspace and cwd runs");
    assert.equal(same.seen.length, 0);
    const otherWs = ui([undefined], "S1", wsB);
    assert.equal((await bash(pi, PUSH, otherWs.ctx))?.block, true);
    assert.equal(otherWs.seen.length, 1, "the same session in another workspace is asked");
    const otherCwd = ui([undefined], "S1", wsSub);
    assert.equal((await bash(pi, PUSH, otherCwd.ctx))?.block, true);
    assert.equal(otherCwd.seen.length, 1, "the same workspace but another working directory is asked");
    const otherSession = ui([undefined], "S2");
    assert.equal((await bash(pi, PUSH, otherSession.ctx))?.block, true);
    assert.equal(otherSession.seen.length, 1, "another session is asked");
    const similar = ui([undefined], "S1");
    assert.equal((await bash(pi, "git push origin feature/b", similar.ctx))?.block, true, "a different action is never covered");
    ok("session approvals are bound to the exact action, workspace, working directory and root session");
  }

  // 3. Learned exact actions are persistent, workspace-scoped, listed, and expire. ----------------
  config({ mode: "auto" });
  {
    const { pi, judged } = await gate(new Array<string>(30).fill('{"verdict":"block","confidence":"high","reason":"not in scope"}'));
    const SUDO = "sudo systemctl restart nginx";
    for (const session of ["L1", "L1", "L2"]) {
      const v = ui(["Allow once"], session);
      assert.equal(await bash(pi, SUDO, v.ctx), undefined);
    }
    const learnedEntry = readStore().approvals.find((x) => x.context === "persistent");
    assert.ok(learnedEntry, "the third approval stores the learned action right away");
    assert.deepEqual([learnedEntry.session, learnedEntry.workspace, learnedEntry.grantedBy.actor, learnedEntry.grantedBy.via, learnedEntry.tier], [null, wsA, "learned", "precedent", "high"]);
    assert.match(learnedEntry.grantedBy.detail ?? "", /3 approvals in 2 sessions/);
    assert.ok(Math.abs(Date.parse(learnedEntry.expiresAt ?? "") - Date.parse(learnedEntry.createdAt) - 30 * 86_400_000) < 60_000, "learned approvals expire after 30 days");
    const runs = ui([], "L3");
    assert.equal(await bash(pi, SUDO, runs.ctx), undefined, "learned: runs without asking in the workspace it was learned in");
    assert.equal(runs.seen.length, 0);
    const judgedBefore = judged.length;
    const elsewhere = ui([undefined], "L4", wsB);
    assert.equal((await bash(pi, SUDO, elsewhere.ctx))?.block, true);
    assert.equal(elsewhere.seen.length, 1, "an action learned in one workspace is asked in another");
    assert.equal(judged.length, judgedBefore, "approvals in another workspace do not make it judge-eligible either");
    // Manual mode never applies a learned allow.
    config({ mode: "manual" });
    const man = ui([undefined], "L5");
    assert.equal((await bash(pi, SUDO, man.ctx))?.block, true);
    assert.equal(man.seen.length, 1);
    config({ mode: "auto" });
    // Expired: the same entry, after its expiry, is no longer an allow.
    const store = readStore();
    for (const a of store.approvals) if (a.context === "persistent") a.expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(approvalsFile, JSON.stringify(store));
    // (the decision log still supports it, so the firewall re-learns it as a fresh entry: it is asked
    // only when the log no longer supports it. What matters here: the expired entry itself is not used.)
    const listing = ui([]);
    await cmd(pi, "firewall", "list", listing.ctx);
    assert.match(lastNote(listing), /1 expired approval\(s\) are ignored/);
    ok("learned exact actions are persistent, workspace-scoped, expiring and listed; manual mode ignores them");
  }

  // 4. Malformed, unknown-shape and unsupported files are ignored (never an allow) and reported. ----
  config({ mode: "manual" });
  {
    const { pi } = await gate();
    const seed = ui(["Allow for this session (exact repeats only)"], "M1");
    assert.equal(await bash(pi, PUSH, seed.ctx), undefined);
    const good = readStore();
    const goodEntry = good.approvals.find((a) => a.context === "session" && a.session === "M1");
    assert.ok(goodEntry, "the seeded session approval is stored");
    const variants = {
      "not JSON": "{ nope",
      "schemaVersion 2": JSON.stringify({ ...good, schemaVersion: 2 }),
      "approvals not an array": JSON.stringify({ ...good, approvals: {} }),
      "unknown field": JSON.stringify({ ...good, approvals: [{ ...goodEntry, condition: "only on Tuesdays" }] }),
      "wrong-typed hash": JSON.stringify({ ...good, approvals: [{ ...goodEntry, hash: 42 }] }),
      "unknown context": JSON.stringify({ ...good, approvals: [{ ...goodEntry, context: "forever" }] }),
      "session approval without a session": JSON.stringify({ ...good, approvals: [{ ...goodEntry, session: null }] }),
      "operator persistent approval": JSON.stringify({ ...good, approvals: [{ ...goodEntry, context: "persistent", session: null }] }),
      "null and partial elements": JSON.stringify({ ...good, approvals: [null, { hash: goodEntry.hash, families: [] }] }),
      "bad expiry": JSON.stringify({ ...good, approvals: [{ ...goodEntry, expiresAt: "someday" }] }),
      "pentest policy entry": JSON.stringify({ ...good, approvals: [{ ...goodEntry, policy: "pentest" }] }),
    };
    for (const [label, text] of Object.entries(variants)) {
      fs.writeFileSync(approvalsFile, text);
      const view = ui([undefined], "M1");
      const { stderr } = await captureStderr(async () => {
        const r = await bash(pi, PUSH, view.ctx);
        assert.equal(r?.block, true, `${label}: must not be treated as an allow`);
      });
      assert.equal(view.seen.length, 1, `${label}: the operator is asked`);
      assert.match(stderr, /tool-firewall: ignoring \d+ malformed item\(s\)/, `${label}: reported on stderr`);
      assert.ok(view.notes.some((n) => n.level === "warning" && /never treated as an allow/.test(n.message)), `${label}: warning shown`);
      const listing = ui([], "M1");
      await cmd(pi, "firewall", "list", listing.ctx);
      assert.match(lastNote(listing), /IGNORED \(malformed, never treated as an allow\)/, `${label}: /firewall list says so`);
    }
    assert.ok(auditLines().some((l) => l.event === "approvals_malformed"), "reported in the audit log");
    // Positive control: the unmodified entry works, so the variants above are not passing vacuously.
    fs.writeFileSync(approvalsFile, JSON.stringify(good));
    const control = ui([], "M1");
    assert.equal(await bash(pi, PUSH, control.ctx), undefined);
    assert.equal(control.seen.length, 0);
    // A rewrite of a rejected file keeps a copy for inspection.
    fs.writeFileSync(approvalsFile, "{ nope");
    const seed2 = ui(["Allow for this session (exact repeats only)"], "M2");
    await bash(pi, PUSH, seed2.ctx);
    assert.ok(fs.readdirSync(path.dirname(approvalsFile)).some((f) => f.startsWith("firewall-approvals.json.rejected-")), "a rejected file is kept, not silently overwritten");
    assert.equal(readStore().approvals.length, 1);
    ok("malformed / unknown-shape / unsupported approvals are ignored fail-closed and reported (stderr, notice, list, audit)");
  }

  // 5. /firewall list, revoke (one, session, workspace, all), invalid arguments. --------------------
  fs.rmSync(approvalsFile, { force: true });
  {
    const { pi } = await gate();
    const ans = "Allow for this session (exact repeats only)";
    const grants: Array<[string, string, string]> = [[PUSH, "R1", wsA], ["git push origin feature/c", "R1", wsA], [PUSH, "R2", wsA], [PUSH, "R1", wsB]];
    for (const [c, sess, cwd] of grants) assert.equal(await bash(pi, c, ui([ans], sess, cwd).ctx), undefined);
    const ids = readStore().approvals.map((a) => a.id);
    assert.equal(new Set(ids).size, 4);
    const view = ui([], "R1");
    await cmd(pi, "firewall", "list", view.ctx);
    const text = lastNote(view);
    for (const id of ids) assert.match(text, new RegExp(id));
    assert.match(text, /scope: session R1 · workspace .*wsA · this exact action, repeats only/);
    assert.match(text, /granted: operator via card \("Allow for this session/);
    assert.match(text, /expires 20\d\d-/);
    assert.match(text, /applies here/);
    assert.match(text, /not for this session\/workspace/);
    const before = fs.readFileSync(approvalsFile, "utf8");
    // Invalid arguments never mutate state.
    const stderrless = ui([], "R1");
    for (const bad of ["revoke", "revoke nosuch", "revoke apr_00000000", "revoke all extra", "revoke session apr_", "revoke host:", "revoke host:nobody", "list extra", "frobnicate", "revoke apr_"]) {
      await cmd(pi, "firewall", bad, stderrless.ctx);
      assert.equal(stderrless.notes.at(-1)?.level, "error", `"${bad}" is an error`);
      assert.equal(fs.readFileSync(approvalsFile, "utf8"), before, `"${bad}" changed nothing`);
    }
    // One approval: the very next call in the same session asks again; the others still run.
    const target = readStore().approvals.find((a) => a.session === "R1" && a.workspace === wsA && a.action.command === PUSH);
    assert.ok(target, "the R1 approval for PUSH in wsA is stored");
    await cmd(pi, "firewall", `revoke ${target.id}`, view.ctx);
    assert.match(lastNote(view), new RegExp(`revoked 1 approval\\(s\\): ${target.id} \\(session\\)`));
    assert.match(lastNote(view), /next tool call/);
    const asks = ui([undefined], "R1");
    assert.equal((await bash(pi, PUSH, asks.ctx))?.block, true);
    assert.equal(asks.seen.length, 1, "revocation applies to the next tool call in the same session");
    assert.equal(await bash(pi, "git push origin feature/c", ui([], "R1").ctx), undefined, "other approvals are untouched");
    // Session scope: only this root session's approvals.
    await cmd(pi, "firewall", "revoke session", view.ctx);
    assert.deepEqual(readStore().approvals.map((a) => a.session), ["R2"], "revoke session removes this root session's approvals in every workspace and nothing else");
    assert.equal((await bash(pi, "git push origin feature/c", ui([undefined], "R1").ctx))?.block, true);
    ok("/firewall list shows scope, grantor and expiry; revoke <id> and revoke session apply to the next call; invalid arguments change nothing");
  }

  // 6. revoke workspace / all; a revoked learned action restarts from zero. -------------------------
  fs.rmSync(approvalsFile, { force: true });
  config({ mode: "auto" });
  {
    const { pi, judged } = await gate(new Array<string>(40).fill('{"verdict":"block","confidence":"high","reason":"not in scope"}'));
    const SUDO = "sudo systemctl restart nginx";
    for (const session of ["V1", "V1", "V2"]) assert.equal(await bash(pi, SUDO, ui(["Allow once"], session).ctx), undefined);
    const learned = readStore().approvals.find((a) => a.context === "persistent");
    assert.ok(learned, "the third approval stores the learned action");
    assert.equal(await bash(pi, SUDO, ui([], "V3").ctx), undefined, "learned");
    // Revoking the learned entry withdraws it AND its learning: one more approval does not bring it back.
    const view = ui([], "V3");
    await cmd(pi, "firewall", `revoke ${learned.id}`, view.ctx);
    assert.match(lastNote(view), /reset learning of apr_/);
    const again = ui(["Allow once"], "V4");
    assert.equal(await bash(pi, SUDO, again.ctx), undefined);
    assert.equal(again.seen.length, 1, "a revoked learned action is asked again");
    // Judge eligibility (approvals of a kind make similar high actions reach the judge) is scoped too.
    const otherHigh = "sudo systemctl restart apache2";
    const judgedBefore = judged.length;
    assert.equal(await bash(pi, otherHigh, ui(["Allow once"], "V6").ctx), undefined);
    assert.equal(judged.length, judgedBefore + 1, "an approved kind reaches the judge (scope check), which here blocked and asked");
    const still = ui([undefined], "V5");
    assert.equal((await bash(pi, SUDO, still.ctx))?.block, true);
    assert.equal(still.seen.length, 1, "...and one fresh approval is not enough to re-learn a revoked action");
    const judgedBeforeRevoke = judged.length;
    await cmd(pi, "firewall", "revoke workspace", view.ctx);
    assert.match(lastNote(view), /reset everything learned in .*wsA/);
    const cold = ui([undefined], "V7");
    assert.equal((await bash(pi, "sudo systemctl restart mysql", cold.ctx))?.block, true);
    assert.equal(cold.seen.length, 1);
    assert.equal(judged.length, judgedBeforeRevoke, "after revoke workspace nothing is judge-eligible any more: straight to the operator");
    // revoke all clears session approvals everywhere and every learned floor.
    config({ mode: "manual" });
    for (const [sess, cwd] of [["A1", wsA], ["A2", wsB]]) assert.equal(await bash(pi, PUSH, ui(["Allow for this session"], sess, cwd).ctx), undefined);
    assert.equal(readStore().approvals.length >= 2, true);
    await cmd(pi, "firewall", "revoke all", view.ctx);
    assert.deepEqual(readStore().approvals, []);
    for (const [sess, cwd] of [["A1", wsA], ["A2", wsB]]) assert.equal((await bash(pi, PUSH, ui([undefined], sess, cwd).ctx))?.block, true);
    ok("revoke workspace/all clear approvals and what was learned; a revoked learned action must be re-earned");
  }

  // 7. After a /reload (a new instance, same session) approvals persist and are not widened. --------
  fs.rmSync(approvalsFile, { force: true });
  config({ mode: "manual" });
  {
    const first = await gate();
    assert.equal(await bash(first.pi, PUSH, ui(["Allow for this session"], "P1").ctx), undefined);
    const reloaded = await gate(); // pi /reload: the factory runs again, the session id is unchanged
    assert.equal(await bash(reloaded.pi, PUSH, ui([], "P1").ctx), undefined, "the approval survives a reload");
    const widened = ui([undefined], "P1");
    assert.equal((await bash(reloaded.pi, `${PUSH} --tags`, widened.ctx))?.block, true, "...but is not widened to a different command");
    assert.equal(widened.seen.length, 1);
    const fresh = ui([undefined], "P-new");
    assert.equal((await bash(reloaded.pi, PUSH, fresh.ctx))?.block, true, "a new session (/new) never inherits it");
    // Compaction (and a resumed session) keeps the same extension instance and session id: the in-memory state
    // is reset (session_start) and the request text changes, and the approval, being file-backed, still applies
    // to exactly the same action and nothing wider.
    await reloaded.pi.handlers.get("session_start")({}, { cwd: wsA, ui: { notify() {} }, sessionManager: { getSessionId: () => "P1" } });
    await reloaded.pi.handlers.get("before_agent_start")({ prompt: "Summary of the conversation so far: …" }, {});
    const afterCompaction = ui([undefined], "P1");
    assert.equal(await bash(reloaded.pi, PUSH, afterCompaction.ctx), undefined, "the approval survives compaction");
    assert.equal(afterCompaction.seen.length, 0);
    const notWider = ui([undefined], "P1");
    assert.equal((await bash(reloaded.pi, "git push origin feature/other", notWider.ctx))?.block, true, "and is not widened by it");
    // Revoked before the reload: still revoked after it.
    const view = ui([], "P1");
    await cmd(reloaded.pi, "firewall", "revoke session", view.ctx);
    const again = await gate();
    const asks = ui([undefined], "P1");
    assert.equal((await bash(again.pi, PUSH, asks.ctx))?.block, true);
    assert.equal(asks.seen.length, 1, "a revocation persists across a reload");
    ok("approvals persist across /reload, are never widened, and a revocation persists too");
  }

  // 8. Known hosts are inspectable and revocable; the ssh config is not trusted after the agent edits it.
  fs.rmSync(approvalsFile, { force: true });
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  const sshConfig = path.join(home, ".ssh", "config");
  fs.writeFileSync(sshConfig, "Host devbox\n  HostName 10.0.0.5\n");
  config({ mode: "auto", knownHosts: ["buildbox"] });
  {
    const { pi, judged } = await gate();
    const v = ui([], "H1");
    assert.equal(await bash(pi, "ssh buildbox uptime", v.ctx), undefined);
    assert.equal(await bash(pi, "ssh devbox uptime", v.ctx), undefined);
    assert.equal(judged.length + v.seen.length, 0, "read-only ssh to known hosts is routine in auto mode");
    await cmd(pi, "firewall", "list", v.ctx);
    assert.match(lastNote(v), /known hosts .*buildbox \[firewall\.json\]/);
    assert.match(lastNote(v), /devbox \[~\/\.ssh\/config\]/);
    // Revoke one from firewall.json and one that only ~/.ssh/config names.
    const before = fs.readFileSync(configFile, "utf8");
    await cmd(pi, "firewall", "revoke host:nobody", v.ctx);
    assert.equal(v.notes.at(-1)?.level, "error");
    assert.equal(fs.readFileSync(configFile, "utf8"), before, "an unknown host changes nothing");
    await cmd(pi, "firewall", "revoke host:buildbox host:devbox", v.ctx);
    assert.match(lastNote(v), /withdrew trust from host buildbox, host devbox \(still named in ~\/\.ssh\/config; the firewall no longer trusts it\)/);
    const cfg = parseJsonAs(HostsConfig, fs.readFileSync(configFile, "utf8"));
    assert.deepEqual([cfg.knownHosts, cfg.untrustedHosts], [[], ["buildbox", "devbox"]]);
    assert.equal(fs.readFileSync(sshConfig, "utf8"), "Host devbox\n  HostName 10.0.0.5\n", "the operator's ssh config is never edited");
    for (const host of ["buildbox", "devbox"]) {
      const n = judged.length;
      assert.equal(await bash(pi, `ssh ${host} uptime`, ui([], "H1").ctx), undefined, "the judge allowed it");
      assert.equal(judged.length, n + 1, `${host} is no longer trusted: the judge is consulted`);
    }
    await cmd(pi, "firewall", "list", v.ctx);
    assert.match(lastNote(v), /devbox \[REVOKED\]/);
    ok("known hosts are listed with their source; revoking withdraws trust without touching ~/.ssh/config");
  }
  config({ mode: "auto", knownHosts: [] });
  {
    const { pi, judged } = await gate();
    const v = ui([], "H2");
    assert.equal(await bash(pi, "ssh devbox uptime", v.ctx), undefined);
    assert.equal(judged.length, 0, "trusted while the ssh config is as it was at session start");
    // The agent edits ~/.ssh/config (an approved write): hosts it names stop being trusted.
    fs.writeFileSync(sshConfig, "Host devbox\n  HostName 10.0.0.5\nHost evil\n  HostName evil.example\n");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(sshConfig, future, future);
    const { stderr } = await captureStderr(async () => {
      const ctx = { ...v.ctx, hasUI: false };
      assert.equal(await bash(pi, "ssh evil uptime", ctx), undefined, "judged and allowed by the stub");
    });
    assert.equal(judged.length, 1, "a host added to the ssh config during the session is judged, not trusted");
    assert.match(stderr, /~\/\.ssh\/config changed during this session/);
    assert.equal(await bash(pi, "ssh devbox uptime", v.ctx), undefined);
    assert.equal(judged.length, 2, "the whole ssh-config trust is suspended until the operator reloads");
    await cmd(pi, "firewall", "reload", v.ctx);
    assert.equal(await bash(pi, "ssh devbox uptime", v.ctx), undefined);
    assert.equal(judged.length, 2, "/firewall reload is the operator's acknowledgement");
    ok("hosts named only in ~/.ssh/config lose trust when the agent changes that file, until /firewall reload");
  }

  // 9. Manual mode never applies the auto-mode trust shortcuts, and /firewall status says so. --------
  fs.writeFileSync(sshConfig, "Host devbox\n");
  config({ mode: "manual", knownHosts: ["buildbox"] });
  {
    const { pi, judged } = await gate();
    const v = ui([undefined, undefined], "T1");
    assert.equal((await bash(pi, "ssh buildbox 'uptime; sudo -n journalctl -n 5'", v.ctx))?.block, true);
    assert.equal(v.seen.length, 1, "manual: read-only ssh to a known host asks");
    assert.equal(judged.length, 0, "manual mode never calls the judge");
    await cmd(pi, "firewall", "status", v.ctx);
    const status = lastNote(v);
    assert.match(status, /mode=manual/);
    assert.match(status, /read-only ssh\/sudo -n on known hosts is NOT trusted in this mode/);
    assert.match(status, /runs without asking: low-tier actions/);
    assert.match(status, /HARD DENY .*UNCERTAIN .*OPERATOR DECISION/);
    assert.match(status, /approvals: 0 remembered/);
    config({ mode: "auto", knownHosts: ["buildbox"] });
    await cmd(pi, "firewall", "status", v.ctx);
    assert.match(lastNote(v), /also read-only ssh and sudo -n reads on known hosts/);
    ok("manual mode does not trust known-host reads; /firewall status states what runs without asking and the three outcomes");
  }

  // 10. Headless: /firewall prints to stderr instead of a silent no-op. ---------------------------
  {
    const { pi } = await gate();
    const headless = { cwd: wsA, hasUI: false, ui: { notify() { throw new Error("must not be used headless"); } }, sessionManager: { getSessionId: () => "HL" } };
    const { stderr } = await captureStderr(async () => {
      await cmd(pi, "firewall", "list", headless);
      await cmd(pi, "firewall", "status", headless);
      await cmd(pi, "firewall", "revoke nosuch", headless);
      await cmd(pi, "firewall", "revoke all", headless);
      await cmd(pi, "firewall:status", "", headless);
    });
    assert.match(stderr, /tool-firewall approvals \(/);
    assert.match(stderr, /tool-firewall: policy=coding/);
    assert.match(stderr, /no approval matches "nosuch"/);
    assert.match(stderr, /revoked 0 approval\(s\); reset everything learned/);
    assert.equal(stderr.match(/tool-firewall: policy=coding/g)?.length, 2, "the /firewall:status alias prints too");
    ok("non-interactive sessions get the /firewall output on stderr, not a silent no-op");
  }

  // 11. The approvals file is a control surface: the agent cannot plant an entry in it. ------------
  {
    const guard = fakePi();
    (await loadExtension("vendor/protected-paths/index.ts"))(guard.api);
    const secret = fakePi();
    (await loadExtension("extensions/secret-guard/index.ts"))(secret.api);
    const ctx = { cwd: wsA, hasUI: false, ui: {} };
    for (const target of [approvalsFile, path.join(root, "elsewhere", "approvals.json")]) {
      const restore = setEnv("PI_KIT_FIREWALL_APPROVALS", target);
      try {
        const w = await guard.handlers.get("tool_call")({ toolName: "write", input: { path: target, content: "{}" } }, ctx);
        assert.equal(w?.block, true, `protected-paths blocks a write to ${target}`);
        const g = await secret.handlers.get("tool_call")({ toolName: "write", input: { path: target, content: "{}" } }, ctx);
        assert.equal(g?.block, true, `secret-guard blocks a write to ${target}`);
        const { pi } = await gate();
        const cli = await bash(pi, `echo '{}' > '${target}'`, ui([undefined], "G1").ctx);
        assert.equal(cli?.block, true, "the firewall asks (high, security control) before a shell write");
      } finally {
        restore();
      }
    }
    ok("the approvals file is protected from agent writes (protected-paths, secret-guard, firewall path class)");
  }

  // 12. Writes always hold the file's lock, and never proceed without it. -----------------------------
  // The file is rewritten whole, so an unlocked write can lose a concurrent one. Losing an ADD only means being asked
  // again; losing a REVOKE would bring back an approval the operator withdrew, so a busy lock fails the write loudly.
  {
    const approvals = await loadModule<typeof ApprovalsModule>("extensions/tool-firewall/approvals.ts");
    const target = path.join(root, "locked", "firewall-approvals.json");
    const restore = setEnv("PI_KIT_FIREWALL_APPROVALS", target);
    const aged = (file: string) => { const t = new Date(Date.now() - 60_000); fs.utimesSync(file, t, t); };
    const stored = () => readApprovalsFile(target).approvals.map((a) => a.id).sort();
    const input = (hash: string): NewApproval => ({ context: "session", session: "S1", workspace: wsA, cwd: wsA, policy: "coding", tool: "bash", hash, families: ["git_send"], scopes: [], tier: "medium", grantedBy: { actor: "operator", via: "card", session: "S1", mode: "manual", policy: "coding" }, action: { command: "git push origin main", summary: "git push origin main", steps: [], reasons: [], chain: [] } });
    try {
      const kept = approvals.addApproval(input("a".repeat(64)));
      // (a) a stale lock (a crashed holder), and a dead break lock, are cleared and the write goes ahead
      fs.writeFileSync(`${target}.lock`, "999999\n"); aged(`${target}.lock`);
      fs.writeFileSync(`${target}.lock.break`, "999999\n"); aged(`${target}.lock.break`);
      const second = approvals.addApproval(input("b".repeat(64)));
      assert.equal(fs.existsSync(`${target}.lock`) || fs.existsSync(`${target}.lock.break`), false, "no lock is left behind");
      assert.deepEqual(stored(), [kept.id, second.id].sort());
      // (b) a lock held by a live process is waited for, then the write FAILS: nothing is written, and a revoke says so
      fs.writeFileSync(`${target}.lock`, "another-holder\n"); // fresh: a live holder
      const t0 = Date.now();
      assert.throws(() => approvals.addApproval(input("c".repeat(64))), /approvals file is busy/);
      fs.utimesSync(`${target}.lock`, new Date(), new Date()); // the holder is still alive: its lock is fresh again (a lock untouched for 10 s is stale)
      const revoked = approvals.revokeApprovals(["all"], { root: "S1", workspace: wsA });
      assert.ok(Date.now() - t0 >= 4_000, "it waited for the holder before giving up");
      assert.match(revoked.error ?? "", /could not withdraw approvals: the approvals file is busy/);
      assert.deepEqual(revoked.removed, [], "a revoke that could not take the lock reports that nothing changed");
      assert.deepEqual(stored(), [kept.id, second.id].sort(), "and the file is untouched");
      assert.equal(fs.readFileSync(`${target}.lock`, "utf8"), "another-holder\n", "the other holder's lock was not removed by our failed attempt");
      fs.unlinkSync(`${target}.lock`);
      // (c) once the lock is free the revoke goes through
      const done = approvals.revokeApprovals(["all"], { root: "S1", workspace: wsA });
      assert.equal(done.error, undefined);
      assert.equal(done.removed.length, 2);
      ok("approval writes always hold the lock: stale and dead break locks are cleared, a live holder is waited for then the write fails (an add is not remembered; a revoke says nothing changed), and a lock that is not ours is never removed");
    } finally {
      restore();
    }
  }

  console.log(`[firewall-approvals-smoke] all ${checks} checks passed`);
} finally {
  clearInterval(keepAlive);
  for (const r of restores.reverse()) r();
  rmWorkspace(root);
}
