#!/usr/bin/env node
/**
 * Profile regression (Epic 9 Sprint 9.1) — OFFLINE, real per-profile capstone matrix.
 *
 * F-06 fix: this previously only resolved names/maturity/ordering and never imported,
 * registered, installed, or evaluated a single extension - the capstone gate stayed
 * green through F-01 (profile filtering not applied), F-02 (first-party tools blocked),
 * H-02 (branch-lab wrong execute signature), and H-03 (provider-router notification
 * discarded). It now actually exercises two of the three DoD legs:
 *
 *   1. "install": resolve the profile's `include` list via packages/core/lib/resolve.ts's
 *      resolveProfile() (fails loud on any dangling/unresolved name, exactly like
 *      packages/core/install.ts now does) and replay the real settings.json narrowing
 *      packages/core/install.ts performs via packages/core/lib/settings.ts's mergePackageBlock() against
 *      a scratch settings file. Asserts the resulting filter is genuinely narrower
 *      than the full extension set and contains exactly the profile's own in-repo/
 *      vendor extensions — the review's own repro bar ("a genuinely narrowed extension
 *      set, not just resolve names").
 *   2. "load" (stands in for "verify" offline): transpile and register every resolved
 *      in-repo/vendor extension against a fake pi API (packages/core/eval/harness.ts), firing
 *      session_start when the extension registers one, in a scratch cwd — catching
 *      import-time and registration-time breakage a name-only check cannot.
 *
 * "eval" (behavioral fixtures) is deliberately NOT re-run here: packages/core/eval/fixtures.ts
 * tests extension behavior, which is identical code regardless of which profile happens
 * to include it, so re-running the fixed 13-fixture suite once per profile would add
 * CI time without new signal. It remains its own required `npm run eval` CI job.
 *
 * Also retained: non-experimental profiles carry no stub/experimental extension;
 * tool-firewall loads before pentest-governance-domain when both present.
 *
 * A live `pi install` + real-model run remains deliberately out of scope (the kit is
 * hardened offline by design); CI runs this across every profile as the matrix.
 *
 * Usage:
 *   node packages/core/profile-check.ts --profile <name>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord, parseJson } from "./lib/guard.ts";
import { resolveProfile } from "./lib/resolve.ts";
import { mergePackageBlock, readSettings } from "./lib/settings.ts";
import { loadExtension, fakePi } from "./eval/harness.ts";
import { requiredProfileExtensions } from "./distribution-contract.ts";
import { protectionCoverageProblems } from "./lib/protection-coverage.ts";
import { WORKSPACE_ROOT, PROFILES_DIR, FIRST_PARTY_DIR, THIRD_PARTY_DIR, extensionRelPath } from "./lib/paths.ts";

type ResolvedExtension = ReturnType<typeof resolveProfile>[number];

const ROOT = WORKSPACE_ROOT;
const args = process.argv.slice(2);
const get = (flag: string): string | null | undefined => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null);
const profileName = get("--profile");

let errors = 0;
const fail = (m: string): void => {
  console.error(`  FAIL: ${m}`);
  errors++;
};

// Manifest index, kept for the stub/experimental + load-ordering checks.
const manifests = new Map<string, Record<string, unknown>>();
for (const dir of [FIRST_PARTY_DIR, THIRD_PARTY_DIR]) {
  if (!fs.existsSync(dir)) continue;
  for (const n of fs.readdirSync(dir)) {
    if (n.startsWith("_")) continue;
    const mp = path.join(dir, n, "extension.json");
    if (!fs.existsSync(mp)) continue;
    const manifest = parseJson(fs.readFileSync(mp, "utf8"));
    if (isRecord(manifest)) manifests.set(n, manifest);
  }
}

function withCwd(cwd: string, fn: () => unknown): Promise<unknown> {
  const previous = process.cwd();
  process.chdir(cwd);
  return Promise.resolve(fn()).finally(() => process.chdir(previous));
}

function checkStubsAndOrdering(includes: readonly string[], label: string, isExperimental: boolean): void {
  for (const name of includes) {
    const meta = manifests.get(name);
    if (meta && !isExperimental && (meta.status === "stub" || meta.status === "experimental")) {
      fail(`${label}: non-experimental loadout includes ${meta.status} extension '${name}'`);
    }
  }
  const fw = includes.indexOf("tool-firewall");
  const gov = includes.indexOf("pentest-governance-domain");
  if (fw >= 0 && gov >= 0 && fw > gov) {
    fail(`${label}: tool-firewall must load before pentest-governance-domain`);
  }
}

// Every profile must keep the protections on, name only firewall values this kit knows, and carry the
// session-helpers extension: it owns /profile (transactional switch), /compaction and the once-per-session
// warning when auto-compaction is off or cannot work, so a profile without it has no way to see or fix
// either. Also prints how the profile manages compaction, so `npm run profile:check` documents the
// per-profile difference instead of leaving it implicit.
// Every mandatory protection (tool-firewall, secret-guard, protected-paths) must be included or carry
// a recorded exemption in packages/core/lib/protection-coverage.ts (tests/profile-protections-smoke.ts).
const REQUIRED_EVERYWHERE = requiredProfileExtensions();
const FIREWALL_POLICIES = ["coding", "pentest"];
const FIREWALL_MODES = ["auto", "manual"];
function checkSafetyAndCompaction(def: Record<string, unknown>, includes: readonly string[], label: string, name: string): void {
  for (const required of REQUIRED_EVERYWHERE) {
    if (!includes.includes(required)) fail(`${label}: '${required}' is missing (every profile must carry it)`);
  }
  for (const problem of protectionCoverageProblems(name, includes)) fail(`${label}: ${problem}`);
  if (!["relaxed", "balanced", "guarded", "strict"].includes(String(def.securityLevel))) fail(`${label}: unknown or missing securityLevel ${JSON.stringify(def.securityLevel)}`);
  const fw = def.firewall;
  if (fw !== undefined) {
    if (!isRecord(fw)) fail(`${label}: "firewall" must be an object`);
    else {
      if (fw.policy !== undefined && !FIREWALL_POLICIES.some((policy) => policy === fw.policy)) fail(`${label}: unknown firewall policy ${JSON.stringify(fw.policy)} (known: ${FIREWALL_POLICIES.join(", ")})`);
      if (fw.mode !== undefined && !FIREWALL_MODES.some((mode) => mode === fw.mode)) fail(`${label}: unknown firewall mode ${JSON.stringify(fw.mode)} (known: ${FIREWALL_MODES.join(", ")})`);
    }
  }
  const { skills } = def;
  if (isRecord(skills) && skills.only !== undefined && skills.exclude !== undefined) fail(`${label}: skills.only and skills.exclude are both set; only one may apply`);
  const managers: string[] = [];
  if (includes.includes("trigger-compact")) managers.push("trigger-compact (fixed 100k trigger, below pi's own when the window is larger)");
  if (includes.includes("custom-compaction")) managers.push("custom-compaction (no-op shim: warns only when PI_KIT_COMPACT_TEMPLATE is set)");
  if (includes.includes("compress")) managers.push("/compress");
  if (includes.includes("context-sieve")) managers.push("context-sieve (window-sized budgets)");
  if (includes.includes("finish-reason-retry")) managers.push("finish-reason-retry (explains an exhausted window, also in subagent children)");
  else console.log(`  note: ${label} has no finish-reason-retry, so subagent children of this profile get no explanation when their window fills`);
  console.log(`  compaction: pi auto-compaction (native, default on) + ${managers.length ? managers.join(", ") : "nothing else"}`);
}

// Step 1 ("install"): resolve every name and replay the real settings.json narrowing.
// Returns the resolved resource list, or null if resolution itself failed.
function checkInstallNarrowing(includes: string[], label: string): ResolvedExtension[] | null {
  let resolved: ResolvedExtension[];
  try {
    resolved = resolveProfile(includes);
  } catch (error) {
    fail(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-check-"));
  const settingsPath = path.join(dir, "settings.json");
  try {
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: [ROOT] }));
    mergePackageBlock(settingsPath, ROOT, resolved);
    // The narrowed package entry mergePackageBlock wrote: `{ source, extensions: [...] }`.
    const entry: unknown = readSettings(settingsPath).packages?.[0];
    const extensions = isRecord(entry) ? entry.extensions : undefined;
    const filter = Array.isArray(extensions) ? extensions.filter((p): p is string => typeof p === "string") : [];

    const expected = resolved
      .filter((r: ResolvedExtension) => r.avenue !== "external")
      .map((r: ResolvedExtension): string => extensionRelPath(r.name, r.avenue));
    const matches = filter.length === expected.length && expected.every((p) => filter.includes(p));
    if (!matches) {
      fail(`${label}: install-time filter [${filter.join(", ")}] does not match the resolved profile set [${expected.join(", ")}]`);
    }

    const allInRepoCount =
      fs.readdirSync(path.join(FIRST_PARTY_DIR)).filter((n) => !n.startsWith("_")).length +
      fs.readdirSync(path.join(THIRD_PARTY_DIR)).length;
    if (filter.length >= allInRepoCount) {
      fail(`${label}: install-time filter (${filter.length}) is not narrower than the full extension set (${allInRepoCount}) — profile scoping is not real`);
    } else {
      console.log(`  install: ${filter.length}/${allInRepoCount} in-repo extensions selected, ${resolved.length - expected.length} external`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return resolved;
}

// Step 2 ("load", stands in for "verify" offline): every resolved in-repo/vendor
// extension actually transpiles, imports, and registers against a fake pi API.
async function checkLoad(resolved: ResolvedExtension[], label: string): Promise<void> {
  const inRepo = resolved.filter((r: ResolvedExtension) => r.avenue !== "external");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-load-"));
  let loaded = 0;
  try {
    await withCwd(workspace, async () => {
      for (const r of inRepo) {
        const relativePath = extensionRelPath(r.name, r.avenue);
        try {
          const register = await loadExtension(relativePath);
          const pi = fakePi();
          register(pi.api);
          const sessionStart = pi.handlers.find("session_start");
          if (sessionStart) {
            await sessionStart({}, { hasUI: false, cwd: workspace, ui: { notify() {}, setStatus() {} }, sessionManager: { getEntries: () => [] } });
          }
          loaded++;
        } catch (error) {
          const detail = error instanceof Error ? error.stack || error.message : undefined;
          fail(`${label}: '${r.name}' failed to load/register: ${detail || String(error)}`);
        }
      }
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  console.log(`  load: ${loaded}/${inRepo.length} in-repo extensions registered cleanly`);
}

async function checkProfile(name: string): Promise<void> {
  console.log(`[profile-check] profile: ${name}`);
  const p = path.join(PROFILES_DIR, `${name}.json`);
  if (!fs.existsSync(p)) {
    fail(`profile ${name} not found`);
    return;
  }
  const def = parseJson(fs.readFileSync(p, "utf8"));
  if (!isRecord(def)) {
    fail(`profile ${name} is not a JSON object`);
    return;
  }
  const include = def.include ?? [];
  if (!Array.isArray(include) || !include.every((n): n is string => typeof n === "string")) {
    fail(`profile ${name}: "include" must be an array of extension names`);
    return;
  }
  const includes: string[] = include;
  if (includes.length === 0) {
    fail(`profile ${name} has no includes`);
    return;
  }
  checkStubsAndOrdering(includes, `profile ${name}`, !!def.experimental);
  checkSafetyAndCompaction(def, includes, `profile ${name}`, name);
  const resolved = checkInstallNarrowing(includes, `profile ${name}`);
  if (resolved) await checkLoad(resolved, `profile ${name}`);
}

async function main(): Promise<void> {
  if (profileName) {
    await checkProfile(profileName);
  } else {
    fail("specify --profile <name>");
  }
}

await main();

if (errors > 0) {
  console.error(`[profile-check] FAILED with ${errors} error(s)`);
  process.exit(1);
}
console.log("[profile-check] OK");
