// Per-session trajectory: what earlier allowed actions did, so a harmless-looking step can be
// judged in context (a secret read followed by a network send; a download that is later run).
// Persisted per session id so it survives reloads and compaction.
import fs from "node:fs";
import path from "node:path";
import { sessionsDir } from "./config.ts";
import { TIER_RANK, type Assessment, type Effect, type Finding, type Tier } from "./classify.ts";

export type Recent = { at: number; tool: string; summary: string; tier: Tier; effects: Effect[]; outcome: string; decider: string };

export type SessionState = {
  id: string;
  securityBinding?: string;
  credentialReads: { what: string; at: number }[];
  downloads: string[];
  untrusted: boolean;
  recent: Recent[];
  deletes: number[];
  judgeCache: Record<string, { verdict: "allow" | "block"; reason: string; differs?: string; confidence?: "high" | "medium" | "low"; turn: string }>;
  stats: { actions: number; human: number; judged: number; judgeBlocks: number; learnedHits: number; grantHits: number; denied: number };
  updated: number;
};

const MAX_RECENT = 40;
const DELETE_WINDOW_MS = 120_000;
const DELETE_BURST = 5;

function fileFor(id: string): string {
  return path.join(sessionsDir(), `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function newSession(id: string): SessionState {
  return { id, credentialReads: [], downloads: [], untrusted: false, recent: [], deletes: [], judgeCache: {}, stats: { actions: 0, human: 0, judged: 0, judgeBlocks: 0, learnedHits: 0, grantHits: 0, denied: 0 }, updated: Date.now() };
}

// A persisted session file is untrusted input: a field is kept only when it has the shape
// newSession() produces, otherwise the fresh default is used. Spreading the parsed object
// unchanged let a wrong-typed field ({"downloads":null}, {"recent":null}, …) reach
// trajectoryFindings/recordAction and throw inside the shipped tool_call gate on every call.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// A recent entry must carry the fields the /auto explain renderer and the judge prompt read.
// A persisted element like `{}` otherwise survives loadSession and the renderer throws on
// r.outcome.padEnd. recordAction always writes every one of these as a string, so valid rows
// are unaffected.
function isRecent(v: unknown): v is Recent {
  return (
    isPlainObject(v) &&
    typeof v.outcome === "string" &&
    typeof v.tier === "string" &&
    typeof v.decider === "string" &&
    typeof v.tool === "string" &&
    typeof v.summary === "string"
  );
}

type Stats = SessionState["stats"];
type CachedVerdict = SessionState["judgeCache"][string];
const STAT_KEYS = ["actions", "human", "judged", "judgeBlocks", "learnedHits", "grantHits", "denied"] as const satisfies readonly (keyof Stats)[];

function isCredentialRead(v: unknown): v is SessionState["credentialReads"][number] {
  return isPlainObject(v) && typeof v.what === "string" && typeof v.at === "number";
}

// A judgeCache entry is replayed as the judge's verdict, so it must have the shape the judge returns.
function isCachedVerdict(v: unknown): v is CachedVerdict {
  return (
    isPlainObject(v) &&
    (v.verdict === "allow" || v.verdict === "block") &&
    typeof v.reason === "string" &&
    typeof v.turn === "string" &&
    (v.differs === undefined || typeof v.differs === "string") &&
    (v.confidence === undefined || v.confidence === "high" || v.confidence === "medium" || v.confidence === "low")
  );
}

export function loadSession(id: string): SessionState {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(fileFor(id), "utf8"));
  } catch {
    return newSession(id);
  }
  const base = newSession(id);
  if (!isPlainObject(raw)) {
    process.stderr.write(`tool-firewall: ignoring wrong-shape session file ${fileFor(id)}: expected a JSON object\n`);
    return base;
  }
  const rejected: string[] = [];
  const pick = <T>(key: keyof SessionState, valid: (v: unknown) => v is T, fallback: T): T => {
    const v = raw[key];
    if (valid(v)) return v;
    if (v !== undefined) rejected.push(key);
    return fallback;
  };
  // Each counter is kept only when it is a number: `stats.actions++` on a string would concatenate.
  const stats: Stats = { ...base.stats };
  const statsRaw = raw.stats;
  if (statsRaw !== undefined && !isPlainObject(statsRaw)) rejected.push("stats");
  if (isPlainObject(statsRaw)) {
    for (const key of STAT_KEYS) {
      const v = statsRaw[key];
      if (typeof v === "number") stats[key] = v;
      else if (v !== undefined) rejected.push("stats");
    }
  }
  // Drop only the malformed judgeCache entries, as for recent: a valid cached verdict still counts.
  let judgeCache = base.judgeCache;
  if (raw.judgeCache !== undefined) {
    if (isPlainObject(raw.judgeCache)) {
      const entries = Object.entries(raw.judgeCache);
      const kept = entries.filter((e): e is [string, CachedVerdict] => isCachedVerdict(e[1]));
      judgeCache = Object.fromEntries(kept);
      if (kept.length !== entries.length) rejected.push("judgeCache");
    } else {
      rejected.push("judgeCache");
    }
  }
  // recent is an array of rows the /auto explain renderer and judge prompt read field-by-field:
  // drop only the elements missing the renderer's fields rather than the whole array, so a
  // single persisted `{}` cannot crash r.outcome.padEnd while valid rows still render.
  let recent = base.recent;
  if (raw.recent !== undefined) {
    if (Array.isArray(raw.recent)) {
      recent = raw.recent.filter(isRecent);
      if (recent.length !== raw.recent.length) rejected.push("recent");
    } else {
      rejected.push("recent");
    }
  }
  // credentialReads feeds the cross-action secret_egress finding, so drop only the malformed rows:
  // one bad row must not erase the valid reads and let a later network send go unflagged.
  let credentialReads = base.credentialReads;
  if (raw.credentialReads !== undefined) {
    if (Array.isArray(raw.credentialReads)) {
      credentialReads = raw.credentialReads.filter(isCredentialRead);
      if (credentialReads.length !== raw.credentialReads.length) rejected.push("credentialReads");
    } else {
      rejected.push("credentialReads");
    }
  }
  const session: SessionState = {
    id,
    ...(typeof raw.securityBinding === "string" ? { securityBinding: raw.securityBinding } : {}),
    credentialReads,
    downloads: pick("downloads", (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string"), base.downloads),
    untrusted: pick("untrusted", (v): v is boolean => typeof v === "boolean", base.untrusted),
    recent,
    deletes: pick("deletes", (v): v is number[] => Array.isArray(v) && v.every((x) => typeof x === "number"), base.deletes),
    judgeCache,
    stats,
    updated: pick("updated", (v): v is number => typeof v === "number", base.updated),
  };
  if (rejected.length) process.stderr.write(`tool-firewall: ignoring malformed session fields in ${fileFor(id)}: ${[...new Set(rejected)].slice(0, 8).join(", ")}\n`);
  return session;
}

let lastPrune = 0;
export function saveSession(s: SessionState): void {
  try {
    s.updated = Date.now();
    const file = fileFor(s.id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, file);
    if (Date.now() - lastPrune > 3_600_000) {
      lastPrune = Date.now();
      const dir = path.dirname(file);
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try {
          if (Date.now() - fs.statSync(p).mtimeMs > 14 * 86_400_000) fs.unlinkSync(p);
        } catch {
          /* raced */
        }
      }
    }
  } catch {
    /* trajectory persistence is best effort; the in-memory copy still applies */
  }
}

// Extra findings from the session's history. Returned separately so the card can show them as
// the chain that raised the tier.
export function trajectoryFindings(a: Assessment, s: SessionState, now = Date.now()): Finding[] {
  const out: Finding[] = [];
  const remoteSends = a.sends.filter((x) => !x.local);
  // Same-command secret + send is already critical in the classifier; this is the cross-action chain.
  const [send] = remoteSends;
  const last = s.credentialReads.at(-1);
  if (send && !a.credentialReads.length && last) {
    out.push({ tier: "high", effect: "network_send", code: "secret_egress", detail: `sends data to ${send.dest} after this session read ${last.what}`, key: `egress ${send.dest}` });
  }
  const ran = [...a.executes, ...a.chmodExec];
  const fetched = [...s.downloads, ...a.downloads];
  const hit = ran.find((p) => fetched.includes(p));
  if (hit) out.push({ tier: "high", effect: "obfuscated_exec", code: "download_exec", detail: `runs or makes executable ${hit}, which was downloaded`, key: `download-exec` });
  if (a.deletes > 0 && a.findings.some((f) => f.effect === "delete" && TIER_RANK[f.tier] >= 1)) {
    const recent = s.deletes.filter((t) => now - t < DELETE_WINDOW_MS);
    if (recent.length >= DELETE_BURST) out.push({ tier: "high", effect: "delete", code: "delete_burst", detail: `${recent.length} deletions in the last ${DELETE_WINDOW_MS / 60000} minutes`, key: "delete-burst" });
  }
  return out;
}

export function recordAction(s: SessionState, a: Assessment, tier: Tier, outcome: string, decider: string, now = Date.now()): void {
  s.stats.actions++;
  s.recent.push({ at: now, tool: a.tool, summary: (a.command ?? a.summary).replace(/\s+/g, " ").slice(0, 200), tier, effects: a.effects, outcome, decider });
  if (s.recent.length > MAX_RECENT) s.recent.splice(0, s.recent.length - MAX_RECENT);
  if (outcome !== "allow") return;
  for (const w of a.credentialReads) s.credentialReads.push({ what: w, at: now });
  if (s.credentialReads.length > 20) s.credentialReads.splice(0, s.credentialReads.length - 20);
  for (const d of a.downloads) if (!s.downloads.includes(d)) s.downloads.push(d);
  if (s.downloads.length > 50) s.downloads.splice(0, s.downloads.length - 50);
  if (a.untrusted) s.untrusted = true;
  if (a.findings.some((f) => f.effect === "delete" && TIER_RANK[f.tier] >= 1)) s.deletes.push(now);
  s.deletes = s.deletes.filter((t) => now - t < DELETE_WINDOW_MS);
}

// Session approvals belong to the operator's root session and are shared with every agent it
// spawns: a root exports PI_KIT_FIREWALL_ROOT_SESSION, kit children (PI_KIT_INTERNAL_CHILD=1)
// inherit it, and "allow for this session" given on a subagent's request (via the human
// console) informs its siblings and the parent too. Any other process is its own root and follows its
// current session, so a /new never keeps the previous session's approvals.
export const ROOT_SESSION_ENV = "PI_KIT_FIREWALL_ROOT_SESSION";

export function rootSessionId(own: string): string {
  const inherited = process.env[ROOT_SESSION_ENV]?.trim();
  if (inherited && process.env.PI_KIT_INTERNAL_CHILD === "1") return inherited;
  process.env[ROOT_SESSION_ENV] = own;
  return own;
}

// What the judge sees of a session approval (approvals.ts holds the stored form): the full action
// the operator allowed with "allow for this session". An exact repeat runs; a similar action (same
// host or privilege scope, or a shared family) goes to the judge, which reasons over the grant's
// steps, severity and chain and explains any mismatch.
export type SessionGrant = {
  at: number;
  session: string;
  tool: string;
  hash: string;
  tier: string;
  command: string; // redacted, bounded
  steps: string[];
  reasons: string[];
  chain: string[];
  families: string[];
  scopes: string[];
};
