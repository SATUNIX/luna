// The host's git side of the run. The host owns one bare repository, mirror.git, and never runs
// git inside a repository the agent can write to: a planted hook or config key there
// (core.hooksPath, core.fsmonitor, a credential helper) would execute on the host with the
// operator's credentials. The agent's refs reach the host only as a bundle written by a
// network-less container (lib/runtime.ts), which is plain data to `git fetch`.
//
// mirror.git holds:
//   refs/heads/<integration>   experimental/main: merged cycles, published, fast-forward only
//   refs/heads/<branch>        the current cycle's work accepted from the agent (fast-forward
//                              only within a cycle; reset to the integration head when a cycle
//                              starts). Never published.
//   refs/tags/exp/<run>/...    cycle and abandoned tags, created here, never by the agent
//   refs/base/<baseRef>        the base the run was cut from
//   refs/integration/remote    the integration branch as last fetched from gitRemote
//   refs/agent/head            the agent's branch as last fetched (may have diverged)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { publishRefspecs, type PublishConfig } from "./mirror.ts";

export interface GitRunOptions {
  /** Return null instead of throwing when git fails. */
  readonly allowFail?: boolean | undefined;
  /** Text for git's stdin. */
  readonly input?: string | undefined;
}

/** A git runner bound to one repository: stdout trimmed, or null on failure with allowFail. */
export interface HostGit {
  (args: readonly string[], opts?: GitRunOptions & { readonly allowFail?: false | undefined }): string;
  (args: readonly string[], opts: GitRunOptions): string | null;
  readonly gitDir: string;
}

/** The part of the runtime configuration (lib/runcfg.ts) the host git functions read. */
export interface MirrorConfig extends PublishConfig {
  readonly run: string;
  /** The cycle's working branch (pi/<run>). */
  readonly branch: string;
  readonly baseRef: string;
  /** A local repository path or a URL the base is fetched from; null when the run starts empty. */
  readonly baseSource?: string | null | undefined;
  /** The v0 configuration's single remote. */
  readonly gitRemote?: string | null | undefined;
  /** Where the integration branch is synchronised and published; null means nowhere. */
  readonly integrationRemote?: string | null | undefined;
  readonly gitIdentity: { readonly name: string; readonly email: string };
}

/** The most output a host git call reads (spawnSync's maxBuffer); a larger output is a failure. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 300_000;

function spawnGit(gitDir: string, args: readonly string[], { timeoutMs = GIT_TIMEOUT_MS, maxBuffer = GIT_MAX_BUFFER, input }: { timeoutMs?: number; maxBuffer?: number; input?: string | undefined } = {}) {
  return spawnSync("git", ["-c", "core.hooksPath=/dev/null", `--git-dir=${gitDir}`, ...args], {
    encoding: "utf8", timeout: timeoutMs, input, maxBuffer,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** A bounded read: git's whole stdout, or why it could not be had (output over maxBytes, or any other failure). */
export type BoundedGitRead =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly overflow: boolean; readonly detail: string };

/**
 * Run git and read at most maxBytes of output. Never returns a partial output: an output over the
 * cap is `overflow`, and a timeout, a signal or a non-zero exit is a failure with its detail. For
 * callers that must fail closed when a read is incomplete (the merge review's diff).
 */
export function gitBounded(g: HostGit, args: readonly string[], maxBytes: number, { timeoutMs = GIT_TIMEOUT_MS }: { timeoutMs?: number } = {}): BoundedGitRead {
  const r = spawnGit(g.gitDir, args, { timeoutMs, maxBuffer: maxBytes });
  const code = r.error && "code" in r.error ? r.error.code : undefined;
  if (code === "ENOBUFS") return { ok: false, overflow: true, detail: `output over ${maxBytes} bytes` };
  if (r.error) return { ok: false, overflow: false, detail: r.error.message };
  if (r.status !== 0) return { ok: false, overflow: false, detail: r.signal ? `killed by ${r.signal}` : (r.stderr.trim().split("\n").slice(-3).join(" | ") || `exit ${String(r.status)}`) };
  return { ok: true, stdout: r.stdout.trim() };
}

/** A git runner bound to one repository. Hooks are disabled for every call. */
export function hostGit(gitDir: string, { timeoutMs = GIT_TIMEOUT_MS }: { timeoutMs?: number } = {}): HostGit {
  function run(args: readonly string[], opts?: GitRunOptions & { readonly allowFail?: false | undefined }): string;
  function run(args: readonly string[], opts: GitRunOptions): string | null;
  function run(args: readonly string[], { allowFail = false, input }: GitRunOptions = {}): string | null {
    const r = spawnGit(gitDir, args, { timeoutMs, input });
    if (r.error || r.status !== 0) {
      if (allowFail) return null;
      throw new Error(`git ${args[0] ?? ""} failed: ${r.error?.message ?? r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
    }
    return r.stdout.trim();
  }
  return Object.assign(run, { gitDir });
}

export function initMirror(gitDir: string): HostGit {
  fs.mkdirSync(gitDir, { recursive: true });
  const r = spawnSync("git", ["init", "--quiet", "--bare", gitDir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  const g = hostGit(gitDir);
  for (const [k, v] of [["fetch.fsckObjects", "true"], ["transfer.fsckObjects", "true"], ["gc.auto", "0"]] as const) g(["config", k, v]);
  return g;
}

/**
 * Where the integration branch is synchronised and published: cfg.integrationRemote when the
 * config has one (null means nowhere: the branch stays in the run's own mirror), else the v0
 * cfg.gitRemote. There is no default remote.
 */
export const integrationRemote = (cfg: Pick<MirrorConfig, "integrationRemote" | "gitRemote">): string | null => (cfg.integrationRemote !== undefined ? cfg.integrationRemote : cfg.gitRemote ?? null);

/**
 * Fetch the base (a branch, a tag or HEAD) from where the work starts: cfg.baseSource (a local
 * repository path or a URL), else the v0 cfg.gitRemote. Returns its sha. Only committed history
 * is fetched, never a working tree.
 */
export function fetchBase(g: HostGit, cfg: Pick<MirrorConfig, "baseSource" | "gitRemote" | "baseRef">): string {
  const source = cfg.baseSource ?? cfg.gitRemote;
  if (!source) throw new Error("no base repository to fetch from");
  const dest = `refs/base/${cfg.baseRef}`;
  const candidates = cfg.baseRef === "HEAD" ? ["HEAD"] : [`refs/heads/${cfg.baseRef}`, `refs/tags/${cfg.baseRef}`];
  let lastError: unknown = null;
  for (const src of candidates) {
    try { g(["fetch", "--quiet", "--no-tags", source, `+${src}:${dest}`]); return g(["rev-parse", dest]); } catch (e) { lastError = e; }
  }
  throw new Error(`cannot fetch ${cfg.baseRef} from ${source}: ${lastError instanceof Error ? lastError.message : "unknown"}`);
}

/** A run id is used once: its run tags must not exist on the remote yet. */
export function remoteHasRunTags(g: HostGit, cfg: MirrorConfig): boolean {
  const remote = integrationRemote(cfg);
  if (!remote) return false;
  return Boolean(g(["ls-remote", "--tags", remote, `refs/tags/${cfg.tagPrefix}*`]));
}

const isAncestor = (g: HostGit, a: string, b: string): boolean => g(["merge-base", "--is-ancestor", a, b], { allowFail: true }) !== null;
const identity = (cfg: Pick<MirrorConfig, "gitIdentity">): string[] => ["-c", `user.name=${cfg.gitIdentity.name}`, "-c", `user.email=${cfg.gitIdentity.email}`];

/**
 * Bring the local integration branch in line with gitRemote's. Adopts the remote head when it
 * is ahead (the operator pushed fixes, or another machine ran cycles); keeps the local head when
 * it is ahead (not yet published). Returns { state: absent|same|adopted|ahead|diverged, head }.
 */
export type SyncResult =
  | { state: "absent" | "same" | "ahead"; head: string | null }
  | { state: "adopted"; head: string }
  | { state: "diverged"; head: string; remote: string };

export function syncIntegration(g: HostGit, cfg: MirrorConfig): SyncResult {
  const ref = `refs/heads/${cfg.integrationBranch}`;
  const local = g(["rev-parse", "--verify", "--quiet", ref], { allowFail: true }) || null;
  const remoteUrl = integrationRemote(cfg);
  if (!remoteUrl) return { state: local ? "same" : "absent", head: local }; // nothing to synchronise with
  if (!g(["ls-remote", "--heads", remoteUrl, ref])) return { state: local ? "ahead" : "absent", head: local };
  g(["fetch", "--quiet", "--no-tags", remoteUrl, `+${ref}:refs/integration/remote`]);
  const remote = g(["rev-parse", "refs/integration/remote"]);
  if (!local || (local !== remote && isAncestor(g, local, remote))) {
    g(["update-ref", ref, remote, local ?? ""]);
    return { state: "adopted", head: remote };
  }
  if (local === remote) return { state: "same", head: local };
  if (isAncestor(g, remote, local)) return { state: "ahead", head: local };
  return { state: "diverged", head: local, remote };
}

const fill = (text: string, vars: Readonly<Record<string, string | number>>): string => text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));

/**
 * Add the seed files under autonomy/ in one commit on `parent` (default: the base), and move the
 * integration branch to it. Built in a temporary worktree of mirror.git (host-owned). Returns
 * the seed commit sha.
 */
export interface SeedOptions {
  readonly seedDir: string;
  /** {{NAME}} placeholders in the seed files. */
  readonly vars: Readonly<Record<string, string | number>>;
  readonly tmpDir: string;
  readonly parent?: string | null | undefined;
}

export function seedBranch(g: HostGit, cfg: MirrorConfig, { seedDir, vars, tmpDir, parent }: SeedOptions): string {
  const base = g(["rev-parse", `refs/base/${cfg.baseRef}`]);
  const from = parent ?? base;
  const wt = path.join(tmpDir, `seed-${process.pid}`);
  g(["worktree", "add", "--quiet", "--detach", wt, from]);
  try {
    const wg = (args: readonly string[]): string => {
      const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...identity(cfg), "-C", wt, ...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args[0] ?? ""} (seed) failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    const dest = path.join(wt, "autonomy");
    fs.mkdirSync(path.join(dest, "cycles"), { recursive: true });
    for (const name of fs.readdirSync(seedDir)) {
      fs.writeFileSync(path.join(dest, name), fill(fs.readFileSync(path.join(seedDir, name), "utf8"), vars));
    }
    fs.writeFileSync(path.join(dest, "cycles", ".gitkeep"), "");
    wg(["add", "autonomy"]);
    wg(["commit", "--quiet", "-m", `chore(autonomy): seed ${cfg.integrationBranch}\n\nCharter, backlog and handoff for autonomous improvement runs, first used by run\n${cfg.run} and cut from ${cfg.baseRef} at ${base.slice(0, 12)}. See docs/autonomy.md.`]);
    const sha = wg(["rev-parse", "HEAD"]);
    g(["update-ref", `refs/heads/${cfg.integrationBranch}`, sha, parent ?? ""]);
    return sha;
  } finally {
    g(["worktree", "remove", "--force", wt], { allowFail: true });
    g(["worktree", "prune"], { allowFail: true });
  }
}

/**
 * Merge the base (main) into the integration branch when main has moved on, so cycles see the
 * operator's merged fixes. No worktree: `git merge-tree` computes the result, and a conflict
 * leaves the branch as it is. Returns { merged, sha?, conflict? }.
 */
export function mergeBaseIntoIntegration(g: HostGit, cfg: MirrorConfig): { merged: false; conflict?: true } | { merged: true; sha: string } {
  const ref = `refs/heads/${cfg.integrationBranch}`;
  const head = g(["rev-parse", ref]);
  const base = g(["rev-parse", `refs/base/${cfg.baseRef}`]);
  if (isAncestor(g, base, head)) return { merged: false };
  const tree = g(["merge-tree", "--write-tree", "--no-messages", head, base], { allowFail: true });
  if (tree === null) return { merged: false, conflict: true };
  const msg = `chore(autonomy): merge ${cfg.baseRef} into ${cfg.integrationBranch}\n\nBrings ${cfg.baseRef} at ${base.slice(0, 12)} into the integration branch before run ${cfg.run}.`;
  const sha = g([...identity(cfg), "commit-tree", tree.split("\n")[0] ?? "", "-p", head, "-p", base, "-m", msg]);
  g(["update-ref", ref, sha, head]);
  return { merged: true, sha };
}

/** A cycle starts from the integration head: the (local) working branch is moved there. */
export function startCycleBranch(g: HostGit, cfg: Pick<MirrorConfig, "integrationBranch" | "branch">): string {
  const head = g(["rev-parse", `refs/heads/${cfg.integrationBranch}`]);
  g(["update-ref", `refs/heads/${cfg.branch}`, head]);
  return head;
}

/** Fast-forward the integration branch to a cycle head. Refuses anything that is not a fast-forward. */
export function integrate(g: HostGit, cfg: Pick<MirrorConfig, "integrationBranch">, sha: string): { merged: false; reason: string } | { merged: true; from: string } {
  const ref = `refs/heads/${cfg.integrationBranch}`;
  const head = g(["rev-parse", ref]);
  if (head === sha) return { merged: false, reason: "nothing new" };
  if (!isAncestor(g, head, sha)) return { merged: false, reason: `not a fast-forward of ${cfg.integrationBranch}` };
  g(["update-ref", ref, sha, head]);
  return { merged: true, from: head };
}

/**
 * Take the agent's branch from a bundle. The accepted branch only moves forward: a rewritten
 * or unrelated agent branch is fetched for the record (refs/agent/head) but not accepted.
 */
export interface IngestResult {
  head: string;
  moved: boolean;
  diverged: boolean;
  agent?: string;
  /** Changed paths outside permissions.writeAreas (HostRepo.ingest). */
  violation?: string[];
}

export function ingestBundle(g: HostGit, cfg: Pick<MirrorConfig, "branch">, bundlePath: string): IngestResult {
  g(["fetch", "--quiet", "--no-tags", bundlePath, `+refs/heads/${cfg.branch}:refs/agent/head`]);
  const agent = g(["rev-parse", "refs/agent/head"]);
  const accepted = g(["rev-parse", `refs/heads/${cfg.branch}`]);
  if (agent === accepted) return { head: accepted, moved: false, diverged: false };
  if (!isAncestor(g, accepted, agent)) {
    return { head: accepted, moved: false, diverged: true, agent };
  }
  g(["update-ref", `refs/heads/${cfg.branch}`, agent, accepted]);
  return { head: agent, moved: true, diverged: false };
}

/**
 * A bundle of the working branch, for the post-cycle gate and for setting the agent side; extra
 * refs (an unmerged cycle's tag) travel with it so the agent can salvage that work.
 */
export function bundleBranch(g: HostGit, cfg: Pick<MirrorConfig, "branch">, out: string, extraRefs: readonly string[] = []): string {
  g(["bundle", "create", "--quiet", out, `refs/heads/${cfg.branch}`, ...extraRefs]);
  return out;
}

export function refsState(g: HostGit, cfg: Pick<MirrorConfig, "integrationBranch" | "tagPrefix">): string {
  return g(["for-each-ref", "--format=%(objectname) %(refname)", `refs/heads/${cfg.integrationBranch}`, `refs/tags/${cfg.tagPrefix}`]);
}

/** Push the integration branch and run tags to the operator's remote, fast-forward only. */
export function publish(g: HostGit, cfg: MirrorConfig, lastPushed: string | null | undefined): { pushed: boolean; state: string } {
  const state = refsState(g, cfg);
  const remoteUrl = integrationRemote(cfg);
  if (!remoteUrl || state === lastPushed) return { pushed: false, state };
  const specs = publishRefspecs(state, cfg);
  if (specs.length) g(["push", "--quiet", "--porcelain", remoteUrl, ...specs]);
  return { pushed: true, state };
}

/** Create a run tag at sha; an existing tag is left alone (tags are never moved). */
export function tag(g: HostGit, cfg: Pick<MirrorConfig, "tagPrefix">, name: string, sha: string): boolean {
  const ref = `refs/tags/${cfg.tagPrefix}${name}`;
  if (g(["rev-parse", "--verify", "--quiet", ref], { allowFail: true })) return false;
  g(["update-ref", ref, sha, ""]);
  return true;
}

/**
 * The manager's RESET_TO_LAST_GOOD: keep the abandoned head as a tag and move the working
 * branch back to the integration head. Local only; the working branch is never published.
 */
export function resetBranch(g: HostGit, cfg: Pick<MirrorConfig, "branch" | "integrationBranch" | "tagPrefix">, { abandonedTag }: { abandonedTag: string }): { from: string; to: string } {
  const current = g(["rev-parse", `refs/heads/${cfg.branch}`]);
  tag(g, cfg, abandonedTag, current);
  const target = startCycleBranch(g, cfg);
  return { from: current, to: target };
}

export function fileAt(g: HostGit, ref: string, file: string): string | null {
  return g(["show", `${ref}:${file}`], { allowFail: true });
}

export function logSince(g: HostGit, from: string, to: string): string {
  return g(["log", "--stat", "--format=%h %s", `${from}..${to}`], { allowFail: true }) ?? "";
}
