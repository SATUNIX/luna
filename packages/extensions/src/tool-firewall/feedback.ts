// Operator decisions as calibrated precedents.
//
// Every human decision on an approval card is appended to firewall-feedback.jsonl. Learning is
// per action family (see familyOf in classify.ts): a family becomes a learned allow only after
// repeated, consistent approval: at least 3 approvals in at least 2 sessions within 30 days,
// with no denial since. One denial suspends it until it is
// re-earned. Critical actions and safety-control / destructive-system / obfuscated effects are
// never learned. Precedents also go to the auto-mode judge as examples.
import fs from "node:fs";
import path from "node:path";
import { feedbackPath, isRecord } from "./config.ts";
import type { Assessment, Tier } from "./classify.ts";
import { redactSecrets } from "./shared/redact.ts";

export type FeedbackRecord = {
  ts: string;
  sig: string;
  decision: "allow" | "deny";
  tier: Tier;
  tool: string;
  summary: string;
  project: string;
  session: string;
  source: "card" | "lease" | "grant" | "broker";
  note?: string;
  // Context for the judge and the background profile (newer records only).
  hash?: string;
  choice?: string;
  steps?: string[];
  chain?: string[];
  judge?: { verdict: "allow" | "block"; reason: string }; // the judge's view when it ran first
};

export const LEARN_MIN_APPROVALS = 3;
export const LEARN_MIN_SESSIONS = 2;
export const LEARN_WINDOW_MS = 30 * 86_400_000;
const NEVER_LEARN_EFFECTS = new Set(["security_control", "destructive_system", "obfuscated_exec"]);
const NEVER_LEARN_CODES = new Set(["secret_egress", "secret_upload", "shell_over_network", "unguarded_agent", "safety_env_override"]);

// Secrets must not land in the feedback log, the audit log or the judge's records: the kit's
// canonical table (./shared/redact.ts; tests/firewall-gate-smoke.ts, tests/redaction-corpus-smoke.ts).
export function redact(text: string): string {
  return redactSecrets(text).text;
}

export function learnable(a: Assessment, tier: Tier): boolean {
  if (tier === "critical" || tier === "low") return false;
  return !a.findings.some((f) => f.tier !== "low" && (NEVER_LEARN_EFFECTS.has(f.effect) || NEVER_LEARN_CODES.has(f.code) || f.tier === "critical"));
}

// A log line is kept when it has a string sig and a known decision; nothing else is checked. That is
// deliberate: the other fields are read defensively (a record with no project or a malformed ts never
// counts as an approval, and a malformed denial still suspends its family), so dropping such lines
// would only ever make learning more permissive.
function isFeedbackLine(r: unknown): r is FeedbackRecord {
  return isRecord(r) && typeof r.sig === "string" && (r.decision === "allow" || r.decision === "deny");
}

let cache: { mtime: number; size: number; records: FeedbackRecord[] } | null = null;

export function readFeedback(): FeedbackRecord[] {
  const file = feedbackPath();
  // One open file: the stat that keys the cache and the text that is parsed describe the same file.
  let st: fs.Stats;
  let text: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      st = fs.fstatSync(fd);
      if (cache?.mtime === st.mtimeMs && cache.size === st.size) return cache.records;
      text = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const records: FeedbackRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r: unknown = JSON.parse(line);
      if (isFeedbackLine(r)) records.push(r);
    } catch {
      /* skip a torn line */
    }
  }
  cache = { mtime: st.mtimeMs, size: st.size, records };
  return records;
}

export function appendFeedback(rec: Omit<FeedbackRecord, "ts"> & { ts?: string }): void {
  const file = feedbackPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const full: FeedbackRecord = {
    ts: rec.ts ?? new Date().toISOString(),
    ...rec,
    summary: redact(rec.summary).slice(0, 400),
    ...(rec.note ? { note: redact(rec.note).slice(0, 400) } : {}),
    ...(rec.steps ? { steps: rec.steps.slice(0, 6).map((x) => redact(x).slice(0, 160)) } : {}),
    ...(rec.chain ? { chain: rec.chain.slice(0, 3).map((x) => redact(x).slice(0, 200)) } : {}),
    ...(rec.judge ? { judge: { verdict: rec.judge.verdict, reason: redact(rec.judge.reason).slice(0, 240) } } : {}),
  };
  // One bounded line per append (< 4 KiB): O_APPEND keeps concurrent sessions from interleaving.
  fs.appendFileSync(file, `${JSON.stringify(full)}\n`, { mode: 0o600 }); // private on create
}

// Learning is scoped. An approval given in one workspace says nothing about another, and a
// revocation floor (approvals.ts `floorFor`) cuts off every decision made before it. Callers pass
// the scoped records to exactStatus / statusFor / operatorApproved / listLearned / precedentsFor.
// A record with no (or a malformed) project or timestamp never counts: fail closed.
export function scopeRecords(records: FeedbackRecord[], scope: { workspace?: string; since?: number }): FeedbackRecord[] {
  return records.filter((r) => (scope.workspace === undefined || r.project === scope.workspace) && (!scope.since || Date.parse(r.ts) > scope.since));
}

export type LearnedStatus = { sig: string; approvals: number; sessions: number; denials: number; last: string; status: "learned" | "learning" | "suspended" | "expired" };

const familiesIn = (sig: string): string[] => {
  const i = sig.indexOf("|");
  return i < 0 ? [] : sig.slice(i + 1).split(";").filter(Boolean);
};
const toolOf = (sig: string): string => sig.slice(0, Math.max(0, sig.indexOf("|")));

// One family ("srv02 as root:write_outside") across every decision that involved it. A denial
// of any action containing the family suspends it: conservative when a denied action mixed
// several kinds, but the operator re-earns it with a few approvals.
export function familyStatus(tool: string, family: string, now = Date.now(), records = readFeedback()): LearnedStatus {
  const mine = records.filter((r) => r.tool === tool && familiesIn(r.sig).includes(family));
  return tally(`${tool}|${family}`, mine, now);
}

function tally(sig: string, mine: FeedbackRecord[], now: number): LearnedStatus {
  const lastDeny = mine.reduce((t, r) => (r.decision === "deny" ? Math.max(t, Date.parse(r.ts)) : t), 0);
  const approvals = mine.filter((r) => r.decision === "allow" && Date.parse(r.ts) > lastDeny && now - Date.parse(r.ts) < LEARN_WINDOW_MS);
  const sessions = new Set(approvals.map((r) => r.session)).size;
  const denials = mine.filter((r) => r.decision === "deny").length;
  const last = mine.at(-1)?.ts ?? "";
  let status: LearnedStatus["status"];
  if (approvals.length >= LEARN_MIN_APPROVALS && sessions >= LEARN_MIN_SESSIONS) status = "learned";
  else if (lastDeny && mine[mine.length - 1]?.decision === "deny") status = "suspended";
  else if (!approvals.length && mine.some((r) => r.decision === "allow")) status = "expired";
  else status = "learning";
  return { sig, approvals: approvals.length, sessions, denials, last, status };
}

// An action is as trusted as its least-trusted family: learned only when every family is
// learned, suspended when any is, and its counts are the weakest family's.
export function statusFor(sig: string, now = Date.now(), records = readFeedback()): LearnedStatus {
  const fams = familiesIn(sig);
  if (!fams.length) return tally(sig, records.filter((r) => r.sig === sig), now);
  const each = fams.map((f) => familyStatus(toolOf(sig), f, now, records));
  const rank = { suspended: 0, expired: 1, learning: 2, learned: 3 } as const;
  const weakest = each.reduce((w, x) => (rank[x.status] < rank[w.status] || (rank[x.status] === rank[w.status] && x.approvals < w.approvals) ? x : w));
  return { sig, approvals: Math.min(...each.map((x) => x.approvals)), sessions: Math.min(...each.map((x) => x.sessions)), denials: each.reduce((n, x) => n + x.denials, 0), last: each.map((x) => x.last).sort().at(-1) ?? "", status: weakest.status };
}

// The exact same action (same action hash) approved repeatedly across sessions with no denial:
// the only thing that is allowed without the judge once learned.
export function exactStatus(hash: string, now = Date.now(), records = readFeedback()): LearnedStatus {
  return tally(`#${hash.slice(0, 12)}`, records.filter((r) => r.hash === hash), now);
}

// Every family has at least one operator approval in the window and no denial since: the
// operator has already said yes to this kind of action, so the judge may weigh scope.
export function operatorApproved(sig: string, now = Date.now(), records = readFeedback()): boolean {
  const fams = familiesIn(sig);
  return fams.length > 0 && fams.every((f) => familyStatus(toolOf(sig), f, now, records).approvals > 0);
}

export function listLearned(now = Date.now(), records = readFeedback()): LearnedStatus[] {
  const pairs = new Map<string, [string, string]>();
  for (const r of records) for (const f of familiesIn(r.sig)) pairs.set(`${r.tool}|${f}`, [r.tool, f]);
  return [...pairs.values()].map(([t, f]) => familyStatus(t, f, now, records)).sort((a, b) => (a.last < b.last ? 1 : -1));
}

// Removes decisions whose signature, or one of whose families, matches (a trailing * matches a
// prefix). `/auto learned` lists families as "tool|family".
export function forget(match: string): number {
  const file = feedbackPath();
  const records = readFeedback();
  const prefix = match.endsWith("*") ? match.slice(0, -1) : null;
  const hit = (v: string) => (prefix !== null ? v.startsWith(prefix) : v === match);
  const keep = records.filter((r) => !hit(r.sig) && !familiesIn(r.sig).some((f) => hit(`${r.tool}|${f}`) || hit(f)));
  const removed = records.length - keep.length;
  if (!removed) return 0;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = null;
  return removed;
}

// The most similar past decisions: same signature first, then shared signature keys. The gate
// passes the scoped records (scopeRecords), so the judge never sees another workspace's decisions
// or ones made before a revocation.
export function precedentsFor(sig: string, records: FeedbackRecord[] = readFeedback(), limit = 5): FeedbackRecord[] {
  const keys = new Set(sig.split("|")[1]?.split(";").filter(Boolean) ?? []);
  const tool = sig.split("|")[0];
  const scored = records
    .map((r, i) => {
      const rk = r.sig.split("|")[1]?.split(";").filter(Boolean) ?? [];
      const shared = rk.filter((k) => keys.has(k)).length;
      const score = (r.sig === sig ? 100 : 0) + shared * 10 + (r.tool === tool ? 1 : 0) + i / 1e6;
      return { r, score, shared };
    })
    .filter((x) => x.score >= 10)
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: FeedbackRecord[] = [];
  for (const { r } of scored) {
    const k = `${r.sig}|${r.decision}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}
