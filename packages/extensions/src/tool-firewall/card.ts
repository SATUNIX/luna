// Evidence cards: what the operator sees when an action needs them.
//
// A card is at most CARD_MAX_LINES lines of at most CARD_WIDTH characters, so it fits a normal
// pane and the human console without scrolling: the tier and summary, the command, the reasons
// that raised the tier (highest first), then the session history, judge note (why it differs
// from what the operator allowed), past decisions and what "allow for this session" does. Mode, policy,
// action hash and the full analysis are in `/auto explain` (buildDetail), not on the card.
//
// A card only ever shows an action that no rule has settled: a HARD DENY (policy says never) is
// never put to the operator. A card the automatic layers could not settle (the judge unsure,
// unavailable or timed out) is tagged UNCERTAIN; what the operator answers is an OPERATOR DECISION,
// remembered only within the scope the card names.
import type { Assessment, Effect, Finding, Tier } from "./classify.ts";
import type { LearnedStatus } from "./feedback.ts";
import { LEARNED_APPROVAL_TTL_MS } from "./approvals.ts";

export const CHOICE_ALLOW_ONCE = "Allow once";
export const CHOICE_ALLOW_SESSION = "Allow for this session";
// Persistent: this exact command, in this project, for LEARNED_APPROVAL_TTL_MS. Offered for low and medium only.
// Keep the word "session" out of it: the unattended supervisor prefers the choice that names a session.
export const CHOICE_ALLOW_PROJECT = `Always allow this exact command in this project (${Math.round(LEARNED_APPROVAL_TTL_MS / 86_400_000)} days)`;
export const CHOICE_DENY = "Deny";
export const CHOICE_DENY_TELL = "Deny and tell the agent why…";

export const CARD_MAX_LINES = 10;
export const CARD_WIDTH = 116;

const TIER_LABEL: Record<Tier, string> = { low: "low", medium: "MEDIUM", high: "HIGH", critical: "CRITICAL" };
const clip = (s: string, n = CARD_WIDTH) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

// The one place a tier becomes a sentence, and an effect becomes words. The first line of a card keeps the
// "TIER · tool · summary" grammar (the console, phone and autonomy supervisor read it); this line is for people.
const TIER_SENTENCE: Record<Tier, string> = {
  low: "Routine: small and easy to undo.",
  medium: "Changes things: check it does what you asked.",
  high: "Risky: could be hard to undo or reach beyond this project.",
  critical: "Dangerous: could cause serious damage or leak secrets.",
};
const EFFECT_WORDS: Partial<Record<Effect, string>> = {
  workspace_write: "edits files in the project", write_outside: "writes outside the project", delete: "deletes files",
  package_install: "installs software", network_read: "downloads from the network", network_send: "sends data over the network",
  remote_exec: "runs code fetched from elsewhere", privilege: "uses elevated rights", persistence: "sets something to run later",
  credential_read: "reads credentials", security_control: "changes a security setting", history_rewrite: "rewrites git history",
  publish: "publishes something", destructive_system: "can damage the system", obfuscated_exec: "runs hidden code",
  code_exec: "runs code", process_control: "stops or starts processes", unknown_exec: "runs a program Luna cannot classify", opaque: "does something Luna cannot inspect",
};
function plainEffect(a: Assessment): string {
  const words = [...new Set(a.effects.map((e) => EFFECT_WORDS[e]).filter((w): w is string => !!w))].slice(0, 3);
  return words.length ? `It ${words.join(", ")}.` : "";
}

// The session choice says what it does: in auto mode, similar steps go to the judge, checked
// against this action; in manual mode, only exact repeats run.
export function sessionChoice(judged: boolean): string {
  return judged ? `${CHOICE_ALLOW_SESSION} (similar steps: judge checks them against this)` : `${CHOICE_ALLOW_SESSION} (exact repeats only)`;
}

export function choicesFor(allowSession: boolean, judged: boolean, allowProject = false): string[] {
  if (!allowSession) return [CHOICE_ALLOW_ONCE, CHOICE_DENY, CHOICE_DENY_TELL];
  return [CHOICE_ALLOW_ONCE, sessionChoice(judged), ...(allowProject ? [CHOICE_ALLOW_PROJECT] : []), CHOICE_DENY, CHOICE_DENY_TELL];
}

export function isProjectChoice(choice: unknown): boolean {
  return choice === CHOICE_ALLOW_PROJECT;
}

// Only low and medium tiers may be remembered across sessions, and never when something other than the
// operator's say-so is needed (an explicit ask rule, an unidentified API) or the level is guarded or strict.
export function projectAllowOffered(tier: Tier, x: { guarded: boolean; strict: boolean; needsOperator: boolean }): boolean {
  return (tier === "low" || tier === "medium") && !x.guarded && !x.strict && !x.needsOperator;
}

export function isSessionChoice(choice: unknown): boolean {
  return typeof choice === "string" && choice.startsWith(CHOICE_ALLOW_SESSION);
}

export type CardExtras = {
  tier: Tier;
  trajectory: Finding[];
  judgeNote?: string;
  precedent?: LearnedStatus;
  hash: string;
  signature: string;
  mode: string;
  policy: string;
  covers?: string; // what a session allow does (omitted when it is not offered)
  scope?: string; // how far a session allow reaches, e.g. "this session + workspace, 24h" (with `covers`)
  uncertain?: boolean; // the judge or classifier could not settle it: an operator escalation
  maxLines?: number;
};

export function buildCard(a: Assessment, x: CardExtras): string {
  const max = Math.max(4, x.maxLines ?? CARD_MAX_LINES);
  const head = [clip(`${x.uncertain ? "UNCERTAIN · " : ""}${TIER_LABEL[x.tier]} · ${a.tool} · ${flat(a.summary)}`)];
  if (a.command !== undefined) {
    const cmd = `$ ${flat(a.command)}`;
    head.push(clip(cmd));
    if (cmd.length > CARD_WIDTH) head.push(clip(`  ${cmd.slice(CARD_WIDTH - 1)}`));
  }
  head.push(clip(`${TIER_SENTENCE[x.tier]} ${plainEffect(a)}`.trim()));
  const tail: string[] = [];
  const history = x.trajectory.map((f) => f.detail);
  if (history.length) tail.push(clip(`History: ${history.join("; ")}`));
  if (x.judgeNote) tail.push(clip(`Judge: ${x.judgeNote}`));
  if (x.precedent && (x.precedent.approvals || x.precedent.denials)) tail.push(clip(`Your past decisions on this kind: ${x.precedent.approvals} approval(s) in ${x.precedent.sessions} session(s), ${x.precedent.denials} denial(s) (${x.precedent.status})`));
  if (x.covers) tail.push(clip(`Session allow: ${x.covers}${x.scope ? ` (${x.scope})` : ""}`));
  tail.push("Mode, policy and action id: /auto explain");

  const inHistory = new Set(history);
  const reasons = [...new Set(a.findings.filter((f) => f.tier !== "low" && !inHistory.has(f.detail)).sort((p, q) => rank(q.tier) - rank(p.tier)).map((f) => `• [${f.tier}] ${flat(f.detail)}`))];
  // Keep the header and footer; drop optional tail lines before squeezing the reasons below one.
  while (head.length + tail.length + Math.min(1, reasons.length) > max && tail.length > 1) tail.splice(tail.length - 2, 1);
  const room = Math.max(0, max - head.length - tail.length);
  let shown = reasons.slice(0, room);
  if (reasons.length > room && room > 0) shown = [...reasons.slice(0, room - 1), `  +${reasons.length - room + 1} more reason(s)`];
  return [...head, ...shown.map((r) => clip(r)), ...tail].slice(0, max).join("\n");
}

function rank(t: Tier): number {
  return t === "critical" ? 3 : t === "high" ? 2 : t === "medium" ? 1 : 0;
}

// The full analysis for `/auto explain`: every step, every reason, no line cap.
export function buildDetail(a: Assessment, x: CardExtras): string {
  const lines = [`${TIER_LABEL[x.tier]} · ${a.tool} · ${a.summary}`];
  if (a.command !== undefined) lines.push("Command:", ...a.command.split("\n").map((l) => `  ${l}`));
  const steps = a.segments.filter((s) => s.tier !== "low");
  if (steps.length) lines.push("Steps:", ...steps.map((s) => `  • ${s.text}  [${s.where}; ${s.effects.join(", ")}]`));
  const why = [...new Set(a.findings.filter((f) => f.tier !== "low").map((f) => `  • [${f.tier}] ${f.detail}`))];
  if (why.length) lines.push("Why:", ...why);
  if (x.trajectory.length) lines.push("Session history:", ...x.trajectory.map((f) => `  • ${f.detail}`));
  if (x.covers) lines.push(`Session allow: ${x.covers}${x.scope ? ` (${x.scope})` : ""}`);
  if (x.uncertain) lines.push("Outcome: UNCERTAIN: the automatic layers could not settle this; your answer is an OPERATOR DECISION.");
  lines.push(`signature: ${x.signature}`, `mode=${x.mode} policy=${x.policy} · action ${x.hash.slice(0, 12)}`);
  return lines.join("\n");
}
