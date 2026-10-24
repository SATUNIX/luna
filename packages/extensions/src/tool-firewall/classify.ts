// Effect classification: what a tool call would do, and how much it matters.
//
// Every finding carries an effect (the spec's ontology), a tier (low < medium < high <
// critical), a reason code and a short human detail. The action's tier is the highest finding.
// `autoLow` marks a medium finding the operator chose to trust in auto mode (read-only ssh to
// a known host, `sudo -n` reads); the decision matrix demotes those to low when auto is on.
import { basenameOf, decoderLike, isForkBomb, normalize, parseShell, type Segment } from "./shell.ts";

export type Tier = "low" | "medium" | "high" | "critical";
export type Effect =
  | "read"
  | "workspace_write"
  | "write_outside"
  | "delete"
  | "package_install"
  | "network_read"
  | "network_send"
  | "remote_exec"
  | "privilege"
  | "persistence"
  | "credential_read"
  | "security_control"
  | "history_rewrite"
  | "publish"
  | "destructive_system"
  | "obfuscated_exec"
  | "code_exec"
  | "process_control"
  | "unknown_exec"
  | "opaque";

export type Finding = {
  tier: Tier;
  effect: Effect;
  code: string;
  detail: string;
  autoLow?: boolean;
  key?: string | undefined; // generalised signature fragment for precedents and leases
  scope?: string; // where it runs: "local", "local as root", "<host>", "<host> as root"
};

export type SegmentView = { text: string; where: string; tier: Tier; effects: Effect[] };

// A host this command contacts from here (loopback excluded), and how; and a git remote it pushes to or
// fetches from. Unattended mode checks them against the run contract.
export type HostRef = { host: string; how: "read" | "send" | "connect"; via: string };
export type RemoteRef = { name: string; op: "push" | "fetch" };

export type Assessment = {
  tool: string;
  tier: Tier;
  findings: Finding[];
  effects: Effect[];
  segments: SegmentView[];
  summary: string;
  command?: string;
  // Trajectory facts.
  credentialReads: string[];
  downloads: string[];
  executes: string[];
  chmodExec: string[];
  sends: { dest: string; local: boolean }[];
  hosts: HostRef[];
  remotes: RemoteRef[];
  remoteChanges: number; // git remote / url config changes in the same command
  deletes: number;
  untrusted: boolean;
};

export type ClassifyEnv = {
  cwd: string;
  workspace: string;
  home: string;
  tmpRoots: string[];
  knownHosts: Set<string>;
  policy: "coding" | "pentest";
  // Files that are the boundary of an unattended run (the contract): a control surface like the kit's own state.
  boundaryPaths?: string[];
};

export const TIER_RANK: Record<Tier, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const maxTier = (a: Tier, b: Tier): Tier => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);

// ---------------------------------------------------------------------------------------------
// Paths

export type PathClass =
  | "device"
  | "root_critical"
  | "system"
  | "security_control"
  | "credential"
  | "credential_ws" // .env-style secrets inside the workspace
  | "persistence"
  | "exec_config"
  | "git_internal"
  | "git_hooks"
  | "workspace_root"
  | "workspace_derived"
  | "workspace"
  | "temp"
  | "home"
  | "other"
  | "unknown"
  | "null_sink";

const SYSTEM_TOP = ["etc", "usr", "bin", "sbin", "lib", "lib32", "lib64", "boot", "var", "opt", "root", "sys", "proc", "dev", "srv", "snap", "efi", "run", "mnt", "media", "home", "nix", "System", "Library", "Applications", "private"];
const DERIVED = new Set(["node_modules", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".output", ".cache", ".parcel-cache", ".turbo", ".vite", "coverage", ".nyc_output", "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".venv", "venv", ".gradle", ".dart_tool", "tmp", ".tmp", ".runtime", "_site", ".docusaurus", "storybook-static", ".angular", ".expo", "DerivedData", ".eslintcache", ".terraform", "bin/Debug", "obj", ".sass-cache", "site", "public/build", ".wrangler", ".vercel", ".netlify", "logs"]);
const NULL_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full"]);
const DEVICE_RE = /^\/dev\/(?:sd[a-z]|nvme\d|mmcblk\d|hd[a-z]|vd[a-z]|xvd[a-z]|disk\d|dm-\d|md\d|loop\d|mapper\/|rdisk|mem$|kmem$|port$)/;

const CRED_BASENAME = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)|\.netrc|_netrc|\.pgpass|\.pypirc|\.npmrc|\.yarnrc\.yml|\.git-credentials|\.htpasswd|credentials(?:\.json|\.db)?|auth\.json|\.credentials\.json|secrets?\.(?:ya?ml|json|toml|env)|service[-_]account.*\.json|shadow|gshadow|master\.key|\.vault[-_]token)$/i;
// Certificates and CA bundles are public even though they share the .pem extension.
const CERT_NAME = /(?:^|[-_.])(?:ca|cert|certs|certificate|chain|fullchain|bundle|root|intermediate|trust)(?:[-_.]|$)|\.crt$/i;
const CRED_PUBLIC = /\.pub$|(?:^|\/)(?:known_hosts|authorized_keys|config)$|\.(?:example|sample|template|dist|defaults?)$|(?:^|\/)ca-certificates|\/certs?\//i;
const ENV_FILE = /^\.env(?:\..+)?$|^\.envrc$|^\.dev\.vars$/;
const HOME_CRED_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".password-store", ".local/share/keyrings", ".config/gh", ".config/gcloud", ".azure", ".config/rclone", ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".pi/agent/auth.json", ".claude/.credentials.json", ".codex/auth.json", ".config/op", ".terraform.d", ".vault-token"];
const PERSIST_HOME = [".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".config/fish/config.fish", ".config/fish/conf.d", ".config/autostart", ".config/systemd", ".config/environment.d", ".ssh/authorized_keys", ".ssh/rc", ".xprofile", ".xinitrc", ".xsession", "Library/LaunchAgents", ".local/share/systemd", ".pam_environment", ".config/hypr/autostart.conf"];
// Config that can name commands to run later (ProxyCommand, core.sshCommand, aliases): worth a look, not a hard stop.
const EXEC_CONFIG_HOME = [".ssh/config", ".gitconfig", ".config/git/config"];
const PERSIST_SYSTEM = [/^\/etc\/(?:systemd|cron|crontab|rc|init|profile|bash\.bashrc|zsh|environment|ld\.so\.preload|sudoers|pam\.d|ssh\/sshd_config|xdg\/autostart)/, /^\/var\/spool\/cron/, /^\/usr\/lib\/systemd/, /^\/Library\/Launch/];

const SAFE_ENV = new Set(["USER", "LOGNAME"]);

export function resolvePath(p: string, cwd: string | null, env: ClassifyEnv, remote?: string, vars?: Record<string, string>): string | null {
  let s = p.trim();
  if (!s) return null;
  if (vars || !remote) {
    s = s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m: string, name: string) => (vars && Object.hasOwn(vars, name) ? vars[name] ?? m : !remote && SAFE_ENV.has(name) && process.env[name] ? process.env[name] : m));
  }
  if (/^[A-Za-z]:(?:[\\/]|[^\\/:]|$)/.test(s) || s.startsWith("\\\\")) return s.replace(/\\/g, "/").replace(/^([A-Za-z]:)(?!\/)/, "$1/"); // Windows absolute (a shell may have eaten the backslash)
  s = s.replace(/^\$\{?HOME\}?(?=\/|$)/, "~").replace(/^\$\{?TMPDIR\}?(?=\/|$)/, remote ? "/tmp" : env.tmpRoots[0] ?? "/tmp");
  s = s.replace(/^\$\{?PWD\}?(?=\/|$)/, cwd ?? "$PWD");
  if (/[`]|\$\(|\$\{?[A-Za-z_]/.test(s)) return null; // unresolved expansion
  if (s === "~" || s.startsWith("~/")) return remote ? normalize(s) : normalize(env.home + s.slice(1));
  if (/^~[A-Za-z]/.test(s)) return remote ? s : `/home/${s.slice(1)}`;
  if (s.startsWith("/")) return normalize(s);
  if (cwd === null) return null;
  return normalize(`${cwd}/${s}`);
}

function within(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function relTo(p: string, root: string): string {
  return p === root ? "" : p.slice(root.length + 1);
}

// The project's own control directory, <workspace>/.pi and <cwd>/.pi: the firewall's audit trail, verdicts and
// auto-mode switch live there, and so do the files pi loads into the next session (project settings, MCP servers,
// system-prompt files, extensions, skills, prompts, themes) and the operator's goal (/goal writes GOAL.yaml).
const PROJECT_CONTROL = /^(?:(?:GOAL\.yaml|settings\.json|mcp\.json|mcp-adapter\.json|SYSTEM\.md|APPEND_SYSTEM\.md)$|(?:extensions|skills|prompts|themes)(?:\/|$))/;

function projectControlDirs(env: ClassifyEnv): string[] {
  return [...new Set([env.workspace, env.cwd].filter(Boolean).map((d) => `${d.replace(/\/+$/, "")}/.pi`))];
}

const MAX_BRACE_EXPANSIONS = 64;

// Bash brace expansion of one word: `{a,b}` alternatives (nested, several groups) and `{x..y[..step]}`
// sequences of integers or single letters; `${...}`, `{}` and `{x}` stay literal. Returns null when the word
// would expand to more than MAX_BRACE_EXPANSIONS words, so callers can fail closed.
function expandBraces(word: string, max = MAX_BRACE_EXPANSIONS): string[] | null {
  for (let i = word.indexOf("{"); i >= 0; i = word.indexOf("{", i + 1)) {
    let depth = 0;
    let end = -1;
    const commas: number[] = [];
    for (let k = i; k < word.length; k++) {
      const ch = word[k];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = k; break; } }
      else if (ch === "," && depth === 1) commas.push(k);
    }
    if (end < 0) return [word];
    if (word[i - 1] === "$") { i = end; continue; }
    const prefix = word.slice(0, i);
    const suffix = word.slice(end + 1);
    let alts: string[];
    if (commas.length) {
      alts = [];
      let from = i + 1;
      for (const k of [...commas, end]) { alts.push(word.slice(from, k)); from = k + 1; }
    } else {
      const seq = braceSequence(word.slice(i + 1, end), max);
      if (seq === undefined) continue;
      if (seq === null) return null;
      alts = seq;
    }
    const out: string[] = [];
    for (const alt of alts) {
      const sub = expandBraces(prefix + alt + suffix, max);
      if (sub === null || out.length + sub.length > max) return null;
      out.push(...sub);
    }
    return out;
  }
  return [word];
}

// `x..y[..step]` inside braces: its words, null when there are too many, undefined when it is not a sequence.
function braceSequence(body: string, max: number): string[] | null | undefined {
  const m = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/.exec(body);
  if (!m) return undefined;
  const letters = m[3] !== undefined;
  const from = letters ? (m[3] ?? "").charCodeAt(0) : Number(m[1]);
  const to = letters ? (m[4] ?? "").charCodeAt(0) : Number(m[2]);
  const step = Math.abs(Number(m[5] ?? "1")) || 1;
  if (Math.floor(Math.abs(to - from) / step) + 1 > max) return null;
  const out: string[] = [];
  for (let v = from; from <= to ? v <= to : v >= to; v += from <= to ? step : -step) out.push(letters ? String.fromCharCode(v) : String(v));
  return out;
}

// The words a path operand stands for after brace expansion, normalized; null past the bound.
function braceAlternatives(p: string): string[] | null {
  if (!p.includes("{")) return [p];
  const alts = expandBraces(p);
  return alts === null ? null : alts.length > 1 ? alts.map((a) => normalize(a)) : alts;
}

// Brace-expanded operands, as the shell hands them to the command; a word past the bound stays as written,
// and classifyPath then treats it as a safety control.
function expandOperands(words: string[]): string[] {
  return words.flatMap((w) => (w.includes("{") ? expandBraces(w) ?? [w] : [w]));
}

// One unexpanded shell glob segment (*, ?, [...]) against one path component. As in bash without dotglob,
// a leading "." in the name has to be matched by a literal "." in the pattern.
function globSegMatches(pat: string, name: string): boolean {
  if (name.startsWith(".") && !pat.startsWith(".")) return false;
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i] ?? "";
    if (ch === "*") { re += "[^/]*"; continue; }
    if (ch === "?") { re += "[^/]"; continue; }
    if (ch === "[") {
      let j = i + 1;
      if (pat[j] === "!" || pat[j] === "^") j++;
      if (pat[j] === "]") j++;
      // A POSIX class, collating symbol or equivalence class ([:alpha:], [.x.], [=e=]) inside the brackets:
      // fail closed and let the whole bracket expression match any one character.
      const cls = /^[^\]]*\[[:.=]/.exec(pat.slice(j));
      if (cls) {
        let k = j + cls[0].length;
        for (;;) {
          const close = pat.indexOf("]", k);
          if (close < 0) { k = -1; break; }
          if (pat[close - 1] === ":" || pat[close - 1] === "." || pat[close - 1] === "=") { k = close + 1; continue; }
          k = close;
          break;
        }
        if (k > 0) { re += "[^/]"; i = k; continue; }
      }
      const end = pat.indexOf("]", j);
      if (end > 0) {
        const negate = pat[i + 1] === "!" || pat[i + 1] === "^";
        const body = pat.slice(negate ? i + 2 : i + 1, end).replace(/[^A-Za-z0-9-]/g, (m) => `\\${m}`);
        re += `[${negate ? "^" : ""}${body}]`;
        i = end;
        continue;
      }
    }
    re += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(name);
}

// A directory that is, or holds, a project control directory: moving it away takes every control file with it.
// An unexpanded glob operand (`mv .p* /tmp`) counts when it could match the control directory or an ancestor.
function holdsProjectControl(abs: string, env: ClassifyEnv): boolean {
  const alts = braceAlternatives(abs);
  if (alts === null) return true;
  if (alts.length > 1) return alts.some((a) => holdsProjectControl(a, env));
  const trimmed = abs.replace(/\/+$/, "") || "/";
  if (!/[*?[]/.test(trimmed)) return projectControlDirs(env).some((d) => within(d, trimmed));
  const pat = trimmed.split("/");
  return projectControlDirs(env).some((d) => {
    const parts = d.split("/");
    return pat.length <= parts.length && pat.every((seg, i) => (/[*?[]/.test(seg) ? globSegMatches(seg, parts[i] ?? "") : seg === parts[i]));
  });
}

export function classifyPath(abs: string | null, env: ClassifyEnv, remote?: string): PathClass {
  if (abs === null) return "unknown";
  if (NULL_SINKS.has(abs) || /^\/dev\/fd\/|^\/proc\/self\/fd\//.test(abs)) return "null_sink";
  if (DEVICE_RE.test(abs)) return "device";
  const base = abs.split("/").pop() ?? "";
  const home = remote ? "~" : env.home;
  // Filesystem roots and the home / workspace ancestors.
  const trimmed = abs.replace(/\/+$/, "") || "/";
  if (trimmed === "/" || trimmed === home || trimmed === "~" || /^[A-Za-z]:\/?$/.test(trimmed)) return "root_critical";
  const top = trimmed.split("/").filter(Boolean);
  if (top.length === 1 && SYSTEM_TOP.includes(top[0] ?? "") && trimmed.startsWith("/")) return "root_critical";
  if (!remote && within(env.workspace, trimmed) && trimmed !== env.workspace) return "root_critical";
  if (/^\/(?:home|Users)\/[^/]+$/.test(trimmed)) return "root_critical";
  if (/^\/proc\/\d+\/environ$|^\/proc\/self\/environ$/.test(trimmed)) return "credential";

  // The tool I/O capture log stores tool output byte-exact, secrets included: reading it is a
  // credential read (so it feeds secret → egress), writing or deleting it is high.
  // The agent directory honours PI_CODING_AGENT_DIR, like the rest of the kit's state (config.ts); the
  // default ~/.pi/agent stays protected as well.
  const agentDirEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDirs = remote ? [] : [...new Set([...(agentDirEnv ? [normalize(agentDirEnv)] : []), `${env.home}/.pi/agent`])];
  const captureDir = remote ? null : (process.env.PI_KIT_CAPTURE_DIR?.trim() || `${agentDirs[0]}/pi-kit/capture`).replace(/\/+$/, "");
  if (captureDir && within(trimmed, captureDir)) return "credential";
  // The web console's access token (`/console` writes <web-ui>/.runtime/console.token, or the operator names a file in
  // PI_CONSOLE_TOKEN_FILE): whoever holds it can drive sessions with shell access, so reading it is a credential read.
  const consoleTokenFile = remote ? "" : process.env.PI_CONSOLE_TOKEN_FILE?.trim();
  if (base === "console.token" || (consoleTokenFile && trimmed === normalize(consoleTokenFile))) return "credential";

  // Security controls for this kit. A brace-expanded path is one when any of its expansions is, and so is one
  // that would expand past the bound (fail closed).
  const braceAlts = braceAlternatives(trimmed);
  if (braceAlts === null || (braceAlts.length > 1 && braceAlts.some((a) => classifyPath(a, env, remote) === "security_control"))) return "security_control";
  if (agentDirs.some((d) => trimmed === `${d}/settings.json` || within(trimmed, `${d}/pi-kit`))) return "security_control";
  // The remembered-approvals file wherever PI_KIT_FIREWALL_APPROVALS puts it: planting an entry would let an action run unasked.
  const approvalsFile = remote ? "" : process.env.PI_KIT_FIREWALL_APPROVALS?.trim();
  if (approvalsFile && (trimmed === normalize(approvalsFile) || trimmed.startsWith(`${normalize(approvalsFile)}.`))) return "security_control";
  if (/\/\.pi\/(?:auto-mode\.json|tool-firewall-audit\.jsonl|firewall(?:\/|$)|human-console(?:\/|$)|verdicts\.json|trace\.jsonl)/.test(trimmed)) return "security_control";
  if (/(?:^|\/)tool-firewall\/default-policy\.json$|(?:^|\/)packages\/core\/policies\//.test(trimmed)) return "security_control";
  // The control directory itself (renaming, replacing or deleting it swaps every control file at once) and the
  // loader and goal files inside it.
  if (!remote && projectControlDirs(env).some((d) => trimmed === d || (within(trimmed, d) && PROJECT_CONTROL.test(relTo(trimmed, d))))) return "security_control";

  if (!remote && env.boundaryPaths?.some((b) => trimmed === b || within(trimmed, b))) return "security_control";

  // Credentials.
  const homeRel = trimmed.startsWith(`${home}/`) ? trimmed.slice(home.length + 1) : null;
  if (homeRel !== null && HOME_CRED_DIRS.some((d) => within(homeRel, d)) && !CRED_PUBLIC.test(trimmed)) return "credential";
  if (/^\/etc\/(?:shadow|gshadow|ssh\/ssh_host_.*_key$|ssl\/private)/.test(trimmed)) return "credential";
  if (CRED_BASENAME.test(base) && !CRED_PUBLIC.test(trimmed) && !(/\.pem$/i.test(base) && CERT_NAME.test(base))) return !remote && within(trimmed, env.workspace) && !/^id_/.test(base) && !/\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i.test(base) ? "credential_ws" : "credential";
  if (ENV_FILE.test(base) && !CRED_PUBLIC.test(base)) return !remote && within(trimmed, env.workspace) ? "credential_ws" : "credential";

  // Persistence.
  if (homeRel !== null && PERSIST_HOME.some((d) => within(homeRel, d))) return "persistence";
  if (homeRel !== null && EXEC_CONFIG_HOME.some((d) => within(homeRel, d))) return "exec_config";
  if (PERSIST_SYSTEM.some((re) => re.test(trimmed))) return "persistence";

  if (!remote) {
    if (within(trimmed, env.workspace)) {
      if (trimmed === env.workspace) return "workspace_root";
      const rel = relTo(trimmed, env.workspace);
      if (/(?:^|\/)\.git\/hooks(?:\/|$)/.test(rel)) return "git_hooks";
      if (/(?:^|\/)\.git(?:\/|$)/.test(rel)) return /\.lock$/.test(rel) ? "workspace" : "git_internal";
      if (rel.split("/").some((part) => DERIVED.has(part)) || /\.(?:log|pid|tmp|o|pyc|class|tsbuildinfo)$/.test(base)) return "workspace_derived";
      return "workspace";
    }
    if (env.tmpRoots.some((t) => within(trimmed, t))) return "temp";
  } else if (/^\/(?:tmp|var\/tmp)(?:\/|$)/.test(trimmed)) return "temp";
  if (top.length && SYSTEM_TOP.includes(top[0] ?? "") && trimmed.startsWith("/") && !/^\/(?:home|Users|mnt|media|run\/media)\//.test(trimmed)) return "system";
  if (homeRel !== null || trimmed.startsWith("~/")) return "home";
  return "other";
}

// Tables keyed by a name the command chose (its executable, an effect in a family key): own entries only, so a
// command called `toString` or `constructor` is an unknown name rather than a hit on Object.prototype.
function own<T>(table: Partial<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function tmpDirect(abs: string, env: ClassifyEnv): boolean {
  return env.tmpRoots.some((t) => abs.startsWith(`${t}/`) && !abs.slice(t.length + 1).includes("/")) || /^\/(?:tmp|var\/tmp)\/[^/]+$/.test(abs);
}

function resourceKey(abs: string | null, cls: PathClass, env: ClassifyEnv, remote?: string): string {
  if (abs === null) return "?";
  if (!remote && within(abs, env.workspace)) {
    const rel = relTo(abs, env.workspace);
    return rel ? `./${rel.split("/")[0]}` : ".";
  }
  if (cls === "temp") return "/tmp";
  const home = remote ? "~" : env.home;
  if (abs.startsWith(`${home}/`)) return `~/${abs.slice(home.length + 1).split("/").slice(0, 2).join("/")}`;
  return `/${abs.split("/").filter(Boolean).slice(0, 2).join("/")}`;
}

// ---------------------------------------------------------------------------------------------
// Building findings

type Ctx = {
  env: ClassifyEnv;
  seg: Segment;
  exe: string;
  findings: Finding[];
  a: Assessment;
};

function prefix(seg: Segment): string {
  return `${seg.remote ? `ssh:${seg.remote} ` : ""}${seg.sudo ? "sudo " : ""}`;
}

function scopeOf(seg: Segment): string {
  return `${seg.remote ?? "local"}${seg.sudo ? " as root" : ""}`;
}

function add(c: Ctx, tier: Tier, effect: Effect, code: string, detail: string, key?: string, autoLow?: boolean): void {
  c.findings.push({ tier, effect, code, detail, key: key === undefined ? undefined : `${prefix(c.seg)}${key}`, scope: scopeOf(c.seg), ...(autoLow ? { autoLow } : {}) });
}

function pathOf(c: Ctx, p: string) {
  const abs = resolvePath(p, c.seg.cwd, c.env, c.seg.remote, c.seg.vars);
  const cls = classifyPath(abs, c.env, c.seg.remote);
  return { abs, cls, key: resourceKey(abs, cls, c.env, c.seg.remote), shown: abs ?? p };
}

const READ_CRED_TIER = (cls: PathClass): Tier | null => (cls === "credential" ? "high" : cls === "credential_ws" ? "medium" : null);

function readPath(c: Ctx, p: string): void {
  const r = pathOf(c, p);
  const t = READ_CRED_TIER(r.cls);
  if (t) {
    add(c, t, "credential_read", "credential_read", `reads secret material: ${r.shown}`, `${c.exe} read ${r.key}`);
    c.a.credentialReads.push(r.shown);
  }
  if (r.cls === "device") add(c, "high", "credential_read", "raw_device_read", `reads a raw block device: ${r.shown}`, `${c.exe} read ${r.key}`);
}

function writePath(c: Ctx, p: string, how: string): void {
  const tcp = /^\/dev\/(tcp|udp)\/([^/]+)\/(\d+)/.exec(p);
  if (tcp) {
    const [, proto = "", host = "", port = ""] = tcp;
    const local = LOCALHOST_RE.test(host);
    c.a.sends.push({ dest: host, local });
    noteHost(c, host, "send");
    add(c, local ? "low" : "medium", "network_send", "dev_tcp", `opens a ${proto} socket to ${host}:${port}`, `/dev/${proto} ${host}`);
    return;
  }
  const r = pathOf(c, p);
  const key = `${c.exe} write ${r.key}`;
  switch (r.cls) {
    case "null_sink":
      return;
    case "device":
      add(c, "critical", "destructive_system", "device_write", `${how} a raw block device: ${r.shown}`, key);
      return;
    case "root_critical":
    case "system":
      add(c, "high", "write_outside", "system_write", `${how} a system path: ${r.shown}`, key);
      return;
    case "security_control":
      add(c, "high", "security_control", "security_control_write", `${how} a safety-control file: ${r.shown}`, key);
      return;
    case "credential":
      add(c, "medium", "write_outside", "credential_write", `${how} a key/credential location: ${r.shown}`, key);
      return;
    case "exec_config":
      add(c, "medium", "write_outside", "exec_config_write", `${how} a config that can run commands (${r.shown})`, key);
      return;
    case "credential_ws":
      add(c, "medium", "workspace_write", "env_write", `${how} a workspace secrets file: ${r.shown}`, key);
      return;
    case "persistence":
    case "git_hooks":
      add(c, "high", "persistence", "persistence_write", `${how} a startup/persistence location: ${r.shown}`, key);
      return;
    case "git_internal":
      add(c, "medium", "workspace_write", "git_internal_write", `${how} git internals: ${r.shown}`, key);
      return;
    case "home":
    case "other":
      add(c, "medium", "write_outside", "outside_write", `${how} outside the workspace: ${r.shown}`, key);
      return;
    case "unknown":
      if (c.seg.remote) return; // remote writes are covered by the remote-exec rule
      add(c, "low", "workspace_write", "unresolved_write", `${how} a path computed at runtime: ${p}`);
      return;
    default:
      add(c, "low", "workspace_write", "workspace_write", `${how} ${r.shown}`);
  }
}

function deletePath(c: Ctx, p: string, recursive: boolean): void {
  const r = pathOf(c, p);
  const glob = /[*?]/.test(p);
  const key = `${c.exe}${recursive ? " -r" : ""} ${r.key}`;
  c.a.deletes++;
  const what = recursive ? "recursively deletes" : "deletes";
  const tierFor = (): [Tier, string] => {
    switch (r.cls) {
      case "null_sink":
        return ["low", "null"];
      case "device":
      case "root_critical":
        return ["critical", "critical_path_delete"];
      case "system":
        return ["high", "system_delete"];
      case "security_control":
        return ["high", "security_control_delete"];
      case "credential":
        return ["high", "credential_delete"];
      case "persistence":
      case "git_hooks":
        return ["high", "persistence_delete"];
      case "exec_config":
        return ["medium", "outside_delete"];
      case "git_internal":
        return ["high", "git_history_delete"];
      case "workspace_root":
        return ["high", "workspace_root_delete"];
      case "workspace_derived":
        return ["low", "derived_delete"];
      case "credential_ws":
        return ["medium", "env_delete"];
      case "workspace":
        return recursive || (glob && pathOf(c, p.replace(/\/?[^/]*[*?][^/]*$/, "") || ".").cls === "workspace_root") ? ["medium", "workspace_delete"] : ["low", "workspace_file_delete"];
      case "temp":
        return recursive && r.abs !== null && tmpDirect(r.abs, c.env) ? ["medium", "temp_delete"] : ["low", "temp_delete"];
      case "home":
      case "other":
        return recursive ? ["high", "outside_delete"] : ["medium", "outside_delete"];
      case "unknown":
        return recursive ? ["high", "unresolved_delete"] : ["medium", "unresolved_delete"];
    }
  };
  let [tier, code] = tierFor();
  if (code === "null") return;
  if (glob) {
    const parent = pathOf(c, p.replace(/\/?[^/]*[*?][^/]*$/, "") || "/");
    if (parent.cls === "root_critical") [tier, code] = ["critical", "critical_path_delete"];
  }
  if (c.seg.remote && TIER_RANK[tier] < TIER_RANK[recursive ? "high" : "medium"] && r.cls !== "temp") {
    tier = recursive ? "high" : "medium";
    code = "remote_delete";
  }
  if (glob && r.cls === "workspace" && !recursive && tier === "low") tier = "low";
  add(c, tier, tier === "critical" ? "destructive_system" : "delete", code, `${what} ${r.shown}`, key);
}

function argPaths(argv: string[], from = 1): string[] {
  const out: string[] = [];
  let endOpts = false;
  for (const a of argv.slice(from)) {
    if (!endOpts && a === "--") { endOpts = true; continue; }
    if (!endOpts && a.startsWith("-") && a !== "-") continue;
    out.push(a);
  }
  return out;
}

function looksLikePath(a: string): boolean {
  return /^(?:~|\/|\.{1,2}\/|\$HOME|\$\{HOME\})/.test(a) || /\//.test(a) || /^\.[A-Za-z]/.test(a) || /\.(?:pem|key|env|json|ya?ml|toml|conf|cfg|ini|txt|sh|py|js|ts)$/.test(a);
}

const LOCALHOST_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|[\w.-]+\.localhost|host\.docker\.internal)$/i;

// Loopback stays inside the zone; everything else is recorded for the unattended egress check. Hosts
// reached FROM a remote machine (inside `ssh host '…'`) are not contacted from here and are not recorded.
const LOOPBACK_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|[\w.-]+\.localhost)$/i;
function noteHost(c: Ctx, host: string | null | undefined, how: HostRef["how"]): void {
  if (c.seg.remote) return;
  const h = (host ?? "?").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (LOOPBACK_RE.test(h)) return;
  c.a.hosts.push({ host: h || "?", how, via: c.exe });
}

function urlHost(u: string): string | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#\s]+)/i.exec(u);
  return m ? (m[1] ?? "").toLowerCase() : null;
}

// Environment-variable style names only (`$OPENAI_API_KEY`, not a loop's `$key`).
function isSecretName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASS(?:WORD|WD)?|PASSPHRASE|AUTH|CREDENTIALS?|SESSION|COOKIE|PRIVATE_?KEY|ACCESS_?KEY)(?:_|$)/.test(name) && !/^(?:KEYMAP|SSH_AUTH_SOCK|GPG_TTY|SESSION_MANAGER|XDG_SESSION_\w+|DBUS_SESSION_BUS_ADDRESS|SSH_ASKPASS\w*|GIT_ASKPASS|SUDO_ASKPASS)$/.test(name);
}

// ---------------------------------------------------------------------------------------------
// Command table

const READ_ONLY = new Set(
  (
    "cat tac less more head tail wc sort uniq cut tr nl od hexdump strings file stat ls exa eza lsd tree du df fd rg grep egrep fgrep zgrep ag ack jq yq gojq diff cmp comm md5sum sha1sum sha256sum sha512sum b2sum cksum realpath readlink dirname basename pwd echo printf true false test which whereis type command-query id whoami groups hostname uname uptime date cal ps pgrep pstree free vmstat iostat mpstat lsof ss netstat ping ping6 dig nslookup host traceroute tracepath mtr whois arp lscpu lsblk blkid lsusb lspci lsmod dmesg sensors nvidia-smi man info tldr column fold fmt paste join sleep wait seq yes expr bc dc locale tput clear stty getent nproc arch lsb_release hostnamectl timedatectl localectl loginctl busctl w who last lastlog users tty ulimit umask history alias hash jobs fc logname printenv-name xdg-mime xdg-user-dir fc-list fc-match glxinfo vulkaninfo inxi fastfetch neofetch btop htop top iotop nethogs iftop bmon watch-noop pactl-list wpctl hyprctl-read gsettings-get defaults-read sw_vers system_profiler diskutil-list ioreg kextstat launchctl-list sysctl-read getconf ldd nm objdump readelf size file strace-noop pv bat batcat glow delta difft tokei cloc scc onefetch zoxide-query exiftool identify ffprobe mediainfo pdfinfo pdftotext-noop jless fx gron xmllint xq htmlq pup miller mlr csvlook csvstat duckdb-noop sqlite3-noop"
  ).split(/\s+/),
);

const DEV_TOOLS = new Set(
  (
    "make cmake ninja meson just task mage rake gradle gradlew mvn ant bazel bazelisk sbt dotnet swift swiftc zig gcc g++ cc c++ clang clang++ rustc javac java kotlinc scalac ghc cabal stack tsc esbuild vite webpack rollup parcel turbo nx lerna pytest py.test unittest tox nox ruff black isort flake8 pylint mypy pyright bandit eslint prettier biome stylelint shellcheck shfmt hadolint actionlint golangci-lint gofmt goimports rustfmt clippy-driver clang-format clang-tidy cppcheck vitest jest mocha ava tap c8 nyc playwright cypress storybook tsx ts-node node deno bun python python3 python2 pypy pypy3 ruby perl php lua luajit Rscript julia elixir mix erl iex go cargo rustup mise asdf nvm fnm volta pyenv rbenv uv uvx poetry pdm hatch pipenv conda mamba micromamba bundle bundler composer pnpm npm yarn npx bunx corepack git-lfs pre-commit husky lint-staged commitlint changeset semantic-release tokei hyperfine entr nodemon concurrently wait-on direnv sqlite3 duckdb psql mysql redis-cli mongosh pg_dump pg_restore alembic prisma drizzle-kit knex sequelize typeorm flyway liquibase protoc buf openapi-generator swagger-codegen graphql-codegen hugo jekyll mkdocs sphinx-build docusaurus astro next nuxt svelte-kit remix expo flutter dart pod xcodebuild xcrun adb emulator fastlane wasm-pack wasm-opt emcc tectonic pdflatex latexmk pandoc typst mdbook ffmpeg magick convert optipng pngquant svgo imagemin sharp code subl nvim vim vi nano emacs micro hx helix kak jupyter ipython marimo streamlit gradio flask uvicorn gunicorn hypercorn django-admin manage.py rails ansible-lint ansible-inventory terraform-docs tflint checkov trivy grype syft semgrep gitleaks trufflehog osv-scanner"
  ).split(/\s+/),
);

const INTERPRETERS = new Set(["node", "deno", "bun", "python", "python3", "python2", "pypy", "pypy3", "ruby", "perl", "php", "lua", "luajit", "Rscript", "julia", "tsx", "ts-node", "osascript", "pwsh", "powershell", "sh", "bash", "zsh", "dash", "ksh", "fish"]);

const SECURITY_SERVICES = /^(?:firewalld|ufw|nftables|iptables|ip6tables|apparmor|auditd|selinux|fail2ban|clamav|crowdsec|osqueryd|falco|wazuh|sshguard|opensnitch)(?:\.service)?$/;
const SESSION_PROCS = /^(?:sshd|systemd|init|Xorg|Xwayland|Hyprland|hyprland|gnome-shell|kwin_wayland|kwin_x11|sway|plasmashell|pipewire|wireplumber|dbus-daemon|dbus-broker|NetworkManager|login|gdm|sddm|lightdm|tmux|zellij|kitty|alacritty|ghostty|foot|wezterm|pi|claude|code)$/;
const UNGUARDED_FLAGS = /^--(?:dangerously[-\w]*|yolo|full-auto|yes-always|no-sandbox|allow-all|trust-all|auto-approve|approval-mode=(?:yolo|never|full-auto))$|^-y$/;

function subcmd(argv: string[], from = 1, optsWithArg: Set<string> = new Set()): { sub: string | undefined; at: number } {
  for (let i = from; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === "--") return { sub: argv[i + 1], at: i + 1 };
    if (a.startsWith("-")) {
      if (optsWithArg.has(a) && !a.includes("=")) i++;
      continue;
    }
    return { sub: a, at: i };
  }
  return { sub: undefined, at: argv.length };
}

function nonFlagArgs(argv: string[], from: number): string[] {
  return argv.slice(from).filter((a) => !a.startsWith("-"));
}

const UNSEEN_TARGET_WRITERS = new Set(["touch", "mkdir", "cp", "mv", "tee", "chmod", "chown", "chgrp", "truncate", "ln", "install"]);

function classifySegment(c: Ctx): void {
  const { seg, exe } = c;
  const argv = seg.argv;
  const lower = exe.toLowerCase();

  if (!argv.length) {
    // Bare redirection (`> file`) or assignment.
    return;
  }
  if (seg.obfuscatedName) add(c, "high", "obfuscated_exec", "obfuscated_name", `command name is obfuscated (${seg.words[0]?.raw ?? exe})`, `obfuscated ${exe}`);
  if (seg.dynamicName) {
    if (seg.decoderInName) add(c, "high", "obfuscated_exec", "decoded_command", "runs a command decoded at runtime", "decoded-exec");
    else add(c, "medium", "opaque", "dynamic_command", `command name is computed at runtime (${seg.words[0]?.raw ?? argv[0]})`, "dynamic-exec");
    return;
  }
  if (seg.evalOf) add(c, "medium", "opaque", "eval_dynamic", "eval of runtime-built text", "eval");
  // xargs/parallel append the paths that arrive on stdin, which cannot be seen: a writer fed that way can
  // reach any path (rm has its own handling of piped-in paths).
  if (seg.unknownArgs && UNSEEN_TARGET_WRITERS.has(exe)) add(c, "medium", "write_outside", "unresolved_write_args", `${exe} writes to paths supplied on stdin (xargs/parallel), which cannot be checked`, `${exe} stdin-paths`);

  // Environment tampering with this kit's safety controls.
  for (const as of seg.assigns) {
    const name = as.split("=")[0] ?? "";
    if (/^PI_KIT_(?:FIREWALL|AUTO_MODE|PROTECTED|WRITE_ALLOWLIST|INTERNAL_CHILD|HUMAN_CONSOLE|CAPTURE|UNATTENDED)/.test(name)) add(c, "high", "security_control", "safety_env_override", `overrides a safety setting via ${name}`, `env ${name}`);
    if (/^(?:LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH)$/.test(name)) add(c, "high", "obfuscated_exec", "library_injection", `injects a shared library via ${name}`, `env ${name}`);
  }

  // Redirections.
  for (const r of seg.redirects) {
    if (/^(?:>|>>|>\||&>|&>>|<>)$/.test(r.op) && r.target && !/^&?\d$|^&-$/.test(r.target)) writePath(c, r.target, r.op.includes(">>") ? "appends to" : "writes");
    else if (r.op === "<" && r.target) readPath(c, r.target);
  }

  // The autonomous-run CLI: whoever runs `start`, `plan --authorise`, `promote` and the like is the person who
  // authorises the run's boundary and spends its budget, so from an agent's shell that is the operator's call.
  const autonomyAt = exe === "pi-autonomy" ? 0 : INTERPRETERS.has(exe) ? argv.findIndex((a, i) => i > 0 && /(?:^|\/)(?:autonomy\/cli\.(?:ts|mjs)|pi-autonomy)$/.test(a)) : -1;
  if (autonomyAt >= 0) { autonomyCli(c, argv.slice(autonomyAt + 1)); return; }

  // Executable given by path: workspace scripts are ordinary development.
  const first = argv[0] ?? "";
  if (first.includes("/") && !/^\/(?:usr\/)?(?:local\/)?s?bin\//.test(first) && !/^\/opt\/|^\/nix\/|^\/home\/[^/]+\/\.local\/share\/mise\//.test(first)) {
    const r = pathOf(c, first);
    c.a.executes.push(r.shown);
    if (r.cls === "temp" || r.cls === "home" || r.cls === "other" || r.cls === "unknown") add(c, "medium", "code_exec", "outside_exec", `runs a program outside the workspace: ${r.shown}`, `exec ${r.key}`);
    else add(c, "low", "code_exec", "workspace_exec", `runs ${r.shown}`);
    if (!READ_ONLY.has(exe) && !DEV_TOOLS.has(exe) && !own(HANDLERS, exe)) return;
  }

  const handler = own(HANDLERS, exe) ?? own(HANDLERS, lower);
  if (handler) { handler(c); return; }
  if (READ_ONLY.has(exe)) { readOnly(c); return; }
  if (DEV_TOOLS.has(exe) || INTERPRETERS.has(exe)) { devTool(c); return; }
  if (seg.remote) add(c, "medium", "remote_exec", "remote_unknown", `runs ${exe} on ${seg.remote}`, exe);
  else add(c, "low", "unknown_exec", "unknown_exec", `runs ${exe}`);
  for (const a of argPaths(argv)) if (looksLikePath(a)) readPath(c, a);
}

// Listing or hashing a secret file does not put its content in front of the model.
const METADATA_ONLY = new Set(["ls", "exa", "eza", "lsd", "tree", "du", "df", "stat", "file", "fd", "realpath", "readlink", "dirname", "basename", "test", "wc", "md5sum", "sha1sum", "sha256sum", "sha512sum", "b2sum", "cksum", "getfacl", "lsattr", "namei", "blkid", "lsblk"]);

function readOnly(c: Ctx): void {
  const { seg, exe } = c;
  // grep -l/-L/-c/-q report names or counts, not content.
  const namesOnly = /^(?:grep|rg|egrep|fgrep|ag|zgrep)$/.test(exe) && seg.argv.some((a) => /^-[A-Za-z]*[lLcq]/.test(a) || /^--(?:files-with(?:out)?-matches|count|quiet)$/.test(a));
  if (!METADATA_ONLY.has(exe) && !namesOnly) for (const a of argPaths(seg.argv)) if (looksLikePath(a) || exe === "cat" || exe === "head" || exe === "tail" || exe === "less") readPath(c, a);
  if (exe === "grep" || exe === "rg" || exe === "egrep" || exe === "ag") {
    if (!namesOnly && seg.argv.some((a) => /PRIVATE KEY|BEGIN OPENSSH|aws_secret|password\s*=|api[_-]?key/i.test(a))) add(c, "medium", "credential_read", "secret_search", "searches for secret material", `${exe} secrets`);
  }
  if (exe === "echo" || exe === "printf") {
    for (const w of seg.words.slice(1)) {
      for (const m of w.raw.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) if (isSecretName(m[1] ?? "")) add(c, "medium", "credential_read", "secret_env_print", `prints $${m[1]}`, `${exe} $${m[1]}`);
    }
  }
  if (exe === "watch-noop") return;
  if (!c.findings.length || c.findings.every((f) => f.tier === "low")) add(c, "low", "read", "read", exe);
}

function devTool(c: Ctx): void {
  const { seg, exe } = c;
  const argv = seg.argv;
  // Inline code (-c / -e / --eval / -p).
  if (INTERPRETERS.has(exe)) {
    const ci = argv.findIndex((a, i) => i > 0 && /^(?:-c|-e|--eval|-p|--print|-E|-r|--command|-x)$/.test(a));
    const code = ci > 0 ? argv[ci + 1] : undefined;
    if (code !== undefined) { inlineCode(c, code); return; }
    if (exe === "python" || exe === "python3") {
      const mi = argv.indexOf("-m");
      if (mi > 0) {
        const mod = argv[mi + 1];
        if (mod === "pip") { packageManager(c, "pip", argv.slice(mi + 2)); return; }
        if (mod === "http.server" || mod === "SimpleHTTPServer") { add(c, "medium", "network_send", "http_server", `serves files over HTTP from ${seg.cwd ?? "?"}`, `${exe} -m http.server`); return; }
        add(c, "low", "code_exec", "module_run", `${exe} -m ${mod}`); return;
      }
    }
    const procSub = seg.words.slice(1).find((w) => w.procSub);
    if (procSub) {
      const body = procSub.subs.join(" ");
      if (/\b(?:curl|wget|nc|ncat|fetch)\b/.test(body)) { add(c, "high", "obfuscated_exec", "remote_script_exec", `${exe} runs downloaded content`, `${exe} <(curl)`); return; }
      if (decoderLike(body)) { add(c, "high", "obfuscated_exec", "decoded_exec", `${exe} runs decoded content`, `${exe} <(decode)`); return; }
      add(c, "medium", "code_exec", "procsub_exec", `${exe} runs generated code`, `${exe} <()`); return;
    }
    const script = argv.slice(1).find((a) => !a.startsWith("-") || a === "-");
    if (!script || script === "-") {
      if (seg.pipeIn) { stdinExec(c); return; }
      if (seg.stdinBody !== undefined) { inlineCode(c, seg.stdinBody); return; }
      add(c, "low", "code_exec", "repl", exe); return;
    }
    const r = pathOf(c, script);
    c.a.executes.push(r.shown);
    // `tests/$t-smoke.mjs`: a relative path with a loop variable still lives under the cwd.
    if (r.cls === "unknown" && !/^[~/$]/.test(script) && c.seg.cwd && !c.seg.remote) { add(c, "low", "code_exec", "script_exec", `${exe} ${script}`); return; }
    if (r.cls === "temp") { add(c, "low", "code_exec", "script_exec", `${exe} ${r.shown}`); return; }
    if (r.cls === "home" || r.cls === "other" || r.cls === "unknown" || r.cls === "system") { add(c, "medium", "code_exec", "outside_script", `${exe} runs a script outside the workspace: ${r.shown}`, `${exe} ${r.key}`); return; }
    add(c, "low", "code_exec", "script_exec", `${exe} ${r.shown}`); return;
  }
  const pm = own(PACKAGE_MANAGERS, exe);
  if (pm) { pm(c); return; }
  add(c, "low", "code_exec", "dev_tool", `${exe}${argv[1] ? ` ${argv[1]}` : ""}`);
  // Writes into the output flags of common formatters/builders are workspace writes; nothing to add.
}

// What a nested classification (inline code that runs a shell command) contacted counts for the outer command too.
function mergeInner(c: Ctx, inner: Assessment): void {
  c.a.hosts.push(...inner.hosts);
  c.a.remotes.push(...inner.remotes);
  c.a.remoteChanges += inner.remoteChanges;
}

function stdinExec(c: Ctx): void {
  const { seg, exe } = c;
  // Walk back through the pipeline for the producer.
  let p = seg.prev;
  let producer = "";
  while (p) {
    const pe = basenameOf(p.argv[0] ?? "");
    if (["curl", "wget", "fetch", "http", "https", "xh", "nc", "ncat", "aria2c"].includes(pe) || (p.remote !== undefined && pe === "cat")) { producer = "network"; break; }
    if (decoderLike(p.argv.join(" "))) { producer = "decoder"; break; }
    if ((pe === "echo" || pe === "printf") && !p.prev) { producer = "literal"; break; }
    p = p.prev;
  }
  if (producer === "network") { add(c, "high", "obfuscated_exec", "remote_script_exec", `pipes downloaded content into ${exe}`, `net|${exe}`); return; }
  if (producer === "decoder") { add(c, "high", "obfuscated_exec", "decoded_exec", `pipes decoded data into ${exe}`, `decode|${exe}`); return; }
  if (producer === "literal" && p && (exe === "sh" || exe === "bash" || exe === "zsh" || exe === "dash")) {
    const script = p.argv.slice(1).filter((a) => !/^-[neE]+$/.test(a)).join(" ");
    const inner = classifyShellText(script, c.env, seg.cwd, seg.remote);
    for (const f of inner.findings) c.findings.push(f);
    mergeInner(c, inner.a);
    add(c, "low", "code_exec", "stdin_exec", `${exe} runs echoed commands`); return;
  }
  add(c, "medium", "code_exec", "stdin_exec", `${exe} executes its piped input`, `pipe|${exe}`);
}

const AUTONOMY_CONTROL = new Set(["start", "supervise", "resume", "steer", "cancel", "pause", "promote", "reconfigure"]);

// `pi-autonomy <command>`: commands that authorise, start, steer or promote a run are high and never learned
// (each one asks the operator); an unattended worker may not run them at all. Reading or preparing is routine.
function autonomyCli(c: Ctx, args: string[]): void {
  const sub = args.find((a) => !a.startsWith("-"));
  const authorising = args.some((a) => a === "--authorise" || a === "--authorize");
  if (sub && (AUTONOMY_CONTROL.has(sub) || (sub === "plan" && authorising))) {
    add(c, "high", "security_control", "autonomy_control", `pi-autonomy ${sub}${authorising ? " --authorise" : ""} authorises, starts, steers or promotes an autonomous run: only the operator does that`, `autonomy ${sub}${authorising ? " authorise" : ""}`); return;
  }
  add(c, sub === "boundary" && args.includes("--probe") ? "medium" : "low", "code_exec", "autonomy_cli", `pi-autonomy ${sub ?? ""}`.trim());
}

function inlineCode(c: Ctx, code: string): void {
  const { exe } = c;
  // Inline code that names one of this kit's safety settings is how a launch is forged from an interpreter
  // (`python -c "os.environ['PI_KIT_UNATTENDED']=..."`): the same override as an env prefix or `export`.
  const safetyName = /PI_KIT_(?:FIREWALL|AUTO_MODE|PROTECTED|WRITE_ALLOWLIST|INTERNAL_CHILD|HUMAN_CONSOLE|CAPTURE|UNATTENDED)\w*/.exec(code);
  if (safetyName) add(c, "high", "security_control", "safety_env_override", `${exe} inline code names a safety setting (${safetyName[0]})`, `inline ${safetyName[0]}`);
  const decode = /b64decode|base64|fromCharCode|atob\(|Buffer\.from\([^)]*['"](?:base64|hex)['"]|codecs\.decode|zlib\.decompress|marshal\.loads|pickle\.loads|bytes\.fromhex|unhexlify|\\x[0-9a-f]{2}.*\\x[0-9a-f]{2}.*\\x[0-9a-f]{2}/i.test(code);
  const execy = /\bexec\s*\(|\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(|\bcompile\s*\(|__import__\s*\(|child_process|subprocess|os\.system|os\.popen|os\.exec|spawnSync|execSync|execFileSync|\bspawn\s*\(|`[^`]+`|\bsystem\s*\(|Kernel\.exec|IO\.popen|proc_open|shell_exec|passthru/.test(code);
  if (decode && execy) { add(c, "high", "obfuscated_exec", "decoded_exec", `${exe} decodes data and executes it`, `${exe} decode+exec`); return; }
  let flagged = false;
  // Recursive deletes with a literal path are scoped like rm -r.
  for (const m of code.matchAll(/(?:rmSync|rmdirSync|\brm|rmdir|rmtree|remove_dir_all|rm_rf|rm_r|rimraf(?:\.sync)?|removeSync|emptyDirSync)\s*\(\s*(?:[\w.]+\s*\(\s*)?(['"`])([^'"`]+)\1([^)]*)\)?/g)) {
    const recursive = /rmtree|remove_dir_all|rm_rf|rm_r|rimraf|removeSync|emptyDirSync/.test(m[0]) || /recursive\s*:\s*true|recursive=True/.test((m[3] ?? "") + code);
    deletePath(c, m[2] ?? "", recursive);
    flagged = true;
  }
  if (!flagged && /rmtree|rmSync|rmdirSync|remove_dir_all|rm_rf|FileUtils\.rm_r|rimraf|\.rm\s*\([^)]*recursive/.test(code)) {
    add(c, "high", "delete", "inline_recursive_delete", `${exe} recursively deletes a path computed at runtime`, `${exe} rmtree ?`);
    c.a.deletes++;
    flagged = true;
  }
  if (!flagged && /os\.remove|os\.unlink|unlinkSync|fs\.unlink|\.unlink\(|File\.delete|FileUtils\.rm\b/.test(code)) {
    add(c, "medium", "delete", "inline_delete", `${exe} deletes files`, `${exe} unlink`);
    c.a.deletes++;
  }
  // Subprocesses: look inside a literal command string when there is one.
  for (const m of code.matchAll(/(?:os\.system|os\.popen|execSync|exec|spawnSync|shell_exec|system|subprocess\.(?:run|call|check_call|check_output|Popen))\s*\(\s*(['"`])([^'"`]+)\1/g)) {
    const inner = classifyShellText(m[2] ?? "", c.env, c.seg.cwd, c.seg.remote);
    for (const f of inner.findings) c.findings.push(f);
    mergeInner(c, inner.a);
    flagged = true;
  }
  for (const m of code.matchAll(/subprocess\.(?:run|call|check_call|check_output|Popen)\s*\(\s*\[([^\]]+)\]/g)) {
    const parts = [...(m[1] ?? "").matchAll(/(['"])([^'"]*)\1/g)].map((x) => x[2] ?? "");
    if (parts.length) {
      const inner = classifyShellText(parts.map((p) => (/[\s'"]/.test(p) ? `'${p.replace(/'/g, "")}'` : p)).join(" "), c.env, c.seg.cwd, c.seg.remote);
      for (const f of inner.findings) c.findings.push(f);
      mergeInner(c, inner.a);
      flagged = true;
    }
  }
  if (!flagged && execy) add(c, "medium", "code_exec", "inline_subprocess", `${exe} inline code runs a subprocess or eval`, `${exe} inline-exec`);
  // Network.
  const urls = [...code.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
  const local = urls.length > 0 && urls.every((u) => LOCALHOST_RE.test(urlHost(u) ?? ""));
  if (/requests\.(?:post|put|patch|delete)|urlopen\([^)]*data=|http\.client|method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)|axios\.(?:post|put|patch|delete)|\.(?:post|put)\s*\(\s*['"`]https?:|socket\.connect|net\.connect|net\.createConnection|dgram|smtplib|ftplib|paramiko|XMLHttpRequest/.test(code)) {
    const dest = urls[0] ? urlHost(urls[0]) ?? "?" : "?";
    c.a.sends.push({ dest, local });
    for (const u of urls.length ? urls : ["?"]) noteHost(c, urls.length ? urlHost(u) : "?", "send");
    add(c, local ? "low" : "medium", "network_send", "inline_network_send", `${exe} sends data over the network${dest !== "?" ? ` to ${dest}` : ""}`, `${exe} send ${dest}`);
  } else if (/requests\.get|urlopen|fetch\s*\(|axios\.get|https?\.get|urllib/.test(code)) {
    c.a.untrusted = true;
    for (const u of urls.length ? urls : ["?"]) noteHost(c, urls.length ? urlHost(u) : "?", "read");
    add(c, "low", "network_read", "inline_network_read", `${exe} fetches from the network`);
  }
  // Writes and secret files named in the code.
  for (const m of code.matchAll(/(?:open\s*\(\s*|writeFileSync\s*\(\s*|appendFileSync\s*\(\s*|write_text\s*\(|Path\s*\(\s*)(['"`])([^'"`]+)\1(\s*,\s*['"`][wa])?/g)) {
    if (m[3] || /writeFileSync|appendFileSync/.test(m[0])) writePath(c, m[2] ?? "", "writes");
    else readPath(c, m[2] ?? "");
  }
  for (const m of code.matchAll(/(['"`])((?:~|\/)[^'"`\s]*(?:id_(?:rsa|ed25519|ecdsa)|\.aws\/credentials|\.ssh\/|auth\.json|\.env|shadow)[^'"`\s]*)\1/g)) readPath(c, m[2] ?? "");
  if (!c.findings.length) add(c, "low", "code_exec", "inline_code", `${exe} inline script`);
}

// ---------------------------------------------------------------------------------------------
// Handlers

type Handler = (c: Ctx) => void;

function rm(c: Ctx): void {
  const argv = c.seg.argv;
  const flags = argv.slice(1).filter((a) => /^-[A-Za-z]+$/.test(a) || a.startsWith("--"));
  const recursive = flags.some((f) => /^-[A-Za-z]*[rR]/.test(f) || f === "--recursive" || /^-recurse$/i.test(f));
  const targets = argPaths(argv).filter((a) => !/^-recurse$|^-force$/i.test(a));
  if (c.seg.unknownArgs && !targets.length) {
    c.a.deletes++;
    add(c, recursive ? "high" : "medium", "delete", "unresolved_delete", `${c.exe}${recursive ? " -r" : ""} on piped-in paths`, `${c.exe}${recursive ? " -r" : ""} ?`); return;
  }
  const recursiveEff = recursive && !(c.seg.filtered && !recursive);
  for (const t of targets) deletePath(c, t, recursiveEff);
  if (c.seg.unknownArgs) {
    c.a.deletes++;
    add(c, recursive ? "high" : "medium", "delete", "unresolved_delete", `${c.exe} also deletes piped-in paths`, `${c.exe} ?`);
  }
}

function psRemove(c: Ctx): void {
  const argv = c.seg.argv;
  const recursive = argv.some((a) => /^-r(?:ecurse)?$/i.test(a) || /^\/s$/i.test(a));
  const targets: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (/^-(?:path|literalpath)$/i.test(a)) { targets.push(argv[++i] ?? ""); continue; }
    if (a.startsWith("-") || /^\/[sq]$/i.test(a)) continue;
    targets.push(a);
  }
  for (const t of targets) deletePath(c, t, recursive);
}

function mvCp(move: boolean): Handler {
  return (c) => {
    const argv = c.seg.argv;
    const ti = argv.findIndex((a) => a === "-t" || a.startsWith("--target-directory"));
    let dest: string | undefined;
    let sources: string[];
    const paths = expandOperands(argPaths(argv));
    if (ti > 0) {
      const opt = argv[ti] ?? "";
      dest = opt.includes("=") ? opt.split("=")[1] : argv[ti + 1];
      sources = paths.filter((p) => p !== dest);
    } else {
      dest = paths[paths.length - 1];
      sources = paths.slice(0, -1);
    }
    for (const s of sources) {
      readPath(c, s);
      if (move) {
        const r = pathOf(c, s);
        if (["root_critical", "system", "security_control", "persistence", "git_internal", "git_hooks", "device"].includes(r.cls)) deletePath(c, s, true);
        else if (!c.seg.remote && r.abs !== null && holdsProjectControl(r.abs, c.env)) add(c, "high", "security_control", "security_control_move", `moves a directory that holds the project's .pi control directory: ${r.shown}`, `${c.exe} move ${r.key}`);
      }
    }
    if (dest) writePath(c, dest, move ? "moves files into" : "copies into");
    if (!c.findings.length) add(c, "low", "workspace_write", move ? "move" : "copy", `${c.exe} ${paths.join(" ")}`);
  };
}

function chmod(c: Ctx): void {
  const argv = c.seg.argv;
  const args = argPaths(argv);
  const mode = args[0] ?? "";
  const targets = args.slice(1);
  const recursive = argv.some((a) => /^-[A-Za-z]*R/.test(a) || a === "--recursive");
  const worldWritable = /^[0-7]?[0-7][0-7][2367]$/.test(mode) || /(?:^|,)(?:a|o|)\+[rwxXst]*w/.test(mode);
  const setuid = /^[4-7][0-7]{3}$/.test(mode) || /\+[rwx]*s/.test(mode);
  const exec = /\+[rwX]*x|^[0-7]?[0-7]*[1357][0-7]*$/.test(mode);
  for (const t of targets) {
    const r = pathOf(c, t);
    if (exec) c.a.chmodExec.push(r.shown);
    if (r.cls === "root_critical" || r.cls === "device") { add(c, "critical", "destructive_system", "critical_chmod", `changes permissions on ${r.shown}${recursive ? " recursively" : ""}`, `chmod ${r.key}`); continue; }
    if (setuid) { add(c, "high", "privilege", "setuid", `sets setuid/setgid on ${r.shown}`, `chmod +s ${r.key}`); continue; }
    if (r.cls === "security_control") { add(c, "high", "security_control", "security_control_chmod", `changes permissions on a safety-control file: ${r.shown}`, `chmod ${r.key}`); continue; }
    if (["system", "credential", "persistence"].includes(r.cls)) { add(c, "high", "write_outside", "sensitive_chmod", `changes permissions on ${r.shown}`, `chmod ${r.key}`); continue; }
    if (worldWritable) { add(c, r.cls.startsWith("workspace") || r.cls === "temp" ? "medium" : "high", "write_outside", "world_writable", `makes ${r.shown} world-writable`, `chmod o+w ${r.key}`); continue; }
    if (r.cls === "home" || r.cls === "other" || r.cls === "unknown") { add(c, "medium", "write_outside", "outside_chmod", `changes permissions outside the workspace: ${r.shown}`, `chmod ${r.key}`); continue; }
    add(c, "low", "workspace_write", "chmod", `chmod ${mode} ${r.shown}`);
  }
  if (!c.findings.length) add(c, "low", "workspace_write", "chmod", "chmod");
}

function chown(c: Ctx): void {
  const args = argPaths(c.seg.argv);
  for (const t of args.slice(1)) {
    const r = pathOf(c, t);
    if (r.cls === "root_critical" || r.cls === "device") add(c, "critical", "destructive_system", "critical_chown", `changes ownership of ${r.shown}`, `chown ${r.key}`);
    else if (r.cls === "security_control") add(c, "high", "security_control", "security_control_chown", `changes ownership of a safety-control file: ${r.shown}`, `chown ${r.key}`);
    else if (r.cls.startsWith("workspace") || r.cls === "temp" || r.cls === "home") add(c, "medium", "workspace_write", "chown", `changes ownership of ${r.shown}`, `chown ${r.key}`);
    else add(c, "high", "privilege", "outside_chown", `changes ownership of ${r.shown}`, `chown ${r.key}`);
  }
  if (!c.findings.length) add(c, "medium", "privilege", "chown", "chown", "chown");
}

function dd(c: Ctx): void {
  for (const a of c.seg.argv.slice(1)) {
    if (a.startsWith("if=")) readPath(c, a.slice(3));
    if (a.startsWith("of=")) writePath(c, a.slice(3), "dd writes");
  }
  if (!c.findings.length) add(c, "low", "read", "dd", "dd");
}

function truncate(c: Ctx): void {
  const argv = c.seg.argv;
  const targets: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === "-s" || a === "-r" || a === "--size" || a === "--reference") { i++; continue; }
    if (a.startsWith("-")) continue;
    targets.push(a);
  }
  for (const t of targets) {
    const r = pathOf(c, t);
    if (r.cls === "workspace" || r.cls === "workspace_derived" || r.cls === "temp") add(c, "low", "workspace_write", "truncate", `truncates ${r.shown}`);
    else writePath(c, t, "truncates");
  }
}

function sed(c: Ctx): void {
  const argv = c.seg.argv;
  const inPlace = argv.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"));
  const script = argv.find((a, i) => i > 0 && !a.startsWith("-") && !(argv[i - 1] === "-e" || argv[i - 1] === "-f"));
  const files = argPaths(argv).filter((a) => a !== script);
  const scripts = argv.filter((a, i) => i > 0 && (argv[i - 1] === "-e" || argv[i - 1] === "--expression" || a === script)).join("\n").split(/[;\n]/);
  // GNU sed's `e` command, or the `e` flag on s///.
  if (scripts.some((l) => /^\s*(?:\d+|\$)?(?:,\s*(?:\d+|\$))?\s*e(?:\s|$)/.test(l) || /^\s*s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gipmMI0-9]*e[gipmMIw0-9]*\s*$/.test(l))) add(c, "medium", "code_exec", "sed_exec", "sed script executes commands", "sed e");
  if (inPlace) for (const f of files) writePath(c, f, "edits");
  else for (const f of files) readPath(c, f);
  if (!c.findings.length) add(c, "low", inPlace ? "workspace_write" : "read", "sed", "sed");
}

function awk(c: Ctx): void {
  const prog = c.seg.argv.find((a, i) => i > 0 && !a.startsWith("-")) ?? "";
  if (/\bsystem\s*\(|\|\s*"(?:sh|bash)"|"\s*\|\s*getline|\|&/.test(prog)) add(c, "medium", "code_exec", "awk_exec", "awk program runs commands", "awk system");
  for (const m of prog.matchAll(/>{1,2}\s*"([^"]+)"/g)) writePath(c, m[1] ?? "", "awk writes");
  for (const a of argPaths(c.seg.argv).slice(1)) readPath(c, a);
  if (!c.findings.length) add(c, "low", "read", "awk", "awk");
}

function tee(c: Ctx): void {
  for (const t of argPaths(c.seg.argv)) writePath(c, t, "tee writes");
  if (!c.findings.length) add(c, "low", "read", "tee", "tee");
}

function find(c: Ctx): void {
  const argv = c.seg.argv;
  const roots: string[] = [];
  let k = 1;
  for (let a = argv[k]; a !== undefined && !/^[-(!]/.test(a); a = argv[++k]) roots.push(a);
  if (!roots.length) roots.push(".");
  const filtered = argv.some((a) => /^-(?:i?name|i?path|i?regex|type|newer|mtime|mmin|size|empty)$/.test(a));
  // With a name/type filter only matching entries go, never the root itself.
  if (argv.includes("-delete")) for (const r of roots) deletePath(c, filtered ? `${r.replace(/\/+$/, "")}/<matches>` : r, !filtered);
  for (let i = k; i < argv.length; i++) { const out = argv[i + 1]; if (/^-f(?:print0?|printf|ls)$/.test(argv[i] ?? "") && out) writePath(c, out, "find writes"); }
  if (!c.findings.length) add(c, "low", "read", "find", "find");
}

function git(c: Ctx): void {
  const argv = c.seg.argv;
  // Global options.
  let i = 1;
  const risky: string[] = [];
  while (argv[i]?.startsWith("-")) {
    if (argv[i] === "-c" || argv[i] === "--config-env") {
      const kv = argv[i + 1] ?? "";
      if (/^(?:remote\.|url\.)/i.test(kv)) c.a.remoteChanges++;
      if (/^(?:core\.(?:sshCommand|pager|editor|hooksPath|fsmonitor|askPass)|alias\.|credential\.helper|protocol\..*\.allow|uploadpack\.|diff\..*\.textconv|filter\.|gpg\.program)/i.test(kv)) risky.push(kv);
      i += 2;
      continue;
    }
    if (["-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(argv[i] ?? "")) { i += 2; continue; }
    i++;
  }
  if (risky.length) add(c, "high", "code_exec", "git_config_exec", `git -c ${risky[0]} can run arbitrary commands`, "git -c exec");
  const sub = argv[i];
  const rest = argv.slice(i + 1);
  const has = (re: RegExp) => rest.some((a) => re.test(a));
  const k = (s: string) => `git ${s}`;
  switch (sub) {
    case undefined:
    case "status": case "log": case "diff": case "show": case "blame": case "annotate": case "ls-files": case "ls-tree": case "ls-remote": case "rev-parse": case "rev-list": case "describe": case "shortlog": case "reflog": case "grep": case "cat-file": case "merge-base": case "for-each-ref": case "symbolic-ref": case "name-rev": case "whatchanged": case "count-objects": case "fsck": case "check-ignore": case "check-attr": case "var": case "help": case "version": case "--version": case "range-diff": case "show-ref": case "show-branch": case "cherry": case "difftool": case "verify-commit": case "verify-tag": case "bugreport": case "diff-tree": case "diff-files": case "diff-index": case "archive":
      if (sub === "reflog" && (rest[0] === "expire" || rest[0] === "delete")) { add(c, "high", "history_rewrite", "git_reflog_expire", "expires the reflog (drops recovery points)", k("reflog expire")); return; }
      if (sub === "archive" && has(/^(?:-o|--output)/)) { add(c, "low", "workspace_write", "git_archive", "git archive"); return; }
      if (sub === "ls-remote") c.a.remotes.push({ name: rest.filter((a) => !a.startsWith("-"))[0] ?? "origin", op: "fetch" });
      add(c, "low", "read", "git_read", k(sub ?? "")); return;
    case "fetch": case "lfs":
      if (sub === "fetch") for (const r of has(/^--all$/) ? ["--all"] : [rest.filter((a) => !a.startsWith("-"))[0] ?? "origin"]) c.a.remotes.push({ name: r, op: "fetch" });
      add(c, "low", "network_read", "git_fetch", k(sub)); return;
    case "clone": case "pull": case "submodule":
      c.a.untrusted = c.a.untrusted || sub === "clone";
      if (sub === "clone" || sub === "pull") c.a.remotes.push({ name: has(/^--all$/) ? "--all" : rest.filter((a) => !a.startsWith("-"))[0] ?? "origin", op: "fetch" });
      add(c, "low", "workspace_write", "git_pull", k(sub)); return;
    case "add": case "commit": case "mv": case "init": case "apply": case "am": case "cherry-pick": case "revert": case "merge": case "switch": case "notes": case "bisect": case "format-patch": case "mergetool": case "sparse-checkout": case "maintenance": case "rerere": case "citool": case "gui": case "tag":
      if (sub === "tag" && has(/^-d$|^--delete$/)) { add(c, "medium", "history_rewrite", "git_tag_delete", "deletes a tag", k("tag -d")); return; }
      if (sub === "commit" && has(/^--amend$/)) { add(c, "low", "history_rewrite", "git_amend", "amends the last commit"); return; }
      add(c, "low", "workspace_write", "git_write", k(sub)); return;
    case "rm":
      add(c, "low", "workspace_write", "git_rm", "git rm (tracked files stay recoverable)"); return;
    case "branch":
      if (has(/^-D$|^--delete$|^-d$/) && has(/^-D$|--force|^-f$/)) { add(c, "medium", "history_rewrite", "git_branch_force_delete", "force-deletes a branch (unmerged commits can be lost)", k("branch -D")); return; }
      if (has(/^-[dmMcC]$|^--(?:delete|move|copy)$/)) { add(c, "low", "workspace_write", "git_branch", k("branch")); return; }
      add(c, "low", "read", "git_read", k("branch")); return;
    case "stash":
      if (rest[0] === "clear" || rest[0] === "drop") { add(c, "medium", "history_rewrite", "git_stash_drop", `drops stashed work (git stash ${rest[0]})`, k(`stash ${rest[0]}`)); return; }
      if (rest[0] === "list" || rest[0] === "show") { add(c, "low", "read", "git_read", k("stash list")); return; }
      add(c, "low", "workspace_write", "git_stash", k("stash")); return;
    case "checkout": case "restore": {
      const dashdash = rest.indexOf("--");
      const paths = dashdash >= 0 ? rest.slice(dashdash + 1) : sub === "restore" ? rest.filter((a) => !a.startsWith("-")) : [];
      if (paths.some((p) => p === "." || p === ":/" || p === "*")) { add(c, "high", "history_rewrite", "git_discard_all", `discards all uncommitted changes (git ${sub} ${paths.join(" ")})`, k(`${sub} .`)); return; }
      if (paths.length || has(/^-f$|^--force$/)) { add(c, "medium", "history_rewrite", "git_discard", `discards uncommitted changes to ${paths.join(" ") || "files"}`, k(`${sub} -- file`)); return; }
      add(c, "low", "workspace_write", "git_checkout", k(sub)); return;
    }
    case "reset":
      if (has(/^--hard$|^--merge$|^--keep$/)) { add(c, "high", "history_rewrite", "git_reset_hard", "hard reset discards uncommitted work", k("reset --hard")); return; }
      add(c, "low", "workspace_write", "git_reset", k("reset")); return;
    case "clean":
      if (has(/^-[A-Za-z]*n|^--dry-run$/)) { add(c, "low", "read", "git_read", k("clean -n")); return; }
      if (has(/^-[A-Za-z]*f|^--force$/)) { add(c, "high", "delete", "git_clean", "force-removes untracked files (unrecoverable)", k("clean -f")); return; }
      add(c, "low", "read", "git_read", k("clean")); return;
    case "rebase":
      if (has(/^-i$|^--interactive$/)) { add(c, "medium", "history_rewrite", "git_rebase_interactive", "interactive rebase (needs an editor)", k("rebase -i")); return; }
      add(c, "low", "history_rewrite", "git_rebase", k("rebase")); return;
    case "push": {
      c.a.remotes.push({ name: rest.filter((a) => !a.startsWith("-"))[0] ?? "origin", op: "push" });
      const force = has(/^-[A-Za-z]*f$|^--force(?:-with-lease|-if-includes)?(?:=.*)?$|^--mirror$/) || rest.some((a) => /^\+/.test(a));
      const del = has(/^-d$|^--delete$|^--prune$/) || rest.some((a) => /^:[^/]/.test(a));
      if (force) { add(c, "high", "history_rewrite", "git_force_push", "force-push rewrites remote history", k("push --force")); return; }
      if (del) { add(c, "high", "history_rewrite", "git_push_delete", "deletes a remote ref", k("push --delete")); return; }
      const remote = rest.filter((a) => !a.startsWith("-"))[0] ?? "origin";
      c.a.sends.push({ dest: remote, local: false });
      add(c, "medium", "publish", "git_push", `pushes to ${remote}`, k(`push ${remote}`)); return;
    }
    case "remote":
      if (!rest.length || rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url") { add(c, "low", "read", "git_read", k("remote")); return; }
      c.a.remoteChanges++;
      add(c, "medium", "workspace_write", "git_remote_change", `changes git remotes (git remote ${rest[0]})`, k(`remote ${rest[0]}`)); return;
    case "config": {
      const setting = rest.find((a) => !a.startsWith("-"));
      if (setting && /^(?:remote\.|url\.)/i.test(setting) && !has(/^--(?:get|get-all|get-regexp|list)$|^-l$/)) c.a.remoteChanges++;
      if (has(/^--(?:get|get-all|get-regexp|list|show-origin)$|^-l$/) || rest.filter((a) => !a.startsWith("-")).length <= 1) { add(c, "low", "read", "git_read", k("config --get")); return; }
      if (setting && /^(?:core\.(?:sshCommand|pager|editor|hooksPath|fsmonitor|askPass)|alias\.|credential\.helper|filter\.|diff\..*\.textconv|gpg\.program|url\..*\.insteadOf)/i.test(setting)) { add(c, "high", "persistence", "git_config_exec", `sets ${setting} (runs commands later)`, k(`config ${setting}`)); return; }
      if (has(/^--global$|^--system$/)) { add(c, "medium", "write_outside", "git_config_global", `changes global git config (${setting})`, k("config --global")); return; }
      add(c, "low", "workspace_write", "git_config", k("config")); return;
    }
    case "worktree":
      if (rest[0] === "remove" || rest[0] === "prune") { add(c, rest.some((a) => a === "-f" || a === "--force") ? "medium" : "low", "delete", "git_worktree_remove", `git worktree ${rest[0]}`, k(`worktree ${rest[0]}`)); return; }
      add(c, "low", "workspace_write", "git_worktree", k("worktree")); return;
    case "filter-branch": case "filter-repo": case "replace": case "update-ref": case "gc": case "prune": case "repack":
      if ((sub === "gc" && !has(/--prune=now|--aggressive/)) || sub === "repack") { add(c, "low", "workspace_write", "git_gc", k(sub)); return; }
      add(c, "high", "history_rewrite", "git_history_rewrite", `git ${sub} rewrites or drops history`, k(sub)); return;
    case "send-email": case "request-pull": case "daemon": case "http-backend": case "instaweb":
      add(c, "medium", "network_send", "git_send", k(sub), k(sub)); return;
    case "credential": case "credential-store": case "credential-cache":
      add(c, "high", "credential_read", "git_credential", "reads stored git credentials", k("credential")); return;
    default:
      add(c, "low", "workspace_write", "git_other", k(sub)); return;
  }
}

function curlLike(c: Ctx): void {
  const argv = c.seg.argv;
  const exe = c.exe;
  let method = "";
  const data: string[] = [];
  const outputs: string[] = [];
  const urls: string[] = [];
  let remoteName = false;
  let config = false;
  const isWget = exe === "wget" || exe === "wget2" || exe === "aria2c";
  const isHttpie = exe === "http" || exe === "https" || exe === "xh" || exe === "xhs";
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    const val = () => (a.includes("=") && a.startsWith("--") ? a.slice(a.indexOf("=") + 1) : argv[++i] ?? "");
    if (isHttpie) {
      if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(a)) { method = a; continue; }
      if (a === "-o" || a === "--output") { outputs.push(val()); continue; }
      if (a === "-d" || a === "--download") { remoteName = true; continue; }
      if (a.startsWith("-")) continue;
      if (!urls.length) { urls.push(a); continue; }
      if (/^[^=:@]+(?::=|=|@|:=@)/.test(a) && !/^[^=:]+:[^=]/.test(a)) data.push(a.includes("@") ? a.slice(a.indexOf("@")) : a);
      continue;
    }
    if (isWget) {
      if (a === "-O" || a === "--output-document") { outputs.push(val()); continue; }
      if (/^-[A-Za-z]*O$/.test(a) || a.startsWith("--output-document=")) { outputs.push(a.includes("=") ? a.split("=")[1] ?? "" : argv[++i] ?? ""); continue; }
      if (/^-[A-Za-z]*O-?$/.test(a) || /^-qO-$/.test(a)) { outputs.push("-"); continue; }
      if (a.startsWith("--post-data") || a.startsWith("--body-data")) { data.push(val()); method ||= "POST"; continue; }
      if (a.startsWith("--post-file") || a.startsWith("--body-file")) { data.push(`@${val()}`); method ||= "POST"; continue; }
      if (a.startsWith("--method")) { method = val().toUpperCase(); continue; }
      if (a === "-P" || a === "--directory-prefix") { outputs.push(`${val()}/`); continue; }
      if (a === "-i" || a === "--input-file") { i++; continue; }
      if (a.startsWith("-")) continue;
      urls.push(a);
      continue;
    }
    // curl
    if (a === "-X" || a === "--request") { method = val().toUpperCase(); continue; }
    if (/^-X[A-Z]+$/.test(a)) { method = a.slice(2); continue; }
    if (/^(?:-d|--data|--data-raw|--data-binary|--data-ascii|--data-urlencode|--json|-F|--form|--form-string)$/.test(a) || /^--(?:data|data-raw|data-binary|data-urlencode|json|form)=/.test(a)) { data.push(val()); continue; }
    if (a === "-T" || a === "--upload-file") { data.push(`@${val()}`); continue; }
    if (a === "-o" || a === "--output") { outputs.push(val()); continue; }
    if (/^-[A-Za-z]*o$/.test(a) && !a.startsWith("--")) { outputs.push(argv[++i] ?? ""); continue; }
    if (/^-[A-Za-z]*O$/.test(a) || a === "--remote-name" || a === "--remote-name-all" || /^-[A-Za-z]*J/.test(a)) { remoteName = true; continue; }
    if (a === "--output-dir") { outputs.push(`${val()}/`); continue; }
    if (a === "-K" || a === "--config") { config = true; i++; continue; }
    if (a === "--url") { urls.push(val()); continue; }
    if (/^(?:-H|--header|-u|--user|-A|--user-agent|-e|--referer|-b|--cookie|-c|--cookie-jar|-m|--max-time|--connect-timeout|-w|--write-out|-x|--proxy|--retry|--resolve|--cacert|--cert|--key|-E|-r|--range|--limit-rate|-z|--time-cond|--interface|--dns-servers|--local-port|-y|-Y|--speed-time|--speed-limit|--max-filesize|--max-redirs|--retry-delay|--retry-max-time|--unix-socket|--abstract-unix-socket|-Q|--quote|--create-dirs-noop|--noproxy|--proto|--proto-redir|--ciphers|--tls-max|--variable|--expand-url)$/.test(a)) {
      const v = val();
      if ((a === "-c" || a === "--cookie-jar") && v) writePath(c, v, "curl writes cookies to");
      if ((a === "--cert" || a === "--key" || a === "-E") && v) readPath(c, v.split(":")[0] ?? "");
      continue;
    }
    if (a.startsWith("-")) continue;
    urls.push(a);
  }
  const hosts = urls.map((u) => urlHost(u) ?? "?");
  const dest = hosts[0] ?? "?";
  for (const h of hosts) noteHost(c, h, data.length > 0 || /^(?:POST|PUT|PATCH|DELETE)$/.test(method) ? "send" : "read");
  const local = hosts.length > 0 && hosts.every((h) => LOCALHOST_RE.test(h));
  const send = data.length > 0 || /^(?:POST|PUT|PATCH|DELETE)$/.test(method);
  if (config) add(c, "medium", "network_send", "curl_config", `${exe} reads options from a config file`, `${exe} -K`);
  for (const d of data) {
    const m = /^@(.+)$/.exec(d.trim()) ?? /=@(.+)$/.exec(d.trim()) ?? /^[^=]+@([~/.$][^;]*)$/.exec(d.trim());
    if (m && m[1] !== "-") {
      const r = pathOf(c, m[1] ?? "");
      if (READ_CRED_TIER(r.cls)) {
        add(c, "critical", "network_send", "secret_upload", `uploads secret material (${r.shown}) to ${dest}`, `${exe} upload-secret ${dest}`);
        c.a.credentialReads.push(r.shown);
      }
    }
    for (const mm of d.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) if (isSecretName(mm[1] ?? "") && !local) add(c, "medium", "network_send", "secret_env_send", `sends $${mm[1]} to ${dest}`, `${exe} send $${mm[1]} ${dest}`);
  }
  if (send) {
    c.a.sends.push({ dest, local });
    if (c.seg.pipeIn && data.some((d) => d === "@-" || d === "-")) {
      // Piped body: taint from the producer is handled in the trajectory by the command as a whole.
      const last = c.a.sends[c.a.sends.length - 1];
      if (last) last.dest = dest;
    }
    add(c, local ? "low" : "medium", "network_send", local ? "local_send" : "network_send", `${method || "POST"} to ${dest}`, `${exe} ${method || "POST"} ${dest}`);
  } else {
    c.a.untrusted = true;
    add(c, "low", "network_read", "network_read", `fetches ${dest}`);
  }
  const outs = [...outputs];
  if (remoteName || (isWget && !outputs.length)) {
    const name = ((urls[0] ?? "").split(/[?#]/)[0] ?? "").split("/").pop() || "index.html";
    outs.push(name);
  }
  for (const o of outs) {
    if (o === "-" || o === "/dev/null" || o === "") continue;
    const target = o.endsWith("/") ? `${o}${((urls[0] ?? "").split(/[?#]/)[0] ?? "").split("/").pop() || "download"}` : o;
    const r = pathOf(c, target);
    c.a.downloads.push(r.shown);
    writePath(c, target, "downloads into");
  }
}

function netcat(c: Ctx): void {
  const argv = c.seg.argv;
  const joined = argv.join(" ");
  if (/\s-[A-Za-z]*[ec]\s|--exec|--sh-exec|--lua-exec/.test(` ${joined} `) || (c.exe === "socat" && /\b(?:EXEC|SYSTEM):/i.test(joined))) { add(c, "critical", "remote_exec", "shell_over_network", `${c.exe} wires a shell to a network socket`, `${c.exe} -e`); return; }
  if (argv.some((a) => /^-[A-Za-z]*z/.test(a))) { add(c, "low", "network_read", "port_probe", `${c.exe} port probe`); return; }
  const listen = argv.some((a) => /^-[A-Za-z]*l/.test(a)) || /LISTEN/i.test(joined);
  const dest = argv.slice(1).find((a) => !a.startsWith("-") && !/^\d+$/.test(a)) ?? "?";
  const local = LOCALHOST_RE.test(dest);
  c.a.sends.push({ dest, local });
  if (!listen) noteHost(c, dest, "connect");
  add(c, local && !listen ? "low" : "medium", "network_send", listen ? "listener" : "raw_socket", listen ? `${c.exe} opens a listening socket` : `${c.exe} connects to ${dest}`, `${c.exe} ${listen ? "listen" : dest}`);
}

function scpRsync(c: Ctx): void {
  const argv = c.seg.argv;
  const withArg = c.exe === "scp" ? new Set(["-P", "-i", "-F", "-o", "-c", "-l", "-S", "-J", "-D", "-X"]) : new Set(["-e", "--rsh", "--exclude", "--include", "--filter", "-f", "--files-from", "--exclude-from", "--include-from", "--rsync-path", "-T", "--temp-dir", "--log-file", "--partial-dir", "--backup-dir", "--suffix", "--chmod", "--chown", "--port", "--password-file", "-B", "--block-size", "--timeout", "--contimeout", "-M", "--remote-option", "--info", "--debug", "--compare-dest", "--copy-dest", "--link-dest", "--max-size", "--min-size", "--bwlimit"]);
  const paths: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (withArg.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    paths.push(...expandOperands([a]));
  }
  if (paths.length < 2) { add(c, "low", "read", c.exe, c.exe); return; }
  const dest = paths[paths.length - 1] ?? "";
  const sources = paths.slice(0, -1);
  const remoteOf = (p: string) => /^rsync:\/\//.test(p) ? urlHost(p) : /^(?:[^/:@]+@)?([^/:]+):/.exec(p)?.[1] ?? null;
  const destHost = remoteOf(dest);
  const deleting = argv.some((a) => /^--(?:delete|delete-before|delete-after|delete-during|delete-excluded|remove-source-files|remove-sent-files)$/.test(a));
  if (destHost) {
    const known = c.env.knownHosts.has(destHost);
    for (const s of sources) {
      if (remoteOf(s)) continue;
      const r = pathOf(c, s);
      if (READ_CRED_TIER(r.cls)) {
        add(c, "critical", "network_send", "secret_upload", `copies secret material (${r.shown}) to ${destHost}`, `${c.exe} upload-secret ${destHost}`);
        c.a.credentialReads.push(r.shown);
      }
    }
    c.a.sends.push({ dest: destHost, local: false });
    noteHost(c, destHost, "send");
    add(c, known ? "medium" : "high", "network_send", known ? "upload_known_host" : "upload_unknown_host", `uploads ${sources.join(" ")} to ${destHost}`, `${c.exe} upload ${destHost}`);
    if (deleting) add(c, "high", "delete", "remote_sync_delete", `${c.exe} --delete removes files on ${destHost}`, `${c.exe} --delete ${destHost}`);
    return;
  }
  const srcHost = sources.map(remoteOf).find(Boolean);
  if (srcHost) {
    const known = c.env.knownHosts.has(srcHost);
    noteHost(c, srcHost, "read");
    add(c, "medium", "network_read", "download_host", `downloads from ${srcHost}`, `${c.exe} download ${srcHost}`, known);
    c.a.untrusted = true;
    c.a.downloads.push(pathOf(c, dest).shown);
  } else for (const s of sources) {
    readPath(c, s);
    if (!argv.some((a) => /^--remove-(?:source|sent)-files$/.test(a))) continue;
    const r = pathOf(c, s);
    if (r.cls === "security_control") deletePath(c, s, true);
    else if (!c.seg.remote && r.abs !== null && holdsProjectControl(r.abs, c.env)) add(c, "high", "security_control", "security_control_move", `removes the source files of a directory that holds the project's .pi control directory: ${r.shown}`, `${c.exe} move ${r.key}`);
  }
  writePath(c, dest, `${c.exe} copies into`);
  if (deleting) deletePath(c, dest, true);
}

function sshConn(c: Ctx): void {
  const s = c.seg.ssh;
  if (!s) { add(c, "medium", "remote_exec", "ssh", "ssh", "ssh"); return; }
  const known = c.env.knownHosts.has(s.host);
  noteHost(c, s.host, "connect");
  if (s.proxyCommand) add(c, "medium", "code_exec", "ssh_proxy_command", `ssh to ${s.host} with a ProxyCommand/LocalCommand`, `ssh ${s.host} proxycmd`);
  if (s.forwards) add(c, "medium", "network_send", "ssh_forward", `ssh port forwarding via ${s.host}`, `ssh ${s.host} forward`);
  if (c.seg.interactiveShell) add(c, "medium", "remote_exec", "ssh_interactive", `opens an interactive shell on ${s.host}`, `ssh ${s.host}`);
  else if (c.seg.unknownArgs) add(c, "medium", "remote_exec", "ssh_stdin_script", `runs a piped-in script on ${s.host}`, `ssh ${s.host} stdin`);
  else if (!known) add(c, "medium", "remote_exec", "ssh_unknown_host", `connects to ${s.host}, which is not in ~/.ssh/config or knownHosts`, `ssh ${s.host}`);
  else add(c, "low", "remote_exec", "ssh_known_host", `connects to known host ${s.host}`);
}

function systemctl(c: Ctx): void {
  const argv = c.seg.argv;
  const user = argv.includes("--user");
  const { sub, at } = subcmd(argv, 1, new Set(["-H", "--host", "-M", "--machine", "-t", "--type", "--state", "-p", "--property", "-n", "--lines", "-o", "--output"]));
  const units = nonFlagArgs(argv, at + 1);
  const k = (s: string) => `systemctl ${user ? "--user " : ""}${s}${units[0] ? ` ${units[0]}` : ""}`;
  const READ = /^(?:status|show|cat|is-active|is-enabled|is-failed|is-system-running|list-units|list-unit-files|list-timers|list-sockets|list-dependencies|list-jobs|list-machines|get-default|help|--version|show-environment)$/;
  if (!sub || READ.test(sub)) { add(c, "low", "read", "systemctl_read", k(sub ?? "list-units")); return; }
  if (/^(?:reboot|poweroff|halt|kexec|emergency|rescue|isolate|default|soft-reboot)$/.test(sub)) { add(c, "critical", "destructive_system", "power_state", `systemctl ${sub} takes the machine down`, k(sub)); return; }
  if (/^(?:suspend|hibernate|hybrid-sleep|suspend-then-hibernate)$/.test(sub)) { add(c, "high", "process_control", "power_state", `systemctl ${sub}`, k(sub)); return; }
  if (units.some((u) => SECURITY_SERVICES.test(u)) && /^(?:stop|disable|mask|kill|restart)$/.test(sub)) { add(c, "critical", "security_control", "security_service", `systemctl ${sub} ${units.join(" ")} weakens host security`, k(sub)); return; }
  if (/^(?:enable|disable|mask|unmask|link|set-default|edit|revert|preset|preset-all|add-wants|add-requires|set-property|set-environment|import-environment)$/.test(sub)) { add(c, "high", "persistence", "service_persistence", `systemctl ${sub} ${units.join(" ")} changes what runs at boot/login`, k(sub)); return; }
  if (/^(?:start|stop|restart|reload|try-restart|reload-or-restart|kill|reset-failed|daemon-reload|daemon-reexec|freeze|thaw|clean)$/.test(sub)) { add(c, user ? "medium" : "high", "process_control", "service_control", `systemctl ${user ? "--user " : ""}${sub} ${units.join(" ")}`, k(sub)); return; }
  add(c, "medium", "process_control", "systemctl_other", `systemctl ${sub}`, k(sub));
}

function journalctl(c: Ctx): void {
  if (c.seg.argv.some((a) => /^--(?:vacuum|rotate|flush|relinquish|setup-keys)/.test(a))) { add(c, "medium", "delete", "journal_vacuum", "journalctl discards or rotates logs", "journalctl --vacuum"); return; }
  add(c, "low", "read", "journal_read", "journalctl");
}

function killish(c: Ctx): void {
  const argv = c.seg.argv;
  const targets = argv.slice(1).filter((a) => !a.startsWith("-") || /^-\d+$/.test(a) && argv.indexOf(a) > 1);
  if (c.exe === "kill") {
    if (argv.includes("-l") || argv.includes("-L")) { add(c, "low", "read", "kill_list", "kill -l"); return; }
    if (targets.some((t) => t === "1" || t === "-1" || t === "0")) { add(c, "critical", "destructive_system", "kill_all", "kills init or every process", "kill -1"); return; }
    add(c, "low", "process_control", "kill_pid", `kill ${targets.join(" ")}`); return;
  }
  const names = nonFlagArgs(argv, 1);
  // A specific pattern (a path, a long name) only matches what the agent started.
  if (names.length && names.every((n) => /[/ ]|\.(?:js|mjs|ts|py|sh)\b/.test(n) || n.length >= 14) && !names.some((n) => SESSION_PROCS.test(n))) { add(c, "low", "process_control", "kill_specific", `${c.exe} ${names.join(" ")}`); return; }
  if (names.some((n) => SESSION_PROCS.test(n))) { add(c, "high", "process_control", "kill_session", `${c.exe} ${names.join(" ")} would kill session infrastructure`, `${c.exe} ${names[0]}`); return; }
  add(c, "medium", "process_control", "kill_by_name", `${c.exe} ${names.join(" ")} (can hit unrelated processes)`, `${c.exe} ${names[0] ?? ""}`);
}

function crontab(c: Ctx): void {
  const argv = c.seg.argv;
  if (argv.includes("-l")) { add(c, "low", "read", "crontab_list", "crontab -l"); return; }
  if (argv.includes("-r")) { add(c, "high", "persistence", "crontab_remove", "removes the crontab", "crontab -r"); return; }
  add(c, "high", "persistence", "crontab_install", "installs a crontab (scheduled persistence)", "crontab");
}

function docker(c: Ctx): void {
  const argv = c.seg.argv;
  const { sub: top, at } = subcmd(argv, 1, new Set(["-H", "--host", "--context", "-c", "--config", "-l", "--log-level"]));
  let sub = top;
  let rest = argv.slice(at + 1);
  if (sub === "compose" || c.exe === "docker-compose" || c.exe === "podman-compose") {
    const s = c.exe === "docker-compose" || c.exe === "podman-compose" ? subcmd(argv, 1, new Set(["-f", "--file", "-p", "--project-name", "--profile", "--env-file"])) : subcmd(argv, at + 1, new Set(["-f", "--file", "-p", "--project-name", "--profile", "--env-file"]));
    sub = `compose ${s.sub ?? ""}`;
    rest = argv.slice(s.at + 1);
  }
  const k = `${c.exe} ${sub ?? ""}`;
  const has = (re: RegExp) => rest.some((a) => re.test(a));
  if (sub && /^(?:container |image |volume |network |system )?(?:ps|ls|list|images|logs|inspect|version|info|stats|top|port|history|search|diff|events|df)$|^compose (?:ps|logs|config|ls|top|images|version|port)$|^(?:context|buildx) ls$/.test(`${sub}${rest[0] && /^(?:ls|list|inspect|df|prune-noop)$/.test(rest[0]) ? ` ${rest[0]}` : ""}`.replace(/^(\w+) (ls|inspect|df)$/, "$2"))) { add(c, "low", "read", "container_read", k); return; }
  if (sub === "run" || sub === "create" || sub === "compose run" || sub === "compose up" || sub === "exec") {
    const dangerous = rest.find((a, i) => /^--privileged$|^--pid=host$|^--net(?:work)?=host$|^--cap-add=(?:ALL|SYS_ADMIN|SYS_PTRACE|NET_ADMIN|SYS_MODULE)$|^--security-opt=(?:apparmor|seccomp)[:=]unconfined$|^--device=\/dev\/(?:sd|nvme|mem)/.test(a) || ((a === "--cap-add" || a === "--pid" || a === "--net" || a === "--network") && /^(?:ALL|SYS_ADMIN|host)$/.test(rest[i + 1] ?? "")));
    const mounts: string[] = [];
    for (const [i, a] of rest.entries()) {
      if (a === "-v" || a === "--volume" || a === "--mount") mounts.push(rest[i + 1] ?? "");
      else if (/^(?:-v|--volume=|--mount=)/.test(a) && a.length > 2) mounts.push(a.replace(/^(?:-v|--volume=|--mount=)/, ""));
    }
    if (dangerous) { add(c, "high", "privilege", "container_escape", `${k} with ${dangerous} (root-equivalent access to the host)`, `${k} ${dangerous}`); return; }
    for (const m of mounts) {
      const src = m.includes("source=") ? /source=([^,]+)/.exec(m)?.[1] ?? "" : m.split(":")[0];
      if (!src || !/^[~/.$]/.test(src)) continue;
      const r = pathOf(c, src);
      if (/docker\.sock$/.test(src)) add(c, "high", "privilege", "docker_socket_mount", "mounts the Docker socket (host root)", `${k} docker.sock`);
      else if (r.cls === "root_critical" || r.cls === "system") add(c, "high", "privilege", "host_mount", `mounts ${r.shown} into a container`, `${k} mount ${r.key}`);
      else if (r.cls === "credential") add(c, "high", "credential_read", "credential_mount", `mounts secret material ${r.shown} into a container`, `${k} mount ${r.key}`);
      else if (r.cls === "home" || r.cls === "other") add(c, "medium", "write_outside", "outside_mount", `mounts ${r.shown} into a container`, `${k} mount ${r.key}`);
    }
    add(c, "low", "code_exec", "container_run", k); return;
  }
  if (sub && /^(?:volume rm|volume prune|system prune|compose down)$/.test(`${sub}${sub === "volume" || sub === "system" ? ` ${rest[0] ?? ""}` : ""}`)) {
    if (sub === "compose down" && !has(/^-v$|^--volumes$/)) { add(c, "low", "process_control", "compose_down", k); return; }
    add(c, "high", "delete", "container_data_delete", `${k} ${rest[0] ?? ""} deletes container data`.trim(), `${k} ${rest[0] ?? ""}`.trim()); return;
  }
  if (sub && /^(?:rm|rmi|container|image|network|builder|buildx)$/.test(sub) && (sub === "rm" || sub === "rmi" || /^(?:rm|prune|remove)$/.test(rest[0] ?? ""))) { add(c, "medium", "delete", "container_delete", `${k} ${rest[0] ?? ""}`.trim(), k); return; }
  if (sub && /^(?:push|compose push|login|logout|trust)$/.test(sub)) { add(c, sub === "login" ? "medium" : "medium", sub === "login" ? "credential_read" : "publish", `container_${sub.replace(/\s/g, "_")}`, k, k); return; }
  if (sub && /^(?:build|pull|tag|compose build|compose pull|buildx|save|load|commit|cp|start|stop|restart|kill|pause|unpause|wait|attach|rename|update|compose stop|compose start|compose restart|compose kill|compose rm|compose create|compose exec|network|context)$/.test(sub)) { add(c, "low", "code_exec", "container_manage", k); return; }
  add(c, "medium", "code_exec", "container_other", k, k);
}

function kubectl(c: Ctx): void {
  const argv = c.seg.argv;
  const { sub, at } = subcmd(argv, 1, new Set(["-n", "--namespace", "--context", "--kubeconfig", "-l", "--selector", "-o", "--output", "-c", "--container", "--cluster", "--user", "-s", "--server"]));
  const rest = argv.slice(at + 1);
  const k = `${c.exe} ${sub ?? ""}`;
  if (c.exe === "helm") {
    if (/^(?:list|ls|status|get|template|lint|show|search|history|version|env|dependency|repo|verify|help)$/.test(sub ?? "")) { add(c, "low", "network_read", "cluster_read", k); return; }
    add(c, "high", "remote_exec", "cluster_change", `${k} changes a cluster`, k); return;
  }
  if (sub === "get" && rest.some((a) => /^secrets?(?:\/|$)/.test(a)) && argv.some((a) => /^-o|^--output/.test(a))) { add(c, "high", "credential_read", "cluster_secret_read", "reads Kubernetes secret values", "kubectl get secret"); return; }
  if (sub === "config" && (rest[0] === "view" && argv.includes("--raw"))) { add(c, "high", "credential_read", "kubeconfig_raw", "prints raw kubeconfig credentials", "kubectl config view --raw"); return; }
  if (/^(?:get|describe|logs|top|explain|version|api-resources|api-versions|cluster-info|auth|config|diff|events|wait)$/.test(sub ?? "")) { add(c, "low", "network_read", "cluster_read", k); return; }
  if (sub === "delete") { add(c, "high", "delete", "cluster_delete", `${k} ${rest.slice(0, 2).join(" ")}`, k); return; }
  add(c, "high", "remote_exec", "cluster_change", `${k} changes a cluster`, k);
}

function cloudCli(c: Ctx): void {
  const argv = c.seg.argv;
  const words = nonFlagArgs(argv, 1);
  const joined = words.join(" ");
  const k = `${c.exe} ${words.slice(0, 2).join(" ")}`;
  if (/get-secret-value|get-parameters?(?:\s|$)[^|]*--with-decryption|secrets versions access|print-access-token|print-identity-token|auth print|configure get|export-credentials|get-session-token|get-login-password|keyvault secret show|kms decrypt|ssm get-parameter/.test(`${joined} ${argv.join(" ")}`)) { add(c, "high", "credential_read", "cloud_secret_read", `${k} reads secret material`, k); return; }
  const verb = words.find((w, i) => i > 0 && /^[a-z][\w-]*$/.test(w)) ?? words[0] ?? "";
  if (/^(?:describe|list|get|show|ls|whoami|status|logs|log|info|version|help|tail|inspect|plan|validate|fmt|output|graph|providers|show-|preview|diff|check|test|lint|doctor|dev|init|config)/.test(verb) || /^(?:sts get-caller-identity|s3 ls|configure list|auth list|config list|projects list)/.test(joined)) {
    if (c.exe === "terraform" || c.exe === "tofu" || c.exe === "pulumi") { add(c, "low", "network_read", "cloud_read", k); return; }
    add(c, "medium", "network_read", "cloud_read", `${k} (cloud read with your credentials)`, k); return;
  }
  if (/^(?:destroy|delete|remove|rm|terminate|purge|drop)/.test(verb) || /\bdestroy\b|\bdelete\b|\brb\b/.test(joined)) { add(c, "high", "delete", "cloud_delete", `${k} deletes cloud resources`, k); return; }
  add(c, "high", "remote_exec", "cloud_change", `${k} changes cloud resources`, k);
}

function gh(c: Ctx): void {
  const argv = c.seg.argv;
  const words = nonFlagArgs(argv, 1);
  const [group, verb] = words;
  const k = `gh ${group ?? ""} ${verb ?? ""}`.trim();
  if (group === "auth" && (verb === "token" || argv.includes("-t") || argv.includes("--show-token"))) { add(c, "high", "credential_read", "gh_token", "prints the GitHub token", "gh auth token"); return; }
  if (group === "api") {
    const m = argv.findIndex((a) => a === "-X" || a === "--method");
    const method = m > 0 ? (argv[m + 1] ?? "").toUpperCase() : argv.some((a) => /^-[fF]$|^--(?:field|raw-field|input)$/.test(a)) ? "POST" : "GET";
    if (method === "GET") { add(c, "low", "network_read", "gh_read", `gh api ${words[1] ?? ""}`); return; }
    if (method === "DELETE") { add(c, "high", "delete", "gh_delete", `gh api DELETE ${words[1] ?? ""}`, `gh api DELETE`); return; }
    add(c, "medium", "publish", "gh_write", `gh api ${method} ${words[1] ?? ""}`, `gh api ${method}`); return;
  }
  if (group === "secret" || group === "variable") { if (verb === "list") add(c, "low", "read", "gh_read", k); else add(c, "high", "security_control", "gh_secret", k, k); return; }
  if (group === "ssh-key" || group === "gpg-key") { if (verb === "list") add(c, "low", "read", "gh_read", k); else add(c, "high", "persistence", "gh_key", k, k); return; }
  if (group === "extension" && /^(?:install|upgrade)$/.test(verb ?? "")) { add(c, "medium", "package_install", "gh_extension", k, k); return; }
  if (/^(?:delete|archive|unarchive|transfer|rename)$/.test(verb ?? "") || (group === "repo" && verb === "edit" && argv.some((a) => /visibility/.test(a)))) { add(c, "high", "delete", "gh_destructive", k, k); return; }
  if (!verb || /^(?:view|list|ls|status|diff|checks|watch|download|browse|search|checkout|clone|fork-noop|help)$/.test(verb) || group === "search" || group === "status" || group === "browse") { add(c, "low", "network_read", "gh_read", k); return; }
  add(c, "medium", "publish", "gh_write", k, k);
}

const PM_READ = /^(?:list|ls|la|ll|show|info|view|outdated|audit|why|explain|search|freeze|check|query|doctor|config-get|help|--version|-v|version|root|bin|prefix|whoami|ping|fund|licenses|tree|env|which|where|cache-dir|dir|get|-Q[a-z]*|-S[si]|-F[a-z]*|-T)$/;

function packageManager(c: Ctx, exe: string, args: string[]): void {
  const words = args.filter((a) => !a.startsWith("-"));
  const sub = words[0];
  const names = words.slice(1).filter((w) => !/^(?:\.|\.\/.*|-r|-e|requirements.*\.txt|.*\.whl|.*\.tar\.gz)$/.test(w));
  const global = args.some((a) => /^(?:-g|--global|--user|--system|--break-system-packages|--location=global)$/.test(a));
  const k = `${exe} ${sub ?? ""}`;
  if (!sub) {
    if (exe === "yarn" || exe === "bun" || exe === "pnpm") { add(c, "low", "package_install", "pm_install_lockfile", `${exe} install from lockfile`); return; }
    add(c, "low", "read", "pm_read", exe); return;
  }
  if (/^(?:publish|unpublish|deprecate|dist-tag|owner|access|team|release|upload|push|yank|trusted-publishing)$/.test(sub) || (exe === "twine" && sub === "upload")) { add(c, "high", "publish", "package_publish", `${k} publishes a package`, k); return; }
  if (/^(?:login|logout|adduser|token|whoami-noop)$/.test(sub)) { add(c, "high", "credential_read", "package_credentials", `${k} handles registry credentials`, k); return; }
  if (/^(?:install|i|add|isntall|ci|update|up|upgrade|remove|rm|uninstall|un|unlink|link|dedupe|prune|rebuild|sync|lock|get|require|global|reinstall|download|fetch|tidy|vendor|self-update|self|use)$/.test(sub)) {
    if (sub === "ci" || sub === "sync" || sub === "lock" || sub === "tidy" || sub === "vendor" || sub === "fetch" || sub === "download" || sub === "dedupe" || sub === "prune" || sub === "rebuild") { add(c, "low", "package_install", "pm_install_lockfile", k); return; }
    if (!names.length && !global) { add(c, "low", "package_install", "pm_install_lockfile", `${k} (from manifest/lockfile)`); return; }
    if (/^(?:remove|rm|uninstall|un|unlink)$/.test(sub)) { add(c, global ? "medium" : "low", "package_install", "pm_remove", `${k} ${names.join(" ")}`, `${exe} remove`); return; }
    add(c, "medium", "package_install", "package_install", `${k} ${names.slice(0, 4).join(" ")}${global ? " (global)" : ""}`, `${exe} install${global ? " -g" : ""}`); return;
  }
  if (PM_READ.test(sub)) { add(c, "low", "read", "pm_read", k); return; }
  if (/^(?:config|set)$/.test(sub)) {
    if (words[1] === "get" || words[1] === "list" || words[1] === "ls") { add(c, "low", "read", "pm_read", k); return; }
    add(c, "medium", "write_outside", "pm_config", `${k} ${words.slice(1, 3).join(" ")}`, `${exe} config`); return;
  }
  if (/^(?:exec|x|dlx|create|init|npx)$/.test(sub) || exe === "npx" || exe === "bunx" || exe === "uvx" || exe === "pipx" && sub === "run") {
    const tool = exe === "npx" || exe === "bunx" || exe === "uvx" ? sub : words[1];
    if (tool && /^(?:tsc|eslint|prettier|vitest|jest|playwright|tsx|ts-node|vite|next|astro|biome|turbo|nx|mocha|c8|nyc|rimraf|cross-env|concurrently|wait-on|husky|lint-staged|changeset|semantic-release|typedoc|esbuild|rollup|webpack|svelte-kit|nuxi|expo|create-[\w-]+|degit|serve|http-server|live-server|prisma|drizzle-kit|knip|depcheck|madge|ruff|black|pytest|mypy|pyright|pre-commit|cowsay|markdownlint(?:-cli2?)?|@biomejs\/biome|@playwright\/test|@anthropic-ai\/[\w-]+|@earendil-works\/[\w-]+)(?:@[\w.^~-]+)?$/.test(tool)) { add(c, "low", "code_exec", "pm_exec_known", `${exe} ${tool}`); return; }
    add(c, "medium", "package_install", "pm_exec_fetch", `${exe} ${sub === tool ? "" : `${sub} `}${tool ?? ""} may fetch and run a package`.replace(/\s+/g, " "), `${exe} exec ${tool ?? ""}`); return;
  }
  add(c, "low", "code_exec", "pm_run", k);
}

const PACKAGE_MANAGERS: Record<string, Handler> = Object.fromEntries(
  ["npm", "pnpm", "yarn", "bun", "npx", "bunx", "pip", "pip3", "uv", "uvx", "pipx", "poetry", "pdm", "conda", "mamba", "micromamba", "gem", "bundle", "bundler", "cargo", "go", "composer", "mise", "asdf", "rustup", "corepack", "deno", "twine", "hatch", "pipenv", "flit", "dotnet", "swift"].map((pm) => [
    pm,
    (c: Ctx) => {
      const argv = c.seg.argv;
      if (pm === "uv" && argv[1] === "pip") { packageManager(c, "uv pip", argv.slice(2)); return; }
      if (pm === "uv" && (argv[1] === "run" || argv[1] === "tool" && argv[2] === "run")) { add(c, "low", "code_exec", "pm_run", `uv ${argv[1]}`); return; }
      if ((pm === "cargo" || pm === "go") && /^(?:build|test|run|check|clippy|fmt|doc|bench|vet|generate|mod|env|version|list|tree|metadata|clean|new|init|fix|expand|nextest|watch|llvm-cov|tarpaulin|work|tool)$/.test(argv[1] ?? "")) {
        if (argv[1] === "mod" && argv[2] === "tidy") { add(c, "low", "package_install", "pm_install_lockfile", `${pm} mod tidy`); return; }
        add(c, "low", "code_exec", "dev_tool", `${pm} ${argv[1]}`); return;
      }
      if (pm === "deno" && /^(?:run|test|task|fmt|lint|check|bench|compile|doc|info|repl|eval|serve|cache|coverage|types|jupyter)$/.test(argv[1] ?? "")) {
        if (argv[1] === "eval") { inlineCode(c, argv[2] ?? ""); return; }
        add(c, "low", "code_exec", "dev_tool", `deno ${argv[1]}`); return;
      }
      if ((pm === "dotnet" || pm === "swift") && !/^(?:add|tool|nuget|package)$/.test(argv[1] ?? "")) { add(c, "low", "code_exec", "dev_tool", `${pm} ${argv[1] ?? ""}`); return; }
      if (pm === "bun" && (argv[1] === "-e" || argv[1] === "--eval")) { inlineCode(c, argv[2] ?? ""); return; }
      if ((pm === "npm" || pm === "pnpm" || pm === "yarn" || pm === "bun") && /^(?:run|run-script|test|t|tst|start|stop|restart|build|dev|lint|format|typecheck|exec-noop|pack|version|help|init|audit|workspaces|workspace|why|-w|--filter|-C|--dir|--prefix|--cwd|-F)$/.test(argv[1] ?? "")) {
        if (argv[1] === "audit" && argv[2] === "fix") { add(c, "low", "package_install", "pm_install_lockfile", `${pm} audit fix`); return; }
        if (/^(?:--filter|-C|--dir|--prefix|--cwd|-F|-w|workspace|workspaces)$/.test(argv[1] ?? "")) { packageManager(c, pm, argv.slice(3)); return; }
        add(c, "low", "code_exec", "pm_run", `${pm} ${argv[1]}${argv[2] && !argv[2].startsWith("-") ? ` ${argv[2]}` : ""}`); return;
      }
      packageManager(c, pm, argv.slice(1));
    },
  ]),
);

function sysPackageManager(c: Ctx): void {
  const argv = c.seg.argv;
  const exe = c.exe;
  const flags = argv.slice(1).filter((a) => a.startsWith("-")).join(" ");
  const words = nonFlagArgs(argv, 1);
  const k = `${exe} ${exe === "pacman" || exe === "yay" || exe === "paru" ? flags.split(" ")[0] ?? "" : words[0] ?? ""}`;
  const pac = exe === "pacman" || exe === "yay" || exe === "paru" || exe === "makepkg";
  if (pac) {
    if (exe === "makepkg") { add(c, "medium", "package_install", "makepkg", "makepkg builds a package (runs PKGBUILD)", "makepkg"); return; }
    if (/^-(?:Q|F|Si|Ss|Sl|Sg|T|V|h)/.test(flags) || (!flags && exe !== "pacman" && !words.length)) { add(c, !flags && !words.length ? "high" : "low", !flags && !words.length ? "package_install" : "read", !flags && !words.length ? "system_upgrade" : "pm_read", k, k); return; }
    if (/-S[a-z]*u|-Syu/.test(flags)) { add(c, "high", "package_install", "system_upgrade", `${exe} full system upgrade`, `${exe} -Syu`); return; }
    if (/^-R/.test(flags)) { add(c, "high", "package_install", "system_remove", `${exe} removes system packages: ${words.join(" ")}`, `${exe} -R`); return; }
    if (/^-(?:S|U)/.test(flags)) { add(c, "medium", "package_install", "system_install", `${exe} installs ${words.join(" ")}`, `${exe} -S`); return; }
    if (/^-(?:D)/.test(flags)) { add(c, "medium", "package_install", "system_pkgdb", `${exe} ${flags}`, `${exe} -D`); return; }
    add(c, "medium", "package_install", "system_pm_other", `${exe} ${flags}`, k); return;
  }
  const sub = words[0] ?? "";
  if (/^(?:list|search|show|info|policy|depends|rdepends|madison|query|provides|whatprovides|repolist|history|check-update|list-installed|-v|--version|leaves|deps|uses|outdated|doctor|config|--prefix|home|cat|desc|home-noop|log)$/.test(sub) || !sub) { add(c, "low", "read", "pm_read", k); return; }
  if (/^(?:upgrade|dist-upgrade|full-upgrade|update|refresh|dup|distro-sync|autoremove|clean|autoclean)$/.test(sub)) { add(c, sub === "update" || sub === "refresh" || sub === "clean" ? "medium" : "high", "package_install", "system_upgrade", k, k); return; }
  if (/^(?:remove|purge|erase|uninstall|rm|del|zap)$/.test(sub)) { add(c, "high", "package_install", "system_remove", `${k} ${words.slice(1).join(" ")}`, k); return; }
  if (/^(?:install|reinstall|add|in|localinstall|tap|link)$/.test(sub)) { add(c, "medium", "package_install", "system_install", `${k} ${words.slice(1).join(" ")}`, k); return; }
  add(c, "medium", "package_install", "system_pm_other", k, k);
}

function diskTool(c: Ctx): void {
  const argv = c.seg.argv;
  const exe = c.exe;
  const readOnly =
    (exe === "fdisk" && argv.includes("-l")) ||
    (exe === "sfdisk" && argv.some((a) => /^-(?:l|d|J|V|s)$|^--(?:list|dump|json|verify|show-size)/.test(a))) ||
    (exe === "parted" && argv.some((a) => a === "-l" || a === "--list" || a === "print")) ||
    ((exe === "sgdisk" || exe === "gdisk") && argv.some((a) => /^-(?:p|i|v|O)$|^--(?:print|info|verify)/.test(a))) ||
    (exe === "cryptsetup" && argv.some((a) => /^(?:status|luksDump|isLuks|--version|benchmark)$/.test(a))) ||
    (/^(?:zpool|zfs)$/.test(exe) && /^(?:status|list|get|iostat|history|events)$/.test(argv[1] ?? "")) ||
    (/^(?:lvs|vgs|pvs|lvdisplay|vgdisplay|pvdisplay)$/.test(exe)) ||
    (exe === "wipefs" && !argv.some((a) => /^-[A-Za-z]*a|^--all|^-o|^--offset/.test(a))) ||
    (exe === "btrfs" && /^(?:filesystem|fi|subvolume|su|device|dev|scrub|balance|qgroup|inspect-internal)$/.test(argv[1] ?? "") && /^(?:show|df|usage|list|ls|status|du|stats|get)$/.test(argv[2] ?? "")) ||
    (exe === "hdparm" && !argv.some((a) => /security|--trim|--write|-[A-Za-z]*[WJzy]/.test(a))) ||
    (exe === "smartctl") ||
    (exe === "badblocks" && !argv.some((a) => /^-[A-Za-z]*[wn]/.test(a))) ||
    (exe === "e2fsck" && argv.some((a) => /^-[A-Za-z]*n/.test(a))) ||
    (exe === "fsck" && argv.some((a) => /^-[A-Za-z]*N/.test(a))) ||
    (exe === "tune2fs" && argv.some((a) => /^-l$/.test(a)) && !argv.some((a) => /^-[A-Za-z]*[cCeEfgijJLmMoOrTuUQ]/.test(a) && a !== "-l")) ||
    (exe === "dumpe2fs") ||
    (exe === "resize2fs" && argv.includes("-P")) ||
    (exe === "losetup" && (argv.length === 1 || argv.some((a) => /^-(?:a|l|j|--list|--all)$/.test(a)))) ||
    (exe === "dmsetup" && /^(?:ls|info|status|table|deps|version)$/.test(argv[1] ?? "")) ||
    (exe === "mdadm" && argv.some((a) => /^--(?:detail|examine|query)$|^-[DEQ]$/.test(a))) ||
    (exe === "efibootmgr" && !argv.some((a) => /^-[A-Za-z]*[BcCnNoaAb]|^--(?:create|delete|bootnum|bootorder|bootnext|active|inactive)/.test(a))) ||
    (exe === "bootctl" && /^(?:status|list|is-installed|--help|--version)$/.test(argv[1] ?? "status"));
  if (readOnly) { add(c, "low", "read", "disk_read", `${exe} (read-only)`); return; }
  if (/^(?:efibootmgr|bootctl|grub-install|grub-mkconfig|update-grub|mkinitcpio|dracut|kernel-install|limine-update|limine-install|update-initramfs)$/.test(exe)) { add(c, "high", "privilege", "boot_config", `${exe} changes boot configuration`, exe); return; }
  if (/^(?:resize2fs|tune2fs|e2fsck|fsck|btrfs|losetup|dmsetup|mdadm|hdparm)$/.test(exe)) { add(c, "high", "privilege", "disk_change", `${exe} changes disks or filesystems`, exe); return; }
  add(c, "critical", "destructive_system", "disk_destroy", `${exe} can destroy disk data`, exe);
}

function mountish(c: Ctx): void {
  const argv = c.seg.argv;
  if (c.exe === "mount" && (argv.length === 1 || argv.every((a, i) => i === 0 || /^-(?:l|t|v)$|^--(?:list|show-labels)/.test(a) || argv[i - 1] === "-t"))) { add(c, "low", "read", "mount_list", "mount (list)"); return; }
  if (c.exe === "findmnt" || c.exe === "swapon" && argv.some((a) => /^--show|^-s$/.test(a))) { add(c, "low", "read", "mount_list", c.exe); return; }
  add(c, "high", "privilege", "mount_change", `${c.exe} ${argv.slice(1).join(" ")}`.slice(0, 120), c.exe);
}

function netAdmin(c: Ctx): void {
  const argv = c.seg.argv;
  const exe = c.exe;
  const joined = argv.slice(1).join(" ");
  if (exe === "ip" && /^(?:-\w+\s+)*(?:a|addr|address|r|route|l|link|n|neigh|neighbour|rule|maddr|tunnel|netns)?(?:\s+(?:show|list|ls|get))?(?:\s|$)/.test(joined) && !/\b(?:add|del|delete|change|replace|set|flush|append|prepend)\b/.test(joined)) { add(c, "low", "read", "net_read", `ip ${joined}`.slice(0, 80)); return; }
  if ((exe === "iptables" || exe === "ip6tables" || exe === "iptables-save" || exe === "nft") && (/^(?:-\w+\s+)*(?:-L|-S|--list|list|-nL|-nvL|-vnL)/.test(joined) || exe === "iptables-save")) { add(c, "low", "read", "fw_read", `${exe} (list)`); return; }
  if (exe === "ufw" && /^(?:status|show|app list|version)/.test(joined)) { add(c, "low", "read", "fw_read", "ufw status"); return; }
  if (exe === "firewall-cmd" && /--(?:list|state|get|query)/.test(joined) && !/--(?:add|remove|set|reload|panic|runtime-to-permanent)/.test(joined)) { add(c, "low", "read", "fw_read", "firewall-cmd (query)"); return; }
  if (exe === "nmcli" && /^(?:-\w+\s+)*(?:(?:g|general|d|device|c|connection|r|radio|n|networking)(?:\s+(?:show|status|list|wifi list))?|monitor)?\s*$/.test(joined)) { add(c, "low", "read", "net_read", `nmcli ${joined}`); return; }
  if (exe === "resolvectl" && /^(?:status|query|statistics|dns|domain)?\s*$/.test(argv[1] ?? "")) { add(c, "low", "read", "net_read", "resolvectl"); return; }
  if (exe === "ifconfig" && !/\b(?:up|down|add|del|netmask|hw|mtu|promisc)\b/.test(joined)) { add(c, "low", "read", "net_read", "ifconfig"); return; }
  if (exe === "tc" && /^(?:-\w+\s+)*(?:qdisc|class|filter)\s+(?:show|ls|list)/.test(joined)) { add(c, "low", "read", "net_read", "tc show"); return; }
  if ((exe === "ufw" && /^(?:disable|reset)/.test(joined)) || (/^(?:iptables|ip6tables|nft)$/.test(exe) && /(?:^|\s)(?:-F|--flush|flush\s+ruleset|-P\s+\w+\s+ACCEPT|-X)(?:\s|$)/.test(joined)) || (exe === "firewall-cmd" && /--panic-off|--set-default-zone=trusted/.test(joined))) { add(c, "critical", "security_control", "firewall_disable", `${exe} ${joined} disables the host firewall`, `${exe} disable`); return; }
  add(c, "high", "privilege", "net_change", `${exe} ${joined}`.slice(0, 120), `${exe} change`);
}

function secretStore(c: Ctx): void {
  const argv = c.seg.argv;
  const exe = c.exe;
  const sub = argv[1] ?? "";
  const listish = /^(?:ls|list|find|search|status|--version|help|git|init|whoami|vault|signin|account|template|item-noop)$/.test(sub) || (exe === "pass" && argv.length === 1);
  if (listish && !(exe === "op" && sub === "item" && argv[2] === "get")) { add(c, "low", "read", "secret_store_list", `${exe} ${sub}`.trim()); return; }
  if (exe === "gpg" || exe === "gpg2") {
    if (argv.some((a) => /^--export-secret|^--export-secret-subkeys/.test(a))) { add(c, "high", "credential_read", "gpg_secret_export", "exports GPG secret keys", "gpg --export-secret-keys"); return; }
    if (argv.some((a) => /^(?:-d|--decrypt)$/.test(a))) { add(c, "medium", "credential_read", "gpg_decrypt", "decrypts GPG data", "gpg --decrypt"); return; }
    if (argv.some((a) => /^--(?:import|delete|gen-key|full-gen-key|quick-gen-key|edit-key|sign-key|lsign-key)/.test(a))) { add(c, "medium", "security_control", "gpg_keyring_change", `gpg ${argv.find((a) => a.startsWith("--"))}`, "gpg keyring"); return; }
    add(c, "low", "read", "gpg", "gpg"); return;
  }
  if (exe === "ssh-keygen") {
    if (argv.some((a) => /^-[A-Za-z]*y/.test(a))) { add(c, "high", "credential_read", "ssh_key_read", "reads a private key", "ssh-keygen -y"); return; }
    if (argv.some((a) => /^-[A-Za-z]*[lRFHB]/.test(a))) { add(c, "low", "read", "ssh_keygen_query", "ssh-keygen (query)"); return; }
    add(c, "medium", "security_control", "ssh_keygen", "creates or changes an SSH key", "ssh-keygen"); return;
  }
  if (exe === "ssh-add") { if (argv.some((a) => /^-[lL]$/.test(a))) add(c, "low", "read", "ssh_agent_list", "ssh-add -l"); else add(c, "medium", "security_control", "ssh_add", "loads a key into the SSH agent", "ssh-add"); return; }
  if (exe === "ssh-copy-id") { add(c, "high", "persistence", "ssh_copy_id", "installs an SSH key on a remote host", "ssh-copy-id"); return; }
  if (exe === "ssh-agent") { add(c, "low", "read", "ssh_agent", "ssh-agent"); return; }
  add(c, "high", "credential_read", "secret_store_read", `${exe} ${sub} reads secret material`.replace(/\s+/g, " "), `${exe} ${sub}`.trim());
}

function envDump(c: Ctx): void {
  const seg = c.seg;
  const argv = seg.argv;
  const names = argv.slice(1).filter((a) => !a.startsWith("-"));
  if (c.exe === "printenv" && names.length) {
    const secret = names.filter(isSecretName);
    if (secret.length) { add(c, "medium", "credential_read", "secret_env_print", `prints ${secret.join(", ")}`, `printenv ${secret[0]}`); return; }
    add(c, "low", "read", "env_read", `printenv ${names.join(" ")}`); return;
  }
  if ((c.exe === "export" || c.exe === "declare" || c.exe === "typeset" || c.exe === "set") && argv.length > 1 && !argv.slice(1).every((a) => /^-[pxf]+$/.test(a))) {
    // `export FOO=bar` / `set -euo pipefail`
    for (const a of argv.slice(1)) {
      const name = a.split("=")[0] ?? "";
      if (/^PI_KIT_(?:FIREWALL|AUTO_MODE|PROTECTED|WRITE_ALLOWLIST|INTERNAL_CHILD|HUMAN_CONSOLE|CAPTURE|UNATTENDED)/.test(name)) add(c, "high", "security_control", "safety_env_override", `overrides a safety setting via ${name}`, `export ${name}`);
      if (/^(?:LD_PRELOAD|DYLD_INSERT_LIBRARIES)$/.test(name)) add(c, "high", "obfuscated_exec", "library_injection", `injects a shared library via ${name}`, `export ${name}`);
      if (/^HISTFILE$/.test(name) && /=\/dev\/null$|=$/.test(a)) add(c, "medium", "security_control", "history_disable", "disables shell history", "export HISTFILE");
    }
    if (!c.findings.length) add(c, "low", "read", "shell_builtin", c.exe);
    return;
  }
  // A dump filtered by grep for non-secret names is fine.
  const next = seg.next;
  if (next && basenameOf(next.argv[0] ?? "") === "grep") {
    const pat = next.argv.slice(1).filter((a) => !a.startsWith("-")).join(" ");
    if (pat && !isSecretName(pat)) { add(c, "low", "read", "env_read", `${c.exe} | grep ${pat}`); return; }
  }
  add(c, "medium", "credential_read", "env_dump", `${c.exe} dumps environment variables (may include tokens)`, `${c.exe} dump`);
}

function piCli(c: Ctx): void {
  const argv = c.seg.argv;
  const exe = c.exe;
  if (exe === "pi") {
    if (argv.some((a) => a === "--no-extensions" || a === "-ne" || a === "--no-extension")) {
      const toolsIdx = argv.indexOf("--tools");
      const noTools = argv.includes("--no-tools") || (toolsIdx >= 0 && (argv[toolsIdx + 1] ?? "").trim() === "");
      if (!noTools && !argv.some((a) => /^(?:--help|-h|--version|-v|list|--list-models)$/.test(a))) { add(c, "high", "security_control", "unguarded_agent", "starts a pi agent without extensions (no firewall)", "pi --no-extensions"); return; }
    }
    if (/^(?:install|remove|uninstall|update|config)$/.test(argv[1] ?? "") && !argv.some((a) => a === "--help" || a === "-h")) { add(c, "medium", "package_install", "pi_package", `pi ${argv[1]} ${argv[2] ?? ""}`.trim(), `pi ${argv[1]}`); return; }
    add(c, "low", "code_exec", "pi_cli", "pi"); return;
  }
  if (argv.some((a) => UNGUARDED_FLAGS.test(a))) { add(c, "high", "security_control", "unguarded_agent", `${exe} ${argv.find((a) => UNGUARDED_FLAGS.test(a))} runs an agent without its approval gate`, `${exe} unguarded`); return; }
  add(c, "low", "code_exec", "agent_cli", exe);
}

function powerState(c: Ctx): void {
  const argv = c.seg.argv;
  if (c.exe === "shutdown" && argv.includes("-c")) { add(c, "low", "process_control", "shutdown_cancel", "shutdown -c"); return; }
  if ((c.exe === "init" || c.exe === "telinit") && !/^[06Ss1]$/.test(argv[1] ?? "")) { add(c, "low", "read", "init_query", c.exe); return; }
  add(c, "critical", "destructive_system", "power_state", `${c.exe} takes the machine down`, c.exe);
}

function accountAdmin(c: Ctx): void {
  add(c, "high", "privilege", "account_change", `${c.exe} changes users, groups or passwords`, c.exe);
}

function archive(c: Ctx): void {
  const argv = c.seg.argv;
  const exe = c.exe;
  if (exe === "tar" || exe === "bsdtar") {
    const flags = argv.slice(1).filter((a) => a.startsWith("-") || /^[a-zA-Z]+$/.test(a) && argv.indexOf(a) === 1).join(" ");
    const fi = argv.findIndex((a) => a === "-f" || a === "--file" || /^-?[a-zA-Z]*f$/.test(a) && argv.indexOf(a) <= 2);
    const fopt = argv[fi] ?? "";
    const file = fi > 0 ? (fopt.includes("=") ? fopt.split("=")[1] : argv[fi + 1]) : undefined;
    const ci = argv.findIndex((a) => a === "-C" || a === "--directory");
    const dir = ci > 0 ? argv[ci + 1] : undefined;
    if (/(?:^|\s)-?[a-zA-Z]*t|--list/.test(flags)) { add(c, "low", "read", "archive_list", "tar (list)"); return; }
    if (/(?:^|\s)-?[a-zA-Z]*x|--extract|--get/.test(flags)) {
      if (dir) writePath(c, dir, "extracts into");
      if (argv.some((a) => /^--(?:absolute-names|overwrite-dir)$|^-[a-zA-Z]*P/.test(a))) add(c, "medium", "write_outside", "archive_absolute", "extracts with absolute paths", "tar -P");
      if (file) readPath(c, file);
      if (!c.findings.length) add(c, "low", "workspace_write", "archive_extract", "tar extract");
      return;
    }
    if (file) writePath(c, file, "creates archive");
    for (const p of argPaths(argv).filter((p) => p !== file && p !== dir && !/^[a-zA-Z]+$/.test(p))) readPath(c, p);
    if (!c.findings.length) add(c, "low", "workspace_write", "archive_create", "tar create");
    return;
  }
  if (exe === "unzip" || exe === "7z" || exe === "7za" || exe === "unrar") {
    if (argv.some((a) => a === "-l" || a === "l" || a === "-v" || a === "t" || a === "-t")) { add(c, "low", "read", "archive_list", `${exe} (list)`); return; }
    const di = argv.findIndex((a) => a === "-d" || a.startsWith("-o"));
    if (di > 0) writePath(c, argv[di] === "-d" ? argv[di + 1] ?? "" : (argv[di] ?? "").slice(2), "extracts into");
    if (!c.findings.length) add(c, "low", "workspace_write", "archive_extract", exe);
    return;
  }
  // zip/gzip/etc.
  for (const p of argPaths(argv)) readPath(c, p);
  if (!c.findings.length) add(c, "low", "workspace_write", "archive", exe);
}

function sourceCmd(c: Ctx): void {
  const file = c.seg.argv[1];
  if (!file) { add(c, "low", "code_exec", "source", "source"); return; }
  if (c.seg.words[1]?.procSub) {
    const sub = c.seg.words[1].subs.join(" ");
    if (/\b(?:curl|wget|nc)\b/.test(sub)) { add(c, "high", "obfuscated_exec", "remote_script_exec", "sources downloaded content", "source <(curl)"); return; }
    add(c, "medium", "code_exec", "source_procsub", "sources generated shell code", "source <()"); return;
  }
  const r = pathOf(c, file);
  c.a.executes.push(r.shown);
  if (r.cls === "credential_ws" || r.cls === "credential") { add(c, "medium", "credential_read", "source_env", `loads secrets from ${r.shown} into the shell`, `source ${r.key}`); return; }
  if (r.abs && /^\/etc\/(?:os-release|lsb-release|environment|default\/)/.test(r.abs)) { add(c, "low", "read", "source_data", `source ${r.shown}`); return; }
  if (r.cls === "home" || r.cls === "other" || r.cls === "unknown" || r.cls === "temp") { add(c, "medium", "code_exec", "source_outside", `sources ${r.shown}`, `source ${r.key}`); return; }
  add(c, "low", "code_exec", "source", `source ${r.shown}`);
}

function evalCmd(c: Ctx): void {
  // `eval "$(tool init)"`-style environment setup for well-known tools.
  const subs = c.seg.words.slice(1).flatMap((w) => w.subs).join(" ");
  if (/^\s*(?:ssh-agent|mise|direnv|brew shellenv|fnm env|pyenv init|rbenv init|starship init|zoxide init|conda shell|keychain|dircolors|thefuck|atuin init|fzf --\w+|register-python-argcomplete|nodenv init|goenv init|jenv init|opam env|luarocks path|rustup completions|uv generate-shell-completion|gh completion)\b/.test(subs)) { add(c, "low", "code_exec", "eval_env_setup", "eval of shell setup output"); return; }
  if (/\b(?:curl|wget|nc)\b/.test(subs)) { add(c, "high", "obfuscated_exec", "remote_script_exec", "evaluates downloaded content", "eval curl"); return; }
  if (decoderLike(subs)) { add(c, "high", "obfuscated_exec", "decoded_exec", "evaluates decoded content", "eval decode"); return; }
  add(c, "medium", "opaque", "eval_dynamic", "eval of runtime-built text", "eval");
}

function tmux(c: Ctx): void {
  const sub = c.seg.argv[1] ?? "";
  if (/^(?:kill-server)$/.test(sub)) { add(c, "high", "process_control", "tmux_kill_server", "kills every tmux session", "tmux kill-server"); return; }
  if (/^(?:kill-session|kill-window|kill-pane)$/.test(sub)) { add(c, "low", "process_control", "tmux_kill", `tmux ${sub}`); return; }
  add(c, "low", "code_exec", "tmux", `${c.exe} ${sub}`.trim());
}

function ln(c: Ctx): void {
  const paths = argPaths(c.seg.argv);
  const dest = paths.length > 1 ? paths[paths.length - 1] : paths[0];
  if (dest) writePath(c, dest, "links");
  for (const s of paths.slice(0, -1)) {
    const r = pathOf(c, s);
    if (r.cls === "credential") add(c, "medium", "credential_read", "credential_link", `links secret material ${r.shown}`, `ln ${r.key}`);
  }
  if (!c.findings.length) add(c, "low", "workspace_write", "link", "ln");
}

function historyCmd(c: Ctx): void {
  if (c.seg.argv.some((a) => /^-[A-Za-z]*[cdw]/.test(a))) { add(c, "medium", "security_control", "history_clear", "clears or rewrites shell history", "history -c"); return; }
  add(c, "low", "read", "history", "history");
}

function systemdRun(c: Ctx): void {
  add(c, "medium", "code_exec", "systemd_run", `${c.exe} runs a transient service outside this session`, c.exe);
}

function atLaunch(c: Ctx): void {
  if (c.exe === "launchctl" && /^(?:list|print|blame|print-disabled|version|help)$/.test(c.seg.argv[1] ?? "")) { add(c, "low", "read", "launchctl_read", "launchctl list"); return; }
  if (c.exe === "atq") { add(c, "low", "read", "at_read", "atq"); return; }
  add(c, "high", "persistence", "scheduled_task", `${c.exe} schedules or installs a job`, c.exe);
}

function sysctl(c: Ctx): void {
  if (c.seg.argv.some((a) => /^-[A-Za-z]*w$|^--write$|^-p$|^--load|^--system$/.test(a) || /=/.test(a))) { add(c, "high", "privilege", "sysctl_write", "changes kernel parameters", "sysctl -w"); return; }
  add(c, "low", "read", "sysctl_read", "sysctl");
}

function kernelModules(c: Ctx): void {
  add(c, "high", "privilege", "kernel_module", `${c.exe} loads or unloads kernel modules`, c.exe);
}

function selinux(c: Ctx): void {
  if (c.exe === "setenforce" && /^(?:0|permissive)$/i.test(c.seg.argv[1] ?? "")) { add(c, "critical", "security_control", "selinux_disable", "disables SELinux enforcement", "setenforce 0"); return; }
  if (c.exe === "aa-disable" || c.exe === "aa-complain" || (c.exe === "apparmor_parser" && c.seg.argv.some((a) => /^-[A-Za-z]*R/.test(a)))) { add(c, "critical", "security_control", "apparmor_disable", `${c.exe} weakens AppArmor`, c.exe); return; }
  if (/^(?:getenforce|sestatus|aa-status|apparmor_status)$/.test(c.exe)) { add(c, "low", "read", "mac_read", c.exe); return; }
  add(c, "high", "security_control", "mac_change", `${c.exe} changes mandatory access control`, c.exe);
}

function chattr(c: Ctx): void {
  add(c, "high", "privilege", "attr_change", `${c.exe} changes file attributes/ACLs`, c.exe);
}

function shred(c: Ctx): void {
  for (const t of argPaths(c.seg.argv)) {
    const r = pathOf(c, t);
    if (r.cls === "device" || r.cls === "root_critical" || r.cls === "system") add(c, "critical", "destructive_system", "shred_critical", `shreds ${r.shown}`, `shred ${r.key}`);
    else add(c, "high", "delete", "shred", `irrecoverably shreds ${r.shown}`, `shred ${r.key}`);
    c.a.deletes++;
  }
  if (!c.findings.length) add(c, "high", "delete", "shred", "shred", "shred");
}

function interactiveSudo(c: Ctx): void {
  if (c.seg.argv[0] === "sudo-query") { add(c, "low", "read", "sudo_query", "sudo -l/-v"); return; }
  add(c, "high", "privilege", "root_shell", "opens a root shell", "sudo -i");
}

function testCmd(c: Ctx): void {
  for (const a of c.seg.argv.slice(1)) if (looksLikePath(a)) readPath(c, a);
  if (!c.findings.length) add(c, "low", "read", "test", "test");
}

function mkdirTouch(c: Ctx): void {
  const argv = c.seg.argv;
  const skip = new Set<string | undefined>();
  // Options that take a value: touch -d/-r/-t (date, reference, time); mkdir/install -m (mode),
  // install -o/-g/-t (owner, group, target dir). `install -d` is a flag: its operands are dirs.
  const valued = c.exe === "touch" ? /^-(?:d|r|t|-reference|-date)$/ : c.exe === "install" ? /^-(?:m|o|g|-mode|-owner|-group)$/ : /^-(?:m|-mode)$/;
  for (let i = 1; i < argv.length; i++) if (valued.test(argv[i] ?? "")) skip.add(argv[i + 1]);
  for (const t of argPaths(argv).filter((a) => !skip.has(a))) {
    // `mkdir -p .pi` only makes sure the control directory exists; what lands in it is classed on its own.
    const abs = c.exe === "mkdir" && !c.seg.remote ? resolvePath(t, c.seg.cwd, c.env, c.seg.remote, c.seg.vars) : null;
    if (abs !== null && projectControlDirs(c.env).includes(abs.replace(/\/+$/, ""))) continue;
    writePath(c, t, c.exe);
  }
  if (!c.findings.length) add(c, "low", "workspace_write", c.exe, c.exe);
}

function installCmd(c: Ctx): void {
  const argv = c.seg.argv;
  if (argv.some((a) => a === "-d" || a === "--directory")) { mkdirTouch(c); return; }
  mvCp(false)(c);
}

function patchCmd(c: Ctx): void {
  const oi = c.seg.argv.findIndex((a) => a === "-o" || a === "--output");
  if (oi > 0) writePath(c, c.seg.argv[oi + 1] ?? "", "patch writes");
  add(c, "low", "workspace_write", "patch", "patch");
}

function editorLike(c: Ctx): void {
  for (const a of argPaths(c.seg.argv)) readPath(c, a);
  if (!c.findings.length) add(c, "low", "workspace_write", "editor", c.exe);
}

function xdgOpen(c: Ctx): void {
  const target = c.seg.argv[1] ?? "";
  if (/^https?:/.test(target)) {
    noteHost(c, urlHost(target), "read");
    add(c, "low", "network_read", "open_url", `opens ${urlHost(target)}`); return;
  }
  add(c, "low", "code_exec", "open", `${c.exe} ${target}`);
}

function notifyCmd(c: Ctx): void {
  add(c, "low", "read", "notify", c.exe);
}

function cdCmd(c: Ctx): void {
  add(c, "low", "read", "cd", `cd ${c.seg.argv[1] ?? "~"}`);
}

function sudoShellMarker(c: Ctx): void {
  interactiveSudo(c);
}

function remoteDesktop(c: Ctx): void {
  add(c, "medium", "remote_exec", "remote_session", `${c.exe} opens a remote session`, c.exe);
}

function dockerLike(c: Ctx): void {
  docker(c);
}

function ftpLike(c: Ctx): void {
  const host = c.seg.argv.slice(1).find((a) => !a.startsWith("-")) ?? "?";
  c.a.sends.push({ dest: host, local: LOCALHOST_RE.test(host) });
  noteHost(c, host, "connect");
  add(c, "medium", "network_send", "file_transfer", `${c.exe} to ${host}`, `${c.exe} ${host}`);
}

function hyprctl(c: Ctx): void {
  const sub = c.seg.argv[1] ?? "";
  if (/^(?:monitors|workspaces|activeworkspace|clients|activewindow|layers|devices|binds|version|splash|getoption|cursorpos|animations|instances|layouts|configerrors|rollinglog|systeminfo|globalshortcuts|decorations|-j)$/.test(sub)) { add(c, "low", "read", "desktop_read", `hyprctl ${sub}`); return; }
  if (sub === "dispatch" && /^exec/.test(c.seg.argv[2] ?? "")) {
    const inner = classifyShellText(c.seg.argv.slice(3).join(" "), c.env, c.seg.cwd, c.seg.remote);
    for (const f of inner.findings) c.findings.push(f);
    mergeInner(c, inner.a);
    return;
  }
  if (sub === "kill") { add(c, "medium", "process_control", "desktop_kill", "hyprctl kill", "hyprctl kill"); return; }
  add(c, "low", "workspace_write", "desktop_config", `hyprctl ${sub}`);
}

const HANDLERS: Record<string, Handler> = {
  rm: rm, unlink: rm, rmdir: (c) => add(c, "low", "workspace_write", "rmdir", "rmdir (empty dirs only)"), srm: rm, trash: (c) => add(c, "low", "workspace_write", "trash", "trash (recoverable)"), "trash-put": (c) => add(c, "low", "workspace_write", "trash", "trash (recoverable)"), gio: (c) => (c.seg.argv[1] === "trash" ? add(c, "low", "workspace_write", "trash", "gio trash") : c.seg.argv[1] === "remove" ? rm(c) : add(c, "low", "read", "gio", "gio")),
  "remove-item": psRemove, ri: psRemove, del: psRemove, erase: psRemove, rd: psRemove,
  mv: mvCp(true), cp: mvCp(false), rsync: scpRsync, scp: scpRsync, install: installCmd, ln, link: ln,
  mkdir: mkdirTouch, touch: mkdirTouch, mktemp: (c) => add(c, "low", "workspace_write", "mktemp", "mktemp"), tee, sed, gsed: sed, perl: (c) => { if (c.seg.argv.some((a) => /^-[A-Za-z]*i/.test(a))) { inlineCode(c, c.seg.argv[c.seg.argv.findIndex((a) => /^-[A-Za-z]*e$/.test(a)) + 1] ?? ""); sed(c); } else devTool(c); },
  awk, gawk: awk, mawk: awk, nawk: awk,
  chmod, chown, chgrp: chown, dd, truncate, shred, wipe: shred,
  find, bfs: find,
  git, "git-lfs": (c) => add(c, "low", "network_read", "git_fetch", "git-lfs"),
  curl: curlLike, wget: curlLike, wget2: curlLike, aria2c: curlLike, http: curlLike, https: curlLike, xh: curlLike, xhs: curlLike,
  nc: netcat, ncat: netcat, netcat: netcat, socat: netcat, telnet: netcat,
  ftp: ftpLike, sftp: ftpLike, lftp: ftpLike, tftp: ftpLike, smbclient: ftpLike,
  ssh: sshConn, mosh: remoteDesktop, xfreerdp: remoteDesktop, vncviewer: remoteDesktop,
  systemctl, journalctl, service: (c) => (/^(?:status|--status-all)$/.test(c.seg.argv[2] ?? c.seg.argv[1] ?? "") ? add(c, "low", "read", "service_read", "service status") : add(c, "high", "process_control", "service_control", `service ${c.seg.argv.slice(1).join(" ")}`, `service ${c.seg.argv[2] ?? ""}`)),
  kill: killish, pkill: killish, killall: killish, xkill: killish,
  crontab, at: atLaunch, batch: atLaunch, atq: atLaunch, launchctl: atLaunch, "systemd-run": systemdRun,
  docker: dockerLike, podman: dockerLike, "docker-compose": dockerLike, "podman-compose": dockerLike, nerdctl: dockerLike,
  kubectl, oc: kubectl, helm: kubectl, k9s: (c) => add(c, "medium", "remote_exec", "cluster_ui", "k9s", "k9s"),
  aws: cloudCli, gcloud: cloudCli, gsutil: cloudCli, az: cloudCli, doctl: cloudCli, flyctl: cloudCli, fly: cloudCli, vercel: cloudCli, netlify: cloudCli, heroku: cloudCli, wrangler: cloudCli, terraform: cloudCli, tofu: cloudCli, pulumi: cloudCli, eksctl: cloudCli, railway: cloudCli, supabase: cloudCli, firebase: cloudCli, ansible: cloudCli, "ansible-playbook": cloudCli, vagrant: cloudCli, packer: cloudCli, rclone: cloudCli, s3cmd: cloudCli, b2: cloudCli,
  gh, glab: gh, hub: gh,
  pacman: sysPackageManager, yay: sysPackageManager, paru: sysPackageManager, makepkg: sysPackageManager, apt: sysPackageManager, "apt-get": sysPackageManager, dpkg: (c) => (c.seg.argv.some((a) => /^-(?:l|L|s|S|p|-list|-status|-search|-listfiles|-print-architecture|-print-foreign-architectures|-get-selections|-version|-compare-versions|-audit|-verify|-info|-contents)$|^-[IcW]$/.test(a)) ? add(c, "low", "read", "pm_read", "dpkg (query)") : add(c, "high", "package_install", "system_install", "dpkg changes system packages", "dpkg")), dnf: sysPackageManager, yum: sysPackageManager, zypper: sysPackageManager, apk: sysPackageManager, brew: sysPackageManager, port: sysPackageManager, snap: sysPackageManager, flatpak: sysPackageManager, "nix-env": sysPackageManager, emerge: sysPackageManager, xbps: sysPackageManager, pkg: sysPackageManager, winget: sysPackageManager, choco: sysPackageManager, scoop: sysPackageManager,
  mkfs: diskTool, "mkfs.ext4": diskTool, "mkfs.ext3": diskTool, "mkfs.ext2": diskTool, "mkfs.xfs": diskTool, "mkfs.btrfs": diskTool, "mkfs.vfat": diskTool, "mkfs.fat": diskTool, "mkfs.ntfs": diskTool, "mkfs.exfat": diskTool, "mkfs.f2fs": diskTool, mke2fs: diskTool, mkswap: diskTool, wipefs: diskTool, fdisk: diskTool, sfdisk: diskTool, cfdisk: diskTool, gdisk: diskTool, sgdisk: diskTool, parted: diskTool, blkdiscard: diskTool, cryptsetup: diskTool, zpool: diskTool, zfs: diskTool, lvremove: diskTool, vgremove: diskTool, pvremove: diskTool, lvcreate: diskTool, lvs: diskTool, vgs: diskTool, pvs: diskTool, lvdisplay: diskTool, vgdisplay: diskTool, pvdisplay: diskTool, badblocks: diskTool, hdparm: diskTool, smartctl: diskTool, e2fsck: diskTool, fsck: diskTool, tune2fs: diskTool, dumpe2fs: diskTool, resize2fs: diskTool, btrfs: diskTool, losetup: diskTool, dmsetup: diskTool, mdadm: diskTool, efibootmgr: diskTool, bootctl: diskTool, "grub-install": diskTool, "grub-mkconfig": diskTool, "update-grub": diskTool, mkinitcpio: diskTool, dracut: diskTool, "kernel-install": diskTool, "limine-update": diskTool, "limine-install": diskTool, "update-initramfs": diskTool, "nvme": (c) => (/^(?:list|smart-log|id-ctrl|id-ns|error-log|fw-log|show-regs|list-subsys)$/.test(c.seg.argv[1] ?? "") ? add(c, "low", "read", "disk_read", "nvme (read)") : add(c, "critical", "destructive_system", "disk_destroy", `nvme ${c.seg.argv[1] ?? ""} can destroy disk data`, "nvme")),
  mount: mountish, umount: mountish, swapon: mountish, swapoff: mountish, findmnt: mountish, fusermount: mountish, fusermount3: mountish, "mount.cifs": mountish, sshfs: mountish, rclone_mount: mountish,
  ip: netAdmin, iptables: netAdmin, ip6tables: netAdmin, "iptables-save": netAdmin, "iptables-restore": netAdmin, nft: netAdmin, ufw: netAdmin, "firewall-cmd": netAdmin, nmcli: netAdmin, resolvectl: netAdmin, ifconfig: netAdmin, route: netAdmin, tc: netAdmin, iw: netAdmin, iwctl: netAdmin, wg: netAdmin, "wg-quick": netAdmin, tailscale: (c) => (/^(?:status|ip|netcheck|ping|version|whois|dns|exit-node-noop)$/.test(c.seg.argv[1] ?? "status") ? add(c, "low", "read", "net_read", "tailscale status") : add(c, "high", "privilege", "net_change", `tailscale ${c.seg.argv[1]}`, "tailscale change")),
  pass: secretStore, gopass: secretStore, "secret-tool": secretStore, security: secretStore, op: secretStore, bw: secretStore, vault: secretStore, keyctl: secretStore, "kwallet-query": secretStore, gpg: secretStore, gpg2: secretStore, "ssh-keygen": secretStore, "ssh-add": secretStore, "ssh-copy-id": secretStore, "ssh-agent": secretStore, "keepassxc-cli": secretStore, age: (c) => (c.seg.argv.some((a) => /^-(?:d|-decrypt)$/.test(a)) ? add(c, "medium", "credential_read", "age_decrypt", "decrypts data", "age -d") : add(c, "low", "read", "age", "age")), sops: (c) => (c.seg.argv.some((a) => /^-(?:d|-decrypt)$|^decrypt$/.test(a)) ? add(c, "high", "credential_read", "sops_decrypt", "decrypts secrets", "sops -d") : add(c, "medium", "security_control", "sops", "sops", "sops")),
  env: envDump, printenv: envDump, export: envDump, declare: envDump, typeset: envDump, set: envDump,
  pi: piCli, claude: piCli, codex: piCli, gemini: piCli, aider: piCli, opencode: piCli, goose: piCli, "cursor-agent": piCli, amp: piCli, crush: piCli, qwen: piCli, droid: piCli,
  reboot: powerState, shutdown: powerState, poweroff: powerState, halt: powerState, init: powerState, telinit: powerState,
  useradd: accountAdmin, usermod: accountAdmin, userdel: accountAdmin, groupadd: accountAdmin, groupdel: accountAdmin, groupmod: accountAdmin, gpasswd: accountAdmin, passwd: accountAdmin, chpasswd: accountAdmin, visudo: accountAdmin, adduser: accountAdmin, deluser: accountAdmin, chsh: accountAdmin, newgrp: accountAdmin, vipw: accountAdmin,
  tar: archive, bsdtar: archive, unzip: archive, zip: archive, "7z": archive, "7za": archive, unrar: archive, gzip: archive, gunzip: archive, bzip2: archive, xz: archive, zstd: archive, unxz: archive,
  source: sourceCmd, ".": sourceCmd, eval: evalCmd,
  tmux, screen: tmux, zellij: tmux,
  history: historyCmd,
  sysctl, modprobe: kernelModules, insmod: kernelModules, rmmod: kernelModules, kmod: kernelModules,
  setenforce: selinux, getenforce: selinux, sestatus: selinux, "aa-disable": selinux, "aa-complain": selinux, "aa-enforce": selinux, apparmor_parser: selinux, "aa-status": selinux, apparmor_status: selinux, semanage: selinux, setsebool: selinux,
  chattr: chattr, setfacl: chattr, setcap: chattr,
  "sudo-shell": sudoShellMarker, "sudo-query": interactiveSudo,
  test: testCmd, "[": testCmd,
  patch: patchCmd,
  vim: editorLike, nvim: editorLike, vi: editorLike, nano: editorLike, emacs: editorLike, code: editorLike, micro: editorLike, hx: editorLike,
  "xdg-open": xdgOpen, open: xdgOpen,
  "notify-send": notifyCmd, cd: cdCmd, pushd: cdCmd, popd: cdCmd, exit: notifyCmd, return: notifyCmd, local: notifyCmd, shift: notifyCmd, unset: notifyCmd, readonly: notifyCmd, trap: notifyCmd, shopt: notifyCmd, read: notifyCmd, getopts: notifyCmd, ":": notifyCmd, true: notifyCmd, false: notifyCmd, break: notifyCmd, continue: notifyCmd, wait: notifyCmd, disown: notifyCmd, bg: notifyCmd, fg: notifyCmd, complete: notifyCmd, bind: notifyCmd, "let": notifyCmd, echo: readOnly, printf: readOnly,
  hyprctl,
  "apt-cache": (c) => add(c, "low", "read", "pm_read", "apt-cache"),
  snapper: (c) => (/^(?:list|ls|status|diff|xadiff|get-config|list-configs|--version|-h|--help)$/.test(nonFlagArgs(c.seg.argv, 1)[0] ?? "list") ? add(c, "low", "read", "snapshot_read", "snapper (read)") : add(c, "high", "privilege", "snapshot_change", `snapper ${nonFlagArgs(c.seg.argv, 1)[0]}`, `snapper ${nonFlagArgs(c.seg.argv, 1)[0]}`)),
};

// ---------------------------------------------------------------------------------------------
// Entry points

function emptyAssessment(tool: string): Assessment {
  return { tool, tier: "low", findings: [], effects: [], segments: [], summary: "", credentialReads: [], downloads: [], executes: [], chmodExec: [], sends: [], hosts: [], remotes: [], remoteChanges: 0, deletes: 0, untrusted: false };
}

function finalize(a: Assessment): Assessment {
  if (!a.findings.length) a.findings.push({ tier: "low", effect: "read", code: "noop", detail: "no effect" });
  a.tier = a.findings.reduce<Tier>((t, f) => maxTier(t, f.tier), "low");
  a.effects = [...new Set(a.findings.map((f) => f.effect))];
  return a;
}

// Post-process one segment's findings for where it runs: remote hosts and sudo.
function contextualize(seg: Segment, findings: Finding[], env: ClassifyEnv): void {
  if (!seg.remote && !seg.sudo) return;
  const known = seg.remote ? env.knownHosts.has(seg.remote) : true;
  // sudo inside `ssh host '…'` has no terminal to prompt on (the kit never adds -t), so it is
  // effectively `sudo -n`: it runs with cached or NOPASSWD rights or fails.
  const nonInteractiveSudo = !!seg.sudo && (seg.sudo.nonInteractive || !!seg.remote);
  for (const f of findings) {
    f.scope = scopeOf(seg);
    const readish = f.effect === "read" || f.effect === "network_read";
    if (seg.sudo) {
      if (f.tier === "critical") continue;
      if (readish && f.tier === "low") {
        f.tier = "medium";
        f.effect = "privilege";
        f.code = nonInteractiveSudo ? "sudo_read" : "sudo_interactive_read";
        f.detail = `as root: ${f.detail}`;
        f.key = `${prefix(seg)}${seg.argv[0] ?? ""}`;
        if (nonInteractiveSudo && known) f.autoLow = true;
      } else if (f.tier === "low" || f.tier === "medium") {
        f.tier = "high";
        f.detail = `as root: ${f.detail}`;
        f.code = `sudo_${f.code}`;
        f.key = f.key ?? `${prefix(seg)}${seg.argv[0] ?? ""}`;
      }
      if (seg.remote && !f.detail.startsWith(`on ${seg.remote}`)) f.detail = `on ${seg.remote}: ${f.detail}`;
      continue;
    }
    // Remote, not privileged.
    if (f.tier === "low") {
      f.tier = "medium";
      f.key = f.key ?? `${prefix(seg)}${seg.argv[0] ?? ""}`;
      if (readish || f.effect === "process_control" && !/kill_pid/.test(f.code) && f.code.endsWith("_read")) {
        f.code = "remote_read";
        f.effect = "read";
        f.detail = `on ${seg.remote}: ${f.detail}`;
        if (known) f.autoLow = true;
      } else {
        f.effect = f.effect === "delete" ? "delete" : "remote_exec";
        f.code = `remote_${f.code}`;
        f.detail = `on ${seg.remote}: ${f.detail}`;
      }
    } else if (!f.detail.startsWith(`on ${seg.remote}`)) f.detail = `on ${seg.remote}: ${f.detail}`;
  }
}

export function classifyShellText(command: string, env: ClassifyEnv, cwd: string | null = env.cwd, remote?: string): { findings: Finding[]; segments: SegmentView[]; a: Assessment } {
  const a = emptyAssessment("bash");
  const parsed = parseShell(command, { cwd, home: env.home, remote });
  const views: SegmentView[] = [];
  if (isForkBomb(command)) a.findings.push({ tier: "critical", effect: "destructive_system", code: "fork_bomb", detail: "fork bomb", key: "fork-bomb" });
  for (const o of parsed.opaque) a.findings.push({ tier: "medium", effect: "opaque", code: "unparsed", detail: `could not fully parse the command (${o})`, key: "unparsed" });
  for (const seg of parsed.segments) {
    const exe = basenameOf(seg.argv[0] ?? "");
    const c: Ctx = { env, seg, exe, findings: [], a };
    if (seg.remote && !env.knownHosts.has(seg.remote) && !seg.ssh) {
      // Unknown hosts get no auto-mode trust; the connection finding already says so.
    }
    try {
      classifySegment(c);
    } catch (error) {
      c.findings.push({ tier: "medium", effect: "opaque", code: "classifier_error", detail: `classifier error on ${exe}: ${error instanceof Error ? error.message : String(error)}`, key: `error ${exe}` });
    }
    contextualize(seg, c.findings, env);
    a.findings.push(...c.findings);
    if (seg.argv.length || seg.redirects.length) {
      const t = c.findings.reduce<Tier>((x, f) => maxTier(x, f.tier), "low");
      views.push({
        text: [...seg.assigns, ...seg.argv].join(" ").slice(0, 200),
        where: `${seg.remote ? `on ${seg.remote}` : "local"}${seg.sudo ? " as root" : ""}${seg.via.length ? ` via ${seg.via.join(" > ")}` : ""}`,
        tier: t,
        effects: [...new Set(c.findings.map((f) => f.effect))],
      });
    }
  }
  return { findings: a.findings, segments: views, a };
}

export function classifyCommand(command: string, env: ClassifyEnv, tool = "bash"): Assessment {
  const { a, segments } = classifyShellText(command, env);
  // Reading secret material and sending data off-host in one command is exfiltration.
  const remoteSend = a.sends.find((x) => !x.local);
  if (remoteSend && a.credentialReads.length && !a.findings.some((f) => f.code === "secret_upload")) {
    a.findings.push({ tier: "critical", effect: "network_send", code: "secret_egress", detail: `reads ${a.credentialReads[0]} and sends data to ${remoteSend.dest} in the same command`, key: `egress ${remoteSend.dest}` });
  }
  a.tool = tool;
  a.command = command;
  a.segments = segments;
  finalize(a);
  a.summary = summarize(a) || `routine: ${segments.map((s) => s.text.split(" ")[0]).filter(Boolean).slice(0, 5).join(", ")}`;
  return a;
}

// Exact adapters whose inputs this classifier understands. A namespace or a verb in an external
// tool's name is not an effect contract. This list cannot authenticate a plugin's implementation:
// loading code and granting an exact external tool rule remain operator trust decisions.
const ADAPTER_TOOLS = new Set(["bash", "powershell", "codemode", "tool_search", "write", "edit", "multiedit", "notebookedit", "apply_patch", "str_replace_editor", "create_file", "read", "view", "cat", "read_file", "read_symbol", "grep", "find", "glob", "ls", "list_directory", "search_files"]);
// pi 1.4.0 dist/core/tools/index.js (unchanged since 1.3.0), plus its bundled orchestration/discovery extensions.
// Identity is exact and case-sensitive; adapter recognition is not registration authority.
const TRUSTED_PI_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "codemode", "tool_search"]);

export type ToolRule = { decision?: "allow" | "ask" | "deny"; risk_class?: string };

function toolPolicy(a: Assessment, tool: string, rule: ToolRule | undefined, unknownDefault: "allow" | "ask" | "deny"): void {
  if (rule?.decision === "deny") a.findings.push({ tier: "critical", effect: "security_control", code: "policy_deny", detail: `policy denies ${tool}`, key: `tool ${tool}` });
  else if (rule?.decision === "ask") a.findings.push({ tier: "high", effect: "unknown_exec", code: "policy_ask", detail: `policy requires approval for ${tool}`, key: `tool ${tool}` });
  else if (!rule?.decision && (unknownDefault === "deny" || !TRUSTED_PI_TOOLS.has(tool))) {
    // Inferred effects never authorise an unidentified API, even when it carries a benign
    // command field. High requires operator authority instead of an auto-mode model verdict.
    a.findings.push({ tier: unknownDefault === "deny" ? "critical" : unknownDefault === "allow" ? "low" : "high", effect: "unknown_exec", code: unknownDefault === "deny" ? "unknown_tool_denied" : "unknown_tool", detail: `unknown tool ${tool} (policy default: ${unknownDefault})`, key: `tool ${tool}` });
  }
}

// Tool input is whatever the model sent: any object is read field by field, anything else has no fields.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Coverage, not just a plausible path: do not silently ignore extra targets or instructions.
// Legacy edits and pi 1.3's single-file batch edits are covered; other patch/multi-file forms
// still get partial path analysis but always need the operator.
function adapterCovered(tool: string, input: unknown): boolean {
  if (!isRecord(input)) return false;
  const fields = input;
  const shapes: Record<string, Record<string, string>> = {
    bash: { command: "string", timeout: "number" },
    powershell: { command: "string", timeout: "number" },
    read: { path: "string", offset: "number|string", limit: "number|string", symbol: "string", map: "boolean", bundle: "string" },
    write: { path: "string", content: "string", map: "boolean" },
    edit: { path: "string", oldText: "string", newText: "string", edits: "object", postEditVerify: "boolean" },
    grep: { path: "string", pattern: "string", glob: "string", ignoreCase: "boolean", literal: "boolean", context: "number|string", limit: "number|string", summary: "boolean", scope: "string", scopeContext: "number|string" },
    find: { path: "string", pattern: "string", limit: "number" },
    ls: { path: "string", limit: "number" },
    read_symbol: { path: "string", symbol: "string", kind: "string" },
    tool_search: { query: "string", limit: "number" },
  };
  const shape = own(shapes, tool);
  if (!shape || Object.entries(fields).some(([k, v]) => !Object.hasOwn(shape, k) || !(shape[k] ?? "").split("|").includes(typeof v))) return false;
  if (["bash", "powershell"].includes(tool)) return typeof fields.command === "string" && fields.command.trim().length > 0;
  if (tool === "tool_search") return typeof fields.query === "string";
  if (["read", "write", "edit", "read_symbol"].includes(tool) && !(typeof fields.path === "string" && fields.path.trim())) return false;
  if (fields.path !== undefined && !(typeof fields.path === "string" && fields.path.trim())) return false;
  if (fields.bundle !== undefined && fields.bundle !== "local" || fields.scope !== undefined && fields.scope !== "symbol") return false;
  for (const k of ["offset", "limit", "context", "scopeContext"]) if (typeof fields[k] === "string" && !/^[+-]?\d+$/.test(fields[k])) return false;
  if (tool === "write") return typeof fields.content === "string";
  if (tool === "edit") {
    if (fields.edits !== undefined) return fields.oldText === undefined && fields.newText === undefined && Array.isArray(fields.edits) && fields.edits.length > 0 && fields.edits.every(coveredEdit);
    return typeof fields.oldText === "string" && typeof fields.newText === "string";
  }
  if (["grep", "find"].includes(tool)) return typeof fields.pattern === "string";
  if (tool === "read_symbol") return typeof fields.symbol === "string";
  return true;
}

// The pinned readseek replacement also edits only the outer path. None of these nested
// operations can introduce another target. Unknown operation keys remain incomplete.
function coveredEdit(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).every((k) => k === "oldText" || k === "newText") && typeof value.oldText === "string" && typeof value.newText === "string") return true;
  if (Object.keys(value).length !== 1) return false;
  for (const [op, required, optional] of [
    ["set_line", ["anchor", "new_text"], []],
    ["replace_lines", ["start_anchor", "end_anchor", "new_text"], []],
    ["insert_after", ["anchor", "new_text"], []],
    ["replace", ["old_text", "new_text"], ["all", "fuzzy"]],
    ["replace_symbol", ["symbol", "new_body"], []],
  ] satisfies Array<[string, string[], string[]]>) {
    const body = value[op];
    if (isRecord(body) && required.every((k) => typeof body[k] === "string") && Object.entries(body).every(([k, v]) => required.includes(k) || optional.includes(k) && typeof v === "boolean")) return true;
  }
  return false;
}

export function needsOperator(a: Assessment): boolean {
  return a.findings.some((f) => /^(?:policy_ask|policy_ask_rule|unknown_tool|incomplete_adapter|codemode_exec)$/.test(f.code));
}

// The input fields an explicitly allowed tool may name a path in. Companion tools take more than
// one `path`: pi-lens's ast_grep_search, ast_grep_outline and lsp_diagnostics take a `paths`
// array, lens_diagnostics takes `analysisRoot`, and others a `file`, a `files` list or a
// directory to scan. Each one is checked, so an allow entry never turns a credential read
// into a routine call. Ask entries keep credential findings too, alongside mandatory approval.
// A destination field (lsp_navigation's rename_file `newFilePath`) is always assessed as a write,
// and so is every path of a `file_write` entry (ast_grep_replace, lens_diagnostic_mark), so
// persistence, git-hook and safety-control targets keep their findings and action families.
const PATH_FIELDS = ["path", "file_path", "filePath", "file", "files", "paths", "cwd", "dir", "directory", "root", "analysisRoot", "newFilePath", "scriptPath"] as const;
const WRITE_PATH_FIELDS: ReadonlySet<string> = new Set(["newFilePath"]);
function pathInputs(fields: Record<string, unknown>): Array<{ target: string; write: boolean }> {
  const out: Array<{ target: string; write: boolean }> = [];
  for (const key of PATH_FIELDS) {
    const value = Object.hasOwn(fields, key) ? fields[key] : undefined;
    const write = WRITE_PATH_FIELDS.has(key);
    const items: unknown[] = Array.isArray(value) ? value : [value];
    for (const item of items) if (typeof item === "string") out.push({ target: item, write });
  }
  return out;
}
function policyPaths(c: Ctx, fields: Record<string, unknown>, rule: ToolRule): void {
  for (const { target, write } of pathInputs(fields)) {
    if (!write) readPath(c, target);
    if (write || rule.risk_class === "file_write") writePath(c, target, write ? "moves a file to" : "edits");
  }
}
function toolSegment(tool: string, cwd: string): Segment {
  return { argv: [tool], words: [], redirects: [], assigns: [], pipeIn: false, pipeOut: false, background: false, cwd, via: [], depth: 0, unknownArgs: false, filtered: false, obfuscatedName: false, dynamicName: false, decoderInName: false, vars: {} };
}

export function classifyToolCall(tool: string, input: unknown, env: ClassifyEnv, rule: ToolRule | undefined, unknownDefault: "allow" | "ask" | "deny"): Assessment {
  const fields: Record<string, unknown> = isRecord(input) ? input : {};
  const command = typeof fields.command === "string" ? fields.command : typeof fields.cmd === "string" ? fields.cmd : typeof fields.script === "string" ? fields.script : null;
  const lname = tool;
  // An unrelated command field cannot replace the selected file/URL adapter's inputs.
  // The workflow tool's `script` is a sandboxed JavaScript workflow, not a shell command: it is gated by its policy entry.
  const fixedAdapter = (!["bash", "powershell"].includes(lname) && ADAPTER_TOOLS.has(lname)) || rule?.risk_class === "network_read" || lname === "workflow";
  const coverage: Finding[] = ADAPTER_TOOLS.has(tool) && tool !== "codemode" && !adapterCovered(tool, input)
    ? [{ tier: "high", effect: "opaque", code: "incomplete_adapter", detail: `${tool}: input is not fully covered by the reviewed adapter`, key: `tool ${tool} incomplete` }] : [];
  let a: Assessment;
  if (command !== null && !fixedAdapter) {
    a = classifyCommand(command, { ...env, cwd: typeof fields.cwd === "string" ? resolvePath(fields.cwd, env.cwd, env) ?? env.cwd : env.cwd }, tool);
    // A policy entry's path inputs are checked on top of its shell analysis, so a `command` field
    // cannot hide a write destination such as lsp_navigation's `newFilePath`.
    if ((rule?.decision === "allow" || rule?.decision === "ask") && !["bash", "powershell"].includes(lname)) {
      policyPaths({ env, seg: toolSegment(tool, env.cwd), exe: tool, findings: a.findings, a }, fields, rule);
    }
  } else {
    a = emptyAssessment(tool);
    const seg = toolSegment(tool, env.cwd);
    const c: Ctx = { env, seg, exe: tool, findings: a.findings, a };
    const p = typeof fields.path === "string" ? fields.path : typeof fields.file_path === "string" ? fields.file_path : typeof fields.filePath === "string" ? fields.filePath : null;
    if (lname === "write" || lname === "edit" || lname === "multiedit" || lname === "notebookedit" || lname === "apply_patch" || lname === "str_replace_editor" || lname === "create_file") {
      if (p) writePath(c, p, lname === "write" || lname === "create_file" ? "writes" : "edits");
      else if (typeof fields.patch === "string" || typeof fields.input === "string") {
        for (const m of String(fields.patch ?? fields.input).matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) writePath(c, (m[1] ?? "").trim(), "patches");
      }
    } else if (lname === "read" || lname === "view" || lname === "cat" || lname === "read_file" || lname === "read_symbol") {
      if (p) readPath(c, p);
      if (!a.findings.length) add(c, "low", "read", "read", `${tool} ${p ?? ""}`);
    } else if (lname === "grep" || lname === "find" || lname === "glob" || lname === "ls" || lname === "list_directory" || lname === "search_files") {
      if (p) readPath(c, p);
      const pattern: unknown = fields.pattern ?? fields.query ?? "";
      const pat = String(pattern);
      if (/PRIVATE KEY|BEGIN OPENSSH|aws_secret/i.test(pat)) add(c, "medium", "credential_read", "secret_search", "searches for secret material", `${tool} secrets`);
      if (!a.findings.length) add(c, "low", "read", "read", `${tool} ${p ?? ""}`);
    } else if (tool === "codemode") {
      add(c, "high", "code_exec", "codemode_exec", "codemode script needs operator approval; nested calls are checked independently", "tool codemode");
    } else if (tool === "tool_search") {
      add(c, "low", "read", "tool_discovery", "discovers and activates tools; does not authorise their calls");
    } else if (rule?.decision === "allow" && rule.risk_class === "network_read") {
      a.untrusted = true;
      // A web search has no fixed destination: it is recorded as an unknown one.
      const url = String(fields.url);
      noteHost(c, fields.url ? urlHost(url) : "?", "read");
      add(c, "low", "network_read", "web_read", `${tool}${fields.url ? ` ${urlHost(url)}` : ""}`);
    } else if (rule?.decision === "allow" || rule?.decision === "ask") {
      if (rule.decision === "allow") add(c, "low", rule.risk_class === "tool_discovery" || (rule.risk_class ?? "").includes("read") ? "read" : "code_exec", "policy_allow", `${tool} (${rule.risk_class ?? "allowed"})`);
      policyPaths(c, fields, rule);
    }
    a.findings.push(...coverage);
    toolPolicy(a, tool, rule, unknownDefault);
    finalize(a);
    a.segments = [{ text: `${tool}${p ? ` ${p}` : ""}`, where: "local", tier: a.tier, effects: a.effects }];
    a.summary = summarize(a) || `routine: ${tool}`;
    return a;
  }
  a.findings.push(...coverage);
  toolPolicy(a, tool, rule, unknownDefault);
  return finalize(a);
}

export function summarize(a: Assessment, auto = false): string {
  const risky = a.findings.filter((f) => f.tier !== "low" && !(auto && f.autoLow)).sort((x, y) => TIER_RANK[y.tier] - TIER_RANK[x.tier]);
  return [...new Set(risky.map((f) => f.detail))].slice(0, 3).join("; ");
}

// Auto mode's operator-chosen trust: medium findings marked autoLow count as low.
export function effectiveTier(a: Assessment, auto: boolean): Tier {
  return a.findings.reduce<Tier>((t, f) => maxTier(t, auto && f.autoLow && f.tier === "medium" ? "low" : f.tier), "low");
}

// Action families: what "this kind of action" means for session leases, learned precedents
// and the judge's precedent check. Work on a remote host or as root is grouped by where it runs
// and what it does ("srv02 as root:write_outside"), because ops commands there vary in every
// detail while the operator's decision is about the host and the kind of effect. Everything
// whose meaning depends on the exact target keeps its exact key: network sends (destination),
// history rewrites and publishes (remote), security-control, destructive, obfuscated and opaque
// actions, and the cross-action chains.
const EXACT_EFFECTS = new Set<Effect>(["network_send", "network_read", "history_rewrite", "publish", "security_control", "destructive_system", "obfuscated_exec", "opaque"]);
const EXACT_CODES = new Set(["secret_egress", "secret_upload", "download_exec", "delete_burst", "shell_over_network", "unguarded_agent", "safety_env_override", "classifier_error"]);

export function familyOf(f: Finding): string {
  const scope = f.scope ?? "local";
  if (scope !== "local" && !EXACT_EFFECTS.has(f.effect) && !EXACT_CODES.has(f.code)) return `${scope}:${f.effect}`;
  return f.key ?? f.code;
}

export function familiesOf(a: Assessment, auto: boolean): string[] {
  const keys = a.findings.filter((f) => (auto && f.autoLow ? "low" : f.tier) !== "low").map(familyOf);
  return [...new Set(keys)].sort();
}

export function signatureOf(a: Assessment, auto: boolean): string {
  return `${a.tool}|${familiesOf(a, auto).join(";")}`;
}

export function familiesFromSignature(sig: string): string[] {
  const i = sig.indexOf("|");
  return i < 0 ? [] : sig.slice(i + 1).split(";").filter(Boolean);
}

const EFFECT_PHRASE: Partial<Record<Effect, string>> = {
  read: "reads",
  workspace_write: "writes files",
  write_outside: "writes system paths",
  delete: "deletes",
  package_install: "installs packages",
  remote_exec: "runs commands",
  privilege: "runs commands",
  persistence: "changes services/startup",
  credential_read: "reads secrets",
  code_exec: "runs code",
  process_control: "controls processes",
  unknown_exec: "runs unknown programs",
};

// One line for the approval card: what "allow this kind for the session" would cover.
export function describeFamilies(families: string[]): string {
  const byScope = new Map<string, Set<string>>();
  const exact: string[] = [];
  for (const fam of families) {
    const m = /^(.+):([a-z_]+)$/.exec(fam);
    const phrase = m ? own(EFFECT_PHRASE, m[2] ?? "") : undefined;
    if (m && phrase) {
      const scope = m[1] ?? "";
      if (!byScope.has(scope)) byScope.set(scope, new Set());
      byScope.get(scope)?.add(phrase);
    } else exact.push(fam);
  }
  const parts = [...byScope].map(([scope, ph]) => `${scope.replace(/^(.+) as root$/, "root on $1").replace(/^root on local$/, "root locally")}: ${[...ph].join(", ")}`);
  return [...parts, ...exact].join("; ");
}
