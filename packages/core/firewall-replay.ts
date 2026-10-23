#!/usr/bin/env node
// Replays the tool firewall's analyser and decision matrix over real pi session transcripts.
//
// For every tool call the model made, it reports what the gate would decide today in each mode
// (manual / auto without a judge / strict), counts per tier, and lists every call that would ask
// or deny, so tuning is driven by real history instead of guesses. Nothing is executed.
//
//   node packages/core/firewall-replay.ts [--sessions DIR] [--mode auto|manual] [--policy coding|pentest]
//                                          [--show low|medium|high|critical] [--json] [--limit N]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadModule } from "./eval/harness.ts";
import { isRecord, literal, object, optional, parseJson, parseJsonAs, record, string } from "./lib/guard.ts";
import type * as Classify from "../extensions/src/tool-firewall/classify.ts";
import type * as FirewallConfig from "../extensions/src/tool-firewall/config.ts";

type Tier = Classify.Tier;
type Outcome = "allow" | "judge" | "ask" | "deny";

/** One reported call (also the --json `rows` items). */
export interface ReplayRow {
  tier: Tier;
  outcome: Outcome;
  tool: string;
  cwd: string;
  command: string;
  why: string;
  sig: string;
}

// The parts of the shipped policy this replay reads (the extension owns the full format).
const Decision = literal("allow", "ask", "deny");
const ReplayPolicySchema = object({
  defaults: optional(object({ unknown: optional(Decision) })),
  tools: optional(record(object({ decision: optional(Decision), risk_class: optional(string()) }))),
});

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const sessionsDir = opt("--sessions", path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "sessions"));
const mode = opt("--mode", "auto");
const policyArg = opt("--policy", "coding");
if (policyArg !== "coding" && policyArg !== "pentest") {
  console.error(`[firewall-replay] unknown --policy ${String(policyArg)} (expected coding or pentest)`);
  process.exit(2);
}
const policyName: Classify.ClassifyEnv["policy"] = policyArg;
const show = new Set((opt("--show", "medium,high,critical") || "").split(",").filter(Boolean));
const limit = Number(opt("--limit", "400"));
const asJson = args.includes("--json");

// The harness compiles the extension sources; their types are the checkout's.
const C = await loadModule<typeof Classify>("extensions/tool-firewall/classify.ts");
const Cfg = await loadModule<typeof FirewallConfig>("extensions/tool-firewall/config.ts");
const policy = parseJsonAs(ReplayPolicySchema, fs.readFileSync(new URL("../extensions/src/tool-firewall/default-policy.json", import.meta.url), "utf8"), "default-policy.json");

/** The call's command or path as text (a non-string value is shown as JSON). */
function shownCommand(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function walk(dir: string | undefined): string[] {
  const out: string[] = [];
  if (dir === undefined) return out;
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

const cfg = Cfg.readConfig();
const hosts = Cfg.knownHosts(cfg);
const tiers: Record<Tier, number> = { low: 0, medium: 0, high: 0, critical: 0 };
const outcomes: Record<Outcome, number> = { allow: 0, judge: 0, ask: 0, deny: 0 };
// Session allows modelled per session file: the operator picks "Allow for this session" on
// every card, so later actions similar to an allowed one (a shared family or host/root scope)
// go to the judge instead of asking (not under the pentest policy). The judge may still ask.
let askWithLeases = 0;
const rows: ReplayRow[] = [];
let calls = 0;

for (const file of walk(sessionsDir)) {
  let cwd = os.homedir();
  const leased = new Set<string>();
  const scoped = new Set<string>();
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    let e: unknown;
    try {
      e = parseJson(line);
    } catch {
      continue;
    }
    if (!isRecord(e)) continue;
    if (e.type === "session" && typeof e.cwd === "string" && e.cwd) cwd = e.cwd;
    const { message } = e;
    const content = isRecord(message) && message.role === "assistant" ? message.content : null;
    if (!Array.isArray(content)) continue;
    for (const part of content as unknown[]) {
      if (!isRecord(part) || part.type !== "toolCall") continue;
      calls++;
      const tool = typeof part.name === "string" ? part.name : String(part.name);
      const input = part.arguments ?? {};
      const env = { cwd, workspace: Cfg.workspaceRoot(cwd), home: os.homedir(), tmpRoots: Cfg.tmpRoots(), knownHosts: hosts, policy: policyName };
      const rule = policy.tools?.[tool];
      const a = C.classifyToolCall(tool, input, env, rule, policy.defaults?.unknown ?? "ask");
      const tier = C.effectiveTier(a, mode === "auto");
      tiers[tier]++;
      let outcome: Outcome;
      if (tier === "critical") outcome = "deny";
      else if (tier === "low") outcome = "allow";
      else if (tier === "medium") outcome = mode === "auto" && policyName === "coding" ? "judge" : "ask";
      else outcome = "ask";
      outcomes[outcome]++;
      if (outcome === "ask") {
        const fams = C.familiesOf(a, mode === "auto");
        const scopes = [...new Set(a.findings.filter((f) => f.tier !== "low" && f.scope && f.scope !== "local").map((f) => f.scope ?? ""))];
        const similar = fams.some((f) => leased.has(f)) || scopes.some((x) => scoped.has(x));
        if (policyName === "pentest" || !similar) {
          askWithLeases++;
          if (policyName !== "pentest") {
            for (const f of fams) leased.add(f);
            for (const x of scopes) scoped.add(x);
          }
        }
      }
      const fields = isRecord(input) ? input : {};
      if (show.has(tier)) rows.push({ tier, outcome, tool, cwd, command: shownCommand(fields.command ?? fields.path ?? JSON.stringify(input)), why: C.summarize(a, mode === "auto") || a.summary, sig: C.signatureOf(a, mode === "auto") });
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ calls, mode, policy: policyName, tiers, outcomes, askWithLeases, rows }, null, 2));
} else {
  console.log(`[firewall-replay] ${calls} tool calls from ${sessionsDir} (mode=${mode}, policy=${policyName}, known hosts: ${[...hosts].join(", ") || "none"})`);
  console.log(`  tiers:    low ${tiers.low}  medium ${tiers.medium}  high ${tiers.high}  critical ${tiers.critical}`);
  console.log(`  outcome:  allow ${outcomes.allow}  judge ${outcomes.judge}  ask-human ${outcomes.ask}  deny ${outcomes.deny}`);
  console.log(`  ask-human if every card is answered "allow for this session" (similar steps judged instead): ${askWithLeases}`);
  for (const r of rows.slice(0, limit)) {
    console.log(`\n  [${r.tier}/${r.outcome}] ${r.tool}: ${r.command.replace(/\s+/g, " ").slice(0, 220)}`);
    console.log(`      why: ${r.why.slice(0, 220)}`);
  }
}
