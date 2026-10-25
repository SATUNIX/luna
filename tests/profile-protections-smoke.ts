#!/usr/bin/env node
/**
 * Mandatory-protection coverage: every MANDATORY_PROTECTION_EXTENSIONS entry is in every
 * shipped profile, or that profile carries a recorded, reasoned exemption in
 * packages/core/lib/protection-coverage.ts. packages/core/profile-check.ts applies the same rule
 * per profile in check:all and CI.
 *
 *  - every shipped profile passes the rule as committed;
 *  - balanced and autonomous load secret-guard (no exemption), and its manifest names exactly them;
 *  - dropping secret-guard from balanced (no exemption) fails, as does an exemption with no
 *    reason, a stale exemption for an included protection, and an exemption naming a
 *    non-protection; every exemption names a shipped profile;
 *  - the delegation guard and the overrides check use the same protection list.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv } from "../packages/core/eval/harness.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import { PROFILES_DIR, FIRST_PARTY_DIR } from "../packages/core/lib/paths.ts";
import { MANDATORY_PROTECTION_EXTENSIONS } from "../packages/core/lib/profiles.ts";
import { PROTECTION_EXEMPTIONS, protectionCoverageProblems } from "../packages/core/lib/protection-coverage.ts";
import { MANDATORY_PROTECTIONS } from "../packages/extensions/src/delegation-guard/index.ts";

const restoreEnv = isolateKitEnv();

function includesOf(name: string): string[] {
  const def = parseJson(fs.readFileSync(path.join(PROFILES_DIR, `${name}.json`), "utf8"));
  assert.ok(isRecord(def) && Array.isArray(def.include), `${name}.json has an include list`);
  return def.include.filter((item): item is string => typeof item === "string");
}

try {
  assert.deepEqual([...MANDATORY_PROTECTIONS], [...MANDATORY_PROTECTION_EXTENSIONS], "delegation-guard and the overrides check name the same mandatory protections");

  const shipped = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json")).sort();
  assert.ok(shipped.length >= 7, "the shipped profiles were found");
  for (const name of shipped) {
    assert.deepEqual(protectionCoverageProblems(name, includesOf(name)), [], `profile ${name} covers every mandatory protection or records why not`);
  }
  for (const name of Object.keys(PROTECTION_EXEMPTIONS)) assert.ok(shipped.includes(name), `exemption for '${name}' names a shipped profile`);

  for (const name of ["balanced", "autonomous"]) {
    assert.ok(includesOf(name).includes("secret-guard"), `${name} loads secret-guard`);
    assert.ok(!Object.hasOwn(PROTECTION_EXEMPTIONS, name), `${name} carries no exemption`);
  }
  const manifest = parseJson(fs.readFileSync(path.join(FIRST_PARTY_DIR, "secret-guard", "extension.json"), "utf8"));
  assert.ok(isRecord(manifest) && Array.isArray(manifest.profiles));
  const declared: unknown[] = manifest.profiles;
  assert.deepEqual(declared.filter((p): p is string => typeof p === "string").sort(), ["autonomous", "balanced"], "secret-guard's manifest names the profiles that load it");

  // The rule can fail: each class of gap is reported.
  const balanced = includesOf("balanced");
  const withoutGuard = balanced.filter((n) => n !== "secret-guard");
  assert.match(protectionCoverageProblems("balanced", withoutGuard).join("\n"), /'secret-guard' is missing and has no recorded exemption/);
  assert.match(protectionCoverageProblems("balanced", withoutGuard, { balanced: { "secret-guard": "  " } }).join("\n"), /no reason/);
  assert.deepEqual(protectionCoverageProblems("balanced", withoutGuard, { balanced: { "secret-guard": "reviewed reason" } }), []);
  assert.match(protectionCoverageProblems("balanced", balanced, { balanced: { "secret-guard": "reviewed reason" } }).join("\n"), /stale exemption/);
  assert.match(protectionCoverageProblems("balanced", balanced, { balanced: { todo: "not a protection" } }).join("\n"), /not a mandatory protection/);
  assert.match(protectionCoverageProblems("quick", includesOf("quick").filter((n) => n !== "tool-firewall")).join("\n"), /'tool-firewall' is missing/);
  // An exemption table keyed "__proto__" or "constructor" never matches a profile by inheritance.
  assert.match(protectionCoverageProblems("constructor", []).join("\n"), /'tool-firewall' is missing/);
  console.log("[profile-protections-smoke] OK (every shipped profile covers the mandatory protections or records why; each gap class fails)");
} finally {
  restoreEnv();
}
