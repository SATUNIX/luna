#!/usr/bin/env node
// Docs accuracy smoke (Epic 7 Sprint 7.1): extract fenced code blocks from the onboarding
// docs, validate every documented command references a real script / profile / file, and
// actually resolve the documented default profile. Deterministic; needs no pi/docker/network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncJournal } from "../packages/core/journal.ts";
import { checkJournal, journalWarnings } from "../packages/core/lib/journal.ts";
import { installPinFiles, installPinVersions, readmeBadgeAltVersion, readmeBadgeVersion, setInstallPins, setReadmeBadgeVersion } from "../packages/core/lib/version-badge.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["README.md", "docs/getting-started.md", "docs/INSTALL.md", "packages/core/helpers/README.md"];

interface PackageJson {
  name: string;
  version: string;
  scripts?: Record<string, string>;
}

interface ExtensionManifest {
  name?: string;
  env?: string[];
}

interface ProfileJson {
  description?: string;
  include?: string[];
  skills?: { only?: string[] };
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as PackageJson;
const npmScripts = new Set(Object.keys(pkg.scripts ?? {}));

function fencedCommands(md: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of md.split(/\r?\n/)) {
    if (/^```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim();
    if (line) lines.push(line);
  }
  return lines;
}

// Inline markdown links that live in fenced code blocks are examples, not links.
function stripFences(md: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const raw of md.split(/\r?\n/)) {
    if (/^```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(raw);
  }
  return out.join("\n");
}

let checked = 0;
const skipped: string[] = [];

for (const rel of DOCS) {
  const md = fs.readFileSync(path.join(ROOT, rel), "utf8");
  for (const cmd of fencedCommands(md)) {
    const tokens = cmd.split(/\s+/);
    // Node resolves the installer path against the current working directory, so
    // `node luna/...` only works from the clone's parent and breaks from inside the clone.
    assert.ok(
      !(tokens[0] === "node" && tokens[1]?.startsWith("luna/")),
      `${rel}: '${cmd}' only resolves from the clone's parent; use the clone root ('cd luna' then 'node packages/core/install.ts ...')`,
    );
    const [bin, arg1] = tokens;

    // node packages/core/<script>.ts ... -> script must exist; --profile arg must be real.
    if (bin === "node" && arg1 !== undefined && /^packages\/core\/.+\.(?:mjs|ts)$/.test(arg1)) {
      assert.ok(fs.existsSync(path.join(ROOT, arg1)), `${rel}: documented script missing: ${arg1}`);
      const pIdx = tokens.indexOf("--profile");
      if (pIdx >= 0 && tokens[pIdx + 1]) {
        assert.ok(fs.existsSync(path.join(ROOT, "packages", "kit", "profiles", `${tokens[pIdx + 1]}.json`)), `${rel}: --profile ${tokens[pIdx + 1]} has no profiles/*.json`);
      }
      checked++;
      continue;
    }

    // npm run <script> -> must exist in package.json.
    if (bin === "npm" && arg1 === "run" && tokens[2]) {
      assert.ok(npmScripts.has(tokens[2]), `${rel}: 'npm run ${tokens[2]}' not in package.json scripts`);
      checked++;
      continue;
    }

    // docker compose -f <file> ... -> compose file must exist.
    if (bin === "docker" && tokens.includes("-f")) {
      const f = tokens[tokens.indexOf("-f") + 1];
      assert.ok(f !== undefined, `${rel}: docker compose -f has no file: ${cmd}`);
      assert.ok(fs.existsSync(path.join(ROOT, f)), `${rel}: docker compose file missing: ${f}`);
      checked++;
      continue;
    }

    // npx @satunix/pi-system --profile <name> -> the package's own installer; profile must be real.
    if (bin === "npx" && arg1 === pkg.name) {
      const pIdx = tokens.indexOf("--profile");
      if (pIdx >= 0 && tokens[pIdx + 1]) {
        assert.ok(fs.existsSync(path.join(ROOT, "packages", "kit", "profiles", `${tokens[pIdx + 1]}.json`)), `${rel}: --profile ${tokens[pIdx + 1]} has no profiles/*.json`);
      }
      checked++;
      continue;
    }

    // External / environment lines we can't run on a clean clone (pi, global npm, env=).
    if (bin === "pi" || (bin === "npm" && tokens.includes("-g")) || /=/.test(bin ?? "") || bin === "MEM0_API_URL") {
      skipped.push(cmd);
      continue;
    }

    skipped.push(cmd);
  }
}

// Relative-link existence check: every inline markdown link in a DOCS file must resolve on
// disk. External URLs, scheme-relative URLs, mailto: and bare #anchors are skipped.
let linksChecked = 0;
for (const rel of DOCS) {
  const md = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const dir = path.dirname(path.join(ROOT, rel));
  for (const m of stripFences(md).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const [, link] = m;
    assert.ok(link !== undefined, `${rel}: link regex lost its target group`);
    const rawTarget = link.trim().split(/\s+/)[0];
    if (!rawTarget) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(rawTarget)) continue; // absolute/external URL
    if (rawTarget.startsWith("#")) continue; // in-page anchor
    const target = rawTarget.split("#")[0];
    if (!target) continue;
    const resolved = path.resolve(dir, target);
    assert.ok(
      fs.existsSync(resolved),
      `${rel}: broken relative link '${rawTarget}' (resolved to ${path.relative(ROOT, resolved)})`,
    );
    linksChecked++;
  }
}

// Actually run the safe offline subset documented in the onboarding path.
for (const profileName of ["balanced", "engagement"]) execFileSync("node", ["packages/core/profile-check.ts", "--profile", profileName], { cwd: ROOT, stdio: "pipe" });

const extensionNames = new Set<string>();
for (const rootRel of ["packages/extensions/src", "packages/extensions/third_party"]) {
  const rootAbs = path.join(ROOT, rootRel);
  if (!fs.existsSync(rootAbs)) continue;
  for (const entry of fs.readdirSync(rootAbs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const manifestPath = path.join(rootAbs, entry.name, "extension.json");
    if (!fs.existsSync(manifestPath)) continue;
    const name = (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ExtensionManifest).name;
    if (name) extensionNames.add(name);
  }
}
const PROFILE_DIR = path.join(ROOT, "packages", "kit", "profiles");
for (const profileFile of fs.readdirSync(PROFILE_DIR).filter((f) => f.endsWith(".json"))) {
  const profile = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, profileFile), "utf8")) as ProfileJson;
  const include = new Set(profile.include ?? []);
  const description = profile.description ?? "";
  for (const name of extensionNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-]|$)`);
    if (!re.test(description)) continue;
    assert.ok(
      include.has(name),
      `${profileFile}: description names extension "${name}" that its include list lacks`,
    );
  }
}

// The README's version badge is the version in package.json (release.ts moves both), and
// the rewrite round-trips shields.io's `-` escaping.
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
assert.equal(readmeBadgeVersion(setReadmeBadgeVersion(readme, "1.2.3-rc_1.4")), "1.2.3-rc_1.4");
assert.equal(readmeBadgeAltVersion(setReadmeBadgeVersion(readme, "1.2.3-rc_1.4")), "1.2.3-rc_1.4");
assert.equal(setReadmeBadgeVersion(readme, pkg.version), readme);

// Every install pin in the public pages names the release in package.json. A pin to a tag that
// was never published (v0.2.4-beta.0) made the documented install fail; release.ts moves the
// pins with the version, so a stale one means a hand edit or a missed bump.
const pinFiles = installPinFiles(ROOT);
assert.ok(pinFiles.some((file) => installPinVersions(fs.readFileSync(file, "utf8")).length > 0), "the install docs pin a release");
for (const file of pinFiles) {
  const text = fs.readFileSync(file, "utf8");
  for (const version of installPinVersions(text)) assert.equal(version, pkg.version, `${path.relative(ROOT, file)} pins v${version}; package.json is ${pkg.version} (release.ts moves both)`);
  assert.deepEqual(installPinVersions(setInstallPins(text, "9.8.7-rc.1")), installPinVersions(text).map(() => "9.8.7-rc.1"));
}

// Docs that described behaviour the code does not have. Each guard is derived from the code where
// it can be, so a later change to the code moves the check with it.
const readRel = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const allExtensionSource = (() => {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) parts.push(fs.readFileSync(abs, "utf8"));
    }
  };
  walk(path.join(ROOT, "packages", "extensions", "src"));
  return parts.join("\n");
})();

// UXD-9: the recovery page names only the environment variables and the command the code has.
const recoveryMd = readRel("docs/recovery-orchestration-mode.md");
for (const name of new Set(recoveryMd.match(/PI_KIT_[A-Z0-9_]+/g) ?? [])) {
  assert.ok(allExtensionSource.includes(`"${name}"`) || allExtensionSource.includes(`process.env.${name}`),
    `docs/recovery-orchestration-mode.md names ${name}, which no extension reads`);
}

// INSTALL.md's environment table must name a real extension and a variable that extension's
// manifest declares. It once listed PI_KIT_GUIDELINES_FILE for `guidelines`, while the manifest,
// the code and the extension README all use PI_KIT_GUIDELINES_PATH, so anyone following the docs
// set a no-op variable.
const manifestsByName = new Map<string, ExtensionManifest>();
for (const rootRel of ["packages/extensions/src", "packages/extensions/third_party"]) {
  const rootAbs = path.join(ROOT, rootRel);
  if (!fs.existsSync(rootAbs)) continue;
  for (const entry of fs.readdirSync(rootAbs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const manifestPath = path.join(rootAbs, entry.name, "extension.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ExtensionManifest;
    if (manifest.name) manifestsByName.set(manifest.name, manifest);
  }
}
for (const line of readRel("docs/INSTALL.md").split(/\r?\n/)) {
  const m = /^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|\s*([a-z0-9-]+)\s*\|/.exec(line);
  if (!m) continue;
  const [, variable, extension] = m;
  assert.ok(variable !== undefined && extension !== undefined, "INSTALL.md env-table regex lost a capture group");
  const manifest = manifestsByName.get(extension);
  assert.ok(manifest, `docs/INSTALL.md lists ${variable} for extension "${extension}", which has no extension.json`);
  assert.ok(manifest.env?.includes(variable), `docs/INSTALL.md lists ${variable} for "${extension}", but its manifest env[] does not declare it`);
}

// PRO-7: pi loads the first of AGENTS.md / CLAUDE.md, so AGENTS.md must carry the safety rules
// a pi agent developing this repository needs.
const agentsMd = readRel("AGENTS.md");
for (const rule of ["PI_CODING_AGENT_DIR", "casts of untrusted data", "repo-wide formatter", "Releasing is an operator action"]) {
  assert.ok(agentsMd.includes(rule), `AGENTS.md must carry the contributor rule mentioning "${rule}" (pi does not load CLAUDE.md here)`);
}

// S17: no shipped page may name a delegation surface this release removed. The names are derived
// from the extension source where they can be: a tool or command still registered there is not
// removed, and the kit agent files are the role list. The parameters and the removed role are
// hard-coded because their removal is pinned by `tests/subagent-roles-isolation-smoke.ts` (neither
// key is in the `subagent` schema, and the kit has four roles).
const subagentSource = (() => {
  const parts: string[] = [];
  const dir = path.join(ROOT, "packages", "extensions", "third_party", "subagent");
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && entry.name.endsWith(".ts")) parts.push(fs.readFileSync(path.join(dir, entry.name), "utf8"));
  }
  return parts.join("\n");
})();
const registeredTools = new Set([...subagentSource.matchAll(/registerTool\(\{[\s\S]{0,200}?name:\s*"([^"]+)"/g)].map((m) => m[1] ?? ""));
const registeredCommands = new Set([...(allExtensionSource + "\n" + subagentSource).matchAll(/registerCommand\(\s*"([^"]+)"/g)].map((m) => m[1] ?? ""));
const kitRoles = fs.readdirSync(path.join(ROOT, "packages", "kit", "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
const subagentToolsSource = readRel("packages/extensions/third_party/subagent/tools.ts");

interface RemovedName {
  kind: "tool" | "command" | "parameter" | "role";
  name: string;
  replacement: string;
  pattern: RegExp;
  removed: boolean;
}
const removedNames: RemovedName[] = [
  { kind: "tool", name: "subagent_status", replacement: "`workflow_status`", pattern: /\bsubagent_status\b/, removed: !registeredTools.has("subagent_status") },
  { kind: "tool", name: "subagent_stop", replacement: "`workflow_control` with `action: \"stop\"`", pattern: /\bsubagent_stop\b/, removed: !registeredTools.has("subagent_stop") },
  { kind: "command", name: "/subagents", replacement: "`/workflows`", pattern: /\/subagents(?=$|[\s"'`)\].,;:])/, removed: !registeredCommands.has("subagents") },
  { kind: "command", name: "/subagent-stop", replacement: "`workflow_control` with `action: \"stop\"`", pattern: /\/subagent-stop(?=$|[\s"'`)\].,;:])/, removed: !registeredCommands.has("subagent-stop") },
  { kind: "command", name: "/reflect", replacement: "a bare `/boost`", pattern: /\/reflect(?=$|[\s"'`)\].,;:])/, removed: !registeredCommands.has("reflect") },
  { kind: "command", name: "/recover", replacement: "a bare `/boost`", pattern: /\/recover(?=$|[\s"'`)\].,;:])/, removed: !registeredCommands.has("recover") },
  { kind: "parameter", name: "chain", replacement: "`workflow_run {steps}`", pattern: /`chain`|(^|[^"\w])chain\s*:|chain mode|\bchain parameter\b/, removed: !/\bchain\s*:/.test(subagentToolsSource) },
  { kind: "parameter", name: "confirmProjectAgents", replacement: "`agentScope` with the project trust prompt", pattern: /\bconfirmProjectAgents\b/, removed: !subagentToolsSource.includes("confirmProjectAgents") },
  { kind: "role", name: "delegator", replacement: "`implementer`, or `workflow_run {steps}` for a chain", pattern: /\bdelegator\b/, removed: !kitRoles.includes("delegator") },
];
for (const item of removedNames) {
  assert.ok(item.removed, `tests/docs-smoke.ts: ${item.name} is registered again; update this guard and the migration notes (${item.replacement} is the replacement)`);
}
assert.ok(registeredTools.has("workflow_status") && registeredTools.has("workflow_control"), "the subagent extension registers workflow_status and workflow_control, the replacements this guard names");
assert.ok(registeredCommands.has("workflows") && !registeredCommands.has("workflow"), "the subagent extension registers /workflows and no /workflow alias");

// The vendored extension's SOURCE.md is its only provenance log: a squash that lands without a dated
// entry leaves the file's history incomplete and nothing pins it. The 2026-11-12 height budget in
// `wf-panel.ts` (commit 23725c2) must therefore be named by its own entry. The entry is isolated
// first, rather than matching the whole file, because all three facts have to travel together in one
// dated bullet instead of being scattered over unrelated entries.
const subagentSourceMd = readRel("packages/extensions/third_party/subagent/SOURCE.md");
const changeEntryStarts = [...subagentSourceMd.matchAll(/^ {2}- \*\*/gm)].map((m) => m.index ?? 0);
const changeEntries = changeEntryStarts.map((start, i) => subagentSourceMd.slice(start, changeEntryStarts[i + 1] ?? subagentSourceMd.length));
const heightEntry = changeEntries.find((entry) => entry.includes("wf-panel.ts") && entry.includes("23725c2")) ?? "";
assert.ok(
  heightEntry.length > 0,
  "SOURCE.md `- Changes:` needs one entry naming both `wf-panel.ts` and commit 23725c2: the 2026-11-12 height budget",
);
assert.match(
  heightEntry,
  /^ {2}- \*\*[^\n]*\(2026-11-12\):\*\*/,
  "the SOURCE.md entry naming `wf-panel.ts` and 23725c2 must be a bolded label dated 2026-11-12",
);

// Every vendored extension's SOURCE.md is its provenance log, so each must carry at least one
// bolded, dated change entry; a squash that lands without one leaves the file's history incomplete.
const thirdPartyDir = path.join(ROOT, "packages", "extensions", "third_party");
const sourceFiles = fs
  .readdirSync(thirdPartyDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/extensions/third_party/${entry.name}/SOURCE.md`);
const missingSourceFiles = sourceFiles.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
assert.deepEqual(
  missingSourceFiles,
  [],
  `every vendored extension directory needs a SOURCE.md provenance log; missing: ${missingSourceFiles.join(", ")}`,
);
const undatedSourceFiles = sourceFiles.filter(
  (rel) => !/^ *- \*\*[^\n]*\(\d{4}-\d{2}-\d{2}\):\*\*/m.test(readRel(rel)),
);
assert.deepEqual(
  undatedSourceFiles,
  [],
  `every vendored SOURCE.md needs a bolded dated change entry (for example \`  - **Vendored upstream (2026-06-17):** ...\`); undated: ${undatedSourceFiles.join(", ")}`,
);

const shippedPages: string[] = [];
const addPage = (rel: string): void => {
  if (!shippedPages.includes(rel)) shippedPages.push(rel);
};
const walkPages = (rel: string): void => {
  for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (child !== "docs/proposals") walkPages(child);
    } else if (entry.name.endsWith(".md")) addPage(child);
  }
};
addPage("README.md");
addPage("AGENTS.md");
walkPages("docs");
for (const pkg of fs.readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue;
  const rel = `packages/${pkg.name}/README.md`;
  if (fs.existsSync(path.join(ROOT, rel))) addPage(rel);
}
for (const group of ["src", "third_party"]) {
  const dir = path.join(ROOT, "packages", "extensions", group);
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `packages/extensions/${group}/${entry.name}/README.md`;
    if (fs.existsSync(path.join(ROOT, rel))) addPage(rel);
  }
}
for (const rel of shippedPages) {
  const lines = readRel(rel).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const item of removedNames) {
      if (!item.pattern.test(line)) continue;
      assert.fail(`${rel}:${index + 1}: names removed ${item.kind} ${item.name}; use ${item.replacement} instead (S17 surface trim; the migration notes are in CHANGELOG.md)`);
    }
  }
}

// S10 changed this claim: a repeat verification FAIL at a new revision returns the policy's `split`
// move from the verify-fail signal (a steer plus the workflow card). It is text, not a recovery
// activation, so recovery itself still starts only on a progress-guard escalation or a bare
// `/boost`. A first FAIL returns no move and a check that regresses sends nothing.
assert.ok(
  !/A verification that\s+still fails after an edit, or a check that regresses,\s+does not start recovery\./.test(readRel("docs/future-work.md")),
  "docs/future-work.md still says a repeat verification FAIL starts nothing; it returns the `split` steer at E3 and above (tests/verify-failclosed-smoke.ts, tests/workflow-strategy-smoke.ts)",
);
assert.ok(
  !/A verification that\s+still fails after an edit, or a check that regresses,\s+is not detected as a trigger/.test(readRel("docs/recovery-orchestration-mode.md")),
  "docs/recovery-orchestration-mode.md still says a repeat verification FAIL is not detected; the verify-fail signal returns `split` (tests/verify-failclosed-smoke.ts, tests/workflow-strategy-smoke.ts)",
);

// A-01 team journal: the committed journal must match the cycle reports, and the checker must
// fail on each drift a later cycle can introduce. Each fixture is its own temp tree.
assert.deepEqual(checkJournal(ROOT), [], "autonomy/JOURNAL.md disagrees with the cycle reports");

interface JournalFixture {
  root: string;
  write(rel: string, text: string): void;
  journal(lines: string[]): void;
}

function journalFixture(): JournalFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "luna-journal-"));
  const write = (rel: string, text: string): void => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const journal = (lines: string[]): void => {
    write("autonomy/JOURNAL.md", ["# Team journal", "", ...lines, ""].join("\n"));
  };
  return { root, write, journal };
}

function removeJournalFixture(fixture: JournalFixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

// A report whose entry is deleted fails, naming the key and the line to add.
{
  const fixture = journalFixture();
  try {
    fixture.write("autonomy/cycles/run-01/01/report.md", "# Report\n\nOutcome: successful\n");
    fixture.journal(["- run-01/01 | Board: none | successful | did a thing"]);
    fixture.journal([]);
    const problems = checkJournal(fixture.root);
    assert.ok(
      problems.some((problem) => problem.includes("report with no journal entry: run-01/01") && problem.includes("add: - run-01/01 | Board: none | successful |")),
      `journal checker missed a deleted entry: ${problems.join("; ")}`,
    );
  } finally {
    removeJournalFixture(fixture);
  }
}

// A decisions link to a file that is gone fails, naming the file.
{
  const fixture = journalFixture();
  try {
    fixture.write("autonomy/cycles/run-01/01/report.md", "# Report\n\nOutcome: successful\n");
    fixture.journal(["- run-01/01 | Board: none | successful | did a thing | decisions: autonomy/decisions/missing.md"]);
    const problems = checkJournal(fixture.root);
    assert.ok(
      problems.some((problem) => problem.includes("links a missing decisions file: autonomy/decisions/missing.md")),
      `journal checker missed a missing decisions file: ${problems.join("; ")}`,
    );
  } finally {
    removeJournalFixture(fixture);
  }
}

// An entry whose board IDs disagree with the report's Board lines fails.
{
  const fixture = journalFixture();
  try {
    fixture.write("autonomy/cycles/run-01/01/report.md", "# Report\n\nOutcome: successful\nBoard: A-91 done - fixed\n");
    fixture.journal(["- run-01/01 | Board: A-01 | successful | did a thing"]);
    const problems = checkJournal(fixture.root);
    assert.ok(
      problems.some((problem) => problem.includes("board mismatch") && problem.includes("entry says A-01") && problem.includes("report has A-91")),
      `journal checker missed a board mismatch: ${problems.join("; ")}`,
    );
  } finally {
    removeJournalFixture(fixture);
  }
}

// The legacy cycles/<NN>/report.md layout is covered too.
{
  const fixture = journalFixture();
  try {
    fixture.write("autonomy/cycles/03/report.md", "# Report\n\nOutcome: successful\n");
    fixture.journal([]);
    const problems = checkJournal(fixture.root);
    assert.ok(
      problems.some((problem) => problem.includes("report with no journal entry: 03")),
      `journal checker missed a legacy report: ${problems.join("; ")}`,
    );
  } finally {
    removeJournalFixture(fixture);
  }
}

// A host close-out report needs no entry: no failure, but a named warning.
{
  const fixture = journalFixture();
  try {
    fixture.write(
      "autonomy/cycles/run-01/01/report.md",
      "Outcome: partial\n\nHost close-out: the worker exited before recording report.md.\n",
    );
    fixture.journal([]);
    const problems = checkJournal(fixture.root);
    assert.deepEqual(problems, [], `a host close-out report produced a failure: ${problems.join("; ")}`);
    const warnings = journalWarnings(fixture.root);
    assert.ok(
      warnings.some((warning) => warning.includes("run-01/01")),
      `journal warnings missed a host close-out report: ${warnings.join("; ")}`,
    );
  } finally {
    removeJournalFixture(fixture);
  }
}

// syncJournal also skips a host close-out report: no line is derived or written.
{
  const fixture = journalFixture();
  try {
    fixture.write(
      "autonomy/cycles/run-01/01/report.md",
      "Outcome: partial\n\nHost close-out: the worker exited before recording report.md.\n",
    );
    fixture.journal([]);
    assert.deepEqual(syncJournal(fixture.root), [], "syncJournal wrote a line for a host close-out report");
    assert.deepEqual(checkJournal(fixture.root), [], "checkJournal rejected a host close-out report");
  } finally {
    removeJournalFixture(fixture);
  }
}

// An entry whose cycle directory exists but has no report.md fails, naming the key.
{
  const fixture = journalFixture();
  try {
    fs.mkdirSync(path.join(fixture.root, "autonomy/cycles/run-01/01"), { recursive: true });
    fixture.journal(["- run-01/01 | Board: none | successful | did a thing"]);
    const problems = checkJournal(fixture.root);
    assert.ok(
      problems.some((problem) => problem.includes("journal entry has no report: run-01/01")),
      `journal checker missed an entry with no report: ${problems.join("; ")}`,
    );
  } finally {
    removeJournalFixture(fixture);
  }
}

// Identical duplicate entries (a `merge=union` artifact) are accepted; only a key repeated
// with different content is a conflict.
{
  const fixture = journalFixture();
  try {
    fixture.write("autonomy/cycles/run-01/01/report.md", "# Report\n\nOutcome: successful\n");
    fixture.journal([
      "- run-01/01 | Board: none | successful | did a thing",
      "- run-01/01 | Board: none | successful | did a thing",
    ]);
    const problems = checkJournal(fixture.root);
    assert.deepEqual(problems, [], `identical duplicate entries produced a failure: ${problems.join("; ")}`);
  } finally {
    removeJournalFixture(fixture);
  }
}

// The same key twice with different content is a conflict, not a union-merge artifact.
{
  const fixture = journalFixture();
  try {
    fixture.write("autonomy/cycles/run-01/01/report.md", "# Report\n\nOutcome: successful\n");
    fixture.journal([
      "- run-01/01 | Board: none | successful | did a thing",
      "- run-01/01 | Board: none | successful | did another thing",
    ]);
    const problems = checkJournal(fixture.root);
    assert.ok(
      problems.some((problem) => problem.includes("conflicting journal entries: run-01/01")),
      `journal checker missed a conflicting duplicate: ${problems.join("; ")}`,
    );
  } finally {
    removeJournalFixture(fixture);
  }
}

// syncJournal derives the missing line, then checkJournal accepts it and a second sync is a no-op.
{
  const fixture = journalFixture();
  try {
    fixture.write("autonomy/cycles/run-01/01/report.md", "# Report\n\nOutcome: successful\n");
    fixture.journal([]);
    const wrote = syncJournal(fixture.root);
    assert.equal(wrote.length, 1, `syncJournal wrote ${wrote.length} lines, expected 1`);
    assert.deepEqual(checkJournal(fixture.root), [], "checkJournal rejected a derived line");
    assert.deepEqual(syncJournal(fixture.root), [], "syncJournal was not idempotent");
  } finally {
    removeJournalFixture(fixture);
  }
}

// A report may name a decisions file that does not exist: the derived line must not link it, so
// checkJournal still accepts the very line it derived (the missing-link regression).
{
  const fixture = journalFixture();
  try {
    fixture.write(
      "autonomy/cycles/run-01/01/report.md",
      "# Report\n\nOutcome: successful\n\nThe decision is in autonomy/decisions/missing.md.\n",
    );
    fixture.journal([]);
    const wrote = syncJournal(fixture.root);
    assert.equal(wrote.length, 1, `syncJournal wrote ${wrote.length} lines, expected 1`);
    const line = wrote[0] ?? "";
    assert.ok(!line.includes("missing.md"), `derived line linked a missing decisions file: ${line}`);
    assert.deepEqual(checkJournal(fixture.root), [], "checkJournal rejected the line it derived");
  } finally {
    removeJournalFixture(fixture);
  }
}

// A decisions file named by the report and present on disk is linked, and that link satisfies
// checkJournal's rule that every decisions file carries a Board line and is referenced.
{
  const fixture = journalFixture();
  try {
    fixture.write("autonomy/cycles/run-01/01/report.md", "# Report\n\nOutcome: successful\n\nSee autonomy/decisions/real.md.\n");
    fixture.write("autonomy/decisions/real.md", "Board: PG-20\n");
    fixture.journal([]);
    const wrote = syncJournal(fixture.root);
    const line = wrote[0] ?? "";
    assert.ok(line.includes("decisions: autonomy/decisions/real.md"), `derived line omitted the decisions link: ${line}`);
    assert.deepEqual(checkJournal(fixture.root), [], "checkJournal rejected a linked decisions file");
  } finally {
    removeJournalFixture(fixture);
  }
}

// syncJournal never follows a link: a committed `autonomy/JOURNAL.md` symlink is refused and the
// file it points at is left exactly as it was.
if (process.platform !== "win32") {
  const fixture = journalFixture();
  try {
    fixture.write("autonomy/cycles/run-01/01/report.md", "# Report\n\nOutcome: successful\n");
    fixture.write("outside.txt", "# Team journal\n");
    fs.symlinkSync(path.join(fixture.root, "outside.txt"), path.join(fixture.root, "autonomy", "JOURNAL.md"));
    assert.throws(() => syncJournal(fixture.root), /symbolic link/, "syncJournal wrote through a symlinked journal");
    assert.equal(fs.readFileSync(path.join(fixture.root, "outside.txt"), "utf8"), "# Team journal\n", "the link target was modified");
  } finally {
    removeJournalFixture(fixture);
  }
}

// A cycle directory name is untrusted: one that could forge a second journal line is refused
// before anything is written, and a journal created by syncJournal is an ordinary readable file.
{
  const fixture = journalFixture();
  try {
    fixture.write("autonomy/cycles/run-01/01/report.md", "# Report\n\nOutcome: successful\n");
    const wrote = syncJournal(fixture.root);
    assert.equal(wrote.length, 1, "syncJournal did not create the journal");
    const journal = path.join(fixture.root, "autonomy", "JOURNAL.md");
    const created = fs.readFileSync(journal, "utf8");
    assert.ok(created.startsWith("# Team journal\n"), "a created journal lacks the standard header");
    if (process.platform !== "win32") assert.equal(fs.statSync(journal).mode & 0o044, 0o044, "a created journal is not group and world readable");
    if (process.platform !== "win32") {
      fixture.write("autonomy/cycles/run-01/02\n- forged | Board: none | successful | forged/report.md", "# Report\n\nOutcome: successful\n");
      assert.throws(() => syncJournal(fixture.root), /cannot be a journal key/, "syncJournal accepted a forged cycle directory name");
      assert.equal(fs.readFileSync(journal, "utf8"), created, "a refused sync still changed the journal");
    }
  } finally {
    removeJournalFixture(fixture);
  }
}

console.log(`[docs-smoke] OK: ${checked} documented commands validated, ${linksChecked} relative links resolved; balanced profile resolved; ${skipped.length} external lines skipped; ${shippedPages.length} shipped pages name no removed delegation surface.`);
