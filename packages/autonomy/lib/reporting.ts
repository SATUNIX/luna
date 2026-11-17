// Reporting lines from the autonomy host up the chain: one machine-readable status file (per-run
// state, the last cycle's result, spend today and this month per inference source, the key's own
// limit, open pull requests, the last alert) and ntfy alerts for the events that need a person
// (a run stops, parks or is refused; a budget or key is exhausted; CI red on an autonomy pull
// request; a release pull request ready) plus one daily digest. Not per-cycle noise: an alert is
// sent when its condition first appears and again only after it has cleared.
//
// The status is built from what the runs already record (state.json, contract.json, the relay's
// meter files and key.json); nothing here changes a run. The ntfy token is read from its file at
// publish time and never logged, returned or written anywhere.
import fs from "node:fs";
import path from "node:path";
import { isRecord, parseJson } from "../../core/lib/guard.ts";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import { runPaths, stateHome } from "./paths.ts";

export const STATUS_SCHEMA_VERSION = 1;

/** The key's own limit as the provider reports it (OpenRouter `GET /key`); nothing else from that reply is kept. */
export interface KeyLimit { at: string; limit: number | null; limit_remaining: number | null; usage: number | null }
export interface SpendWindow { todayUsd: number; monthUsd: number }
export type CiState = "green" | "red" | "pending" | "none";
export interface PullRequestInfo { number: number; title: string; head: string; base: string; draft: boolean; ci: CiState; url: string }
export interface CycleSummary { n: number | null; outcome: string | null; reason: string | null; gate: string | null; merged: boolean | null }
export interface RunRow {
  run: string;
  status: string;
  step: number | null;
  reason: string | null;
  blocker: { kind: string; waiting: string | null; question: string } | null;
  lastCycle: CycleSummary | null;
  source: string;
  spend: SpendWindow & { totalUsd: number | null; budgetUsd: number | null };
  updatedAt: string | null;
}
export interface AlertRecord { at: string; title: string; delivered: boolean; httpStatus: number | null }
export interface StatusReport {
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  generatedAt: string;
  timeZone: string;
  runs: RunRow[];
  spend: Record<string, SpendWindow>;
  keys: Record<string, KeyLimit>;
  openPrs: PullRequestInfo[] | null;
  lastAlert: AlertRecord | null;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** One visible ASCII line: what ntfy headers and a phone notification can carry. */
const oneLine = (s: string, max = 200): string => s.replace(/[^\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The calendar day and month of an instant in a time zone, as YYYY-MM-DD and YYYY-MM. */
export function dayIn(at: Date, timeZone: string): { day: string; month: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
  const month = `${get("year")}-${get("month")}`;
  return { day: `${month}-${get("day")}`, month };
}
const hourIn = (at: Date, timeZone: string): number => Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(at));

/** Where a run's inference is billed: OpenRouter, or the host of a custom OpenAI-compatible upstream. */
export function sourceOf(contract: unknown): string {
  if (!isRecord(contract)) return "unknown";
  const provider = isRecord(contract.model) ? str(contract.model.provider) : null;
  if (provider === "openrouter") return "openrouter";
  const upstream = isRecord(contract.providerSettings) ? str(contract.providerSettings.upstream) : null;
  try { return upstream ? new URL(upstream).hostname : provider ?? "unknown"; } catch { return provider ?? "unknown"; }
}

/** Spend today and this month from meter rows (`at` + numeric `costUsd`); unreadable rows and rows without a cost add nothing. */
export function spendFrom(meterText: string, now: Date, timeZone: string): SpendWindow {
  const { day, month } = dayIn(now, timeZone);
  const out: SpendWindow = { todayUsd: 0, monthUsd: 0 };
  for (const line of meterText.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = parseJson(line); } catch { continue; }
    if (!isRecord(row) || typeof row.costUsd !== "number" || !Number.isFinite(row.costUsd) || row.costUsd < 0 || typeof row.at !== "string") continue;
    const at = new Date(row.at);
    if (Number.isNaN(at.getTime())) continue;
    const when = dayIn(at, timeZone);
    if (when.month === month) out.monthUsd += row.costUsd;
    if (when.day === day) out.todayUsd += row.costUsd;
  }
  return out;
}

/** A key.json the relay wrote: only the three limit figures and the time are kept. */
export function keyLimitOf(value: unknown): KeyLimit | null {
  if (!isRecord(value) || typeof value.at !== "string") return null;
  return { at: value.at, limit: finite(value.limit), limit_remaining: finite(value.limit_remaining), usage: finite(value.usage) };
}

const readText = (f: string): string => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

function lastCycleOf(state: Record<string, unknown>): CycleSummary | null {
  const si = isRecord(state.selfImprove) ? state.selfImprove : null;
  const history = si && Array.isArray(si.history) ? si.history : [];
  const last: unknown = history[history.length - 1];
  if (!isRecord(last)) return null;
  return { n: finite(last.n), outcome: str(last.outcome), reason: str(last.reason) && oneLine(String(last.reason), 300), gate: str(last.gate), merged: typeof last.merged === "boolean" ? last.merged : null };
}

/** The status of every run under `home`, with the per-source spend and key limits. Read-only. */
export function buildStatus({ home = stateHome(), now = new Date(), timeZone = "UTC", prs = null, lastAlert = null }: { home?: string | undefined; now?: Date | undefined; timeZone?: string | undefined; prs?: PullRequestInfo[] | null | undefined; lastAlert?: AlertRecord | null | undefined } = {}): StatusReport {
  let names: string[] = [];
  try { names = fs.readdirSync(home).sort(); } catch { /* no runs yet */ }
  const runs: RunRow[] = [];
  const spend: Record<string, SpendWindow> = {};
  const keys: Record<string, KeyLimit> = {};
  for (const run of names) {
    const p = runPaths(run, home);
    const state = readJson(p.state, null);
    if (!isRecord(state)) continue;
    const source = sourceOf(readJson(path.join(p.root, "contract.json"), null));
    const window = spendFrom(readText(path.join(p.meter, "usage.jsonl")) + "\n" + readText(path.join(p.meter, "manager.jsonl")), now, timeZone);
    const total = spend[source] ?? { todayUsd: 0, monthUsd: 0 };
    spend[source] = { todayUsd: total.todayUsd + window.todayUsd, monthUsd: total.monthUsd + window.monthUsd };
    const key = keyLimitOf(readJson(path.join(p.meter, "key.json"), null));
    const known = keys[source];
    if (key && (!known || key.at > known.at)) keys[source] = key;
    const usage = isRecord(state.usage) ? state.usage : {};
    const budget = isRecord(state.limits) && isRecord(state.limits.budget) ? state.limits.budget : {};
    const b = state.blocker;
    const outcome = isRecord(state.outcome) ? state.outcome : null;
    runs.push({
      run,
      status: str(state.status) ?? "unknown",
      step: finite(state.step),
      reason: outcome ? str(outcome.reason) : null,
      blocker: isRecord(b) && typeof b.kind === "string" ? { kind: oneLine(b.kind, 40), waiting: str(b.waiting), question: oneLine(str(b.question) ?? "", 300) } : null,
      lastCycle: lastCycleOf(state),
      source,
      spend: { ...window, totalUsd: finite(usage.usd), budgetUsd: finite(budget.totalUsd) },
      updatedAt: str(state.updatedAt),
    });
  }
  return { schemaVersion: STATUS_SCHEMA_VERSION, generatedAt: now.toISOString(), timeZone, runs, spend, keys, openPrs: prs, lastAlert };
}

// --- pull requests ---------------------------------------------------------------------------------

/** CI state from `gh pr list --json statusCheckRollup`: any failure is red, anything unfinished is pending. */
export function ciFromRollup(rollup: unknown): CiState {
  if (!Array.isArray(rollup) || !rollup.length) return "none";
  let pending = false;
  for (const c of rollup) {
    if (!isRecord(c)) continue;
    const conclusion = str(c.conclusion) ?? str(c.state) ?? "";
    const status = str(c.status) ?? "";
    if (/^(FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE)$/.test(conclusion)) return "red";
    if ((status && status !== "COMPLETED") || conclusion === "PENDING" || conclusion === "EXPECTED" || conclusion === "") pending = true;
  }
  return pending ? "pending" : "green";
}

/** Open pull requests from `gh pr list --json number,title,headRefName,baseRefName,isDraft,url,statusCheckRollup` output. */
export function prsFromGh(value: unknown): PullRequestInfo[] {
  if (!Array.isArray(value)) throw new Error("gh pr list did not return a list");
  return value.flatMap((v): PullRequestInfo[] => {
    if (!isRecord(v) || typeof v.number !== "number") return [];
    return [{ number: v.number, title: oneLine(str(v.title) ?? ""), head: str(v.headRefName) ?? "", base: str(v.baseRefName) ?? "", draft: v.isDraft === true, ci: ciFromRollup(v.statusCheckRollup), url: str(v.url) ?? "" }];
  });
}

// --- alerts ----------------------------------------------------------------------------------------

export interface Alert { key: string; title: string; message: string; priority: 2 | 3 | 4 | 5; tags: string[] }
export interface AlertRules {
  /** Head-branch prefixes of the pull requests autonomy opens (the integrator's `integrate/*`). */
  autonomyHeads: string[];
  /** The branch release pull requests target, and the heads that make one. */
  releaseBase: string;
  releaseHeads: string[];
}
export const DEFAULT_RULES: AlertRules = { autonomyHeads: ["integrate/"], releaseBase: "main", releaseHeads: ["integration/", "release/"] };

const usd = (n: number | null): string => (n === null ? "?" : `$${n.toFixed(2)}`);

/** The conditions that need a person, now. A paused run is the operator's own doing and raises nothing. */
export function alertsFor(status: StatusReport, rules: AlertRules = DEFAULT_RULES): Alert[] {
  const out: Alert[] = [];
  for (const r of status.runs) {
    const spent = `spent ${usd(r.spend.totalUsd)} of ${usd(r.spend.budgetUsd)}`;
    if (r.status === "failed" || r.status === "cancelled" || r.status === "succeeded") {
      out.push({ key: `run:${r.run}:${r.status}:${r.reason ?? ""}`, title: `Luna ${r.run} stopped: ${r.status}`, message: `${r.run} ended ${r.status}${r.reason ? ` (${r.reason})` : ""}; ${spent}.`, priority: r.status === "succeeded" ? 3 : 4, tags: ["stop_sign"] });
    } else if (r.status === "budget_exhausted") {
      out.push({ key: `run:${r.run}:budget:${r.reason ?? ""}`, title: `Luna ${r.run}: budget exhausted`, message: `${r.run} ran out of ${r.reason ?? "budget"}; ${spent}. Raising it is a reconfigure.`, priority: 4, tags: ["moneybag"] });
    } else if (r.status === "blocked" && r.blocker) {
      const w = r.blocker.waiting;
      const what = w === "waiting_budget" ? "provider refused: budget or credits exhausted" : w === "waiting_provider" ? "provider refused or unavailable" : `parked (${r.blocker.kind})`;
      out.push({ key: `run:${r.run}:blocked:${w ?? r.blocker.kind}`, title: `Luna ${r.run}: ${what}`, message: `${r.run}: ${r.blocker.question || what}`, priority: w ? 4 : 3, tags: [w ? "warning" : "parking"] });
    }
  }
  for (const [source, k] of Object.entries(status.keys)) {
    if (k.limit_remaining !== null && k.limit_remaining <= 0) out.push({ key: `key:${source}:exhausted`, title: `Luna: ${source} key limit exhausted`, message: `The ${source} key has ${usd(k.limit_remaining)} of its ${usd(k.limit)} limit left (usage ${usd(k.usage)}, checked ${k.at}).`, priority: 5, tags: ["key"] });
  }
  for (const pr of status.openPrs ?? []) {
    if (pr.ci === "red" && rules.autonomyHeads.some((h) => pr.head.startsWith(h))) {
      out.push({ key: `pr:${pr.number}:red`, title: `Luna PR #${pr.number}: CI red`, message: `${pr.title} (${pr.head} -> ${pr.base}) ${pr.url}`, priority: 4, tags: ["x"] });
    }
    if (pr.ci === "green" && !pr.draft && pr.base === rules.releaseBase && rules.releaseHeads.some((h) => pr.head.startsWith(h))) {
      out.push({ key: `pr:${pr.number}:release-ready`, title: `Luna release PR #${pr.number} ready`, message: `${pr.title}: all checks green. ${pr.url}`, priority: 3, tags: ["package"] });
    }
  }
  return out;
}

/** One short line per run and source: the daily digest. */
export function digestOf(status: StatusReport): Alert {
  const runs = status.runs.map((r) => `${r.run}: ${r.status}${r.lastCycle ? `, last cycle ${r.lastCycle.n ?? "?"} ${r.lastCycle.outcome ?? "?"}${r.lastCycle.merged ? " (merged)" : ""}` : ""}`);
  const spend = Object.entries(status.spend).map(([s, w]) => `${s}: today ${usd(w.todayUsd)}, month ${usd(w.monthUsd)}`);
  const keys = Object.entries(status.keys).map(([s, k]) => `${s} key: ${usd(k.limit_remaining)} of ${usd(k.limit)} left`);
  const prs = status.openPrs === null ? [] : [`open PRs: ${status.openPrs.length}${status.openPrs.length ? ` (${status.openPrs.map((p) => `#${p.number} ${p.ci}`).join(", ")})` : ""}`];
  return { key: "digest", title: `Luna daily digest ${dayIn(new Date(status.generatedAt), status.timeZone).day}`, message: [...runs, ...spend, ...keys, ...prs].join("\n") || "no runs", priority: 2, tags: ["calendar"] };
}

/** What has been sent: the conditions still active (so each is sent once), the last digest day and the last alert. */
export interface AlertState { active: string[]; digestDay: string | null; lastAlert: AlertRecord | null }
export function readAlertState(file: string): AlertState {
  const v = readJson(file, null);
  if (!isRecord(v)) return { active: [], digestDay: null, lastAlert: null };
  const la = isRecord(v.lastAlert) && typeof v.lastAlert.at === "string" && typeof v.lastAlert.title === "string" ? { at: v.lastAlert.at, title: v.lastAlert.title, delivered: v.lastAlert.delivered === true, httpStatus: finite(v.lastAlert.httpStatus) } : null;
  return { active: Array.isArray(v.active) ? v.active.filter((k): k is string => typeof k === "string") : [], digestDay: str(v.digestDay), lastAlert: la };
}

/**
 * The alerts to send now: conditions that were not active at the last tick, and the digest once a
 * day at or after `digestHour` (local to the status's time zone). A condition that clears is
 * forgotten, so it alerts again if it comes back.
 */
export function plan(state: AlertState, current: Alert[], status: StatusReport, { digestHour = 8 }: { digestHour?: number | undefined } = {}): { send: Alert[]; next: AlertState } {
  const was = new Set(state.active);
  const send = current.filter((a) => !was.has(a.key));
  const now = new Date(status.generatedAt);
  const today = dayIn(now, status.timeZone).day;
  let digestDay = state.digestDay;
  if (digestDay !== today && hourIn(now, status.timeZone) >= digestHour) { send.push(digestOf(status)); digestDay = today; }
  return { send, next: { active: [...new Set(current.map((a) => a.key))], digestDay, lastAlert: state.lastAlert } };
}

// --- ntfy ------------------------------------------------------------------------------------------

export interface NtfyTarget {
  /** The topic URL, e.g. https://ntfy.example/luna-status. */
  url: string;
  /** A file holding a publish-only access token, read at publish time. Absent file: publish without one. */
  tokenFile?: string | undefined;
}
export type Fetch = typeof fetch;

const loopback = (host: string): boolean => host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

/** Publish one alert. Never throws and never returns or logs the token; a network failure is `{ delivered: false, httpStatus: null }`. */
export async function publish(target: NtfyTarget, alert: Alert, { fetchImpl = fetch, timeoutMs = 10_000, now = () => new Date() }: { fetchImpl?: Fetch | undefined; timeoutMs?: number | undefined; now?: (() => Date) | undefined } = {}): Promise<AlertRecord & { error?: string }> {
  const record = (delivered: boolean, httpStatus: number | null, error?: string): AlertRecord & { error?: string } => ({ at: now().toISOString(), title: alert.title, delivered, httpStatus, ...(error ? { error } : {}) });
  let url: URL;
  try { url = new URL(target.url); } catch { return record(false, null, "the ntfy URL is not a URL"); }
  const headers: Record<string, string> = { Title: oneLine(alert.title, 120), Priority: String(alert.priority), Tags: alert.tags.join(","), "Content-Type": "text/plain; charset=utf-8" };
  if (target.tokenFile) {
    let token = "";
    try { token = fs.readFileSync(target.tokenFile, "utf8").trim(); } catch { /* absent: unauthenticated */ }
    if (token) {
      if (url.protocol !== "https:" && !loopback(url.hostname)) return record(false, null, "refusing to send the ntfy token over plain http to a non-loopback host");
      headers.Authorization = `Bearer ${token}`;
    }
  }
  try {
    const res = await fetchImpl(url.href, { method: "POST", headers, body: alert.message.slice(0, 3000), signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => undefined); // the reply is not needed; never read it into memory
    return record(res.status >= 200 && res.status < 300, res.status);
  } catch (e) {
    const cause = e instanceof Error && isRecord(e.cause) && typeof e.cause.code === "string" ? e.cause.code : e instanceof Error ? e.name : "error";
    return record(false, null, `ntfy unreachable (${cause})`);
  }
}

// --- one tick ---------------------------------------------------------------------------------------

export interface TickOptions {
  home?: string | undefined;
  now?: Date | undefined;
  timeZone?: string | undefined;
  prs?: PullRequestInfo[] | null | undefined;
  /** Where status.json is written. */
  out: string;
  /** Where the alert state lives (default: alerts.json beside `out`). */
  alertState?: string | undefined;
  ntfy?: NtfyTarget | null | undefined;
  digestHour?: number | undefined;
  rules?: AlertRules | undefined;
  fetchImpl?: Fetch | undefined;
  log?: ((line: string) => void) | undefined;
}

/** Build the status, send what is new, record the result and write status.json. Without an ntfy target, alerts are logged and not marked sent. */
export async function reportTick(o: TickOptions): Promise<{ status: StatusReport; sent: Array<AlertRecord & { error?: string }> }> {
  const log = o.log ?? (() => undefined);
  const stateFile = o.alertState ?? path.join(path.dirname(o.out), "alerts.json");
  const state = readAlertState(stateFile);
  const now = o.now ?? new Date();
  let status = buildStatus({ home: o.home, now, timeZone: o.timeZone, prs: o.prs ?? null, lastAlert: state.lastAlert });
  const { send, next } = plan(state, alertsFor(status, o.rules), status, { digestHour: o.digestHour });
  const sent: Array<AlertRecord & { error?: string }> = [];
  if (o.ntfy) {
    const failed = new Set<string>();
    for (const a of send) {
      const r = await publish(o.ntfy, a, { fetchImpl: o.fetchImpl, now: () => now });
      sent.push(r);
      next.lastAlert = { at: r.at, title: r.title, delivered: r.delivered, httpStatus: r.httpStatus };
      log(`${r.delivered ? "sent" : "NOT sent"}: ${a.title}${r.httpStatus !== null ? ` (HTTP ${r.httpStatus})` : ""}${r.error ? `: ${r.error}` : ""}`);
      if (!r.delivered) { if (a.key === "digest") next.digestDay = state.digestDay; else failed.add(a.key); }
    }
    // An alert that did not go out is not remembered as active, so the next tick tries it again.
    next.active = next.active.filter((k) => !failed.has(k));
  } else {
    for (const a of send) log(`alert (no ntfy target configured): ${a.title}`);
    next.active = state.active.filter((k) => next.active.includes(k));
    next.digestDay = state.digestDay;
  }
  writeJsonAtomic(stateFile, next);
  status = { ...status, lastAlert: next.lastAlert };
  writeJsonAtomic(o.out, status);
  return { status, sent };
}
