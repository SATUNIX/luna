#!/usr/bin/env node
// Workflow registry with script workflows (packages/extensions/third_party/subagent/workflow.ts and
// workflow-tools.ts, docs/workflows.md "Script workflows").
//   1. `.js` scripts are found in the kit, user (<agent dir>/workflows) and project (.pi/workflows)
//      directories by their literal meta; `.claude/workflows` is never read.
//   2. one namespace: a later directory overrides an earlier one across kinds; a same-directory
//      name clash, a bad meta and an oversized script are reported, not listed.
//   3. `workflow_run list` shows scripts; `workflow_run` refuses to run one (no engine yet).
//   4. openScriptWorkflow: kit and user scripts open without a prompt; project scripts go through
//      the No-first trust gate, nested `workflow(name)` calls included (the prompt names the caller),
//      even when a project script shadows a kit name; the returned source is the exact bytes of
//      the checked digest; a trusted digest opens headless until the file changes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, rmWorkspace, setEnv, textOf, tmpWorkspace, fakePi, loadExtension, type FakePiApi } from "../packages/core/eval/harness.ts";
import { discoverWorkflows, MAX_SCRIPT_BYTES, workflowDirs } from "../packages/extensions/third_party/subagent/workflow.ts";
import { openScriptWorkflow, TRUST_CHOICES } from "../packages/extensions/third_party/subagent/workflow-tools.ts";

const ws = tmpWorkspace("pi-kit-wf-registry-");
const kitDir = path.join(ws, "kit-workflows");
const agentHome = path.join(ws, "agent");
const project = path.join(ws, "project");
const restores = [isolateKitEnv(), setEnv("HOME", path.join(ws, "home")), setEnv("PI_CODING_AGENT_DIR", agentHome), setEnv("PI_KIT_WORKFLOWS_DIR", kitDir)];
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

const script = (name: string, description: string, body = "return 1") => `export const meta = { name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)}, whenToUse: "tests", phases: [{ title: "One" }] }\n${body}\n`;
const yaml = (name: string) => `---\nname: ${name}\ndescription: yaml ${name}\nsteps:\n  - id: a\n    agent: scout\n    task: hi\n---\n`;
const put = (dir: string, file: string, text: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const userDir = path.join(agentHome, "workflows");
const projDir = path.join(project, ".pi", "workflows");

try {
  // 1 + 2. Discovery.
  put(kitDir, "understand.js", script("understand", "kit understand"));
  put(kitDir, "review.js", script("review", "kit review"));
  put(kitDir, "plan.md", yaml("plan"));
  put(userDir, "review.md", yaml("review")); // user YAML overrides the kit script
  put(userDir, "mine.js", script("mine", "user script"));
  put(userDir, "clash.md", yaml("clash"));
  put(userDir, "clash.js", script("clash", "same dir clash"));
  put(projDir, "plan.js", script("plan", "project plan script")); // project script overrides kit YAML
  put(projDir, "understand.js", script("understand", "project shadow"));
  put(projDir, "local.js", script("local", "project local", 'await workflow("understand")'));
  put(projDir, "broken.js", "export const meta = { name: someVar, description: 'd' }\n");
  put(projDir, "huge.js", script("huge", "too big", `// ${"x".repeat(MAX_SCRIPT_BYTES)}`));
  fs.mkdirSync(path.join(projDir, "folder.js"), { recursive: true });
  // A FIFO named like a script is skipped without blocking the open on a writer that never comes.
  const fifo = process.platform !== "win32" && spawnSync("mkfifo", [path.join(projDir, "pipe.js")]).status === 0;
  put(path.join(project, ".claude", "workflows"), "claude.js", script("claude-only", "must not be read"));

  assert.ok(workflowDirs(project).every((d) => !d.dir.split(path.sep).includes(".claude")), "no .claude directory is a workflow directory");
  const found = discoverWorkflows(project);
  const scripts = new Map(found.scripts.map((s) => [s.name, s]));
  assert.deepEqual([...scripts.keys()], ["local", "mine", "plan", "understand"]);
  assert.deepEqual(found.workflows.map((w) => w.name), ["clash", "review"]);
  assert.equal(scripts.get("understand")?.source, "project");
  assert.equal(scripts.get("understand")?.description, "project shadow");
  assert.equal(scripts.get("plan")?.source, "project");
  assert.equal(scripts.get("mine")?.source, "user");
  assert.deepEqual(scripts.get("mine")?.phases, [{ title: "One", detail: undefined, model: undefined }]);
  assert.equal(scripts.get("mine")?.whenToUse, "tests");
  assert.equal(found.workflows.find((w) => w.name === "review")?.source, "user");
  assert.ok(!scripts.has("claude-only"), ".claude/workflows is not read");
  const errs = found.errors.join("\n");
  assert.match(errs, /clash\.js: name "clash" is already used/);
  assert.match(errs, /broken\.js: "someVar" is not a literal/);
  assert.match(errs, /huge\.js: larger than/);
  assert.doesNotMatch(errs, /folder\.js/);
  assert.doesNotMatch(errs, /pipe\.js/);
  ok("scripts load from kit, user and project dirs by literal meta; .claude/workflows is ignored");
  ok("one namespace with later-directory override; clashes, bad meta and oversized scripts are reported");
  ok(`a directory${fifo ? " and a FIFO" : ""} named *.js are skipped silently (type and size come from the opened file)`);

  // 3. Tools.
  const subagent = await loadExtension<(api: FakePiApi) => void>("vendor/subagent/index.ts");
  const pi = fakePi();
  subagent(pi.api);
  const tool = pi.tools.get("workflow_run");
  assert.ok(tool);
  const listed = textOf(await tool.execute("1", { name: "list" }, undefined, undefined, { cwd: project, hasUI: false }));
  assert.match(listed, /- mine \(user, script\): user script — use when: tests/);
  assert.match(listed, /- understand \(project, script\): project shadow/);
  assert.match(listed, /broken\.js/);
  const refused = await tool.execute("2", { name: "mine" }, undefined, undefined, { cwd: project, hasUI: false });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /is a script workflow; run it with the workflow tool/);
  ok("workflow_run lists scripts and refuses to run one");

  // 4. The trust gate.
  const prompts: Array<{ title: string; options: string[] }> = [];
  const ui = (answer: string | undefined) => ({
    cwd: project,
    hasUI: true,
    ui: {
      select: (title: string, options: string[]) => {
        prompts.push({ title, options });
        return Promise.resolve(answer);
      },
      confirm: () => Promise.reject(new Error("confirm must not be used: it defaults to Yes")),
    },
  });
  const headless = { cwd: project, hasUI: false };

  const mine = await openScriptWorkflow(headless, "mine");
  assert.equal(mine.error, undefined, "a user script opens headless");
  assert.equal(prompts.length, 0);
  assert.match((await openScriptWorkflow(headless, "review")).error ?? "", /YAML workflow, not a script/);
  assert.match((await openScriptWorkflow(headless, "nope")).error ?? "", /Unknown script workflow/);

  assert.match((await openScriptWorkflow(headless, "local")).error ?? "", /needs interactive approval or a digest grant/);
  for (const answer of [TRUST_CHOICES[0], undefined]) {
    assert.match((await openScriptWorkflow(ui(answer), "local")).error ?? "", /Cancelled: project workflow not approved/);
  }
  assert.deepEqual(prompts[0]?.options, ["No, don't run it", "Run once", "Trust this digest"], "No is the first (default) option");
  assert.match(prompts[0]?.title ?? "", /Run project workflow "local"\? project local/);
  const once = await openScriptWorkflow(ui(TRUST_CHOICES[1]), "local");
  assert.ok(once.def, "Run once opens it");
  const bytes = fs.readFileSync(path.join(projDir, "local.js"));
  assert.equal(once.source, bytes.toString("utf8"));
  assert.equal(once.digest, crypto.createHash("sha256").update(bytes).digest("hex"));
  ok("project scripts go through the No-first gate; the source returned is the checked bytes");

  // A kit-or-project name: the nested call from "local" resolves to the project shadow of the kit
  // "understand" and is gated too, with the caller named in the prompt.
  const asked = prompts.length;
  assert.match((await openScriptWorkflow(headless, "understand", "local")).error ?? "", /needs interactive approval/);
  assert.match((await openScriptWorkflow(ui(TRUST_CHOICES[0]), "understand", "local")).error ?? "", /Cancelled/);
  assert.equal(prompts.length, asked + 1);
  assert.match(prompts[asked]?.title ?? "", /Run project workflow "understand" \(called by workflow "local"\)\? project shadow/);
  ok("nested workflow(name) calls that resolve to a project script are gated, shadowed kit names included");

  const trusted = await openScriptWorkflow(ui(TRUST_CHOICES[2]), "understand", "local");
  assert.ok(trusted.def);
  const before = prompts.length;
  assert.ok((await openScriptWorkflow(headless, "understand", "local")).def, "a trusted digest opens headless");
  assert.equal(prompts.length, before);
  fs.appendFileSync(path.join(projDir, "understand.js"), "// edited\n");
  assert.match((await openScriptWorkflow(headless, "understand")).error ?? "", /needs interactive approval/, "an edited script needs a new grant");
  ok("Trust this digest opens headless until the script changes");
} finally {
  for (const restore of restores.reverse()) restore();
  rmWorkspace(ws);
}

console.log(`workflow-registry-smoke: ${checks} checks passed`);
