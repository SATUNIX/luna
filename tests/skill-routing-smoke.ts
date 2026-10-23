#!/usr/bin/env node
// Skill routing eval: the automatic skill hints must match tests/skill-routing-fixtures.jsonl
// exactly (precision and recall 1.0), evaluated against the skills each profile actually loads.
// Hints are deterministic trigger matches, so any regression — a new trigger that fires on an
// ordinary coding prompt, or a lost trigger — fails here. Also pins the progressive-disclosure
// budget: the skills listed in the system prompt stay small.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadModule } from "../packages/core/eval/harness.ts";
import { excludedSkills, normalizeOverrides, loadProfileDef } from "../packages/core/lib/profiles.ts";
import { array, object, parseJsonAs, string } from "../packages/core/lib/guard.ts";
import type * as Match from "../packages/extensions/src/skill-router/match.ts";

// One line of tests/skill-routing-fixtures.jsonl.
const Fixture = object({ profile: string(), prompt: string(), expect: array(string()) });

const match = await loadModule<typeof Match>("extensions/skill-router/match.ts");
const skillsDir = path.join(ROOT, "packages", "kit", "skills");
const all = fs.readdirSync(skillsDir).filter((n) => fs.existsSync(path.join(skillsDir, n, "SKILL.md"))).map((n) => {
  const file = path.join(skillsDir, n, "SKILL.md");
  return match.parseSkillFile(fs.readFileSync(file, "utf8"), file, n);
});
const catalogFor = (profile: string): Match.SkillEntry[] => {
  const hidden = new Set(excludedSkills(loadProfileDef(profile), normalizeOverrides({})));
  return all.filter((s) => !hidden.has(s.name));
};

// 1. Fixture eval.
const fixtures = fs.readFileSync(path.join(ROOT, "tests", "skill-routing-fixtures.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => parseJsonAs(Fixture, l, "fixture"));
let tp = 0, fp = 0, fn = 0;
const failures: string[] = [];
for (const f of fixtures) {
  const got = match.matchTriggers(f.prompt, catalogFor(f.profile)).map((h) => h.name).sort();
  const want = [...f.expect].sort();
  for (const g of got) {
    if (want.includes(g)) tp++;
    else fp++;
  }
  for (const w of want) if (!got.includes(w)) fn++;
  if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`  [${f.profile}] "${f.prompt}"\n      expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
}
const precision = tp + fp ? tp / (tp + fp) : 1;
const recall = tp + fn ? tp / (tp + fn) : 1;
console.log(`  fixtures: ${fixtures.length} (${fixtures.filter((f) => f.expect.length === 0).length} negatives) · precision ${precision.toFixed(3)} · recall ${recall.toFixed(3)}`);
if (failures.length) {
  console.error(`[skill-routing-smoke] ${failures.length} mismatch(es):\n${failures.join("\n")}`);
  process.exit(1);
}

// 2. Every hidden skill is reachable: it has triggers or is found by skill_search on its own name.
for (const s of all.filter((x) => x.hidden)) {
  assert.ok(s.triggers.length > 0, `${s.name}: a hidden skill needs triggers`);
  for (const t of s.triggers) assert.ok(match.triggerRegex(t), `${s.name}: trigger ${t} must compile`);
  const top = match.searchSkills(s.description, all, 3).map((r) => r.skill.name);
  assert.ok(top.includes(s.name), `${s.name}: skill_search on its own description must find it (got ${top.join(", ")})`);
}

// 3. skill_search sanity on realistic queries.
const search = (q: string): string[] => match.searchSkills(q, all, 3).map((r) => r.skill.name);
assert.ok(search("review a new npm dependency for risk").includes("supply-chain-review"));
assert.ok(search("stuck repeating the same failing command").includes("self-reflection-and-recovery"));
assert.ok(search("find where a function is defined in a big repo").includes("codebase-navigation"));

// 4. Progressive-disclosure budget: listed skills stay small (~600 tokens of descriptions).
const listed = all.filter((s) => !s.hidden);
const chars = listed.reduce((n, s) => n + s.name.length + s.description.length + s.path.length + 40, 0);
assert.ok(listed.length <= 6, `at most 6 skills listed in the prompt (got ${listed.length}: ${listed.map((s) => s.name).join(", ")})`);
assert.ok(chars / 4 < 700, `listed skills cost ~${Math.round(chars / 4)} tokens; budget is 700`);

console.log(`[skill-routing-smoke] routing exact on all fixtures; ${all.length} skills, ${listed.length} listed (~${Math.round(chars / 4)} tokens), ${all.length - listed.length} on demand`);
