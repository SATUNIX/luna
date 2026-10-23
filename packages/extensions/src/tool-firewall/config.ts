// Firewall configuration: global mode/policy, where state lives, and what counts as a known host.
//
// ~/.pi/agent/pi-kit/firewall.json is written by the profile installer and by `/auto`:
//   { "mode": "auto" | "manual", "policy": "coding" | "pentest", "judgeModel": "provider/id",
//     "learn": true, "knownHosts": ["ms01"], "untrustedHosts": ["old-box"], "source": "profile" | "user" }
// Precedence for the mode: PI_KIT_AUTO_MODE env > a project .pi/auto-mode.json (legacy, which can
// only downgrade to manual: a repo-carried file never turns auto mode on) > firewall.json > manual. For the policy: PI_KIT_FIREWALL_PROFILE env > firewall.json > coding.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type FirewallMode = "auto" | "manual";
export type PolicyName = "coding" | "pentest";
export type FirewallConfig = {
  mode: FirewallMode;
  policy: PolicyName;
  judgeModel?: string;
  learn: boolean;
  knownHosts: string[];
  // Hosts the operator withdrew trust from (`/firewall revoke host:<name>`): removed from the known
  // set even when ~/.ssh/config names them.
  untrustedHosts: string[];
  source: "profile" | "user" | "default";
};

const DEFAULTS: FirewallConfig = { mode: "manual", policy: "coding", learn: true, knownHosts: [], untrustedHosts: [], source: "default" };

export function homeDir(): string {
  return process.env.HOME || os.homedir();
}

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homeDir(), ".pi", "agent");
}

export function kitStateDir(): string {
  return path.join(agentDir(), "pi-kit");
}

export function configPath(): string {
  return process.env.PI_KIT_FIREWALL_CONFIG?.trim() || path.join(kitStateDir(), "firewall.json");
}

export function feedbackPath(): string {
  return process.env.PI_KIT_FIREWALL_FEEDBACK?.trim() || path.join(kitStateDir(), "firewall-feedback.jsonl");
}

export function sessionsDir(): string {
  return process.env.PI_KIT_FIREWALL_SESSIONS_DIR?.trim() || path.join(kitStateDir(), "firewall-sessions");
}

// A parsed JSON object (not null, not an array). Shared by the firewall's own state readers.
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The string members of a JSON array (anything else yields an empty list).
export function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((h): h is string => typeof h === "string") : [];
}

export function readConfig(): FirewallConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const raw: Record<string, unknown> = isRecord(parsed) ? parsed : {};
    const judgeModel = typeof raw.judgeModel === "string" && raw.judgeModel.trim() ? raw.judgeModel.trim() : undefined;
    return {
      mode: raw.mode === "auto" ? "auto" : "manual",
      policy: raw.policy === "pentest" ? "pentest" : "coding",
      ...(judgeModel !== undefined ? { judgeModel } : {}),
      learn: raw.learn !== false,
      knownHosts: stringList(raw.knownHosts),
      untrustedHosts: stringList(raw.untrustedHosts),
      source: raw.source === "user" || raw.source === "profile" ? raw.source : "default",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(patch: Partial<FirewallConfig>): FirewallConfig {
  const file = configPath();
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isRecord(parsed)) current = parsed;
  } catch {
    /* new file */
  }
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return readConfig();
}

export function legacyAutoModePath(cwd: string): string {
  const dir = process.env.PI_KIT_AUTO_MODE_STATE_DIR?.trim();
  return dir ? path.join(dir, "auto-mode.json") : path.join(cwd, ".pi", "auto-mode.json");
}

export function resolveMode(cwd: string, cfg: FirewallConfig = readConfig()): { mode: FirewallMode; source: string } {
  const env = process.env.PI_KIT_AUTO_MODE?.trim();
  if (env === "1") return { mode: "auto", source: "env PI_KIT_AUTO_MODE=1" };
  if (env === "0") return { mode: "manual", source: "env PI_KIT_AUTO_MODE=0" };
  try {
    const legacy = legacyAutoModePath(cwd);
    const raw: unknown = JSON.parse(fs.readFileSync(legacy, "utf8"));
    // Downgrade only: the file lives in the (possibly untrusted) repo, while raising the mode needs
    // the terminal-gated /auto on, which records it in the global firewall.json.
    if (isRecord(raw) && raw.enabled === false) return { mode: "manual", source: legacy };
  } catch {
    /* no project override */
  }
  return { mode: cfg.mode, source: cfg.source === "default" ? "default" : configPath() };
}

export function resolvePolicy(cfg: FirewallConfig = readConfig()): { policy: PolicyName; source: string } {
  const env = process.env.PI_KIT_FIREWALL_PROFILE?.trim();
  if (env === "pentest" || env === "coding") return { policy: env, source: `env PI_KIT_FIREWALL_PROFILE=${env}` };
  return { policy: cfg.policy, source: cfg.source === "default" ? "default" : configPath() };
}

// Hosts named in ~/.ssh/config (aliases and literal HostNames, no wildcards) plus firewall.json,
// minus the hosts the operator revoked. A known host only ever lowers the tier of READ-ONLY ssh and
// `sudo -n` reads in auto mode with the coding policy (classify.ts `autoLow`); it never allows a
// write. The files are small and read on every call, so a change is seen at once.
export type KnownHosts = {
  hosts: Set<string>; // effective: (firewall.json + ssh config) minus untrusted
  fromConfig: Set<string>; // firewall.json knownHosts
  fromSsh: Set<string>; // ~/.ssh/config and its Includes
  untrusted: Set<string>; // firewall.json untrustedHosts
  sshMtime: number; // newest modification time among the ssh files read (0 when there are none)
};

export function knownHostsMeta(cfg: FirewallConfig = readConfig(), home = homeDir()): KnownHosts {
  const sshConfig = path.join(home, ".ssh", "config");
  const fromConfig = new Set<string>(cfg.knownHosts.map((h) => h.toLowerCase()));
  const untrusted = new Set<string>(cfg.untrustedHosts.map((h) => h.toLowerCase()));
  const fromSsh = new Set<string>();
  let sshMtime = 0;
  const seen = new Set<string>();
  const readSsh = (file: string, depth: number) => {
    if (depth > 3 || seen.has(file)) return;
    seen.add(file);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
      sshMtime = Math.max(sshMtime, fs.statSync(file).mtimeMs);
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      const m = /^\s*(Host|HostName|Include)\s+(.+?)\s*$/i.exec(line);
      if (!m) continue;
      const [, word = "", rest = ""] = m;
      const kind = word.toLowerCase();
      if (kind === "include") {
        for (const pat of rest.split(/\s+/)) {
          const abs = pat.startsWith("~") ? path.join(home, pat.slice(1)) : path.isAbsolute(pat) ? pat : path.join(home, ".ssh", pat);
          const dir = path.dirname(abs);
          const base = path.basename(abs);
          if (/[*?]/.test(base)) {
            const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
            try {
              for (const f of fs.readdirSync(dir)) if (re.test(f)) readSsh(path.join(dir, f), depth + 1);
            } catch {
              /* missing include dir */
            }
          } else readSsh(abs, depth + 1);
        }
        continue;
      }
      for (const h of rest.split(/\s+/)) if (h && !/[*?!]/.test(h)) fromSsh.add(h.toLowerCase());
    }
  };
  readSsh(sshConfig, 0);
  const hosts = new Set<string>([...fromConfig, ...fromSsh].filter((h) => !untrusted.has(h)));
  return { hosts, fromConfig, fromSsh, untrusted, sshMtime };
}

export function knownHosts(cfg: FirewallConfig = readConfig(), home = homeDir()): Set<string> {
  return knownHostsMeta(cfg, home).hosts;
}

// The workspace is the enclosing git repository (or the cwd outside one).
// Recomputed on every call: a repo can be created or deleted at an ancestor after the
// first lookup, so caching the result would leave a stale root (and grow per distinct cwd).
export function workspaceRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  let found = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      found = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Never treat the home directory (dotfile repos), / or a shared temp root as the workspace. A
  // stray .git in a temp root (some sandboxes create an empty /tmp/.git) would otherwise make every
  // file below it part of the workspace and scope approvals to all of it.
  if (found === homeDir() || found === "/" || tmpRoots().includes(found)) found = path.resolve(cwd);
  return found;
}

export function tmpRoots(): string[] {
  const roots = new Set<string>(["/tmp", "/var/tmp"]);
  const t = process.env.TMPDIR?.trim();
  if (t) roots.add(path.resolve(t));
  try {
    roots.add(fs.realpathSync(os.tmpdir()));
  } catch {
    roots.add(os.tmpdir());
  }
  return [...roots].map((r) => r.replace(/\/+$/, ""));
}
