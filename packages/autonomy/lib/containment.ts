// A last line of defence over every `docker run` / `podman run` the supervisor executes. The
// argument builders in lib/docker.ts produce hardened arguments; this module re-checks the
// finished argument list against the boundary before it runs, so a bug or a hostile config value
// in a builder cannot start a container that is privileged, on the host network, holding the
// engine socket or the operator's home, or carrying a credential. It fails closed: a flag it
// does not know is a problem.
//
//   inspectRunArgs(args, { roots, networks, role }) -> { problems: [string], facts }
//   assertRunArgs(...)   throws an Error listing every problem
import path from "node:path";

// flag -> takes a value
const FLAGS = new Map<string, boolean>(Object.entries({
  "run": false, "-d": false, "-i": false, "-t": false, "--rm": false, "--init": false, "--read-only": false, "--no-healthcheck": false, "--privileged": false, "-P": false, "--publish-all": false,
  "--name": true, "--user": true, "-u": true, "--network": true, "--net": true, "--network-alias": true, "--mount": true, "-v": true, "--volume": true, "--env": true, "-e": true, "--env-file": true,
  "--tmpfs": true, "--cap-add": true, "--cap-drop": true, "--security-opt": true, "--pids-limit": true, "--memory": true, "-m": true, "--cpus": true, "--device": true, "--pid": true, "--ipc": true,
  "--uts": true, "--userns": true, "--cgroupns": true, "--label": true, "-l": true, "--entrypoint": true, "--volumes-from": true, "--add-host": true, "--dns": true, "--publish": true, "-p": true,
  "--expose": true, "--link": true, "--sysctl": true, "--ulimit": true, "--restart": true, "--workdir": true, "-w": true, "--platform": true, "--hostname": true, "-h": true, "--stop-timeout": true,
  "--health-cmd": true, "--shm-size": true, "--memory-swap": true, "--log-driver": true, "--cgroup-parent": true, "--runtime": true, "--oom-score-adj": true, "--group-add": true, "--pull": true,
}));

const FORBIDDEN_TARGETS = [/^\/$/, /^\/proc(\/|$)/, /^\/sys(\/|$)/, /^\/dev(\/|$)/, /^\/var\/run(\/|$)/, /^\/run\/(docker|podman)/, /^\/etc(\/|$)/, /^\/root(\/|$)/, /^\/boot(\/|$)/, /docker\.sock/, /podman\.sock/];
/** Host paths that may never be mounted into a container (and that a contract may not copy in): credential stores, the engine socket, system directories. */
export const FORBIDDEN_SOURCES = [/docker\.sock/, /podman\.sock/, /^\/$/, /^\/(proc|sys|dev|boot|etc|root|var\/run|var\/lib\/docker|var\/lib\/containers)(\/|$)/, /\/\.ssh(\/|$)/, /\/\.aws(\/|$)/, /\/\.gnupg(\/|$)/, /\/\.docker(\/|$)/, /\/\.kube(\/|$)/, /\/\.config\/(gcloud|gh|git)(\/|$)/, /\/\.(netrc|npmrc|pypirc|git-credentials)$/, /\/\.pi(\/|$)/];
const CRED_NAME = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH)/i;
const CRED_VALUE = /(sk-[A-Za-z0-9_-]{16,}|glpat-|ghp_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._~+/-]{16,})/;

// The engines read these mount keys as one setting each, and the LAST occurrence wins.
const MOUNT_KEY = new Map([["src", "source"], ["destination", "target"], ["dst", "target"], ["ro", "readonly"]]);

/**
 * The options of a --mount value, and the settings it names more than once. A null prototype, so
 * a `__proto__` key is an ordinary (and refused) option rather than a prototype assignment.
 */
function parseMount(text: string): { options: Record<string, string | true>; repeated: string[] } {
  const options = Object.create(null) as Record<string, string | true>;
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const part of text.split(",")) {
    const i = part.indexOf("=");
    const key = i < 0 ? part : part.slice(0, i);
    const setting = MOUNT_KEY.get(key) ?? key;
    if (seen.has(setting)) repeated.push(setting);
    seen.add(setting);
    options[key] = i < 0 ? true : part.slice(i + 1);
  }
  return { options, repeated };
}

/** A readonly/ro option as the engine reads it: bare, or a true value; "false" and "0" mean writable. */
const isTrue = (v: string | true | undefined): boolean => v === true || v === "true" || v === "1";

const inside = (child: string, roots: readonly string[]): boolean => roots.some((r) => child === r || child.startsWith(r.endsWith(path.sep) ? r : r + path.sep));

export interface InspectOptions {
  /** Absolute directories bind-mount sources must be inside. */
  readonly roots?: readonly string[] | undefined;
  /** The network names this container may join (`none` is always allowed). */
  readonly networks?: readonly string[] | undefined;
  readonly role?: string | undefined;
  readonly allowRoot?: boolean | undefined;
  /** Environment variable NAMES that may be passed without a value (inherited from the supervisor, for run services). */
  readonly secretEnvNames?: readonly string[] | undefined;
  readonly allowedImages?: readonly string[] | undefined;
}

export interface MountFact {
  type: string | true;
  source: string | true | undefined;
  target: string | true | undefined;
  readOnly: boolean;
}

/** What a run command would start, as read from its arguments. */
export interface RunFacts {
  role: string;
  user: string | null;
  networks: string[];
  mounts: MountFact[];
  tmpfs: string[];
  env: string[];
  caps: { drop: string[]; add: string[] };
  securityOpt: string[];
  readOnly: boolean;
  pids: number | null;
  memory: string | null;
  cpus: string | null;
  image: string | null;
  command: string[];
  privileged: boolean;
}

// --- resource limits ---------------------------------------------------------------------------------

/** An engine size ("6g", "512m", "1.5GiB", "1024"): its number and unit. */
const SIZE = /^(\d+(?:\.\d+)?) ?([kmgtp]?)i?b?$/i;
const CPUS = /^\d+(?:\.\d+)?$/;

/** A memory limit the engines enforce: a size above zero (both engines read 0 as "no limit"). */
export function isPositiveSize(value: string): boolean {
  const m = SIZE.exec(value);
  return m !== null && Number(m[1]) > 0;
}

/** A CPU limit the engines enforce: a number above zero (both engines read 0 as "no limit"). */
export const isPositiveCpus = (value: string): boolean => CPUS.test(value) && Number(value) > 0;

/**
 * Problems with the --memory and --cpus a `run` carries. Both engines read 0 as "no limit", and
 * inspectRunArgs only checks that the flags are present, so a 0 (from the contract, a service or
 * the gate's templateOptions) would start an unlimited container. Fail closed: anything that is not
 * a positive size or count is refused. The contract (contract.ts, templates/self-improve.ts) and the
 * run config (runcfg.ts) refuse the same values earlier, when they are resolved or read.
 */
export function limitProblems(facts: Pick<RunFacts, "memory" | "cpus">): string[] {
  const problems: string[] = [];
  if (facts.memory === null || !isPositiveSize(facts.memory)) problems.push(`--memory ${facts.memory ?? "(none)"} is not a positive size (0 means unlimited)`);
  if (facts.cpus === null || !isPositiveCpus(facts.cpus)) problems.push(`--cpus ${facts.cpus ?? "(none)"} is not a positive number (0 means unlimited)`);
  return problems;
}

/** Check `args`, the full argument list after the engine binary (`run ...`), against the boundary. */
export function inspectRunArgs(args: readonly string[], { roots = [], networks = [], role = "container", allowRoot = false, secretEnvNames = [] }: InspectOptions = {}): { problems: string[]; facts: RunFacts } {
  const problems: string[] = [];
  const facts: RunFacts = { role, user: null, networks: [], mounts: [], tmpfs: [], env: [], caps: { drop: [], add: [] }, securityOpt: [], readOnly: false, pids: null, memory: null, cpus: null, image: null, command: [], privileged: false };
  const bad = (msg: string): void => { problems.push(msg); };
  const normRoots = roots.map((r) => path.resolve(r));
  if (args[0] !== "run") bad(`not a run command (${args[0]})`);
  let i = 1;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!a?.startsWith("-")) break; // the image
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!FLAGS.has(name)) { bad(`unrecognised flag ${name} (fail closed)`); continue; }
    let value: string | undefined;
    if (eq > 0) value = a.slice(eq + 1);
    else if (FLAGS.get(name)) { value = args[++i]; if (value === undefined) { bad(`${name} has no value`); break; } }
    // Every flag below that reads its value takes one, so `v` is only "" for a flag that has none.
    const v = value ?? "";
    switch (name) {
      case "--privileged": facts.privileged = true; bad("--privileged"); break;
      case "--read-only": facts.readOnly = true; break;
      case "--user": case "-u": facts.user = v; break;
      case "--network": case "--net": facts.networks.push(v); break;
      case "--cap-add": facts.caps.add.push(v); bad(`--cap-add ${v}`); break;
      case "--cap-drop": facts.caps.drop.push(v); break;
      case "--security-opt": facts.securityOpt.push(v); break;
      case "--pids-limit": facts.pids = Number(v); break;
      case "--memory": case "-m": facts.memory = v; break;
      case "--cpus": facts.cpus = v; break;
      case "--device": bad(`--device ${v}`); break;
      case "--volumes-from": bad(`--volumes-from ${v}`); break;
      case "--pid": case "--ipc": case "--uts": case "--cgroupns": bad(`${name} ${v} (namespaces are never shared with the host or another container)`); break;
      case "--publish": case "-p": case "-P": case "--publish-all": bad(`${name}${value ? ` ${value}` : ""} (nothing is published to the host)`); break;
      case "--add-host": case "--dns": case "--link": case "--sysctl": case "--cgroup-parent": case "--runtime": bad(`${name} ${v}`); break;
      case "--env-file": bad("--env-file (environment is passed explicitly, never from a file)"); break;
      // No builder adds groups, and `keep-groups` or a host gid would hand the container the operator's group access.
      case "--group-add": bad(`--group-add ${v} (a container joins no extra groups)`); break;
      case "--userns": if (value !== "keep-id") bad(`--userns ${v}`); break;
      case "--env": case "-e": {
        const k = v.split("=")[0] ?? "";
        const hasValue = v.includes("=");
        facts.env.push(k);
        if (CRED_VALUE.test(v)) bad(`environment ${k} holds a credential-shaped value`);
        if (!hasValue && !secretEnvNames.includes(k)) bad(`environment ${k} is inherited from the supervisor without being declared as a secret for this container`);
        else if (hasValue && CRED_NAME.test(k) && !["AUTONOMY_KEY_SHA256", "PI_KIT_UNATTENDED_CONTRACT", "AUTONOMY_KEY_REGEX"].includes(k) && !secretEnvNames.includes(k)) bad(`environment ${k} looks like a credential (credentials never go into container environments)`);
        break;
      }
      case "--tmpfs": { const target = v.split(":")[0] ?? ""; facts.tmpfs.push(target); if (FORBIDDEN_TARGETS.some((re) => re.test(target)) && !target.startsWith("/tmp")) bad(`--tmpfs on ${target}`); break; }
      case "--mount": case "-v": case "--volume": {
        if (name !== "--mount") { bad(`${name} ${v} (use --mount so type and read-only are explicit)`); break; }
        const { options: m, repeated } = parseMount(v);
        // `source=<inside the run>,src=/elsewhere` would be checked as the first and mounted as the second.
        for (const setting of repeated) bad(`mount ${setting} is given more than once (${v})`);
        const type = m["type"] ?? "volume";
        const target = m["target"] ?? m["destination"] ?? m["dst"];
        const source = m["source"] ?? m["src"];
        facts.mounts.push({ type, source, target, readOnly: isTrue(m["readonly"]) || isTrue(m["ro"]) });
        if (type !== "bind") { bad(`--mount type=${String(type)} (only bind mounts of supervisor-created paths)`); break; }
        if (typeof source !== "string" || !source || !path.isAbsolute(source)) { bad(`mount source ${String(source)} is not an absolute path`); break; }
        const resolved = path.resolve(source);
        if (resolved !== source && path.normalize(source) !== source.replace(/\/+$/, "")) bad(`mount source ${source} is not normalised`);
        if (source.split("/").includes("..")) bad(`mount source ${source} contains ..`);
        if (FORBIDDEN_SOURCES.some((re) => re.test(resolved))) bad(`mount source ${source} is a host location a container must never see`);
        if (!inside(resolved, normRoots)) bad(`mount source ${source} is outside the run's directories`);
        if (typeof target !== "string" || !target || !target.startsWith("/") || FORBIDDEN_TARGETS.some((re) => re.test(target))) bad(`mount target ${String(target)} is not allowed`);
        for (const key of Object.keys(m)) if (!["type", "source", "src", "target", "destination", "dst", "readonly", "ro"].includes(key)) bad(`mount option ${key} is not allowed (${v})`);
        break;
      }
      case "--entrypoint": case "--label": case "-l": case "--name": case "--network-alias": case "-w": case "--workdir": case "--restart": case "--stop-timeout":
      case "--health-cmd": case "--shm-size": case "--memory-swap": case "--log-driver": case "--oom-score-adj": case "--platform": case "--hostname": case "-h": case "--expose": case "--ulimit": case "--pull": break;
      default: break;
    }
  }
  facts.image = args[i] ?? null;
  facts.command = args.slice(i + 1);
  if (!facts.image) bad("no image");
  if (!facts.readOnly) bad("missing --read-only (the root filesystem must be read-only)");
  if (!facts.caps.drop.some((c) => c.toUpperCase() === "ALL")) bad("missing --cap-drop ALL");
  if (!facts.securityOpt.includes("no-new-privileges:true") && !facts.securityOpt.includes("no-new-privileges")) bad("missing --security-opt no-new-privileges:true");
  for (const s of facts.securityOpt) if (!/^no-new-privileges(:true)?$/.test(s)) bad(`--security-opt ${s}`);
  if (facts.pids === null || !(facts.pids > 0)) bad("missing --pids-limit");
  if (!facts.memory) bad("missing --memory");
  if (!facts.cpus) bad("missing --cpus");
  if (!facts.user) bad("missing --user (a container never runs as the image default, which may be root)");
  else {
    const uid = facts.user.split(":")[0] ?? "";
    if ((uid === "0" || uid === "root" || !/^\d+$/.test(uid)) && !allowRoot) bad(`--user ${facts.user}: a container never runs as root or a named user`);
  }
  if (!facts.networks.length) bad("no --network (the default bridge is not allowed)");
  for (const n of facts.networks) {
    if (n === "none") continue;
    if (/^(host|container:|bridge$|default$|slirp4netns|pasta|ns:)/.test(n)) bad(`--network ${n}`);
    else if (!networks.includes(n)) bad(`--network ${n} is not one of this container's networks (${networks.join(", ") || "none"})`);
  }
  if (facts.networks.length > 1) bad("more than one --network at start (extra networks are attached explicitly, later)");
  return { problems, facts };
}

export function assertRunArgs(args: readonly string[], opts?: InspectOptions): RunFacts {
  const { problems, facts } = inspectRunArgs(args, opts);
  if (problems.length) throw new Error(`refusing to start ${opts?.role ?? "container"}: ${problems.join("; ")}`);
  return facts;
}
