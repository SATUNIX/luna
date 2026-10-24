import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import fs from "node:fs";

// secret-guard is an opt-in, pattern-based secrets/protected-path backstop. It ships in no
// profile (extension.json: "profiles": [], experimental); an operator adds it deliberately.
// When loaded it blocks four classes (tests/secret-guard-smoke.ts):
//   0. read/grep/find/ls/glob of a credential file (SECRET_READ_* patterns),
//   1. writes/edits to secret files or protected engagement/repo-control paths,
//   2. writes/edits whose CONTENT is a high-confidence secret (key material, tokens),
//   3. shell commands that read/copy/encode/exfiltrate a secret or protected path.
//
// Self-containment forbids importing pentest-governance-domain, so PROTECTED_PATTERNS
// below is kept a SUPERSET of that extension's list and verify.ts fails if they diverge
// (Epic 2 Sprint 2.2 "cross-link ... so the two lists can't silently diverge").

// Secret FILE signatures (path/filename based).
const SECRET_PATH_PATTERNS = [
  /\.env$/i,
  /\.env\./i,
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /credentials/i,
  /secret/i,
  /\.ssh[/\\]/i,
  /id_rsa/i,
  /id_ed25519/i,
  /(?:^|\/)\.npmrc$/i,
  /(?:^|\/)\.netrc$/i,
  /\.pi\/agent\/auth\.json$/i,
];

// Protected paths — MUST remain a superset of pentest-governance-domain's PROTECTED_PATTERNS.
// verify.ts enforces the parity. Keep the string forms identical so the check can match.
const PROTECTED_PATTERNS = [
  ".env",
  ".git/",
  "engagement/scope.yaml",
  "engagement/roe.yaml",
  "engagement/tool-policy.yaml",
  "engagement/tool-policy.json",
  "workspace/evidence/",
  "workspace/audit/",
  "/srv/data/pi-system/evidence/",
  "/srv/data/pi-system/audit/",
  ".pi/tool-firewall-audit.jsonl",
  ".pi/trace.jsonl",
  ".pi/agents/",
  ".pi/engagement/",
  ".pi/ctx-contributions/",
  ".pi/verdicts.json",
  "packages/extensions/src/tool-firewall/default-policy.json",
  "packages/core/policies/",
  ".pi/human-console/",
  ".pi/human-console-audit.jsonl",
  ".pi/pentest/",
  ".pi/pentest/audit/",
  ".pi/pentest/checkpoints/",
  ".pi/pentest/evidence/",
  ".pi/pentest/findings/",
  ".pi/pentest/hypotheses/",
  ".pi/pentest/memory/",
  ".pi/pentest/reports/",
  ".pi/pentest/tasks/",
  ".pi/pentest/verification/",
];

// High-confidence secret CONTENT signatures. Deliberately narrow (key material and
// known token prefixes) to avoid flagging ordinary code that merely mentions "password".
const SECRET_CONTENT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, label: "private key block" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key id" },
  { re: /\baws_secret_access_key\b\s*[:=]/i, label: "AWS secret access key" },
  { re: /\bxox[baprs]-[0-9A-Za-z]{8,}-[0-9A-Za-z]{8,}/, label: "Slack token" },
  { re: /\bghp_[0-9A-Za-z]{30,}\b/, label: "GitHub personal access token" },
  { re: /\bgithub_pat_[0-9A-Za-z_]{20,}\b/, label: "GitHub fine-grained token" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, label: "provider API key (sk-)" },
  { re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9+/_-]{20,}/i, label: "credential assignment" },
];

// Shell verbs that read/copy/encode/transfer file contents. Combined with a secret or
// protected path reference, these are exfiltration attempts (base64/cp/mv bypasses etc.).
// Includes PowerShell read/encode primitives - the POSIX-only list previously missed
// PowerShell entirely, so any PowerShell-based read/encode of a secret bypassed
// detection regardless of whether the path was obfuscated (F-04).
const TRANSFER_VERB =
  /\b(?:cp|mv|cat|less|more|head|tail|base64|base32|xxd|od|hexdump|strings|scp|rsync|sftp|tar|zip|gzip|7z|curl|wget|nc|ncat|socat|openssl|dd|get-content|gc|copy-item|move-item|out-file|set-content|set-clipboard|compress-archive|readallbytes|readalltext|tobase64string)\b/i;

// Canonical basenames used to test whether a glob-metacharacter token in a shell
// command (e.g. `.e??`) could expand to a protected/secret filename. Not exhaustive -
// mirrors SECRET_PATH_PATTERNS/PROTECTED_PATTERNS at the representative-filename level.
const CANONICAL_SECRET_BASENAMES = [
  ".env", ".env.local", ".env.production", ".env.development", ".env.test",
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
  "credentials", "credentials.json",
  "secret", "secrets.json", "secrets.yaml", "secrets.yml",
];

function globTokenToRegExp(token: string): RegExp | null {
  if (!/[*?]/.test(token)) return null;
  let pattern = "^";
  for (const ch of token) {
    if (ch === "*") pattern += ".*";
    else if (ch === "?") pattern += ".";
    else pattern += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  pattern += "$";
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

// Detects glob-obscured secret references (`base64 .e??`, `cp .e??`) that never
// appear as a literal secret filename substring in the command text (F-04).
function commandHasGlobTokenMatchingSecret(command: string): boolean {
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^["']|["']$/g, "");
    const base = token.split(/[\\/]/).pop() || token;
    const re = globTokenToRegExp(base);
    if (re && CANONICAL_SECRET_BASENAMES.some(name => re.test(name))) return true;
  }
  return false;
}

// Same fragmentation-evasion families handled in tool-firewall (adjacent empty
// quotes, backslash-before-letter) - kept duplicated per this extension's
// self-containment rule rather than imported.
function deobfuscateShellText(command: string): string {
  return command.replace(/'{2,}|"{2,}/g, "").replace(/\\(?=[A-Za-z])/g, "");
}

// Suffix patterns like `\.env$` are anchored to end-of-string, which is correct for a
// single isolated file path (isSecretPath) but wrong for scanning a whole command
// line: `base64 .env; echo done` never matches because more text follows `.env`.
// Replace the end anchor with a shell-token boundary (whitespace/quote/operator/EOF).
function toCommandScanPattern(re: RegExp): RegExp {
  const source = re.source.endsWith("$") ? `${re.source.slice(0, -1)}(?=[\\s"'\`;|&)<>]|$)` : re.source;
  return new RegExp(source, re.flags);
}

// Direct leak/exfil patterns (independent of a distinct path token).
const SECRET_BASH_LEAK_PATTERNS = [
  /git\s+add\s+[^\n]*\.env/i,
  /git\s+commit[^\n]*\.env/i,
  /echo\s+[^\n]*(?:password|secret|api.?key|token)\s*=/i,
  /(?:curl|wget)\b[^\n]*(?:-d|--data|--data-binary|--data-raw|-F|--form)\b[^\n]*(?:password|secret|api.?key|token)/i,
  /(?:curl|wget)\b[^\n]*(?:@|-T\s)[^\n]*(?:\.env|\.pem|\.key|id_rsa|id_ed25519|credentials|secret)/i,
];

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function resolvedPath(value: string, cwd: string): string {
  const absolute = path.resolve(cwd, value);
  try { return fs.realpathSync(absolute); } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(resolvedPath(parent, cwd), path.basename(absolute));
  }
}

// Canonical (symlink-resolved) target. `scoped` is workspace-relative when the target
// is inside the workspace, otherwise absolute: substring patterns such as /secret/ must
// not match the workspace's own location (e.g. a checkout under ~/secrets-app/).
function targetPaths(rawPath: string, cwd: string): { scoped: string; absolute: string } {
  const absolute = resolvedPath(rawPath, cwd);
  const relative = path.relative(resolvedPath(".", cwd), absolute);
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  return { scoped: normalizePath(inside ? relative : absolute), absolute: normalizePath(absolute) };
}

// Read-side credential signatures. Narrower than SECRET_PATH_PATTERNS: its substring
// forms (/secret/, /credentials/) would make ordinary source such as
// extensions/secret-guard/index.ts unreadable. Public keys (id_*.pub) stay readable.
const SECRET_READ_BASENAME_PATTERNS = [
  /^\.env$/, /^\.env\./, /\.key$/, /\.pem$/, /\.p12$/, /\.pfx$/,
  /^id_(?:rsa|ed25519|ecdsa|dsa)$/, /^\.npmrc$/, /^\.netrc$/,
  /^credentials(?:\.json)?$/, /^secrets?\.(?:json|ya?ml|toml|env|txt)$/,
];
const SECRET_READ_PATH_PATTERNS = [/(?:^|\/)\.ssh\//, /(?:^|\/)\.pi\/agent\/auth\.json$/];

// Checked-in env *templates* are not secrets: the installer scaffolds `.env.example` and
// refreshes it on upgrade, so the template must be readable and writable. Without this the
// whole secret-guard surface (secret-path, secret-read-path and protected-path rules) blocks
// it, and the file can never be created or regenerated at all. Deliberately narrow: exact
// basenames only, and content is STILL scanned for secrets further down, so a template that
// actually contains a credential remains blocked. PROTECTED_PATTERNS and SECRET_PATH_PATTERNS
// are left untouched so verify.ts's literal parity extraction against
// pentest-governance-domain still holds. Mirrored in pentest-governance-domain and
// third_party/protected-paths, which carry the same exemption.
function isEnvTemplatePath(filePath: string): boolean {
  const base = path.posix.basename(normalizePath(filePath));
  return base === ".env.example" || base === ".env.sample";
}

// Keyed on the literal template names only. `cp .env.example .env` still matches below,
// because stripping the template token leaves the real `.env` reference intact.
function stripEnvTemplateTokens(text: string): string {
  return text.replace(/\.env\.(?:example|sample)\b/gi, " ");
}

function isSecretPath(filePath: string): boolean {
  if (isEnvTemplatePath(filePath)) return false;
  const normalized = normalizePath(filePath);
  const base = path.posix.basename(normalized);
  return SECRET_PATH_PATTERNS.some(p => p.test(base) || p.test(normalized));
}

function isSecretReadPath(filePath: string): boolean {
  if (isEnvTemplatePath(filePath)) return false;
  const normalized = normalizePath(filePath);
  const base = path.posix.basename(normalized);
  return SECRET_READ_BASENAME_PATTERNS.some(p => p.test(base)) || SECRET_READ_PATH_PATTERNS.some(p => p.test(normalized));
}

function isProtectedPath(filePath: string): boolean {
  if (isEnvTemplatePath(filePath)) return false;
  const normalized = normalizePath(filePath);
  return PROTECTED_PATTERNS.some(pattern => normalized === pattern || normalized.includes(pattern));
}

// Env-configured control paths, kept outside PROTECTED_PATTERNS so verify.ts's literal
// parity extraction stays valid. Fail-closed: an override adds protection, never removes it.
function configuredHumanConsolePaths(cwd: string): string[] {
  const configured = process.env.PI_KIT_HUMAN_CONSOLE_DIR?.trim();
  return configured ? [normalizePath(resolvedPath(configured, cwd))] : [];
}
function withinAny(absolutePath: string, roots: string[]): boolean {
  return roots.some((root) => absolutePath === root || absolutePath.startsWith(`${root}/`));
}

const SECRET_PATH_PATTERNS_FOR_COMMANDS = SECRET_PATH_PATTERNS.map(toCommandScanPattern);

function commandReferencesSecret(command: string): boolean {
  const normalized = stripEnvTemplateTokens(normalizePath(command));
  return SECRET_PATH_PATTERNS_FOR_COMMANDS.some(p => p.test(normalized)) || commandHasGlobTokenMatchingSecret(normalized);
}

function commandReferencesProtected(command: string, cwd: string = process.cwd()): boolean {
  const normalized = stripEnvTemplateTokens(normalizePath(command));
  if (PROTECTED_PATTERNS.some(pattern => normalized.includes(pattern.replace(/\/$/, "")))) return true;
  const roots = configuredHumanConsolePaths(cwd);
  if (roots.some(root => normalized.includes(root))) return true;
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^["']|["']$/g, "");
    if (!token) continue;
    if (withinAny(normalizePath(path.resolve(cwd, token)), roots)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Tool arguments come from the model: a field is a string, absent (falsy, as `||` skipped it), or malformed.
type TextField = { ok: true; value: string | undefined } | { ok: false; key: string };
// The first of `keys` that is set (`||` order). A set non-string is malformed, never skipped.
function textField(input: Record<string, unknown>, keys: readonly string[]): TextField {
  for (const key of keys) {
    const value = input[key];
    if (!value) continue;
    return typeof value === "string" ? { ok: true, value } : { ok: false, key };
  }
  return { ok: true, value: undefined };
}

function contentOf(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["content", "text", "new_string", "newText", "newString", "data", "body"]) {
    const value = input[key];
    if (typeof value === "string") parts.push(value);
  }
  // The live `edit` tool takes { path, edits: [{ oldText, newText }] }. Without traversing that
  // array the guard never sees an edit payload, so a secret written via edit is not detected.
  if (Array.isArray(input.edits)) {
    for (const item of input.edits) {
      if (!isRecord(item)) continue;
      for (const key of ["oldText", "newText", "new_string", "newString", "old_string", "content", "text"]) {
        const value = item[key];
        if (typeof value === "string") parts.push(value);
      }
    }
  }
  return parts.join("\n");
}

function detectSecretContent(content: string): string | null {
  for (const { re, label } of SECRET_CONTENT_PATTERNS) {
    if (re.test(content)) return label;
  }
  return null;
}

// Protections registry (shared, in-process; see tool-firewall/README.md). Each mandatory protection
// (tool-firewall, secret-guard, protected-paths) records its name here when its factory has
// installed its hooks, so a trusted launcher can check that a session loaded what it must have
// loaded. Extensions are self-contained, so every one carries this same small helper: whichever
// loads first creates the registry, the others add to it. It is a consistency check, not a
// boundary against code running in the same process.
const PROTECTIONS_KEY = Symbol.for("pi-kit.protections");

/** What another protection may already have stored under the key (every copy of this helper stores a Set). */
interface RegistryLike extends Iterable<unknown> {
  add(name: string): unknown;
  has(name: string): unknown;
  list?: unknown;
}

function isRegistryLike(value: unknown): value is RegistryLike {
  return (typeof value === "object" || typeof value === "function") && value !== null
    && "add" in value && typeof value.add === "function"
    && "has" in value && typeof value.has === "function"
    && Symbol.iterator in value && typeof value[Symbol.iterator] === "function";
}

function registerProtection(name: string): void {
  try {
    const g = globalThis as Record<symbol, unknown>;
    const existing = g[PROTECTIONS_KEY];
    let reg: RegistryLike;
    if (isRegistryLike(existing)) reg = existing;
    else {
      reg = new (class ProtectionRegistry extends Set<string> {})();
      g[PROTECTIONS_KEY] = reg;
    }
    reg.add(name);
    if (typeof reg.list !== "function") Object.defineProperty(reg, "list", { value: () => [...reg].map(String).sort(), enumerable: false, configurable: true });
  } catch {
    /* the registry must never break the protection itself */
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    const raw: unknown = event.input;
    const input = isRecord(raw) ? raw : {};
    const pathField = textField(input, ["path", "file"]);
    const commandField = toolName === "bash" ? textField(input, ["command", "cmd", "script"]) : null;
    for (const field of [pathField, commandField]) {
      if (field && !field.ok) return blocked(ctx, `secret-guard: blocked ${toolName}: ${field.key} is not a string`);
    }
    const rawPath = pathField.ok ? pathField.value : undefined;
    const cwd = ctx.cwd || process.cwd();
    const target = rawPath ? targetPaths(rawPath, cwd) : undefined;
    // 0. Direct reads/searches of credential files (defense in depth, not OS isolation;
    // a directory-wide grep can still reach file contents the path does not name).
    if (target && ["read", "grep", "find", "ls", "glob"].includes(toolName) && isSecretReadPath(target.scoped)) {
      return blocked(ctx, `secret-guard: blocked ${toolName} of sensitive path`);
    }

    // 1 + 2. Writes/edits: block secret/protected paths and secret content anywhere.
    if (toolName === "write" || toolName === "edit") {
      if (target && isSecretPath(target.scoped)) {
        return blocked(ctx, `secret-guard: blocked ${toolName} to secret file: ${rawPath}`);
      }
      // tool-firewall rotates its audit log to `<path>.1` past 4 MiB, so the rotated copy is protected too.
      const auditLog = process.env.PI_KIT_FIREWALL_AUDIT_LOG;
      const configuredAdminPaths = [process.env.PI_KIT_FIREWALL_POLICY, auditLog, auditLog ? `${auditLog}.1` : undefined, process.env.PI_KIT_FIREWALL_APPROVALS, process.env.PI_KIT_UNATTENDED_CONTRACT].filter((p): p is string => !!p).map(p => normalizePath(resolvedPath(p, cwd)));
      const absoluteProtected = PROTECTED_PATTERNS.filter(pattern => pattern.startsWith("/"));
      if (target && (isProtectedPath(target.scoped) || absoluteProtected.some(pattern => target.absolute.includes(pattern)) || configuredAdminPaths.includes(target.absolute) || withinAny(target.absolute, configuredHumanConsolePaths(cwd)))) {
        return blocked(ctx, `secret-guard: blocked ${toolName} to protected path: ${rawPath}`);
      }
      const contentHit = detectSecretContent(contentOf(input));
      if (contentHit) {
        return blocked(ctx, `secret-guard: blocked ${toolName} — content looks like a secret (${contentHit})`);
      }
    }

    // 3. Shell commands: direct leaks, or read/copy/encode/transfer of a secret/protected path.
    if (toolName === "bash") {
      const command = commandField?.ok ? commandField.value : undefined;
      if (command) {
        for (const candidate of new Set([command, deobfuscateShellText(command)])) {
          for (const pattern of SECRET_BASH_LEAK_PATTERNS) {
            if (pattern.test(candidate)) {
              return blocked(ctx, `secret-guard: blocked bash command matching secret-leak pattern: ${command.slice(0, 100)}`);
            }
          }
          if (TRANSFER_VERB.test(candidate) && (commandReferencesSecret(candidate) || commandReferencesProtected(candidate, cwd))) {
            return blocked(ctx, `secret-guard: blocked bash command reading/copying/exfiltrating a secret or protected path: ${command.slice(0, 100)}`);
          }
        }
      }
    }

    return undefined;
  });
  // Only once the hook is installed: a factory that failed earlier never registers.
  registerProtection("secret-guard");
}

function blocked(ctx: Pick<ExtensionContext, "hasUI" | "ui">, msg: string): { block: true; reason: string } {
  if (ctx.hasUI) ctx.ui.notify(msg, "warning");
  return { block: true, reason: msg };
}
