#!/usr/bin/env node
// tool-firewall control paths: pi's autoload locations and the operator-authority files,
// offline.
//
// 1. Autoload discovery: reads the pinned pi package's own sources (resource loader, package manager,
//    project-trust manager, context-file discovery, session services) and extracts every file or directory it
//    loads from the agent directory and the project. Each must classify as a safety control (or an
//    operator-authority secret), so a write there asks the operator. The test fails when pi adds a location
//    the firewall does not cover, and when the extraction itself finds nothing (pi's code changed shape).
// 2. Operator-authority files: every entry of classify.ts OPERATOR_AUTHORITY_FILES still names a file its
//    source writes, and classifies as it says (a secret is a credential read and a safety-control write).
//    A scan of the kit's sources fails on a secret-looking file name that is neither in the list, nor
//    already a credential path, nor in the reviewed exemptions below.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadModule, isolateKitEnv } from "../packages/core/eval/harness.ts";
import type * as Classify from "../packages/extensions/src/tool-firewall/classify.ts";

const restoreIsolation = isolateKitEnv();
const C = await loadModule<typeof Classify>("extensions/tool-firewall/classify.ts");

const ROOT = path.resolve(import.meta.dirname, "..");
const WS = "/work/repo";
const HOME = "/u/op";
const AGENT = `${HOME}/.pi/agent`;
const env: Classify.ClassifyEnv = { cwd: WS, workspace: WS, home: HOME, tmpRoots: ["/tmp"], knownHosts: new Set(), policy: "coding" };
const CONTROL = new Set<Classify.PathClass>(["security_control", "credential_control"]);
const tier = (cmd: string) => C.effectiveTier(C.classifyCommand(cmd, env), false);

// --- 1. pi's autoload locations ----------------------------------------------------------------------
const piDir = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const piDist = path.join(piDir, "dist");
const versionOf = (file: string, field: "version" | "pin"): string => {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return "";
  if (field === "version") return "version" in parsed && typeof parsed.version === "string" ? parsed.version : "";
  const dev = "devDependencies" in parsed && typeof parsed.devDependencies === "object" && parsed.devDependencies !== null ? parsed.devDependencies : {};
  const pin = "@earendil-works/pi-coding-agent" in dev ? dev["@earendil-works/pi-coding-agent"] : undefined;
  return typeof pin === "string" ? pin : "";
};
// At the pinned pi every extraction must find its locations. The compat lanes install an older or newer pi
// over the pin: there a source file may be absent or shaped differently, so only what is found is checked.
const pinned = versionOf(path.join(piDir, "package.json"), "version") === versionOf(path.join(ROOT, "package.json"), "pin");
const read = (rel: string): string => {
  const file = path.join(piDist, rel);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  assert.ok(!pinned, `the pinned pi has ${rel}`);
  return "";
};
const names = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m[1] ?? "").filter(Boolean);

const loader = read("core/resource-loader.js");
const packages = read("core/package-manager.js");
const trust = read("core/trust-manager.js");
const services = read("core/agent-session-services.js");

const agentNames = new Set<string>([
  ...names(loader, /join\(this\.agentDir, "([^"]+)"\)/g),
  ...names(packages, /join\(this\.agentDir, "([^"]+)"\)/g),
  ...names(services, /join\(agentDir, "([^"]+)"\)/g),
  ...names(trust, /join\(resolvePath\(agentDir\), "([^"]+)"\)/g),
]);
// The global context file is looked up in the agent directory under each of these names.
const contextNames = /const candidates = \[([^\]]+)\]/.exec(loader)?.[1]?.match(/"([^"]+)"/g)?.map((n) => n.slice(1, -1)) ?? [];
const projectNames = /TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = \[([^\]]+)\]/.exec(trust)?.[1]?.match(/"([^"]+)"/g)?.map((n) => n.slice(1, -1)) ?? [];
if (pinned) {
  assert.ok(agentNames.size >= 6, `pi's agent-directory locations were extracted (${[...agentNames].join(", ")}); if pi's code changed shape, update this test`);
  assert.ok(contextNames.length >= 2, "pi's context-file names were extracted");
  assert.ok(projectNames.length >= 4, "pi's trust-requiring project resources were extracted");
  assert.ok(/join\(\w+, "\.agents", "skills"\)/.test(packages), "pi still loads skills from .agents/skills");
} else console.log("  note: the installed pi is not the pinned version; checking only the locations found in its sources");

// Locations pi names under the agent directory that load nothing into a session, with the reason.
const NOT_AUTOLOAD: Record<string, string> = {
  tmp: "package-manager scratch space for installs in progress",
  sessions: "session transcripts pi writes; read back only by an explicit resume",
};
for (const name of [...agentNames, ...contextNames]) {
  if (Object.hasOwn(NOT_AUTOLOAD, name)) continue;
  for (const p of [`${AGENT}/${name}`, `${AGENT}/${name}/x/index.ts`]) {
    if (p.endsWith("/x/index.ts") && /\.(?:json|md|MD)$/.test(name)) continue;
    assert.ok(CONTROL.has(C.classifyPath(p, env)), `${p} (pi loads ${name} from the agent directory) is a safety-control path, got ${C.classifyPath(p, env)}`);
  }
}
for (const name of projectNames) assert.equal(C.classifyPath(`${WS}/.pi/${name}`, env), "security_control", `.pi/${name} (a trust-requiring project resource) is a safety-control path`);
for (const p of [`${HOME}/.agents/skills/x/SKILL.md`, `${WS}/.agents/skills/x/SKILL.md`, `/work/.agents/skills/x/SKILL.md`]) assert.equal(C.classifyPath(p, env), "security_control", `${p} is a skill pi loads`);
for (const p of C.AGENT_AUTOLOAD) assert.ok(CONTROL.has(C.classifyPath(`${AGENT}/${p.replace(/\/$/, "/x")}`, env)), `AGENT_AUTOLOAD entry ${p} classifies as a control path`);
assert.equal(tier(`echo x > ${AGENT}/extensions/a.ts`), "high");
assert.equal(tier(`git clone https://git.example/r ${AGENT}/skills/r`), "high", "a clone into an autoload directory is a safety-control write");
assert.equal(tier(`cat ${AGENT}/SYSTEM.md`), "low", "reading an autoload file is not a credential read");
console.log(`  OK: ${agentNames.size + contextNames.length} agent-directory and ${projectNames.length} project locations pi loads are safety controls`);

// --- 2. Operator-authority files ---------------------------------------------------------------------
for (const f of C.OPERATOR_AUTHORITY_FILES) {
  const src = f.source.startsWith("@earendil-works/pi-coding-agent ") ? path.join(piDist, f.source.split(" ")[1]?.replace(/^dist\//, "") ?? "") : path.join(ROOT, f.source);
  const fromPi = src.startsWith(piDist);
  if (!fromPi || pinned) assert.ok(fs.existsSync(src), `${f.id}: its source ${f.source} exists`);
  if (f.name && fs.existsSync(src)) assert.ok(fs.readFileSync(src, "utf8").includes(`"${path.basename(f.name)}"`), `${f.id}: ${f.source} still names ${path.basename(f.name)}`);
  const at = f.root === "agent" ? `${AGENT}/${f.name}` : f.root === "remote-state" ? `${AGENT}/remote-control/${f.name || "runtime/x"}` : `/opt/kit/packages/web-ui/.runtime/${f.name}`;
  const cls = C.classifyPath(at, env);
  assert.equal(cls, f.secret ? "credential_control" : "security_control", `${f.id}: ${at} classifies as ${f.secret ? "an operator-authority secret" : "a safety control"}`);
  assert.equal(tier(`cp /tmp/x ${at}`), "high", `${f.id}: writing ${at} is high`);
  assert.equal(tier(`cat ${at}`), f.secret ? "high" : "low", `${f.id}: reading ${at} is ${f.secret ? "a credential read" : "routine"}`);
}

// A secret reached without naming it: a glob or a directory that holds one, through the shell or a
// pi tool's path argument (the `grep` tool returns file contents), is a credential read.
for (const p of [`${AGENT}/remote-control`, AGENT, `${AGENT}/remote-control/*`, `${AGENT}/remote-*/control.json`, `${AGENT}/auth.js*`, `${HOME}/.pi`]) {
  assert.equal(C.classifyPath(p, env), "credential_control", `${p} reaches an operator-authority secret`);
  for (const tool of ["grep", "read"]) assert.equal(C.effectiveTier(C.classifyToolCall(tool, { pattern: ".", path: p }, env, undefined, "ask"), false), "high", `the ${tool} tool on ${p} is a credential read`);
}
for (const p of [`${AGENT}/extensions`, `${AGENT}/sessions`, `${AGENT}/remote-control/devices.js*`]) assert.notEqual(C.classifyPath(p, env), "credential_control", `${p} holds no secret`);
console.log("  OK: globs and directories that reach an operator-authority secret are credential reads, by shell and by tool");

// Secret-looking file names in kit source that are not files the classifier needs to know about.
const EXEMPT: Record<string, string> = {
  "pi-console.token": "a browser localStorage key in the web console, not a file",
};
const SECRET_NAME = /["'`]([A-Za-z0-9_.-]*(?:token|secret|credential|private|key|control|devices|identity|auth|approval)[A-Za-z0-9_.-]*\.(?:json|jsonl|pem|token|key|txt)|[A-Za-z0-9_-]+\.token)["'`]/gi;
const known = new Set(C.OPERATOR_AUTHORITY_FILES.map((f) => path.basename(f.name)).filter(Boolean));
const unclassified: string[] = [];
function scan(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/^(?:node_modules|fixtures|scripts|\.runtime)$/.test(e.name)) scan(p); continue; }
    if (!/\.ts$/.test(e.name) || p.endsWith(path.join("tool-firewall", "classify.ts"))) continue;
    for (const m of fs.readFileSync(p, "utf8").matchAll(SECRET_NAME)) {
      const name = m[1] ?? "";
      if (known.has(name) || Object.hasOwn(EXEMPT, name)) continue;
      // Already a credential or control path wherever it lands (CRED_BASENAME and friends).
      if (CONTROL.has(C.classifyPath(`${HOME}/x/${name}`, env)) || C.classifyPath(`${HOME}/x/${name}`, env) === "credential" || CONTROL.has(C.classifyPath(`${AGENT}/pi-kit/${name}`, env))) continue;
      unclassified.push(`${path.relative(ROOT, p)}: ${name}`);
    }
  }
}
scan(path.join(ROOT, "packages"));
assert.deepEqual(unclassified, [], `kit source names secret-looking files the firewall does not classify; add each to OPERATOR_AUTHORITY_FILES (classify.ts) or, after review, to EXEMPT here:\n${unclassified.join("\n")}`);
console.log(`  OK: ${C.OPERATOR_AUTHORITY_FILES.length} operator-authority entries match their sources and classify as declared; no unclassified secret file in kit source`);

restoreIsolation();
console.log("[firewall-autoload-smoke] OK");
