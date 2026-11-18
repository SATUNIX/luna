// Operator delegation (board item F-02): the operator lets the attended session run named day-to-day verbs
// of one wrapper program without a prompt, for a limited time. Everything else still needs the operator.
//
// The entry lives in the operator's firewall.json (machine-local, like knownHosts; never the shipped policy):
//   "delegations": [{ "operator": "alex", "path": "/opt/ops/bin/runctl", "verbs": ["status", "pause"],
//                     "expires": "2027-01-31" }]
// It is read strictly. A field of the wrong shape, an unknown key, a verb outside DELEGABLE_VERBS, any verb in
// NEVER_DELEGABLE, a path that is not its own realpath, a file another user owns or can write, and an expiry
// in the past or more than MAX_DELEGATION_DAYS ahead drop that entry with a warning; nothing else changes.
// A command is delegated only when it is exactly one simple command (no pipe, list, redirect, assignment,
// substitution, wrapper or background) whose program resolves to the entry's path and whose first argument
// is one of its verbs; the caller also requires every other finding to be low.
import fs from "node:fs";
import path from "node:path";
import { configPath, isRecord, stringList } from "./config.ts";
import { parseShell } from "./shared/shell.ts";

/** The verbs an operator may delegate: reading a run and its day-to-day control. */
export const DELEGABLE_VERBS: ReadonlySet<string> = new Set(["status", "pause", "resume", "restart", "steer", "backlog", "board-push", "answer", "raise-budget", "units", "tick", "metrics"]);
/** Verbs that authorise, create, end or reconfigure a run: never delegated, even if an entry names them. */
export const NEVER_DELEGABLE: ReadonlySet<string> = new Set(["start", "supervise", "plan", "promote", "cancel", "reconfigure", "init", "recreate", "decide", "add-stream", "remove-stream", "start-streams"]);
export const MAX_DELEGATION_DAYS = 90;

export type Delegation = { operator: string; path: string; verbs: string[]; expires: string };
// `paths`: every configured delegate path (and its real path), valid or not, so the boundary protects a delegate
// while its entry is dropped (expired, linked, missing): it cannot be replaced and then trusted again.
export type DelegationView = { entries: Delegation[]; warnings: string[]; paths: string[] };
export type DelegatedCall = { entry: Delegation; verb: string };

const ENTRY_KEYS: ReadonlySet<string> = new Set(["operator", "path", "verbs", "expires"]);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Why the delegate program cannot be trusted as configured, or null. Re-checked when a call is matched. */
export function delegateFileProblem(file: string): string | null {
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(file);
    stat = fs.statSync(real);
  } catch {
    return "does not exist";
  }
  if (real !== file) return `is not its own real path (it resolves to ${real}); name the program itself`;
  if (!stat.isFile()) return "is not a regular file";
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && stat.uid !== uid && stat.uid !== 0) return "is owned by another user";
  if ((stat.mode & 0o022) !== 0) return "is writable by its group or by everyone";
  return null;
}

function parseEntry(raw: unknown, index: number, now: number): { entry: Delegation } | { warning: string } {
  const where = `firewall.json delegations[${index}]`;
  if (!isRecord(raw)) return { warning: `${where} is not an object` };
  const extra = Object.keys(raw).filter((k) => !ENTRY_KEYS.has(k));
  if (extra.length) return { warning: `${where} has unknown key(s) ${extra.join(", ")}` };
  const { operator, path: file, verbs, expires } = raw;
  if (typeof operator !== "string" || !/^[\w .@-]{1,64}$/.test(operator.trim())) return { warning: `${where}.operator must name the operator (1-64 letters, digits, spaces, . @ _ -)` };
  if (typeof file !== "string" || !path.isAbsolute(file)) return { warning: `${where}.path must be an absolute path` };
  const problem = delegateFileProblem(file);
  if (problem) return { warning: `${where}.path ${file} ${problem}` };
  if (!Array.isArray(verbs) || verbs.length === 0 || stringList(verbs).length !== verbs.length) return { warning: `${where}.verbs must be a non-empty list of verbs` };
  const named = stringList(verbs);
  const never = named.filter((v) => NEVER_DELEGABLE.has(v));
  if (never.length) return { warning: `${where} names verb(s) that are never delegated: ${never.join(", ")}` };
  const unknown = named.filter((v) => !DELEGABLE_VERBS.has(v));
  if (unknown.length) return { warning: `${where} names verb(s) outside the delegable set: ${unknown.join(", ")}` };
  const at = typeof expires === "string" ? Date.parse(expires) : Number.NaN;
  if (!Number.isFinite(at)) return { warning: `${where}.expires must be a date` };
  if (at <= now) return { warning: `${where} expired on ${String(expires)}` };
  if (at > now + MAX_DELEGATION_DAYS * DAY_MS) return { warning: `${where}.expires is more than ${MAX_DELEGATION_DAYS} days ahead; review it sooner` };
  return { entry: { operator: operator.trim(), path: file, verbs: [...new Set(named)], expires: String(expires) } };
}

/** The live delegations in firewall.json and why any were dropped. A missing or unreadable file has none. */
export function readDelegations(now = Date.now()): DelegationView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return { entries: [], warnings: [], paths: [] };
  }
  if (!isRecord(parsed) || parsed.delegations === undefined) return { entries: [], warnings: [], paths: [] };
  if (!Array.isArray(parsed.delegations)) return { entries: [], warnings: ["firewall.json delegations must be a list; no delegation applies"], paths: [] };
  const view: DelegationView = { entries: [], warnings: [], paths: [] };
  for (const raw of parsed.delegations) {
    const file = isRecord(raw) ? raw.path : undefined;
    if (typeof file !== "string" || !path.isAbsolute(file)) continue;
    view.paths.push(path.normalize(file));
    try { view.paths.push(fs.realpathSync(file)); } catch { /* not there now: the configured path is still protected */ }
  }
  parsed.delegations.forEach((raw, i) => {
    const r = parseEntry(raw, i, now);
    if ("entry" in r) view.entries.push(r.entry);
    else view.warnings.push(r.warning);
  });
  view.paths = [...new Set(view.paths)];
  return view;
}

/** The delegation a bash command uses, or null when it is anything but one plain call of a delegate verb. */
export function matchDelegation(command: string, cwd: string, home: string, entries: readonly Delegation[]): DelegatedCall | null {
  if (entries.length === 0) return null;
  const parsed = parseShell(command, { cwd, home });
  const seg = parsed.segments[0];
  if (parsed.opaque.length > 0 || parsed.segments.length !== 1 || !seg) return null;
  if (seg.redirects.length || seg.assigns.length || seg.pipeIn || seg.pipeOut || seg.background || seg.via.length || seg.depth !== 0) return null;
  if (seg.remote !== undefined || seg.sudo !== undefined || seg.dynamicName || seg.obfuscatedName || seg.fnCall === true || seg.unknownArgs || seg.evalOf === true) return null;
  if (seg.words.some((w) => w.dynamic || w.subs.length > 0 || w.procSub)) return null;
  // The program is the command's first word as typed: a wrapper the parser unwraps (`env`, `exec`, `nice`) is
  // not part of what the operator delegated.
  if (!command.trimStart().startsWith(seg.words[0]?.raw ?? "\u0000")) return null;
  const program = seg.argv[0] ?? "";
  // The program is named by path; a bare name would be whatever PATH finds first. Of the tilde forms only `~/` is
  // read here: bash expands `~user/`, `~+/` and `~-/` to other directories.
  if (!program.includes("/")) return null;
  if (program.startsWith("~") && !program.startsWith("~/")) return null;
  const typed = program.startsWith("~/") ? path.join(home, program.slice(2)) : path.resolve(seg.cwd ?? cwd, program);
  let real: string;
  try {
    real = fs.realpathSync(typed);
  } catch {
    return null;
  }
  const verb = seg.argv[1];
  if (verb === undefined || NEVER_DELEGABLE.has(verb)) return null;
  const entry = entries.find((e) => e.path === real && e.verbs.includes(verb));
  if (!entry) return null;
  if (delegateFileProblem(real) !== null) return null;
  return { entry, verb };
}
