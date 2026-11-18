#!/usr/bin/env node
/**
 * Root `npm audit` gate with dated, dev-only exceptions.
 *
 * `npm audit` has no way to accept an advisory that no release fixes yet, so a single such
 * advisory in the dev toolchain would fail every pull request. This gate runs the audit itself and
 * fails when:
 *
 *   - the production tree (`--omit=dev`) has any high or critical advisory, accepted or not: an
 *     exception never covers what a user installs;
 *   - the whole tree has a high or critical advisory that is not accepted;
 *   - an accepted entry has expired (its `ignoreUntil` is past).
 *
 * Accepted advisories are the `[[IgnoredVulns]]` entries of `osv-scanner.toml`, the file
 * OSV-Scanner reads, so one list governs both scanners. An entry no advisory matches any longer is
 * reported so it can be removed. Other lockfiles are audited in `security.yml` without exceptions.
 *
 * Usage: node packages/core/audit-gate.ts
 *
 * Pinned by `tests/audit-gate-smoke.ts`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, parseJson } from "./lib/guard.ts";
import { WORKSPACE_ROOT } from "./lib/paths.ts";

export interface Exception { id: string; until: Date; reason: string }
export interface Finding { id: string; pkg: string; severity: string }

const BLOCKING = new Set(["high", "critical"]);

/** The `[[IgnoredVulns]]` entries of an osv-scanner.toml. Each needs an id, an ignoreUntil and a reason. */
export function parseExceptions(toml: string): Exception[] {
  const out: Exception[] = [];
  for (const block of toml.split(/^\[\[IgnoredVulns\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\[/m)[0] ?? "";
    const value = (m: RegExpMatchArray | null): string | undefined => m?.[1]?.trim().replace(/^"(.*)"$/, "$1");
    const id = value(body.match(/^id\s*=\s*(.+)$/m));
    const until = value(body.match(/^ignoreUntil\s*=\s*(.+)$/m));
    const reason = value(body.match(/^reason\s*=\s*(.+)$/m));
    if (id === undefined || until === undefined || reason === undefined || reason === "") throw new Error(`osv-scanner.toml: an [[IgnoredVulns]] entry needs id, ignoreUntil and reason (${id ?? "no id"})`);
    const date = new Date(until);
    if (Number.isNaN(date.getTime())) throw new Error(`osv-scanner.toml: ${id} has an invalid ignoreUntil ${until}`);
    out.push({ id, until: date, reason });
  }
  return out;
}

/** Every advisory in `npm audit --json` output, identified by its GHSA id. */
export function findings(auditJson: string): Finding[] {
  const parsed = parseJson(auditJson);
  const vulns = isRecord(parsed) ? parsed["vulnerabilities"] : undefined;
  if (!isRecord(vulns)) throw new Error("npm audit --json: no vulnerabilities object");
  const out = new Map<string, Finding>();
  for (const entry of Object.values(vulns)) {
    const via = isRecord(entry) ? entry["via"] : undefined;
    if (!Array.isArray(via)) continue;
    for (const v of via as unknown[]) {
      if (!isRecord(v)) continue; // a string names a dependency, not an advisory
      const url = typeof v["url"] === "string" ? v["url"] : "";
      const pkg = typeof v["name"] === "string" ? v["name"] : "?";
      const severity = typeof v["severity"] === "string" ? v["severity"] : "unknown";
      const id = /GHSA(?:-[0-9a-z]{4}){3}$/.exec(url)?.[0] ?? url;
      out.set(`${id} ${pkg}`, { id, pkg, severity });
    }
  }
  return [...out.values()];
}

/** The problems that fail the gate, and notes on entries that no longer match anything. */
export function evaluate(all: Finding[], prod: Finding[], exceptions: Exception[], now: Date): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const live = new Map<string, Exception>();
  for (const e of exceptions) {
    if (e.until.getTime() <= now.getTime()) problems.push(`${e.id}: the accepted exception expired on ${e.until.toISOString().slice(0, 10)}; fix it or renew it with a reason`);
    else live.set(e.id, e);
  }
  for (const f of prod) if (BLOCKING.has(f.severity)) problems.push(`${f.id} (${f.pkg}, ${f.severity}) is in the production tree; an exception never covers it`);
  for (const f of all) if (BLOCKING.has(f.severity) && !live.has(f.id)) problems.push(`${f.id} (${f.pkg}, ${f.severity}) is not accepted in osv-scanner.toml`);
  const seen = new Set(all.map((f) => f.id));
  const notes = exceptions.filter((e) => !seen.has(e.id)).map((e) => `${e.id}: accepted, but npm audit no longer reports it here; remove it if OSV-Scanner does not need it either`);
  return { problems, notes };
}

function audit(args: string[]): string {
  try {
    return execFileSync("npm", ["audit", "--json", ...args], { cwd: WORKSPACE_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
    const out = typeof err === "object" && err !== null && "stdout" in err ? err.stdout : undefined;
    if (typeof out === "string" && out.trim().startsWith("{")) return out;
    throw err;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exceptions = parseExceptions(fs.readFileSync(path.join(WORKSPACE_ROOT, "osv-scanner.toml"), "utf8"));
  const { problems, notes } = evaluate(findings(audit([])), findings(audit(["--omit=dev"])), exceptions, new Date());
  for (const n of notes) console.log(`[audit-gate] note: ${n}`);
  for (const e of exceptions) console.log(`[audit-gate] accepted until ${e.until.toISOString().slice(0, 10)}: ${e.id} (${e.reason})`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`[audit-gate] FAIL: ${p}`);
    process.exit(1);
  }
  console.log("[audit-gate] OK: no unaccepted high or critical advisory, and none in the production tree");
}
