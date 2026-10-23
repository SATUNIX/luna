#!/usr/bin/env node
// Kit prompt templates must pass the user's arguments through, and must not send a profile's model
// to tools or skills that profile cannot reach.
//   1. Every kit prompt template declares `argument-hint` and contains a pi argument placeholder.
//      pi's expandPromptTemplate only substitutes placeholders, so a template without one drops
//      `/code-plan add retry to fetchUser` down to its generic body.
//   2. Expanded through pi's own loader and expander, the argument reaches the model, and with no
//      argument a default is used (no empty "Task:" line, no unexpanded placeholder).
//   3. A profile that allowlists skills hidden by `disable-model-invocation` loads `skill-router`,
//      the only way the model can find them; a profile that lists the `memory` skill loads a
//      memory extension that registers `memory_save`.
//   4. A prompt shown in a profile without `pentest-governance-domain` only calls the
//      `pi_system_governance` MCP tools conditionally.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandPromptTemplate, loadPromptTemplates } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js";
import { excludedPrompts, excludedSkills, kitPrompts, listProfiles, loadProfileDef, normalizeOverrides, PROMPTS_DIR, SKILLS_DIR } from "../packages/core/lib/profiles.ts";

let checks = 0;
const ok = (name: string): void => {
  checks += 1;
  console.log(`  ok  ${name}`);
};

// The placeholder forms pi's substituteArgs replaces ($1, $@, $ARGUMENTS, ${@:-default}, ${@:N}).
const PLACEHOLDER = /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-args-"));
try {
  const names = kitPrompts();
  assert.ok(names.length >= 20, `expected the kit's prompt templates, found ${names.length}`);
  const { templates, diagnostics } = loadPromptTemplates({
    cwd: tmp,
    agentDir: path.join(tmp, "agent"),
    promptPaths: names.map((n) => path.join(PROMPTS_DIR, `${n}.md`)),
    includeDefaults: false,
  });
  assert.deepEqual(diagnostics, [], "pi loads every kit prompt template without a diagnostic");
  assert.deepEqual(templates.map((t) => t.name).sort(), names, "pi loads one template per kit prompt file");

  // 1. Declared and placeheld.
  for (const t of templates) {
    assert.ok(t.argumentHint, `${t.name}: declares argument-hint`);
    assert.match(t.content, PLACEHOLDER, `${t.name}: declares argument-hint "${t.argumentHint ?? ""}" but has no $@ / \${@:-...} placeholder`);
  }
  ok(`all ${templates.length} kit prompt templates declare argument-hint and contain a placeholder`);

  // 2. Expansion with and without an argument.
  const arg = "add retry to fetchUser in src/api.ts";
  for (const t of templates) {
    const withArg = expandPromptTemplate(`/${t.name} ${arg}`, templates);
    assert.ok(withArg.includes(arg), `${t.name}: the argument reaches the expanded prompt`);
    const bare = expandPromptTemplate(`/${t.name}`, templates);
    assert.doesNotMatch(bare, PLACEHOLDER, `${t.name}: no unexpanded placeholder without an argument`);
    // Substitution keeps line numbers, so each placeholder line can be checked in the output.
    const bareLines = bare.split("\n");
    t.content.split("\n").forEach((line, i) => {
      if (PLACEHOLDER.test(line)) assert.doesNotMatch(bareLines[i] ?? "", /:\s*$/, `${t.name}: argument line is empty without an argument: ${line}`);
    });
  }
  ok("pi's expander passes the argument through, and uses a default without one");

  // 3. Profiles can reach the skills and tools they list.
  const hiddenSkills = new Set(fs.readdirSync(SKILLS_DIR).filter((n) => {
    const file = path.join(SKILLS_DIR, n, "SKILL.md");
    return fs.existsSync(file) && /^disable-model-invocation:\s*true\s*$/m.test(fs.readFileSync(file, "utf8"));
  }));
  const memoryExtensions = ["memory-vault"];
  for (const name of listProfiles()) {
    const def = loadProfileDef(name);
    const include = def.include ?? [];
    const off = new Set(excludedSkills(def, normalizeOverrides({})));
    const shown = fs.readdirSync(SKILLS_DIR).filter((n) => fs.existsSync(path.join(SKILLS_DIR, n, "SKILL.md")) && !off.has(n));
    const unreachable = shown.filter((s) => hiddenSkills.has(s));
    if (unreachable.length) assert.ok(include.includes("skill-router"), `${name}: loads ${unreachable.length} skills hidden from the system prompt (${unreachable.join(", ")}) but not skill-router`);
    if (shown.includes("memory")) assert.ok(include.some((e) => memoryExtensions.includes(e)), `${name}: lists the memory skill but loads no extension that registers memory_save`);
  }
  ok("every profile that lists hidden skills loads skill-router, and every profile listing the memory skill loads memory-vault");

  // 4. Governance MCP calls are conditional outside pentest.
  const conditional = "If the `pi_system_governance` MCP server is available";
  for (const name of listProfiles()) {
    const def = loadProfileDef(name);
    if ((def.include ?? []).includes("pentest-governance-domain")) continue;
    const off = new Set(excludedPrompts(def, normalizeOverrides({})));
    for (const t of templates) {
      if (off.has(t.name)) continue;
      for (const line of t.content.split("\n")) {
        if (line.includes("pi_system_governance.")) assert.ok(line.includes(conditional), `${name}/${t.name}: calls a pi_system_governance tool unconditionally: ${line.trim()}`);
      }
    }
  }
  ok("prompts shown outside pentest only call pi_system_governance tools when the server is available");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`prompt-arguments-smoke: ${checks} checks passed`);
