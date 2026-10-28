// Remembered approvals: the one file that says what may run without asking again.
//
//   <agent dir>/pi-kit/firewall-approvals.json          (override: PI_KIT_FIREWALL_APPROVALS)
//   { "schemaVersion": 1, "updated": "…", "approvals": [ Approval… ], "floors": { … } }
//
// An approval is never broader than the choice the operator made:
//   - it is bound to ONE exact action (tool + action hash) in ONE workspace and working directory,
//     under the policy it was given in;
//   - "session" approvals are bound to the root session (shared with the subagents it spawns) and
//     expire after SESSION_APPROVAL_TTL_MS; "persistent" ones are actions the operator approved
//     repeatedly (learned exact actions) and expire after LEARNED_APPROVAL_TTL_MS;
//   - each records who or what granted it (operator via the card or the console, or the learning
//     rule), when, and why it is tiered as it is, so `/firewall list` can show it and
//     `/firewall revoke` can withdraw it.
// The file is untrusted input. A file of another schemaVersion, invalid JSON, or an entry of any
// unknown shape (wrong type, missing field, unknown key) is ignored, never treated as an allow, and
// reported. Revocation takes effect on the next tool call because decisions read this file each time.
//
// `floors` are revocation watermarks for the learning that is derived from the decision log
// (firewall-feedback.jsonl): approvals given before a floor no longer count towards a learned exact
// action or towards making a similar action eligible for the judge.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { kitStateDir } from "./config.ts";

export const APPROVALS_SCHEMA_VERSION = 1;
export const SESSION_APPROVAL_TTL_MS = 24 * 3_600_000;
export const LEARNED_APPROVAL_TTL_MS = 30 * 86_400_000;
const MAX_APPROVALS = 200;

export type ApprovalContext = "session" | "persistent";

export type GrantedBy = {
  actor: "operator" | "learned"; // a human choice, or the learning rule (repeated approvals)
  via: "card" | "console" | "precedent";
  session: string; // the session that asked (a subagent's id when the request came from one)
  mode: string;
  policy: string;
  choice?: string; // the menu entry the operator picked
  detail?: string; // e.g. "3 approvals in 2 sessions"
};

export type Approval = {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  context: ApprovalContext;
  session: string | null; // root session id for "session"; null for "persistent"
  workspace: string;
  cwd: string;
  policy: string;
  tool: string;
  hash: string; // exact action (tool + arguments)
  families: string[]; // what "similar" means for the judge (session approvals only)
  scopes: string[];
  tier: "medium" | "high";
  grantedBy: GrantedBy;
  action: { command: string; summary: string; steps: string[]; reasons: string[]; chain: string[] };
};

export type Floors = { all: string | null; workspaces: Record<string, string>; actions: Record<string, string> };

export type ApprovalsView = {
  file: string;
  approvals: Approval[]; // valid and not expired
  expired: number;
  problems: string[]; // everything that was ignored, and why
  floors: Floors;
};

export function approvalsPath(): string {
  return process.env.PI_KIT_FIREWALL_APPROVALS?.trim() || path.join(kitStateDir(), "firewall-approvals.json");
}

const emptyFloors = (): Floors => ({ all: null, workspaces: {}, actions: {} });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 4000): v is string => typeof v === "string" && v.length <= max;
const isStrArr = (v: unknown, maxItems = 40, max = 1500): v is string[] => Array.isArray(v) && v.length <= maxItems && v.every((x) => isStr(x, max));
const isTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isAbs = (v: unknown): v is string => isStr(v, 2048) && (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v));

const ENTRY_KEYS = new Set(["id", "createdAt", "expiresAt", "context", "session", "workspace", "cwd", "policy", "tool", "hash", "families", "scopes", "tier", "grantedBy", "action"]);
const GRANTED_KEYS = new Set(["actor", "via", "session", "mode", "policy", "choice", "detail"]);
const ACTION_KEYS = new Set(["command", "summary", "steps", "reasons", "chain"]);

function unknownKey(o: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const k of Object.keys(o)) if (!allowed.has(k)) return k;
  return null;
}

// Returns the approval, or the reason the entry is ignored.
export function validateApproval(raw: unknown): Approval | string {
  if (!isObj(raw)) return "not an object";
  const extra = unknownKey(raw, ENTRY_KEYS);
  if (extra) return `unknown field "${extra}"`;
  if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(raw.id)) return "bad id";
  if (!isTime(raw.createdAt)) return "bad createdAt";
  if (raw.expiresAt !== null && !isTime(raw.expiresAt)) return "bad expiresAt";
  if (raw.context !== "session" && raw.context !== "persistent") return `unknown context ${JSON.stringify(raw.context)}`;
  if (raw.context === "session" && !(isStr(raw.session, 300) && raw.session)) return "session approval without a session";
  if (raw.context === "persistent" && raw.session !== null) return "persistent approval with a session";
  if (!isAbs(raw.workspace)) return "bad workspace";
  if (!isAbs(raw.cwd)) return "bad cwd";
  if (raw.policy !== "coding") return `unsupported policy ${JSON.stringify(raw.policy)}`;
  if (!isStr(raw.tool, 200) || !raw.tool) return "bad tool";
  if (typeof raw.hash !== "string" || !/^[0-9a-f]{64}$/.test(raw.hash)) return "bad action hash";
  if (!isStrArr(raw.families) || !isStrArr(raw.scopes)) return "bad families/scopes";
  if (raw.tier !== "medium" && raw.tier !== "high") return `unsupported tier ${JSON.stringify(raw.tier)}`;
  const g = raw.grantedBy;
  if (!isObj(g)) return "grantedBy missing";
  const gExtra = unknownKey(g, GRANTED_KEYS);
  if (gExtra) return `unknown grantedBy field "${gExtra}"`;
  if (g.actor !== "operator" && g.actor !== "learned") return "bad grantedBy.actor";
  if (g.via !== "card" && g.via !== "console" && g.via !== "precedent") return "bad grantedBy.via";
  if (!isStr(g.session, 300) || !isStr(g.mode, 40) || !isStr(g.policy, 40)) return "bad grantedBy";
  if ((g.choice !== undefined && !isStr(g.choice, 300)) || (g.detail !== undefined && !isStr(g.detail, 400))) return "bad grantedBy";
  if (raw.context === "session" && g.actor !== "operator") return "a session approval must be given by the operator";
  if (raw.context === "persistent" && g.actor !== "learned") return "a persistent approval must come from the learning rule";
  const a = raw.action;
  if (!isObj(a)) return "action missing";
  const aExtra = unknownKey(a, ACTION_KEYS);
  if (aExtra) return `unknown action field "${aExtra}"`;
  if (!isStr(a.command, 4000) || !isStr(a.summary, 4000) || !isStrArr(a.steps, 12) || !isStrArr(a.reasons, 12) || !isStrArr(a.chain, 12)) return "bad action";
  // Every field is checked above; rebuild the entry from them (no other keys can exist).
  const grantedBy: GrantedBy = {
    actor: g.actor,
    via: g.via,
    session: g.session,
    mode: g.mode,
    policy: g.policy,
    ...(typeof g.choice === "string" ? { choice: g.choice } : {}),
    ...(typeof g.detail === "string" ? { detail: g.detail } : {}),
  };
  return {
    id: raw.id,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    context: raw.context,
    session: raw.context === "session" && typeof raw.session === "string" ? raw.session : null,
    workspace: raw.workspace,
    cwd: raw.cwd,
    policy: raw.policy,
    tool: raw.tool,
    hash: raw.hash,
    families: raw.families,
    scopes: raw.scopes,
    tier: raw.tier,
    grantedBy,
    action: { command: a.command, summary: a.summary, steps: a.steps, reasons: a.reasons, chain: a.chain },
  };
}

function readFloors(raw: unknown, problems: string[], now: number): Floors {
  if (raw === undefined) return emptyFloors();
  const bad = () => {
    problems.push("floors is malformed: learned and similar-action approvals are suspended until they are re-earned");
    const suspended: Floors = { all: new Date(now).toISOString(), workspaces: {}, actions: {} };
    return suspended;
  };
  if (!isObj(raw)) return bad();
  const all = raw.all === null || raw.all === undefined ? null : isTime(raw.all) ? raw.all : "bad";
  if (all === "bad") return bad();
  const rec = (v: unknown): Record<string, string> | null => {
    if (v === undefined) return {};
    if (!isObj(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, t] of Object.entries(v)) {
      if (!isTime(t)) return null;
      out[k] = t;
    }
    return out;
  };
  const workspaces = rec(raw.workspaces);
  const actions = rec(raw.actions);
  if (!workspaces || !actions) return bad();
  return { all, workspaces, actions };
}

export function readApprovals(now = Date.now()): ApprovalsView {
  const file = approvalsPath();
  const view: ApprovalsView = { file, approvals: [], expired: 0, problems: [], floors: emptyFloors() };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") view.problems.push(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return view;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    view.problems.push("not valid JSON: every approval in it is ignored");
    return view;
  }
  if (!isObj(raw) || raw.schemaVersion !== APPROVALS_SCHEMA_VERSION) {
    view.problems.push(`unsupported schemaVersion ${JSON.stringify(isObj(raw) ? raw.schemaVersion : undefined)} (this version reads ${APPROVALS_SCHEMA_VERSION}): every approval in it is ignored`);
    return view;
  }
  view.floors = readFloors(raw.floors, view.problems, now);
  if (!Array.isArray(raw.approvals)) {
    view.problems.push("approvals is not an array: ignored");
    return view;
  }
  const seen = new Set<string>();
  raw.approvals.forEach((entry, i) => {
    const v = validateApproval(entry);
    if (typeof v === "string") {
      view.problems.push(`approvals[${i}] ignored: ${v}`);
      return;
    }
    if (seen.has(v.id)) {
      view.problems.push(`approvals[${i}] ignored: duplicate id ${v.id}`);
      return;
    }
    seen.add(v.id);
    if (v.expiresAt !== null && Date.parse(v.expiresAt) <= now) {
      view.expired++;
      return;
    }
    view.approvals.push(v);
  });
  return view;
}

// Problems are reported once per distinct set, on stderr (visible headless) and by the caller.
const reported = new Set<string>();
export function reportProblems(view: ApprovalsView): string[] {
  if (!view.problems.length) return [];
  const key = `${view.file}|${view.problems.join("|")}`;
  if (!reported.has(key)) {
    reported.add(key);
    try {
      process.stderr.write(`tool-firewall: ignoring ${view.problems.length} malformed item(s) in ${view.file} (never treated as an allow): ${view.problems.slice(0, 4).join("; ")}${view.problems.length > 4 ? "; …" : ""}\n`);
    } catch {
      /* stderr unavailable */
    }
  }
  return view.problems;
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no Atomics.wait: spin nothing, retry immediately */
  }
}

// The approvals file is read, changed and rewritten whole, so two sessions writing at once would lose an entry:
// an add (harmless: the operator is asked again) or, worse, a REVOKE (an approval the operator withdrew would
// come back). So a write always holds this exclusive lock and never goes ahead without it: after the wait the
// write fails, an add is not remembered, and a revoke reports that nothing was changed. The lock carries this
// acquisition's token and is removed only if it still does, and a stale lock (a crashed holder) is broken under
// a second short-lived lock after looking at it again, so two waiters cannot both remove "the" stale lock and
// then both hold a fresh one.
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const LOCK_BREAK_STALE_MS = 3_000;

function breakStaleLock(lock: string): void {
  const breaker = `${lock}.break`;
  try {
    fs.closeSync(fs.openSync(breaker, "wx", 0o600));
  } catch {
    try {
      if (Date.now() - fs.statSync(breaker).mtimeMs > LOCK_BREAK_STALE_MS) fs.unlinkSync(breaker);
    } catch {
      /* raced */
    }
    return; // someone else is breaking it, or we cleared a dead breaker: look again
  }
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
  } catch {
    /* released meanwhile */
  } finally {
    try {
      fs.unlinkSync(breaker);
    } catch {
      /* gone */
    }
  }
}

function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const token = `${process.pid}:${crypto.randomUUID()}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          breakStaleLock(lock);
          continue;
        }
      } catch {
        continue; // released between the attempt and the stat
      }
      if (Date.now() > deadline) throw new Error("the approvals file is busy (another session holds its lock); nothing was written", { cause: error });
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lock, "utf8") === token) fs.unlinkSync(lock);
    } catch {
      /* gone */
    }
  }
}

function pruneFloors(f: Floors, now: number): Floors {
  const keep = (t: string) => now - Date.parse(t) < 2 * LEARNED_APPROVAL_TTL_MS;
  const rec = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, t]) => keep(t)));
  return { all: f.all && keep(f.all) ? f.all : null, workspaces: rec(f.workspaces), actions: rec(f.actions) };
}

function save(view: ApprovalsView, approvals: Approval[], floors: Floors, now: number): void {
  const file = view.file;
  // A file that had unreadable content is kept next to the new one so the operator can inspect it.
  if (view.problems.length) {
    try {
      const text = fs.readFileSync(file);
      const copy = `${file}.rejected-${crypto.createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
      fs.writeFileSync(copy, text, { mode: 0o600, flag: "wx" }); // "wx": created only if it is not there already, in one step
    } catch {
      /* best effort (including: the copy already exists) */
    }
  }
  const live = approvals.filter((a) => a.expiresAt === null || Date.parse(a.expiresAt) > now).slice(-MAX_APPROVALS);
  const body = { schemaVersion: APPROVALS_SCHEMA_VERSION, updated: new Date(now).toISOString(), approvals: live, floors: pruneFloors(floors, now) };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${now}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export type NewApproval = {
  context: ApprovalContext;
  session: string | null;
  workspace: string;
  cwd: string;
  policy: string;
  tool: string;
  hash: string;
  families: string[];
  scopes: string[];
  tier: "medium" | "high";
  grantedBy: GrantedBy;
  action: Approval["action"];
  ttlMs?: number | null;
};

// Adds (or refreshes) one approval. The same action in the same scope replaces its earlier entry.
export function addApproval(input: NewApproval, now = Date.now()): Approval {
  const ttl = input.ttlMs === undefined ? (input.context === "session" ? SESSION_APPROVAL_TTL_MS : LEARNED_APPROVAL_TTL_MS) : input.ttlMs;
  const entry: Approval = {
    id: `apr_${crypto.randomBytes(4).toString("hex")}`,
    createdAt: new Date(now).toISOString(),
    expiresAt: ttl === null ? null : new Date(now + ttl).toISOString(),
    context: input.context,
    session: input.session,
    workspace: input.workspace,
    cwd: input.cwd,
    policy: input.policy,
    tool: input.tool,
    hash: input.hash,
    families: input.families.slice(0, 40),
    scopes: input.scopes.slice(0, 40),
    tier: input.tier,
    grantedBy: input.grantedBy,
    action: input.action,
  };
  const checked = validateApproval(entry);
  if (typeof checked === "string") throw new Error(`refusing to store an approval of the wrong shape: ${checked}`);
  return withLock(approvalsPath(), () => {
    const view = readApprovals(now);
    const same = (a: Approval) => a.context === entry.context && a.session === entry.session && a.workspace === entry.workspace && a.cwd === entry.cwd && a.policy === entry.policy && a.tool === entry.tool && a.hash === entry.hash;
    save(view, [...view.approvals.filter((a) => !same(a)), entry], view.floors, now);
    return entry;
  });
}

export type RevokeResult = { removed: Approval[]; resetLearning: string[]; error?: string };

// Withdraws approvals. Selectors: an id (or a unique prefix of at least 6 characters), `session` (this
// root session's approvals), `workspace` (everything for this workspace, and what was learned there)
// or `all` (everything, and everything learned). One learned exact action restarts its learning from
// zero. Every selector is checked first: nothing is written when any of them matches nothing, is
// ambiguous, or is combined with another scope word.
export function revokeApprovals(selectors: string[], scope: { root: string; workspace: string }, now = Date.now()): RevokeResult {
  const sels = selectors.map((x) => x.trim()).filter(Boolean);
  const fail = (error: string): RevokeResult => ({ removed: [], resetLearning: [], error });
  if (!sels.length) return fail("nothing to revoke: give an approval id, session, workspace or all");
  const words = sels.filter((x) => x === "all" || x === "session" || x === "workspace");
  if (words.length && sels.length > 1) return fail(`"${words[0]}" cannot be combined with other targets`);
  try {
    return revokeLocked(sels, scope, now, fail);
  } catch (error) {
    return fail(`could not withdraw approvals: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function revokeLocked(sels: string[], scope: { root: string; workspace: string }, now: number, fail: (error: string) => RevokeResult): RevokeResult {
  return withLock(approvalsPath(), () => {
    const view = readApprovals(now);
    const floors: Floors = { all: view.floors.all, workspaces: { ...view.floors.workspaces }, actions: { ...view.floors.actions } };
    const stamp = new Date(now).toISOString();
    const drop = new Map<string, Approval>();
    const resetLearning: string[] = [];
    for (const sel of sels) {
      if (sel === "all") {
        for (const a of view.approvals) drop.set(a.id, a);
        floors.all = stamp;
        resetLearning.push("everything learned from earlier decisions");
      } else if (sel === "session") {
        for (const a of view.approvals) if (a.context === "session" && a.session === scope.root) drop.set(a.id, a);
      } else if (sel === "workspace") {
        for (const a of view.approvals) if (a.workspace === scope.workspace) drop.set(a.id, a);
        floors.workspaces[scope.workspace] = stamp;
        resetLearning.push(`everything learned in ${scope.workspace}`);
      } else {
        const hits = view.approvals.filter((a) => a.id === sel || (sel.length >= 6 && a.id.startsWith(sel)));
        const [hit] = hits;
        if (!hit) return fail(`no approval matches "${sel}" (see /firewall list)`);
        if (hits.length > 1) return fail(`"${sel}" matches ${hits.length} approvals (${hits.map((h) => h.id).join(", ")}): give the whole id`);
        drop.set(hit.id, hit);
        if (hit.grantedBy.actor === "learned") {
          floors.actions[`${hit.workspace}|${hit.hash}`] = stamp;
          resetLearning.push(`learning of ${hit.id}`);
        }
      }
    }
    if (drop.size || resetLearning.length) save(view, view.approvals.filter((a) => !drop.has(a.id)), floors, now);
    return { removed: [...drop.values()], resetLearning };
  });
}

// The newest revocation that applies to this workspace (and, for one action, that action).
export function floorFor(view: ApprovalsView, workspace: string, hash?: string): number {
  const times = [view.floors.all, view.floors.workspaces[workspace], hash ? view.floors.actions[`${workspace}|${hash}`] : null].filter((t): t is string => !!t).map(Date.parse);
  return times.length ? Math.max(...times) : 0;
}

export type Match = { root: string; workspace: string; cwd: string; policy: string; tool: string; hash: string };

// The approvals that cover exactly this action here: a session approval for this root, or a persistent
// (learned) one. The operator's own approvals come first.
export function findExact(view: ApprovalsView, m: Match): Approval | undefined {
  const hits = view.approvals.filter((a) => a.policy === m.policy && a.tool === m.tool && a.hash === m.hash && a.workspace === m.workspace && a.cwd === m.cwd && (a.context === "persistent" ? a.session === null : a.session === m.root));
  return hits.find((a) => a.grantedBy.actor === "operator") ?? hits[0];
}

// Session approvals of this root and workspace: what the judge weighs a similar action against.
export function sessionApprovals(view: ApprovalsView, m: { root: string; workspace: string; policy: string }): Approval[] {
  return view.approvals.filter((a) => a.context === "session" && a.session === m.root && a.workspace === m.workspace && a.policy === m.policy);
}

// Similar: shares a family, or runs in the same non-local scope (host or root).
export function similarApprovals(list: Approval[], families: string[], scopes: string[]): Approval[] {
  const fam = new Set(families);
  const sc = new Set(scopes.filter((x) => x !== "local"));
  return list.filter((a) => a.families.some((f) => fam.has(f)) || a.scopes.some((x) => sc.has(x)));
}

// One line of `/firewall list`.
export function describeScope(a: Approval): string {
  const where = a.context === "session" ? `session ${a.session}` : "any session";
  const covers = a.context === "session" ? "this exact action, repeats only (similar actions go to the judge)" : "this exact action only";
  return `${where} · workspace ${a.workspace}${a.cwd !== a.workspace ? ` · cwd ${a.cwd}` : ""} · ${covers}`;
}
