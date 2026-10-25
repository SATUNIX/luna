// The host's view of a run's work: one bare repository (mirror.git) that only the supervisor
// writes. The worker's commits arrive only as a bundle (plain data) produced by a network-less
// container, are accepted only if they fast-forward, and every path they touch is checked
// against permissions.writeAreas before they count. The host never runs git inside a
// repository the worker can write (a planted hook or config key there would run with the
// operator's credentials). Promotion out of the mirror is fast-forward only and never forced.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import * as gm from "./gitmirror.ts";
import type { HostGit, IngestResult } from "./gitmirror.ts";
import { pathsOutsideAreas } from "./glob.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The part of the runtime configuration (lib/runcfg.ts runtimeConfig(contract)) the host repository reads. */
export interface HostRepoConfig {
  readonly run: string;
  readonly branch: string;
  readonly tagPrefix: string;
  /** Null outside self-improve (no integration branch). */
  readonly integrationBranch?: string | null | undefined;
  readonly baseRef: string;
  readonly baseSource?: string | null | undefined;
  readonly gitRemote?: string | null | undefined;
  readonly gitIdentity: { readonly name: string; readonly email: string };
}

export type PromotionResult =
  | { status: "unchanged" | "updated"; from: string | null; to: string }
  | { status: "pushed"; to: string };

export class HostRepo {
  readonly gitDir: string;
  readonly cfg: HostRepoConfig;
  /** The git runner; null until init() or open(). */
  g: HostGit | null;

  constructor({ gitDir, cfg }: { gitDir: string; cfg: HostRepoConfig }) {
    this.gitDir = gitDir;
    this.cfg = cfg;
    this.g = null;
  }

  init(): this {
    this.g = gm.initMirror(this.gitDir);
    return this;
  }

  open(): this {
    this.g = gm.hostGit(this.gitDir);
    return this;
  }

  /** The git runner, once init() or open() has run. */
  git(): HostGit {
    if (!this.g) throw new Error(`the host repository ${this.gitDir} is not open (call init() or open() first)`);
    return this.g;
  }

  identity(): string[] {
    return ["-c", `user.name=${this.cfg.gitIdentity.name}`, "-c", `user.email=${this.cfg.gitIdentity.email}`];
  }

  /**
   * The run's starting point on refs/heads/<branch>: the configured base (fetched, committed
   * history only) or, with no repository given, one empty commit. Returns the start sha.
   */
  seedBase(): string {
    const { cfg } = this;
    const g = this.git();
    let start: string;
    if (cfg.baseSource) start = gm.fetchBase(g, cfg);
    else {
      const tree = g(["hash-object", "-t", "tree", "-w", "--stdin"], { input: "" }) || EMPTY_TREE;
      start = g([...this.identity(), "commit-tree", tree, "-m", `chore: start run ${cfg.run}\n\nAn empty starting point: this run was given no repository.`]);
    }
    g(["update-ref", `refs/heads/${cfg.branch}`, start]);
    return start;
  }

  head(): string { return this.git()(["rev-parse", `refs/heads/${this.cfg.branch}`]); }

  /**
   * Take the worker's branch from a bundle. Only a fast-forward of the accepted head is
   * accepted, and only if every path it changes is inside `areas` (permissions.writeAreas):
   * otherwise the accepted head stays where it was and the offending paths are reported.
   */
  ingest(bundle: string, { areas }: { areas?: readonly string[] | null | undefined } = {}): IngestResult {
    const { cfg } = this;
    const g = this.git();
    g(["fetch", "--quiet", "--no-tags", bundle, `+refs/heads/${cfg.branch}:refs/agent/head`]);
    const agent = g(["rev-parse", "refs/agent/head"]);
    const accepted = g(["rev-parse", `refs/heads/${cfg.branch}`]);
    if (agent === accepted) return { head: accepted, moved: false, diverged: false };
    if (g(["merge-base", "--is-ancestor", accepted, agent], { allowFail: true }) === null) return { head: accepted, moved: false, diverged: true, agent };
    if (areas) {
      const outside = pathsOutsideAreas(this.changedPaths(accepted, agent), areas);
      if (outside.length) return { head: accepted, moved: false, diverged: false, agent, violation: outside };
    }
    g(["update-ref", `refs/heads/${cfg.branch}`, agent, accepted]);
    return { head: agent, moved: true, diverged: false };
  }

  /** Paths whose content differs between two commits (renames count as delete + add). */
  changedPaths(from: string | null | undefined, to: string): string[] {
    if (!from || from === to) return [];
    const out = this.git()(["diff", "--name-only", "--no-renames", "-z", from, to]);
    return out ? out.split("\0").filter(Boolean) : [];
  }

  /** Changed paths that permissions.writeAreas does not allow. */
  outsideWriteAreas(from: string | null | undefined, to: string, areas: readonly string[]): string[] { return pathsOutsideAreas(this.changedPaths(from, to), areas); }

  diffText(from: string, to: string, max = 60_000): string {
    const text = this.git()(["diff", "--no-color", "--no-ext-diff", from, to, "--", ".", ":(exclude)package-lock.json"], { allowFail: true }) ?? "";
    return text.length <= max ? text : `${text.slice(0, max / 2)}\n...[${text.length - max} characters cut]...\n${text.slice(-max / 2)}`;
  }

  /**
   * The whole diff the merge review judges (lockfiles excluded), or why it cannot be had. Never
   * clipped and never empty-on-failure: a diff over `budget` characters is `over-budget` (git's
   * output is capped at 4 bytes per character, so a huge diff is refused without being read
   * whole), and a git failure or timeout is `unreadable`. Callers reject both
   * (tests/autonomy-review-inputs-smoke.ts).
   */
  reviewDiff(from: string, to: string, budget: number): { ok: true; text: string } | { ok: false; reason: "over-budget" | "unreadable"; detail: string } {
    const read = gm.gitBounded(this.git(), ["diff", "--no-color", "--no-ext-diff", from, to, "--", ".", ":(exclude)package-lock.json"], budget * 4 + 4096);
    if (!read.ok) return { ok: false, reason: read.overflow ? "over-budget" : "unreadable", detail: read.detail };
    if (read.stdout.length > budget) return { ok: false, reason: "over-budget", detail: `${read.stdout.length} characters` };
    return { ok: true, text: read.stdout };
  }

  logSince(from: string, to: string): string { return gm.logSince(this.git(), from, to); }

  logOneline(from: string | null | undefined, to: string, n = 15): string { return this.git()(["log", `-${n}`, "--format=%h %s", from ? `${from}..${to}` : to], { allowFail: true }) ?? ""; }

  fileAt(ref: string, file: string): string | null { return gm.fileAt(this.git(), ref, file); }

  bundleBranch(out: string, extraRefs: readonly string[] = []): string { return gm.bundleBranch(this.git(), this.cfg, out, extraRefs); }

  tag(name: string, sha: string): boolean { return gm.tag(this.git(), this.cfg, name, sha); }

  /** Everything worth taking away: the work branch, the integration branch if any, the run's tags. */
  exportBundle(out: string): string[] {
    const { cfg } = this;
    const g = this.git();
    const refs = [`refs/heads/${cfg.branch}`];
    if (cfg.integrationBranch && g(["rev-parse", "--verify", "--quiet", `refs/heads/${cfg.integrationBranch}`], { allowFail: true })) refs.push(`refs/heads/${cfg.integrationBranch}`);
    const tags = g(["for-each-ref", "--format=%(refname)", `refs/tags/${cfg.tagPrefix}`], { allowFail: true });
    if (tags) refs.push(...tags.split("\n").filter(Boolean));
    g(["bundle", "create", "--quiet", out, ...refs]);
    return refs;
  }

  /** A binary-safe patch of from..to. */
  exportPatch(out: string, from: string, to: string): number {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", `--git-dir=${this.gitDir}`, "diff", "--binary", "--no-color", "--no-ext-diff", from, to], { maxBuffer: 512 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr.toString().slice(0, 300)}`);
    fs.writeFileSync(out, r.stdout);
    return r.stdout.length;
  }

  // --- promotion: fast-forward only, never forced ----------------------------------------------
  /** The sha a ref has in another repository (a local path or a URL), or null. */
  remoteRefSha(where: string, ref: string): string | null {
    const out = this.git()(["ls-remote", where, ref], { allowFail: true });
    const first = out?.split("\n")[0]?.split(/\s+/)[0];
    return first || null;
  }

  /** Fast-forward `branch` in a LOCAL repository to `sha`. */
  promoteLocal(repoPath: string, branch: string, sha: string): PromotionResult {
    const g = this.git();
    g(["update-ref", "refs/promote/head", sha]);
    const ref = `refs/heads/${branch}`;
    const before = spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" }).stdout.trim() || null;
    if (before === sha) return { status: "unchanged", from: before, to: sha };
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repoPath, "fetch", "--quiet", "--no-tags", this.gitDir, `refs/promote/head:${ref}`], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (r.status !== 0) throw new Error(`promotion to ${repoPath} ${branch} failed (only fast-forwards are made; a branch that is checked out there cannot be updated): ${r.stderr.trim().split("\n").slice(-2).join(" | ")}`);
    return { status: "updated", from: before, to: sha };
  }

  /** Push `sha` to `branch` of a remote (fast-forward only; tags of this run when asked). */
  promotePush(url: string, branch: string, sha: string, { tags = false }: { tags?: boolean | undefined } = {}): PromotionResult {
    const { cfg } = this;
    const g = this.git();
    g(["update-ref", "refs/promote/head", sha]);
    const specs = [`refs/promote/head:refs/heads/${branch}`];
    if (tags) for (const t of (g(["for-each-ref", "--format=%(refname)", `refs/tags/${cfg.tagPrefix}`], { allowFail: true }) ?? "").split("\n").filter(Boolean)) specs.push(`${t}:${t}`);
    g(["push", "--quiet", "--porcelain", url, ...specs]);
    return { status: "pushed", to: sha };
  }
}
