#!/usr/bin/env node
/**
 * H-05 regression coverage: skill_archive must not permit path traversal or destructive
 * destination aliasing, and (PRO-12) must never delete an earlier archive of the same name. Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv, textOf } from "../packages/core/eval/harness.ts";
import type * as SkillForge from "../packages/extensions/src/skill-forge/index.ts";

async function archiveTool() {
  const register = await loadExtension("extensions/skill-forge/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi.tools.get("skill_archive");
}

// H-05 independent repro: skill_name="../../victim" must not let the tool delete an
// arbitrary reachable path (previously: source/destination both normalized to the same
// out-of-bounds "victim" directory, which was rm'd then the rename threw ENOENT).
async function testPathTraversalBlocked() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-skillarchive-"));
  const ws = path.join(root, "workspace");
  const victim = path.join(root, "victim");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "important.txt"), "do not delete me\n");
  try {
    const tool = await archiveTool();
    const res = await tool.execute("1", { skill_name: "../../victim" }, null, null, { cwd: ws });
    assert.ok(fs.existsSync(path.join(victim, "important.txt")), "traversal must not delete the victim directory");
    assert.match(textOf(res), /nothing to archive|not a valid skill name/, "traversal attempt must not report success");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Sanitization must reject a name that becomes empty/meaningless after stripping.
async function testDegenerateNameRejected() {
  const ws = tmpWorkspace("pi-kit-skillarchive-degenerate-");
  try {
    const tool = await archiveTool();
    const res = await tool.execute("1", { skill_name: "../.." }, null, null, { cwd: ws });
    assert.match(textOf(res), /not a valid skill name/, "an all-traversal name must be rejected outright");
  } finally {
    rmWorkspace(ws);
  }
}

// Legitimate archiving must still work end to end.
async function testLegitimateArchiveStillWorks() {
  const ws = tmpWorkspace("pi-kit-skillarchive-legit-");
  try {
    const proposalDir = path.join(ws, ".pi", "skill-proposals", "read-once-flow");
    fs.mkdirSync(proposalDir, { recursive: true });
    fs.writeFileSync(path.join(proposalDir, "SKILL.md"), "---\nname: read-once-flow\n---\n");

    const tool = await archiveTool();
    const res = await tool.execute("1", { skill_name: "read-once-flow", reason: "superseded by v2" }, null, null, { cwd: ws });

    assert.match(textOf(res), /archived 'read-once-flow'/);
    assert.ok(!fs.existsSync(proposalDir), "original proposal dir must be moved, not copied");
    const archived = path.join(ws, ".pi", "skill-archive", "read-once-flow");
    assert.ok(fs.existsSync(path.join(archived, "SKILL.md")), "archived skill content must be present");
    assert.match(fs.readFileSync(path.join(archived, "ARCHIVE_REASON.txt"), "utf8"), /superseded by v2/);
  } finally {
    rmWorkspace(ws);
  }
}

// PRO-12 regression: the tool is described as a non-destructive move, so archiving a second
// skill of the same name must never delete the earlier archived copy; it goes to a unique name.
async function testRepeatArchiveKeepsEarlierCopy() {
  const ws = tmpWorkspace("pi-kit-skillarchive-repeat-");
  try {
    const tool = await archiveTool();
    const archiveBase = path.join(ws, ".pi", "skill-archive");
    const proposalDir = path.join(ws, ".pi", "skill-proposals", "dup-skill");
    fs.mkdirSync(proposalDir, { recursive: true });
    fs.writeFileSync(path.join(proposalDir, "SKILL.md"), "first\n");
    assert.match(textOf(await tool.execute("1", { skill_name: "dup-skill" }, null, null, { cwd: ws })), /archived 'dup-skill' -> \.pi\/skill-archive\/dup-skill \(/);

    const skillDir = path.join(ws, ".pi", "skills", "dup-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "second\n");
    const res = textOf(await tool.execute("2", { skill_name: "dup-skill" }, null, null, { cwd: ws }));
    assert.equal(fs.readFileSync(path.join(archiveBase, "dup-skill", "SKILL.md"), "utf8"), "first\n", "the earlier archived copy must survive");
    assert.ok(!fs.existsSync(skillDir), "the second skill must be moved out of .pi/skills");
    const others = fs.readdirSync(archiveBase).filter((d) => d !== "dup-skill");
    assert.equal(others.length, 1, `the second archive must get its own directory (got ${others.join(", ")})`);
    const second = others[0] ?? "";
    assert.match(second, /^dup-skill-\d+$/);
    assert.equal(fs.readFileSync(path.join(archiveBase, second, "SKILL.md"), "utf8"), "second\n");
    assert.ok(res.includes(`-> .pi/skill-archive/${second} (`), `the result must name the unique directory (got ${res})`);
  } finally {
    rmWorkspace(ws);
  }
}

// CRT-1 regression: skill_score must run the kit's own eval harness, never the
// packages/core/eval/run.ts of the repository that is the session's working directory. The planted
// harness here writes a marker file and reports a perfect 1/1 score.
async function testScoreIgnoresRepoHarness() {
  const ws = tmpWorkspace("pi-kit-skillscore-");
  const home = tmpWorkspace("pi-kit-skillscore-home-");
  const restoreHome = setEnv("HOME", home);
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", path.join(home, ".pi", "agent"));
  try {
    const marker = path.join(ws, "PWNED");
    const planted = path.join(ws, "packages", "core", "eval");
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(
      path.join(planted, "run.ts"),
      `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\nconsole.log(JSON.stringify({ passed: 1, total: 1 }));\n`,
    );
    const register = await loadExtension("extensions/skill-forge/index.ts");
    const pi = fakePi();
    register(pi.api);
    const res = textOf(await pi.tools.get("skill_score").execute("1", { skill_name: "probe" }, null, null, { cwd: ws }));
    assert.ok(!fs.existsSync(marker), "skill_score must not execute the repository's packages/core/eval/run.ts");
    assert.doesNotMatch(res, /\(1\/1 fixtures passing\)/, `the score must not come from the planted harness (got ${res})`);
    assert.match(res, /eval baseline = [\d.]+ \(\d+\/\d+ fixtures passing\)/, `the kit's own harness must still score (got ${res})`);
    const record = fs.readFileSync(path.join(ws, ".pi", "skill-scores.jsonl"), "utf8");
    assert.match(record, /"skill":"probe"/, "the score record is still written under the session's .pi");
  } finally {
    restoreAgentDir();
    restoreHome();
    rmWorkspace(ws);
    rmWorkspace(home);
  }
}

// UXD-6: readTrace keeps only well-typed fields, so a numeric tool or an object target from a
// foreign or corrupt ledger line is not mined as a tool name or a repeated read.
async function testReadTraceDropsMistypedFields() {
  const ws = tmpWorkspace("pi-kit-skill-trace-");
  try {
    const mod = await loadModule<typeof SkillForge>("extensions/skill-forge/index.ts");
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    const lines = [
      JSON.stringify({ kind: "call", tool: 7, target: "src/a.ts" }),
      JSON.stringify({ kind: "call", tool: "read", target: { p: 1 } }),
      JSON.stringify({ kind: "call", tool: "read", target: { p: 1 } }),
      "null",
      JSON.stringify({ kind: "call", tool: "read", target: "src/b.ts" }),
    ];
    fs.writeFileSync(path.join(ws, ".pi", "trace.jsonl"), lines.join("\n") + "\n");
    const mined = mod.mineTrace(mod.readTrace(ws));
    assert.deepEqual(mined.topTools, [{ tool: "read", count: 3 }], "a numeric tool is not a tool name");
    assert.deepEqual(mined.repeatedReads, [], "an object target is not a repeated read");
  } finally {
    rmWorkspace(ws);
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["readTrace drops trace fields of the wrong type (UXD-6)", testReadTraceDropsMistypedFields],
  ["path traversal via skill_name must not delete an out-of-bounds path", testPathTraversalBlocked],
  ["a degenerate all-traversal name is rejected outright", testDegenerateNameRejected],
  ["a legitimate archive still moves the proposal and writes the reason", testLegitimateArchiveStillWorks],
  ["archiving a name twice keeps the earlier archived copy", testRepeatArchiveKeepsEarlierCopy],
  ["skill_score runs the kit's eval harness, not the working directory's", testScoreIgnoresRepoHarness],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

if (failed > 0) {
  console.error(`\n[skill-archive-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[skill-archive-smoke] all ${tests.length} checks passed`);
