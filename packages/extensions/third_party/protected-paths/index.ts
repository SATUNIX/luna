import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import fs from "node:fs";

import os from "node:os";

// Protected paths depend on the firewall policy (the same `policy` tool-firewall reads):
//   coding  — secrets, key files and the agent-control/audit surfaces. `.git/`,
//             `node_modules/` and `.pi/agents/` are ordinary work there, except git's
//             hooks/, config and info/ and a linked worktree's link to its git dir (see
//             gitControlPaths), protected under both.
//   pentest — everything in coding plus repository internals, dependencies, agent
//             definitions and the engagement records.
// PI_KIT_PROTECTED_PATHS (semicolon-separated) can only ADD entries.
const CODING_PROTECTED = [
  ".env", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
  ".pi/human-console/", ".pi/human-console-audit.jsonl",
  // Agent-control and audit surfaces. A write here can forge a verdict, silence the audit
  // trail, re-arm autonomous mode, or weaken the firewall for a later session.
  ".pi/auto-mode.json", ".pi/verdicts.json", ".pi/trace.jsonl",
  ".pi/tool-firewall-audit.jsonl", ".pi/ctx-contributions/",
  // The copies trace-ledger and tool-firewall rotate their logs into at 4 MiB.
  ".pi/trace.jsonl.1", ".pi/tool-firewall-audit.jsonl.1",
  // The operator's goal: the firewall judge and the system prompt read it as operator intent, so only
  // the /goal command (goal-core, not a tool call) writes it.
  ".pi/GOAL.yaml",
  "packages/core/policies/",
  "packages/extensions/src/tool-firewall/default-policy.json",
];
const PENTEST_PROTECTED = [
  ...CODING_PROTECTED,
  ".git/", "node_modules/", ".pi/agents/", ".pi/pentest/", ".pi/engagement/",
];

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

function firewallConfigPath(): string {
  return process.env.PI_KIT_FIREWALL_CONFIG?.trim() || path.join(agentDir(), "pi-kit", "firewall.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Self-contained mirror of tool-firewall's resolvePolicy: env, then firewall.json, then coding.
// An unreadable config falls back to coding, whose list still covers secrets and control files.
export function firewallPolicy(): "coding" | "pentest" {
  const env = process.env.PI_KIT_FIREWALL_PROFILE?.trim().toLowerCase();
  if (env === "pentest" || env === "coding") return env;
  try {
    const config: unknown = JSON.parse(fs.readFileSync(firewallConfigPath(), "utf8"));
    if (isRecord(config) && config.policy === "pentest") return "pentest";
  } catch {
    /* no config: coding */
  }
  return "coding";
}

// The firewall's own state lives outside the workspace; a write there would re-arm auto
// mode, plant learned approvals or erase session taints.
function firewallStatePaths(): string[] {
  const dir = path.join(agentDir(), "pi-kit");
  return [
    firewallConfigPath(),
    process.env.PI_KIT_FIREWALL_FEEDBACK?.trim() || path.join(dir, "firewall-feedback.jsonl"),
    // Remembered approvals: a planted entry here would let an action run without asking.
    process.env.PI_KIT_FIREWALL_APPROVALS?.trim() || path.join(dir, "firewall-approvals.json"),
    process.env.PI_KIT_FIREWALL_SESSIONS_DIR?.trim() || path.join(dir, "firewall-sessions"),
    // Workflow digest grants (subagent's "Trust this digest"): a planted digest would run a project workflow unasked.
    path.join(dir, "trusted-workflows.json"),
    // Per-model Memento opt-ins (effort's "/effort memento on"): a planted entry would opt a model in unasked.
    path.join(dir, "autonomy.json"),
    // The tool I/O capture log (tool-capture): the agent must not rewrite its own record.
    process.env.PI_KIT_CAPTURE_DIR?.trim() || path.join(dir, "capture"),
  ].map(normalizeSlashes);
}

// Git's own control files, under either policy: a write to a hook, the config (core.hooksPath,
// core.fsmonitor, aliases) or info/ (attributes, exclude) runs code or changes what git does in
// every checkout of the repository. They live in the git common directory, which for a linked
// worktree (`.git` is a file naming its git dir) is the main checkout's `.git`, outside the
// worktree. The link itself (the worktree's `.git` file and `<common>/worktrees/`, which holds
// each worktree's gitdir and commondir) is protected too: rewriting it would point this lookup,
// and git, at a directory the agent made. The checkout that holds the common dir has its own
// protected entries protected too, so a workflow agent in `<repo>/.pi/worktrees/...` cannot reach
// them by an absolute path. A `.git` file that does not name a real git dir is `invalid`, and
// every write is blocked (fail closed).
// `links` (a linked worktree's `.git` file) match exactly: `.git/...` under a `.git` file cannot exist.
export interface GitControl { paths: string[]; links: string[]; roots: string[]; invalid?: string }

export function gitControlPaths(cwd: string): GitControl {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | undefined;
    try { stat = fs.statSync(dotGit); } catch { stat = undefined; }
    if (stat) {
      const links: string[] = [];
      let commonDir = dotGit;
      if (stat.isFile()) {
        const invalid = { paths: [], links: [normalizeSlashes(dotGit)], roots: [], invalid: `${normalizeSlashes(dotGit)} does not name a valid git dir` };
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit));
        if (!match?.[1]) return invalid;
        const gitDir = canonicalPath(path.resolve(dir, match[1]));
        if (!isDirectory(gitDir)) return invalid;
        const common = readText(path.join(gitDir, "commondir")).trim();
        commonDir = common ? canonicalPath(path.resolve(gitDir, common)) : gitDir;
        // A linked worktree's git dir is `<common>/worktrees/<name>` and the common dir is a real
        // repository; a submodule's (no commondir file) is its own common dir.
        if (common && (path.dirname(gitDir) !== path.join(commonDir, "worktrees") || !isDirectory(path.join(commonDir, "objects")))) return invalid;
        links.push(normalizeSlashes(dotGit));
      }
      const paths = ["hooks", "config", "info", "worktrees"].map((name) => normalizeSlashes(path.join(commonDir, name)));
      const roots = path.basename(commonDir) === ".git" ? [path.dirname(commonDir)] : [];
      return { paths, links, roots };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { paths: [], links: [], roots: [] };
}

// What each cwd's lookup found the first time (the extension primes it with the session's cwd
// when it loads, before any tool call). Later lookups only add to it, so an agent that rewrites a
// `.git` file afterwards cannot drop the protections the original link gave.
const firstGitControl = new Map<string, GitControl>();

function trustedGitControl(cwd: string): GitControl {
  const key = path.resolve(cwd);
  const fresh = gitControlPaths(key);
  const first = firstGitControl.get(key);
  if (!first) {
    firstGitControl.set(key, fresh);
    return fresh;
  }
  return { paths: [...first.paths, ...fresh.paths], links: [...first.links, ...fresh.links], roots: [...new Set([...first.roots, ...fresh.roots])], ...(fresh.invalid ? { invalid: fresh.invalid } : {}) };
}

function isDirectory(file: string): boolean {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
}

function readText(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function getProtectedPaths(cwd: string): string[] {
  const policyDefaults = firewallPolicy() === "pentest" ? PENTEST_PROTECTED : CODING_PROTECTED;
  const git = trustedGitControl(cwd);
  const mainCheckout = git.roots.flatMap((root) => policyDefaults.filter((entry) => entry.includes("/")).map((entry) => normalizeSlashes(path.join(root, entry))));
  const defaults = [...policyDefaults, ...git.paths, ...mainCheckout];
  const env = process.env.PI_KIT_PROTECTED_PATHS;
  // PI_KIT_PROTECTED_PATHS can only ADD to the defaults. It previously replaced them, so a
  // child handed a custom list silently lost .env and control-surface protection.
  const base = env ? [...defaults, ...env.split(";").map(p => p.trim()).filter(Boolean)] : defaults;
  const configuredConsole = process.env.PI_KIT_HUMAN_CONSOLE_DIR?.trim();
  const dynamic = configuredConsole ? [normalizeSlashes(path.resolve(cwd, normalizeSlashes(configuredConsole)))] : [];
  // The unattended-run contract (PI_KIT_UNATTENDED_CONTRACT) is the supervisor's, not the agent's: protected
  // whether or not the firewall accepted it.
  const contract = process.env.PI_KIT_UNATTENDED_CONTRACT?.trim();
  const contractPaths = contract ? [normalizeSlashes(path.resolve(cwd, normalizeSlashes(contract)))] : [];
  return [...base, ...firewallStatePaths(), ".pi/human-console/", ".pi/human-console-audit.jsonl", ...dynamic, ...contractPaths];
}

// Optional ALLOWLIST mode (Epic 6 Sprint 6.3, dream mode): when PI_KIT_WRITE_ALLOWLIST is
// set (semicolon-separated prefixes), any write/edit to a path NOT under an allowlisted
// prefix is blocked. This lets a scheduled "dream" pass touch only AGENTS.md / memory /
// GOAL.yaml and nothing else — protected-paths becomes the enforcement point.
function getWriteAllowlist(): string[] | null {
  const env = process.env.PI_KIT_WRITE_ALLOWLIST;
  if (!env) return null;
  const list = env.split(";").map(p => p.trim()).filter(Boolean);
  return list.length ? list : null;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

// H-01 fix: the previous implementation matched via `normalized.includes(entry)`, a raw
// substring test. That let "src/AGENTS.md.backdoor" satisfy an "AGENTS.md" allowlist
// entry, and ".pi/memory-escape/file.txt" satisfy a ".pi/memory" entry — neither is
// actually the allowlisted file/directory, they just happen to share a text prefix.
// Real path-boundary matching: a directory-style entry (contains "/") matches only the
// exact path or a genuine descendant (segment boundary, not string prefix); a bare
// filename entry matches only an exact basename, never a prefix/substring of a longer
// name.
function resolveEntry(entry: string, cwd: string): string {
  return canonicalPath(path.resolve(cwd, normalizeSlashes(entry).replace(/\/+$/, "")));
}

function canonicalPath(value: string): string {
  let result: string;
  try { result = fs.realpathSync(value); } catch {
    const parent = path.dirname(value);
    result = parent === value ? value : path.join(canonicalPath(parent), path.basename(value));
  }
  return process.platform === "win32" ? result.toLowerCase() : result;
}

function matchesDirectoryOrExactEntry(candidateAbs: string, entryAbs: string): boolean {
  return candidateAbs === entryAbs || candidateAbs.startsWith(entryAbs + path.sep);
}

function isAllowlisted(filePath: string, allowlist: string[], cwd: string): boolean {
  const candidateAbs = canonicalPath(path.resolve(cwd, normalizeSlashes(filePath)));
  return allowlist.some(entry => {
    const normalizedEntry = normalizeSlashes(entry).replace(/\/+$/, "");
    if (normalizedEntry.includes("/")) {
      return matchesDirectoryOrExactEntry(candidateAbs, resolveEntry(entry, cwd));
    }
    // Bare filename: exact basename match only — never a prefix/substring (this is
    // exactly what let "AGENTS.md.backdoor" satisfy an "AGENTS.md" entry).
    return candidateAbs === resolveEntry(entry, cwd);
  });
}

// Denylist can stay slightly broader than the allowlist (over-blocking here is safe,
// fail-closed; it's the allowlist where over-matching is the security defect), but must
// still respect real path segment boundaries rather than matching anywhere in the string.
function isProtected(filePath: string, protectedList: string[], cwd: string): boolean {
  // Same canonical (realpath, win32-lowercased) form as resolveEntry, or directory
  // entries never match on Windows and symlinks escape the denylist.
  const candidateAbs = canonicalPath(path.resolve(cwd, normalizeSlashes(filePath)));
  const segments = normalizeSlashes(candidateAbs).split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? "";
  // `.env` protection covers secret files; checked-in templates (.env.example / .env.sample)
  // are non-secret and exempt. Real `.env` and `.env.<other>` still match below.
  if (base === ".env.example" || base === ".env.sample") return false;
  return protectedList.some(entry => {
    const slashed = normalizeSlashes(entry).replace(/\/+$/, "");
    const normalizedEntry = process.platform === "win32" ? slashed.toLowerCase() : slashed;
    if (normalizedEntry.includes("/")) {
      return matchesDirectoryOrExactEntry(candidateAbs, resolveEntry(entry, cwd));
    }
    return segments.includes(normalizedEntry) || base === normalizedEntry || base.startsWith(`${normalizedEntry}.`);
  });
}

// H-01 fix, second bypass: this extension only inspected `write`/`edit` tool input,
// so a `bash` redirect/copy to the exact same disallowed path was invisible to it. Pull
// candidate write targets out of a shell command the same content-aware way tool-firewall
// and secret-guard already do for their own threat classes. Deliberately narrow (a known
// set of write primitives, not a full shell parser), but the set covers the common ways
// a shell rewrites a file — a single missed primitive is a full bypass of this gate.
// Over-extraction is safe: every candidate is still checked against the real path
// boundary in `isProtected`/`isAllowlisted`, and these patterns only fire on commands
// that write, so plain reads are never matched.
function bashWriteTargets(command: string): string[] {
  const targets: string[] = [];
  const stripQuotes = (t: string) => t.replace(/^["']|["']$/g, "");
  const push = (value: string | undefined) => {
    const stripped = value ? stripQuotes(value) : "";
    if (stripped) targets.push(stripped);
  };
  // Output redirection and `tee`.
  for (const m of command.matchAll(/>{1,2}\s*([^\s|;&<>]+)/g)) push(m[1]);
  for (const m of command.matchAll(/\btee\b(?:\s+-a)?\s+([^\s|;&]+)/g)) push(m[1]);
  // cp/mv: last argument is the destination that gets created/overwritten.
  for (const m of command.matchAll(/\b(?:cp|mv)\b(?:\s+-\S+)*\s+\S+\s+([^\s|;&]+)/g)) push(m[1]);
  // `dd of=<file>` (the output operand).
  for (const m of command.matchAll(/\bdd\b[^\n|;&]*?\bof=([^\s|;&]+)/g)) push(m[1]);
  // `sed -i`/`perl -i` rewrite every file operand in place. Scan all operands after the
  // flag (skipping flags and the inline s/…/…/ program) so a protected operand is caught
  // wherever it sits in the argument list, not only when it happens to be last.
  for (const m of command.matchAll(/\b(?:sed|perl)\b[^\n|;&]*?\s-i\S*([^\n|;&]*)/g)) {
    for (const rawToken of (m[1] ?? "").split(/\s+/)) {
      const stripped = stripQuotes(rawToken);
      if (!stripped || stripped.startsWith("-") || looksLikeInlineProgram(rawToken, stripped)) continue;
      push(stripped);
    }
  }
  // install/ln: last argument is the created destination.
  for (const m of command.matchAll(/\b(?:install|ln)\b[^\n|;&]*\s+([^\s|;&]+)\s*(?:[|;&]|$)/g)) push(m[1]);
  // curl -o <file> / wget -O <file>.
  for (const m of command.matchAll(/\bcurl\b[^\n|;&]*?\s-o\s*([^\s|;&]+)/g)) push(m[1]);
  for (const m of command.matchAll(/\bwget\b[^\n|;&]*?\s-O\s*([^\s|;&]+)/g)) push(m[1]);
  // sponge <file> soaks stdin and writes it to the named file.
  for (const m of command.matchAll(/\bsponge\b(?:\s+-\S+)*\s+([^\s|;&]+)/g)) push(m[1]);
  // `python -c "open('file','w')..."` (w/a/x and binary/plus variants).
  for (const m of command.matchAll(/\bopen\s*\(\s*["']([^"']+)["']\s*,\s*["'][wax][bt+]*["']/g)) push(m[1]);
  return targets.filter(Boolean);
}

// sed/perl inline programs (`s/…/…/`, `y/…/…/`, a quoted one-liner) are code, not file
// operands. Only used to filter tokens following a `-i` flag.
function looksLikeInlineProgram(rawToken: string, stripped: string): boolean {
  if (/^[sy][/|#]/.test(stripped)) return true;
  if (/^["']/.test(rawToken) && !stripped.includes("/") && !/\.[A-Za-z0-9]{1,8}$/.test(stripped)) return true;
  return false;
}

// Protections registry (shared, in-process; see tool-firewall/README.md). Each mandatory protection
// (tool-firewall, secret-guard, protected-paths) records its name here when its factory has
// installed its hooks, so a trusted launcher can check that a session loaded what it must have
// loaded. Extensions are self-contained, so every one carries this same small helper: whichever
// loads first creates the registry, the others add to it. It is a consistency check, not a
// boundary against code running in the same process.
const PROTECTIONS_KEY = Symbol.for("pi-kit.protections");
interface RegistryLike {
  add(name: string): unknown;
  has(name: string): unknown;
  list?: unknown;
}
function isRegistryLike(value: unknown): value is RegistryLike {
  return (typeof value === "object" || typeof value === "function") && value !== null
    && "add" in value && typeof value.add === "function"
    && "has" in value && typeof value.has === "function";
}
function isIterable(value: unknown): value is Iterable<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null
    && Symbol.iterator in value && typeof value[Symbol.iterator] === "function";
}
// Every kit producer stores a Set; an existing registry is iterated as one, as before.
const sortedNames = (registry: unknown): string[] => (isIterable(registry) ? [...registry].map(String).sort() : []);

// Tool arguments come from the model: a field is a string, absent (undefined or null), or malformed.
type TextField = { ok: true; value: string | undefined } | { ok: false; key: string };
// The first of `keys` that is present (`??` order). A present non-string is malformed, never skipped.
function textField(input: Record<string, unknown>, keys: readonly string[]): TextField {
  for (const key of keys) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    return typeof value === "string" ? { ok: true, value } : { ok: false, key };
  }
  return { ok: true, value: undefined };
}
function registerProtection(name: string): void {
  try {
    const g = globalThis as Record<symbol, unknown>;
    const existing = g[PROTECTIONS_KEY];
    let reg: RegistryLike;
    if (isRegistryLike(existing)) {
      reg = existing;
    } else {
      reg = new (class ProtectionRegistry extends Set<string> {})();
      g[PROTECTIONS_KEY] = reg;
    }
    reg.add(name);
    if (typeof reg.list !== "function") Object.defineProperty(reg, "list", { value: () => sortedNames(reg), enumerable: false, configurable: true });
  } catch {
    /* the registry must never break the protection itself */
  }
}

export default function (pi: ExtensionAPI) {
  // Record the session checkout's git link before any tool call can change it.
  trustedGitControl(process.cwd());
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    const raw: unknown = event.input;
    const input = isRecord(raw) ? raw : {};
    const cwd = ctx.cwd || process.cwd();

    let candidatePaths: string[] = [];
    const field = toolName === "write" || toolName === "edit" ? textField(input, ["path"]) : toolName === "bash" ? textField(input, ["command", "cmd", "script"]) : null;
    if (field && !field.ok) {
      const msg = `protected-paths: blocked ${toolName}: ${field.key} is not a string`;
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
      return { block: true, reason: msg };
    }
    if (field?.value) candidatePaths = toolName === "bash" ? bashWriteTargets(field.value) : [field.value];
    if (candidatePaths.length === 0) return undefined;

    const git = trustedGitControl(cwd);
    if (git.invalid) {
      const msg = `protected-paths: blocked ${toolName}: ${git.invalid}`;
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
      return { block: true, reason: msg };
    }
    const protectedList = getProtectedPaths(cwd);
    const allowlist = getWriteAllowlist();
    for (const filePath of candidatePaths) {
      // Denylist always applies.
      const candidateAbs = canonicalPath(path.resolve(cwd, normalizeSlashes(filePath)));
      if (isProtected(filePath, protectedList, cwd) || git.links.some((link) => canonicalPath(link) === candidateAbs)) {
        const msg = `protected-paths: blocked ${toolName} to protected path: ${filePath}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        return { block: true, reason: msg };
      }
      // Allowlist mode (dream/print-mode): block anything not explicitly allowlisted.
      if (allowlist && !isAllowlisted(filePath, allowlist, cwd)) {
        const msg = `protected-paths: allowlist mode — blocked ${toolName} to non-allowlisted path: ${filePath}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        return { block: true, reason: msg };
      }
    }

    return undefined;
  });
  // Only once the hook is installed: a factory that failed earlier never registers.
  registerProtection("protected-paths");
}
