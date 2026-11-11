import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import fs from "node:fs";

// secret-guard is a pattern-based secrets/protected-path backstop, loaded by the balanced and
// autonomous profiles; the others record an exemption (packages/core/lib/protection-coverage.ts).
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

// Where the last `]` and the last `:]` of a token are, so that finding the end of a bracket class
// can say "none" in constant time. Without it a token of ten thousand `[` rescans the whole token
// from every `[` (quadratic).
interface ClassLimits { close: number; posix: number }

// Index of the `]` that closes the bracket class opened at `open`, or -1 when there is none. A `]`
// straight after the `[` (or after `[!` / `[^`) is a member, and `[:alpha:]` inside is one unit.
function bracketClassEnd(token: string, open: number, limits: ClassLimits): number {
  if (limits.close <= open) return -1;
  let i = open + 1;
  if (token.charAt(i) === "!" || token.charAt(i) === "^") i++;
  if (token.charAt(i) === "]") i++;
  while (i < token.length) {
    if (token.startsWith("[:", i)) {
      if (limits.posix < i + 2) return -1;
      i = token.indexOf(":]", i + 2) + 2;
      continue;
    }
    if (token.charAt(i) === "]") return i;
    i++;
  }
  return -1;
}

// What each POSIX class inside a bracket expression matches, as a RegExp class fragment.
const POSIX_CLASS_FRAGMENTS = new Map<string, string>([
  ["alpha", "a-zA-Z"], ["digit", "0-9"], ["alnum", "a-zA-Z0-9"], ["lower", "a-z"], ["upper", "A-Z"],
  ["xdigit", "0-9A-Fa-f"], ["word", "a-zA-Z0-9_"], ["blank", " \\t"], ["space", " \\t\\n\\r\\f\\v"],
  ["punct", "!-\\/:-@\\[-`{-~"], ["graph", "!-~"], ["print", " -~"], ["cntrl", "\\x00-\\x1f\\x7f"],
]);

// RegExp source for the inside of a bracket class. A POSIX class this does not know, or a range the
// engine rejects, becomes "any one character", which can only match more than the shell would.
function bracketClassSource(body: string): string {
  const negated = body.startsWith("!") || body.startsWith("^");
  const members = negated ? body.slice(1) : body;
  let inside = "";
  for (let i = 0; i < members.length; i++) {
    if (members.startsWith("[:", i)) {
      const end = members.indexOf(":]", i + 2);
      const fragment = end < 0 ? undefined : POSIX_CLASS_FRAGMENTS.get(members.slice(i + 2, end));
      if (fragment === undefined) return ".";
      inside += fragment;
      i = end + 1;
      continue;
    }
    const ch = members.charAt(i);
    inside += ch === "\\" || ch === "]" || ch === "^" || ch === "[" ? `\\${ch}` : ch;
  }
  const source = `[${negated ? "^" : ""}${inside}]`;
  try {
    new RegExp(source);
    return source;
  } catch {
    return ".";
  }
}

// Every element of a glob except `*` stands for exactly one character, so a glob with more of them
// than this cannot match a canonical secret name (the longest is sixteen characters). It also keeps
// the RegExp small: a token of sixty thousand `[` would otherwise build one V8 refuses to run.
const MAX_GLOB_ELEMENTS = 32;

interface GlobElement { source: string; literal: boolean; star: boolean }

// A glob token as RegExp pieces, or null when it has no glob character or cannot match a name of
// canonical length. One pass, linear in the token.
function parseGlob(token: string): GlobElement[] | null {
  if (!/[*?[]/.test(token)) return null;
  const limits: ClassLimits = { close: token.lastIndexOf("]"), posix: token.lastIndexOf(":]") };
  // One failed search for a class end makes the rest of the token literal, so a malformed token
  // costs one scan, not one per `[`.
  let classes = true;
  let consuming = 0;
  const elements: GlobElement[] = [];
  for (let i = 0; i < token.length; i++) {
    const ch = token.charAt(i);
    const end = ch === "[" && classes ? bracketClassEnd(token, i, limits) : -1;
    if (ch === "[" && end < 0) classes = false;
    if (ch === "*") {
      if (!elements.at(-1)?.star) elements.push({ source: ".*", literal: false, star: true });
      continue;
    }
    if (++consuming > MAX_GLOB_ELEMENTS) return null;
    if (ch === "?") elements.push({ source: ".", literal: false, star: false });
    else if (end > i) {
      elements.push({ source: bracketClassSource(token.slice(i + 1, end)), literal: false, star: false });
      i = end;
    } else elements.push({ source: ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"), literal: true, star: false });
  }
  return elements;
}

function globElementsToRegExp(elements: GlobElement[]): RegExp | null {
  try {
    return new RegExp(`^${elements.map((element) => element.source).join("")}$`, "i");
  } catch {
    return null;
  }
}

function globTokenToRegExp(token: string): RegExp | null {
  const elements = parseGlob(token);
  return elements ? globElementsToRegExp(elements) : null;
}

// Bounds on one token's expansion: how many words, and how many characters in all, so that a long
// token cannot multiply the cost of the scans that follow. A group that would pass either bound
// widens to `*`.
const MAX_GLOB_ALTERNATIVES = 1024;
const MAX_GLOB_EXPANDED_CHARS = 1048576;
const MAX_GLOB_ROUNDS = 16;
const PLAIN_CLASS_MEMBER = /[^\][!^\\:-]/;

interface GlobGroup { start: number; end: number; alternatives: string[] }

// The first complete group in a word, scanning once: a `{a,b}` (the innermost, because its `}`
// comes first; `{x}` without a comma is literal in the shell) or a bracket class of up to sixteen
// plain members (`[v]`, `[vV]`).
function findGlobGroup(word: string): GlobGroup | null {
  const opens: number[] = [];
  for (let i = 0; i < word.length; i++) {
    const ch = word.charAt(i);
    if (ch === "{") opens.push(i);
    else if (ch === "}") {
      const start = opens.pop();
      if (start === undefined) continue;
      const body = word.slice(start + 1, i);
      if (body.includes(",")) return { start, end: i + 1, alternatives: body.split(",") };
    } else if (ch === "[") {
      let j = i + 1;
      while (j < word.length && j - i <= 16 && PLAIN_CLASS_MEMBER.test(word.charAt(j))) j++;
      if (j > i + 1 && word.charAt(j) === "]") return { start: i, end: j + 1, alternatives: Array.from(word.slice(i + 1, j)) };
    }
  }
  return null;
}

// Replace each outermost `{...}` with `*` in one pass: the widest reading of a group the rounds
// did not finish, which can only match more than the group did.
function widenBraceGroups(word: string): string {
  let result = "";
  let copied = 0;
  let depth = 0;
  let open = 0;
  for (let i = 0; i < word.length; i++) {
    const ch = word.charAt(i);
    if (ch === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        result += `${word.slice(copied, open)}*`;
        copied = i + 1;
      }
    }
  }
  return result + word.slice(copied);
}

// The shell expands `{a,b}` and a bracket class of plain members before a command runs, so
// `.e{n,x}v`, `.en[v]` and `[.]env` name `.env` although no secret name appears in the text.
// Expand them, bounded: duplicates collapse (`{,,,}` is one empty word), at most 64 words are
// kept, and a group left over after the bound or 16 levels of nesting widens to `*`. Ranges,
// negations and POSIX classes (`[a-c]`, `[!x]`, `[[:lower:]]`) stay in the token for
// globTokenToRegExp. Quoted text is expanded too, deliberately: `sh -c 'cat .en[v]'` is a quoted
// word whose content a second shell expands.
function expandGlobGroups(token: string): string[] {
  let words = new Set([token]);
  for (let round = 0; round < MAX_GLOB_ROUNDS; round++) {
    const next = new Set<string>();
    let chars = 0;
    let expanded = false;
    for (const word of words) {
      const group = findGlobGroup(word);
      if (!group) {
        next.add(word);
        chars += word.length;
        continue;
      }
      expanded = true;
      const alternatives = new Set(group.alternatives);
      const before = word.slice(0, group.start);
      const after = word.slice(group.end);
      let added = alternatives.size * (before.length + after.length);
      for (const alternative of alternatives) added += alternative.length;
      if (next.size + alternatives.size > MAX_GLOB_ALTERNATIVES || chars + added > MAX_GLOB_EXPANDED_CHARS) {
        next.add(`${before}*${after}`);
        chars += before.length + 1 + after.length;
      } else {
        for (const alternative of alternatives) next.add(`${before}${alternative}${after}`);
        chars += added;
      }
    }
    words = next;
    if (!expanded) break;
  }
  return Array.from(words, widenBraceGroups);
}

// A glob segment names a secret directory only when enough of it is literal to be about that
// name: `secre[t-u]` and `.ss[h-i]` do, `*` and `s*` do not (`cat docs/*/README.md` is ordinary).
const MIN_LITERAL_GLOB_CHARS = 3;
function globSegmentReachesSecretDirectory(segment: string): boolean {
  const elements = parseGlob(segment);
  if (!elements || elements.filter((element) => element.literal).length < MIN_LITERAL_GLOB_CHARS) return false;
  const re = globElementsToRegExp(elements);
  return re !== null && [...SECRET_PATH_SEGMENTS, ".ssh"].some((name) => re.test(name));
}

// Detects glob-obscured secret references (`base64 .e??`, `cp .e??`, `cat .en[v]`) that never
// appear as a literal secret filename substring in the command text (F-04).
function commandHasGlobTokenMatchingSecret(command: string): boolean {
  for (const rawToken of command.split(/\s+/)) {
    for (const expanded of expandGlobGroups(rawToken)) {
      const token = expanded.replace(/^["']|["']$/g, "");
      const segments = token.split(/[\\/]/);
      const base = segments.at(-1) || token;
      const re = globTokenToRegExp(base);
      if (re && CANONICAL_SECRET_BASENAMES.some(name => re.test(name))) return true;
      if (segments.some(globSegmentReachesSecretDirectory)) return true;
    }
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

// Shell commands are sequences of words. A secret path is a secret in a path position,
// so the broad write-side patterns are tested against each token's basename rather than
// the whole command line. Matching the line made ordinary source under a secret-named
// directory (packages/extensions/src/secret-guard/index.ts) look like a secret read.
function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  // Quoted runs are one token; unquoted runs stop at whitespace, quotes, backticks and
  // shell operators, so `server.pem;` and `ReadAllBytes('.env')` split cleanly.
  const re = /"([^"]*)"|'([^']*)'|([^\s"'`;|&<>()]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const token = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

const SECRET_READ_PATH_PATTERNS_FOR_COMMANDS = SECRET_READ_PATH_PATTERNS.map(toCommandScanPattern);
// The broad write-side patterns match /secret/ and /credentials/ anywhere, which made an
// ordinary source path such as packages/extensions/src/secret-guard/index.ts look secret.
// A directory component counts only when it is exactly one of these names.
const SECRET_PATH_SEGMENTS = new Set(["secret", "secrets", "credentials"]);

interface SearchWord { value: string; start: number; end: number; quoted: boolean }

// Recognise only plain, leading grep/rg invocations. If shell syntax or option roles are
// uncertain, leave the command untouched for the existing fail-closed token scan.
function searchPatternSpans(command: string): SearchWord[] {
  // Escapes change quote and word boundaries; this narrow recogniser does not model them.
  if (command.includes("\\")) return [];
  let quote: "'" | '"' | null = null;
  for (const ch of command) {
    if (ch === quote) quote = null;
    else if (quote === null && (ch === "'" || ch === '"')) quote = ch;
  }
  if (quote !== null) return [];

  const words: SearchWord[] = [];
  let i = 0;
  while (i < command.length) {
    if (/\s/.test(command.charAt(i))) { i++; continue; }
    if (command.charAt(i) === "|") break;
    const start = i;
    let value: string;
    const quoted = command.charAt(i) === "'" || command.charAt(i) === '"';
    if (quoted) {
      const closing = command.indexOf(command.charAt(i), i + 1);
      if (closing < 0) return [];
      value = command.slice(i + 1, closing);
      i = closing + 1;
      if (i < command.length && !/\s|\|/.test(command.charAt(i))) return [];
    } else {
      while (i < command.length && !/\s|\|/.test(command.charAt(i))) i++;
      value = command.slice(start, i);
    }
    // Includes substitutions, shell operators, escaping and joined quote fragments.
    if (/[`$;&<>()\\]/.test(value)) return [];
    words.push({ value, start, end: i, quoted });
  }
  if (i < command.length && command.charAt(i + 1) === "|") return [];
  if (!/^(?:rg|grep|egrep|fgrep)$/i.test(words[0]?.value ?? "")) return [];

  const positions: SearchWord[] = [];
  const explicitPatterns: SearchWord[] = [];
  let hasPatternFile = false;
  let options = true;
  const shortNoValue = new Set("nrRivlcqshHowxFE");
  const longNoValue = new Set(["--line-number", "--recursive", "--ignore-case", "--fixed-strings", "--extended-regexp", "--count", "--quiet", "--no-heading"]);
  const longWithValue = new Set(["--glob", "--type", "--max-count", "--after-context", "--before-context", "--context"]);
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (!word) return [];
    if (options && word.value === "--") { options = false; continue; }
    if (options && word.value.startsWith("--")) {
      if (word.value === "--regexp" || word.value === "--file") {
        const next = words[++index];
        if (!next) return [];
        if (word.value === "--file") hasPatternFile = true;
        else explicitPatterns.push(next);
      } else if (word.value.startsWith("--regexp=")) {
        explicitPatterns.push(word);
      } else if (word.value.startsWith("--file=")) {
        hasPatternFile = true;
      } else if (longWithValue.has(word.value)) {
        if (!words[++index]) return [];
      } else if (!longNoValue.has(word.value)) return [];
      continue;
    }
    if (options && word.value.startsWith("-") && word.value !== "-") {
      for (let flag = 1; flag < word.value.length; flag++) {
        const ch = word.value.charAt(flag);
        if (ch === "e" || ch === "f" || "ABCmgt".includes(ch)) {
          const attached = flag + 1 < word.value.length;
          const operand = attached ? word : words[++index];
          if (!operand) return [];
          if (ch === "e") explicitPatterns.push(operand);
          if (ch === "f") hasPatternFile = true;
          break;
        }
        if (!shortNoValue.has(ch)) return [];
      }
      continue;
    }
    positions.push(word);
  }
  if (explicitPatterns.length === 0 && hasPatternFile) return [];
  const patterns = explicitPatterns.length > 0 ? explicitPatterns : positions.slice(0, 1);
  // The shell expands an unquoted glob, brace or tilde word before the search tool sees it,
  // so it can name a file (`grep sec* x`, `grep ~/.ssh/id_* x`) even where it sits in the
  // pattern position. Only a quoted pattern is certainly text.
  if (patterns.some((word) => !word.quoted && /[*?[\]{}~]/.test(word.value))) return [];
  return patterns;
}

function commandReferencesSecret(command: string): boolean {
  let scanned = command;
  for (const span of searchPatternSpans(command).reverse()) {
    scanned = `${scanned.slice(0, span.start)} ${scanned.slice(span.end)}`;
  }
  scanned = stripEnvTemplateTokens(normalizePath(scanned));
  if (commandHasGlobTokenMatchingSecret(scanned)) return true;
  for (const token of shellTokens(scanned).flatMap(expandGlobGroups)) {
    const segments = token.split(/[\\/]/);
    const base = segments.pop() || token;
    if (SECRET_PATH_PATTERNS.some(p => p.test(base))) return true;
    if (SECRET_READ_BASENAME_PATTERNS.some(p => p.test(base))) return true;
    if (SECRET_READ_PATH_PATTERNS_FOR_COMMANDS.some(p => p.test(token))) return true;
    if (segments.some(segment => SECRET_PATH_SEGMENTS.has(segment))) return true;
  }
  return false;
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
