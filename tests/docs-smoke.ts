#!/usr/bin/env node
// Docs accuracy smoke (Epic 7 Sprint 7.1): extract fenced code blocks from the onboarding
// docs, validate every documented command references a real script / profile / file, and
// actually resolve the documented default profile. Deterministic; needs no pi/docker/network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installPinFiles, installPinVersions, readmeBadgeAltVersion, readmeBadgeVersion, setInstallPins, setReadmeBadgeVersion } from "../packages/core/lib/version-badge.ts";
import { skillsCatalogueContent } from "../packages/core/skills-catalogue.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["README.md", "docs/getting-started.md", "docs/INSTALL.md", "packages/core/helpers/README.md"];

interface PackageJson {
  name: string;
  version: string;
  scripts?: Record<string, string>;
}

interface ExtensionManifest {
  name?: string;
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
    // `node pi-system/...` only works from the clone's parent and breaks from inside the clone.
    assert.ok(
      !(tokens[0] === "node" && tokens[1]?.startsWith("pi-system/")),
      `${rel}: '${cmd}' only resolves from the clone's parent; use the clone root ('cd pi-system' then 'node packages/core/install.ts ...')`,
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
execFileSync("node", ["packages/core/profile-check.ts", "--profile", "balanced"], { cwd: ROOT, stdio: "pipe" });

// Secret-guard ships in the balanced and autonomous profiles only (the other profiles record an
// exemption in packages/core/lib/protection-coverage.ts). Keep the docs honest about that — the
// security table must not claim it is in "every profile", and no profile description may name an
// extension its own include list lacks.
const securityMd = fs.readFileSync(path.join(ROOT, "docs", "security.md"), "utf8");
for (const line of securityMd.split(/\r?\n/)) {
  if (!line.includes("secret-guard")) continue;
  assert.ok(
    !/every profile/i.test(line),
    "docs/security.md must not claim secret-guard ships in every profile (it is opt-in/experimental)",
  );
}

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

// Regression guards for doc-drift fixes (commit cb77757 + companion carry-over wording).
// The injection-monopoly bullet once contained a duplicated, mangled fragment; ensure it
// never comes back. The companion-carry-over sentence must not claim a skipped companion
// is never recorded at all (earlier installs carry it over in the marker).
const capabilityMd = fs.readFileSync(path.join(ROOT, "docs", "capability-research-workflow.md"), "utf8");
assert.ok(
  !capabilityMd.includes("includeInCompact}`); context-sieve assembles them under a token budget"),
  "docs/capability-research-workflow.md contains the orphaned duplicated injection-monopoly fragment",
);
const profilesMd = fs.readFileSync(path.join(ROOT, "docs", "architecture", "profiles-and-install.md"), "utf8");
assert.ok(
  !profilesMd.includes("is not recorded, because this install never registered it"),
  "docs/architecture/profiles-and-install.md still claims a skipped companion is not recorded (earlier installs carry it over)",
);
// TOO-1: firewall.json and security.json are machine-global, so a --scope project install leaves
// them alone and a project /profile is not verified against them; the page must not say otherwise.
assert.ok(
  !profilesMd.includes("Inst->>Files: write firewall.json from the profile"),
  "docs/architecture/profiles-and-install.md still shows every install writing firewall.json (only --scope global does)",
);
assert.ok(
  !profilesMd.includes("- `firewall.json` parses as an object, its policy is known and matches the profile"),
  "docs/architecture/profiles-and-install.md still says verifySwitch checks firewall.json for every switch (global switches only)",
);
assert.match(
  profilesMd,
  /a `--scope project` install never writes them/,
  "docs/architecture/profiles-and-install.md must say a --scope project install leaves firewall.json and security.json alone",
);

// The README's version badge is the version in package.json (release.ts moves both), and
// the rewrite round-trips shields.io's `-` escaping.
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
assert.equal(readmeBadgeVersion(readme), pkg.version, "README version badge must match package.json (release.ts updates both)");
assert.equal(readmeBadgeAltVersion(readme), pkg.version, "README version badge alt text must match package.json (release.ts updates both)");
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
assert.ok(!/\/unstuck\b/.test(recoveryMd), "docs/recovery-orchestration-mode.md offers /unstuck, which no extension registers");

// SEC-8: secret-guard ships in balanced and autonomous only, and blocks reads of credential files.
const secretGuardSrc = readRel("packages/extensions/src/secret-guard/index.ts");
const secretGuardReadme = readRel("packages/extensions/src/secret-guard/README.md");
const secretGuardManifest: unknown = JSON.parse(readRel("packages/extensions/src/secret-guard/extension.json"));
assert.ok(typeof secretGuardManifest === "object" && secretGuardManifest !== null && "profiles" in secretGuardManifest && "summary" in secretGuardManifest
  && typeof secretGuardManifest.summary === "string", "secret-guard's extension.json has profiles and a summary");
assert.deepEqual(secretGuardManifest.profiles, ["balanced", "autonomous"], "secret-guard's manifest lists balanced and autonomous; update these guards if that changes");
assert.match(secretGuardReadme, /balanced.{0,40}autonomous/s, "secret-guard README must name the profiles that load it");
for (const [where, text] of [["index.ts header", secretGuardSrc.slice(0, 1200)], ["README.md", secretGuardReadme], ["extension.json summary", secretGuardManifest.summary]] as const) {
  assert.ok(!/ships in every profile|universal/i.test(text), `secret-guard ${where} must not call it universal or say it ships in every profile (it is in balanced and autonomous only)`);
}
assert.ok(!/Reading secret files/i.test(secretGuardReadme), "secret-guard README must not say reads of secret files are allowed (index.ts blocks them)");
for (const name of new Set(secretGuardReadme.match(/`([A-Z][A-Z0-9_]*_PATTERNS)`/g) ?? [])) {
  const bare = name.slice(1, -1);
  assert.ok(new RegExp(`const ${bare}\\b`).test(secretGuardSrc), `secret-guard README names ${bare}, which index.ts does not define`);
}
assert.match(secretGuardReadme, /tests\/secret-guard-smoke\.ts/, "secret-guard README must name the test that pins its behaviour");

// ORC-12: custom-compaction only warns; its SOURCE.md must not claim it overrides compaction.
const customCompactionSource = readRel("packages/extensions/src/custom-compaction/SOURCE.md");
assert.ok(!/overrides context compaction/i.test(customCompactionSource), "custom-compaction SOURCE.md claims it overrides compaction");
assert.match(customCompactionSource, /no-op/, "custom-compaction SOURCE.md must say plainly that it is a no-op");
const customCompactionProfiles = fs.readdirSync(PROFILE_DIR).filter((f) => f.endsWith(".json")
  && fs.readFileSync(path.join(PROFILE_DIR, f), "utf8").includes('"custom-compaction"'));
assert.deepEqual(customCompactionProfiles, ["balanced.json"], "custom-compaction SOURCE.md says only the balanced profile ships it");

// PRO-7: pi loads the first of AGENTS.md / CLAUDE.md, so AGENTS.md must carry the safety rules
// a pi agent developing this repository needs.
const agentsMd = readRel("AGENTS.md");
for (const rule of ["PI_CODING_AGENT_DIR", "casts of untrusted data", "repo-wide formatter", "Releasing is an operator action"]) {
  assert.ok(agentsMd.includes(rule), `AGENTS.md must carry the contributor rule mentioning "${rule}" (pi does not load CLAUDE.md here)`);
}

// UXD-8: the web console is compiled by build:web, lives in packages/web-ui, and the control
// centre's main page count matches its model.
const webReadme = readRel("packages/web-ui/README.md");
const webConsoleMd = readRel("docs/web-console.md");
for (const [where, text] of [["packages/web-ui/README.md", webReadme], ["docs/web-console.md", webConsoleMd]] as const) {
  assert.ok(!/no build step/i.test(text), `${where} says "no build step" (browser code is compiled by npm run build:web)`);
}
assert.ok(!webReadme.includes("cd pi-console"), "packages/web-ui/README.md tells users to cd into pi-console, which does not exist");
assert.ok(webReadme.includes("PI_CONSOLE_PROJECT_AGENTS") && webReadme.includes("packages/kit/agents"),
  "packages/web-ui/README.md must name the console's project agent directory (packages/kit/agents, PI_CONSOLE_PROJECT_AGENTS)");
const modelTs = readRel("packages/extensions/src/control-center/model.ts");
const mainPages = (modelTs.match(/id: "page\.[a-z]+", [^}]*page: "main", kind: "page"/g) ?? []).length;
const numberWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const pageWord = numberWords[mainPages];
assert.ok(pageWord !== undefined && mainPages > 0, `control-center model has ${mainPages} main pages`);
assert.match(readRel("docs/control-center.md"), new RegExp(`levels strip plus ${pageWord} pages`),
  `docs/control-center.md must say the main page holds ${pageWord} pages (model.ts)`);

// Regression guard (WU-6 / B-060): the skills catalogue used to claim EVERY skill's
// one-line description is always in context. Only skills without
// `disable-model-invocation: true` are; the rest are surfaced on demand. The emitted
// visible count must be derived from frontmatter, never hardcoded/stale.
const skillsCatalogueDoc = fs.readFileSync(path.join(ROOT, "docs", "skills-catalogue.md"), "utf8");
assert.ok(
  !skillsCatalogueDoc.includes("Only each skill's one-line description is always in context"),
  "docs/skills-catalogue.md still claims every skill description is always in context (only skills without disable-model-invocation are)",
);

const SKILLS_ROOT = path.join(ROOT, "packages", "kit", "skills");
let skillsTotal = 0;
let skillsVisible = 0;
for (const entry of fs.readdirSync(SKILLS_ROOT)) {
  const skillPath = path.join(SKILLS_ROOT, entry, "SKILL.md");
  if (!fs.existsSync(skillPath)) continue;
  skillsTotal++;
  const text = fs.readFileSync(skillPath, "utf8");
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  const fm = end > 0 ? text.slice(3, end) : "";
  if (!/^disable-model-invocation:\s*true\s*$/m.test(fm)) skillsVisible++;
}
assert.ok(skillsTotal > 0, "expected at least one packages/kit/skills/*/SKILL.md");
const skillsHidden = skillsTotal - skillsVisible;

// The doc must be exactly what the generator emits (catches a stale hand-edit).
const generatedCatalogue = skillsCatalogueContent();
assert.equal(
  skillsCatalogueDoc,
  generatedCatalogue,
  "docs/skills-catalogue.md is stale vs packages/core/skills-catalogue.ts (run npm run catalog)",
);

// Pin the visible/total counts to the frontmatter-derived ones so a hardcoded or wrong
// number in the generator is caught even when doc and generator agree with each other.
const visibleNoun = skillsVisible === 1 ? "skill" : "skills";
const hiddenVerb = skillsHidden === 1 ? "is" : "are";
assert.ok(
  generatedCatalogue.includes(`The ${skillsVisible} ${visibleNoun} without \`disable-model-invocation: true\``),
  `skills catalogue must state the frontmatter-derived visible count (${skillsVisible} of ${skillsTotal})`,
);
assert.ok(
  generatedCatalogue.includes(`the other ${skillsHidden} ${hiddenVerb} surfaced on demand`),
  `skills catalogue must state the frontmatter-derived on-demand count (${skillsHidden} of ${skillsTotal})`,
);

// The lite-profile subset counts ENABLED skills (the profile's `skills.only` allowlist),
// not skills in context. Derive the count from the profile so the wording and number
// cannot drift.
const liteProfile = JSON.parse(
  fs.readFileSync(path.join(ROOT, "packages", "kit", "profiles", "lite.json"), "utf8"),
) as ProfileJson;
const liteEnableCount = (liteProfile.skills?.only ?? []).length;
assert.ok(
  generatedCatalogue.includes(
    `The lite profile enables ${liteEnableCount} of ${skillsTotal} skills, for small local models:`,
  ),
  `skills catalogue must say the lite profile enables ${liteEnableCount} of ${skillsTotal} skills`,
);
assert.ok(
  !generatedCatalogue.includes("The lite profile shows "),
  "skills catalogue must not use the ambiguous 'lite profile shows' wording",
);

console.log(`[docs-smoke] OK: ${checked} documented commands validated, ${linksChecked} relative links resolved; balanced profile resolved; ${skipped.length} external lines skipped; skills catalogue visible ${skillsVisible}/${skillsTotal}.`);
