// Unattended mode: the consumer side of the autonomy run contract.
//
// The autonomy runner starts a worker inside a hard boundary (a container) and sets, from the
// trusted supervisor:
//   PI_KIT_UNATTENDED=1
//   PI_KIT_UNATTENDED_BOUNDARY=container                (a known boundary kind)
//   PI_KIT_UNATTENDED_CONTRACT=/run/contract.json        (a read-only, sanitised JSON copy)
//   { "schemaVersion": 1, "unattended": { "authorised": true, "autoApprove": true },
//     "boundaryDigest": "…", "permissions": { "egress": ["relay"], "remotes": ["origin"] } }
//
// Inside the zone the container is the boundary, so there are no approval prompts and no judge calls:
// low, medium and high actions run. What never runs: what is critical, hard-denied classes (security
// control, destructive system, credential exfiltration chains, the boundary itself, the contract and
// policy files) and anything that needs authority OUTSIDE the zone (network to a host that is not in the
// contract's egress list, git remotes that are not listed, publishing, cloud and cluster APIs). Those fail
// closed with a message the agent can relay. secret-guard and protected-paths are separate hooks and keep
// working.
//
// Entering the mode is deliberately narrow:
//   - ONLY from that env + contract pair. firewall.json, /auto, settings and a tool call cannot enable it:
//     the state is decided once, when the extension loads, from the process environment the supervisor
//     built, and a later change to the environment or to a file cannot switch it on;
//   - anything missing, malformed, contradictory or of an unknown boundary kind means NOT unattended, with
//     a loud warning: the normal interactive / headless rules apply (fail closed, never permissive);
//   - the contract is re-read on every call and any change to its content turns the mode off for the rest
//     of the process (it cannot be broadened by editing it);
//   - the contract must not live where the agent writes (the workspace, the working directory or the agent
//     directory) and must have a provenance a process running as this user cannot fake: it is on a
//     read-only mount (the supervisor mounts /run read-only) or it is owned by another user and this
//     process cannot write it. A file the same user created and then `chmod 0444`-ed proves nothing, so
//     it is refused, for root too;
//   - neither proof counts outside the initial user namespace: an unprivileged user can `unshare` a user
//     and mount namespace (and a PID namespace, so that its own process is PID 1 there), bind-mount a
//     file read-only and appear to own nothing. Both routes therefore need this process to be in the
//     initial user namespace (its namespace id is the kernel's fixed initial one and its uid map is the
//     identity map), where an unprivileged user cannot make a mount namespace; a read-only mount
//     counts only in PID 1's mount namespace as well, and another user's file never when the owner is
//     one of this user's subordinate ids (/etc/subuid), which the user can create files as without
//     root. A worker under a rootless engine runs in a user namespace its user made, which looks the
//     same from inside as one an agent made, so there the mode fails closed (normal rules apply).
// Children (subagents, grandchildren) are separate processes that inherit the environment, read the same
// contract and validate it themselves: a child that cannot read the contract is not unattended.
//
// What this does not stop: an actor that can run code inside the pi process itself, or root on the host,
// which can mount or own anything. The mode's protection against a forged launch from an agent shell is
// this provenance rule plus the firewall's classification of `PI_KIT_UNATTENDED*` overrides; it is a
// guard rail, and the container (not this file) is the boundary.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const KNOWN_BOUNDARIES = new Set(["container"]);
export const UNATTENDED_KEY = Symbol.for("pi-kit.unattended");
const MAX_CONTRACT_BYTES = 256 * 1024;

export type UnattendedState = {
  requested: boolean; // PI_KIT_UNATTENDED asked for it (with any value but "" / "0")
  active: boolean;
  boundary: string | null;
  autoApprove: boolean;
  label: string;
  contractPath: string | null;
  digest: string | null; // sha256 of the contract as it was when the mode was entered
  boundaryDigest: string | null; // the supervisor's own digest of the boundary, from the contract
  egress: string[]; // hosts the worker may reach: exact names or "*.suffix"
  remotes: string[]; // git remotes (names or local paths) it may fetch from and push to
  warnings: string[]; // why it is not active, or what was ignored
};

export type UnattendedPublic = { active: boolean; boundary: string | null; autoApprove: boolean; label: string };

const inactive = (over: Partial<UnattendedState> = {}): UnattendedState => ({ requested: false, active: false, boundary: null, autoApprove: false, label: "", contractPath: null, digest: null, boundaryDigest: null, egress: [], remotes: [], warnings: [], ...over });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

// A host entry of the egress list: an exact host or "*.suffix"; a port is ignored. Anything else (a bare
// "*", a URL, an empty string) is dropped and reported: fewer hosts allowed, never more.
export function normaliseEgress(raw: unknown, warnings: string[]): string[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.hosts) ? raw.hosts : raw === undefined ? [] : null;
  if (list === null) {
    warnings.push("permissions.egress is not a list of hosts: no host is allowed");
    return [];
  }
  const out: string[] = [];
  for (const item of list) {
    const h = typeof item === "string" ? item.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "") : "";
    if (/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(h)) out.push(h);
    else warnings.push(`permissions.egress entry ${JSON.stringify(item)} ignored (an exact host or *.suffix is expected)`);
  }
  return [...new Set(out)];
}

function normaliseRemotes(raw: unknown, warnings: string[]): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : null;
  if (list === null) {
    warnings.push("permissions.remotes is not a list: no git remote is allowed");
    return [];
  }
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === "string" && item.trim() && item.length <= 500 && item.trim() !== "*") out.push(item.trim());
    else warnings.push(`permissions.remotes entry ${JSON.stringify(item)} ignored`);
  }
  return [...new Set(out)];
}

// The namespaces of this process and of PID 1 (`/proc/<pid>/ns/{user,mnt}` link text, null when it
// cannot be read: PID 1 of a host belongs to root) and this process's /proc/self/uid_map.
export type NsIds = { user: string; mnt: string };
export type NamespaceFacts = { self: NsIds | null; init: NsIds | null; uidMap: string | null };

// The facts the provenance rule reads, injectable so a test can present a mount table, an owner or a
// namespace without root. Only code running inside the pi process can supply them: the environment cannot.
export type ProvenanceIo = {
  getuid?: () => number;
  mountinfo?: () => string | null;
  writable?: (file: string) => boolean;
  namespaces?: () => NamespaceFacts;
  subuid?: () => string | null;
};

// Mount points are octal-escaped in /proc/self/mountinfo (a space is \040).
const unescapeMount = (s: string): string => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

// The mount that holds `file`: the longest mount point that contains it (the last one listed wins where
// mounts are stacked). `ro` is true when the mount, or the filesystem under it, is read-only.
export function mountHolding(file: string, mountinfo: string): { point: string; ro: boolean } | null {
  let best: { point: string; ro: boolean } | null = null;
  for (const line of mountinfo.split("\n")) {
    const parts = line.split(" ");
    const dash = parts.indexOf("-");
    if (dash < 6 || parts.length < dash + 4) continue;
    const point = unescapeMount(parts[4] ?? ""); // present: dash >= 6
    if (!within(file, point)) continue;
    if (best && point.length < best.point.length) continue;
    best = { point, ro: (parts[5] ?? "").split(",").includes("ro") || (parts[dash + 3] ?? "").split(",").includes("ro") };
  }
  return best;
}

const readMountinfo = (): string | null => {
  try {
    return fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return null; // not Linux, or /proc is hidden: only the "owned by another user" route is left
  }
};

const canWrite = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const readNsIds = (pid: string): NsIds | null => {
  try {
    return { user: fs.readlinkSync(`/proc/${pid}/ns/user`), mnt: fs.readlinkSync(`/proc/${pid}/ns/mnt`) };
  } catch {
    return null;
  }
};
const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const readNamespaces = (): NamespaceFacts => ({ self: readNsIds("self"), init: readNsIds("1"), uidMap: readText("/proc/self/uid_map") });

// Where this process stands: in PID 1's user and mount namespaces ("same"), in others ("different"),
// or unknown (PID 1's cannot be read, or there is no /proc); and whether its user namespace is the
// initial one (the identity uid map; a platform without /proc/self/uid_map has no user namespaces).
// The initial user namespace has a fixed id on Linux (PROC_USER_INIT_INO); a namespace a user makes never has it.
export const INITIAL_USER_NS = "user:[4026531837]";

export function namespaceStanding(facts: NamespaceFacts, platform: string = process.platform): { kind: "same" | "different" | "unknown"; initialUser: boolean } {
  const kind = facts.self && facts.init ? (facts.self.user === facts.init.user && facts.self.mnt === facts.init.mnt ? "same" : "different") : "unknown";
  const initialUser = platform !== "linux" ? facts.uidMap === null : facts.self?.user === INITIAL_USER_NS && facts.uidMap !== null && /^\s*0\s+0\s+4294967295\s*$/.test(facts.uidMap);
  return { kind, initialUser };
}

// Is `uid` one of this user's subordinate ids (/etc/subuid: `name-or-uid:start:count`)? A user can
// create files owned by those ids without root (newuidmap), so such an owner is not "another user".
export function isSubordinateId(uid: number, subuid: string | null, self: { uid: number; name: string }): boolean {
  for (const line of (subuid ?? "").split("\n")) {
    const [who, start, count] = line.trim().split(":");
    if (!who || (who !== self.name && who !== String(self.uid))) continue;
    const from = Number(start);
    const n = Number(count);
    if (Number.isInteger(from) && Number.isInteger(n) && uid >= from && uid < from + n) return true;
  }
  return false;
}

const userName = (): string => {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
};

// Could a process running as this user have written the contract? Only a read-only mount, or a file
// another user owns and this process cannot write, is proof that it did not, and only in namespaces
// this user could not have made (see the header).
export function contractProvenance(file: string, st: { uid: number }, io: ProvenanceIo = {}): { ok: true; via: string } | { ok: false; why: string } {
  const ns = namespaceStanding((io.namespaces ?? readNamespaces)());
  if (!ns.initialUser) return { ok: false, why: `this process is not in the initial user namespace, so it may be in one this user made (with unshare, or a rootless container engine), where a read-only mount or another owner of the contract ${file} proves nothing; unattended mode needs a worker in the initial user namespace` };
  if (ns.kind === "different") return { ok: false, why: `this process is not in the user and mount namespaces of PID 1, so it may be in a namespace this user made, where a read-only mount or another owner of the contract ${file} proves nothing` };
  const info = (io.mountinfo ?? readMountinfo)();
  const held = info ? mountHolding(file, info) : null;
  if (held?.ro && ns.kind === "same") return { ok: true, via: `the read-only mount ${held.point}` };
  const uid = (io.getuid ?? (() => (typeof process.getuid === "function" ? process.getuid() : -1)))();
  if (uid !== -1 && st.uid !== uid && !(io.writable ?? canWrite)(file)) {
    if (isSubordinateId(st.uid, (io.subuid ?? (() => readText("/etc/subuid")))(), { uid, name: userName() })) return { ok: false, why: `the contract ${file} is owned by uid ${st.uid}, one of this user's subordinate ids, which this user can create files as without root` };
    return { ok: true, via: "a file owned by another user that this process cannot write" };
  }
  if (held?.ro) return { ok: false, why: `the contract ${file} is on a read-only mount, but PID 1's namespaces cannot be read to show the mount was not made in a namespace this user created (the supervisor starts the worker in the container's own namespaces)` };
  return { ok: false, why: `the contract ${file} is neither on a read-only mount nor owned by another user, so a process running as this user could have written it (the supervisor mounts /run read-only)` };
}

export type LoadOptions = { env?: NodeJS.ProcessEnv; workspace: string; cwd: string; agentDir: string; policy: string; io?: ProvenanceIo };

// Decides once whether this process is an unattended worker. Pure apart from reading the contract file.
export function evaluateUnattended(o: LoadOptions): UnattendedState {
  const env = o.env ?? process.env;
  const flag = env.PI_KIT_UNATTENDED?.trim();
  if (flag === undefined || flag === "" || flag === "0") return inactive();
  const warnings: string[] = [];
  const fail = (why: string): UnattendedState => inactive({ requested: true, warnings: [why, ...warnings], label: "UNATTENDED requested but NOT active (fail closed: normal rules apply)" });
  if (flag !== "1") return fail(`PI_KIT_UNATTENDED must be exactly "1" (got ${JSON.stringify(flag)})`);
  const boundary = env.PI_KIT_UNATTENDED_BOUNDARY?.trim() ?? "";
  if (!KNOWN_BOUNDARIES.has(boundary)) return fail(`PI_KIT_UNATTENDED_BOUNDARY ${boundary ? `is an unknown boundary kind (${JSON.stringify(boundary)}; known: ${[...KNOWN_BOUNDARIES].join(", ")})` : "is not set"}`);
  const contractEnv = env.PI_KIT_UNATTENDED_CONTRACT?.trim() ?? "";
  if (!contractEnv) return fail("PI_KIT_UNATTENDED_CONTRACT is not set");
  if (!path.isAbsolute(contractEnv)) return fail(`PI_KIT_UNATTENDED_CONTRACT must be an absolute path (got ${JSON.stringify(contractEnv)})`);
  const file = real(contractEnv);
  let bytes: Buffer;
  let owner: { uid: number };
  try {
    // One open file: the owner, the size and the bytes that are judged are those of the same file.
    const fd = fs.openSync(file, "r");
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return fail(`the contract ${file} is not a regular file`);
      if (st.size > MAX_CONTRACT_BYTES) return fail(`the contract ${file} is larger than ${MAX_CONTRACT_BYTES} bytes`);
      bytes = fs.readFileSync(fd);
      owner = { uid: st.uid };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return fail(`the contract ${file} cannot be read (${(error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error))})`);
  }
  // Where the agent writes, the file could have been forged by the agent itself.
  for (const [what, dir] of [["the workspace", o.workspace], ["the working directory", o.cwd], ["the agent directory", o.agentDir]] as const) {
    if (dir && within(file, real(dir))) return fail(`the contract ${file} is inside ${what} (${dir}), which the agent can write: a contract there proves nothing`);
  }
  // Anywhere else the same user can write, the agent could have forged it (write, then chmod 0444).
  const provenance = contractProvenance(file, owner, o.io);
  if (!provenance.ok) return fail(provenance.why);
  let contract: unknown;
  try {
    contract = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail(`the contract ${file} is not valid JSON`);
  }
  if (!isObj(contract)) return fail("the contract is not a JSON object");
  if (contract.schemaVersion !== 1) return fail(`the contract has schemaVersion ${JSON.stringify(contract.schemaVersion)} (this version reads 1)`);
  const u = contract.unattended;
  if (!isObj(u)) return fail("the contract has no unattended section");
  if (u.authorised !== true) return fail(`the contract does not authorise unattended operation (unattended.authorised is ${JSON.stringify(u.authorised)}, not true)`);
  if (u.autoApprove !== undefined && typeof u.autoApprove !== "boolean") return fail("unattended.autoApprove is not a boolean");
  if (typeof contract.boundaryDigest !== "string" || !contract.boundaryDigest.trim() || contract.boundaryDigest.length > 256) return fail("the contract has no boundaryDigest");
  // The boundary named in the contract, when it names one, must be the boundary the environment says.
  for (const named of [u.boundary, contract.boundary]) {
    if (named === undefined) continue;
    const kind = typeof named === "string" ? named : isObj(named) && typeof named.kind === "string" ? named.kind : null;
    if (kind !== boundary) return fail(`the contract names the boundary ${JSON.stringify(kind)} but PI_KIT_UNATTENDED_BOUNDARY says ${JSON.stringify(boundary)}`);
  }
  if (o.policy === "pentest") return fail("the pentest policy needs an interactive operator and cannot run unattended");
  const perms = contract.permissions === undefined ? {} : contract.permissions;
  if (!isObj(perms)) return fail("permissions is not an object");
  const egress = normaliseEgress(perms.egress ?? (isObj(perms.network) ? perms.network.egress : undefined), warnings);
  const remotes = normaliseRemotes(perms.remotes ?? (isObj(perms.git) ? perms.git.remotes : undefined), warnings);
  // writeAreas and unattended sit in the supervisor's copy for the worker's own reading (and the boundary probe).
  const known = new Set(["egress", "network", "remotes", "git", "writeAreas", "unattended"]);
  const ignored = Object.keys(perms).filter((k) => !known.has(k));
  if (ignored.length) warnings.push(`permissions keys not used by the firewall: ${ignored.slice(0, 8).join(", ")}`);
  const autoApprove = u.autoApprove === true;
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  return {
    requested: true,
    active: true,
    boundary,
    autoApprove,
    label: `UNATTENDED (${boundary}${autoApprove ? ", auto-approve" : ", no operator"})`,
    contractPath: file,
    digest,
    boundaryDigest: contract.boundaryDigest.trim(),
    egress,
    remotes,
    warnings,
  };
}

// The decided state plus the per-call re-check. Once the contract has changed (or vanished) the mode is
// off for the rest of the process.
export type Unattended = {
  state(): UnattendedState;
  // The state to decide a call by: null when the mode is not active (or a stricter policy applies).
  // `where` is the working directory and workspace of THIS call: a contract found inside them turns the mode off.
  current(policy: string, where?: { cwd: string; workspace: string }): UnattendedState | null;
  publish(): void;
};

export function createUnattended(o: LoadOptions): Unattended {
  let state = evaluateUnattended(o);
  const publish = () => {
    const pub: UnattendedPublic = { active: state.active, boundary: state.boundary, autoApprove: state.active && state.autoApprove, label: state.label };
    Object.assign(globalThis, { [UNATTENDED_KEY]: Object.freeze(pub) });
  };
  const latchOff = (why: string) => {
    state = inactive({ requested: true, warnings: [why], label: "UNATTENDED requested but NOT active (fail closed: normal rules apply)" });
    publish();
    try {
      process.stderr.write(`tool-firewall: WARNING — ${why}. Failing closed: the normal interactive/headless approval rules apply from now on.\n`);
    } catch {
      /* stderr unavailable */
    }
  };
  publish();
  return {
    state: () => state,
    current(policy: string, where?: { cwd: string; workspace: string }) {
      if (!state.active) return null;
      if (where && state.contractPath) {
        for (const [what, dir] of [["the workspace", where.workspace], ["the working directory", where.cwd]] as const) {
          if (dir && within(state.contractPath, real(dir))) {
            latchOff(`the contract ${state.contractPath} is inside ${what} (${dir}), which the agent can write: a contract there proves nothing`);
            return null;
          }
        }
      }
      try {
        const now = crypto.createHash("sha256").update(fs.readFileSync(state.contractPath as string)).digest("hex");
        if (now !== state.digest) {
          latchOff("the contract changed after the run started: unattended mode is off for the rest of this process (restart under the supervisor)");
          return null;
        }
      } catch {
        latchOff("the contract can no longer be read: unattended mode is off for the rest of this process");
        return null;
      }
      // The pentest policy needs an operator: it only ever narrows what unattended mode allows.
      return policy === "pentest" ? null : state;
    },
    publish,
  };
}

// ---- What an unattended run may not do ------------------------------------------------------------

// hard: never in an unattended run. outside: needs authority beyond the zone. operator: the policy itself says a
// person must decide (an `ask` rule, a tool the policy does not name), and nobody can.
export type Denial = { kind: "hard" | "outside" | "operator"; code: string; what: string };

const BOUNDARY_CODES = /^(?:sudo_)?(?:container_escape|docker_socket_mount|host_mount|mount_change|net_change|kernel_module|sysctl_write|attr_change|setuid|boot_config|disk_change|account_change)$/;
const CHAIN_CODES = /^(?:sudo_)?(?:secret_egress|secret_upload|shell_over_network|safety_env_override|unguarded_agent)$/;
const OUTSIDE_CODES = /^(?:sudo_)?(?:cloud_change|cloud_delete|cloud_read|cloud_secret_read|cluster_change|cluster_delete|cluster_read|cluster_ui|cluster_secret_read|kubeconfig_raw|remote_session|container_push|container_compose_push|container_login|container_logout|container_trust|package_credentials|gh_read|gh_write|gh_delete|gh_destructive|gh_secret|gh_key|git_send|package_publish)$/;

const NEEDS_OPERATOR_CODES = /^(?:sudo_)?(?:policy_ask|policy_ask_rule|unknown_tool|incomplete_adapter|codemode_exec)$/;

const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|[\w.-]+\.localhost)$/i;

export function hostAllowed(host: string, egress: string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || h.includes("?") || h.includes("$")) return false;
  if (LOOPBACK.test(h)) return true;
  return egress.some((e) => (e.startsWith("*.") ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e));
}

// The host of a remote given as a URL or scp-style address, or null for a name or a local path.
export function remoteHost(remote: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(remote) ?? /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)(?!\d+(?:\/|$))/.exec(remote);
  const host = m?.[1];
  if (host === undefined) return null;
  return host.toLowerCase();
}

const isLocalPath = (r: string) => /^(?:\/|\.{1,2}\/|~\/|file:\/\/)/.test(r);

// `remote.<name>.url` and `pushurl` from the repository's own config, so a remote that was retargeted
// at a host outside the contract is caught even though its name is listed. Best effort: includes and
// url.<base>.insteadOf are not followed (the container's network policy is the hard stop).
export function configuredRemoteUrls(workspace: string, name: string): string[] {
  try {
    const text = fs.readFileSync(path.join(workspace, ".git", "config"), "utf8");
    const out: string[] = [];
    let inRemote = false;
    for (const line of text.split("\n")) {
      const sec = /^\s*\[([^\]]+)\]/.exec(line);
      if (sec) {
        inRemote = new RegExp(`^remote\\s+"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"$`).test((sec[1] ?? "").trim());
        continue;
      }
      const kv = /^\s*(url|pushurl)\s*=\s*(.+?)\s*$/i.exec(line);
      const url = kv?.[2];
      if (inRemote && url !== undefined) out.push(url);
    }
    return out;
  } catch {
    return [];
  }
}

// The reasons an action may not run in an unattended run, or null when it may. Hard classes come first.
export function unattendedDenial(a: { findings: { tier: string; effect: string; code: string; detail: string }[]; hosts?: { host: string; how: string; via: string }[]; remotes?: { name: string; op: string }[]; remoteChanges?: number }, u: UnattendedState, workspace: string): Denial | null {
  for (const f of a.findings) {
    if (f.tier === "low") continue;
    if (f.effect === "destructive_system") return { kind: "hard", code: f.code, what: f.detail };
    if ((f.effect === "security_control" || /^(?:sudo_)?security_control_/.test(f.code)) && (f.tier === "high" || f.tier === "critical")) return { kind: "hard", code: f.code, what: f.detail };
    if (CHAIN_CODES.test(f.code)) return { kind: "hard", code: f.code, what: f.detail };
    if (BOUNDARY_CODES.test(f.code)) return { kind: "hard", code: f.code, what: `${f.detail} (it reaches for the boundary itself)` };
  }
  for (const f of a.findings) {
    if (OUTSIDE_CODES.test(f.code)) return { kind: "outside", code: f.code, what: `${f.detail} (publishing, cloud and cluster APIs are outside the zone)` };
  }
  for (const f of a.findings) {
    if (NEEDS_OPERATOR_CODES.test(f.code)) return { kind: "operator", code: f.code, what: f.detail };
  }
  for (const h of a.hosts ?? []) {
    if (!hostAllowed(h.host, u.egress)) return { kind: "outside", code: "egress", what: `${h.how === "send" ? "sends data to" : h.how === "read" ? "fetches from" : "connects to"} ${h.host === "?" ? "a destination that cannot be determined" : h.host}, which is not in this run's egress allowlist` };
  }
  for (const r of a.remotes ?? []) {
    const host = remoteHost(r.name);
    const listed = u.remotes.includes(r.name);
    if (a.remoteChanges) return { kind: "outside", code: "remote_retarget", what: `${r.op}es ${r.name} in the same command that changes git remotes, so the destination cannot be verified` };
    if (host !== null) {
      if (!hostAllowed(host, u.egress) && !listed) return { kind: "outside", code: "remote", what: `${r.op}es ${r.name}, whose host ${host} is not in this run's egress allowlist or git remotes` };
      continue;
    }
    if (!listed) return { kind: "outside", code: "remote", what: `${r.op}es the git remote ${r.name}, which is not in this run's allowed git remotes` };
    // A listed name must still point where the contract allows.
    for (const url of isLocalPath(r.name) ? [] : configuredRemoteUrls(workspace, r.name)) {
      const uh = remoteHost(url);
      if (uh !== null && !hostAllowed(uh, u.egress) && !u.remotes.includes(url)) return { kind: "outside", code: "remote", what: `${r.op}es ${r.name}, which is configured to reach ${uh}, not in this run's egress allowlist` };
    }
  }
  return null;
}
