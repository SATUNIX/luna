/**
 * Pre-push leak scan for a clone of the public repository.
 *
 * Every pushed branch of the public repository is public at once, so this hook checks the
 * commits a push would publish before git sends them. For each commit not already on the remote
 * it scans every added line of the commit's diff, the commit message and the author and committer
 * identities with the export's blocked-identifier rules (`lib/leak-scan.ts`, exceptions in
 * `packages/core/leak-scan-exceptions.json`), and refuses any commit that adds or changes a file
 * under a private path (`PRIVATE_PATH_PREFIXES`). Findings name the commit, file and line, never
 * the value. Exit status: 0 clean, 1 findings, 2 usage or git errors (the push is refused).
 *
 * Allowlists come from the trusted base, never from the commits being checked: the exceptions are
 * read from the remote's default branch as this clone last fetched it (`<remote>/HEAD`, else
 * `<remote>/main`), or from `--base <rev>`; with neither there are none. A pushed range that
 * changes the exceptions file together with any other file is refused, so a commit cannot add an
 * identifier and the exception that admits it in one push. An exceptions-only change passes (it
 * holds hashes and reasons, and is itself scanned) and is called out for owner review; the content
 * it admits can be pushed once it is on the default branch.
 *
 *   node packages/core/prepush-scan.ts install            # write .git/hooks/pre-push
 *   node packages/core/prepush-scan.ts hook <remote> <url> # what the hook runs (refs on stdin)
 *   node packages/core/prepush-scan.ts range [--base <rev>] [--pending-from <rev>] <rev-list args...>
 *       # scan by hand, e.g. origin/main..HEAD, with the same rules as the hook (the pull-request
 *       # job runs this). --pending-from <rev> only names, among the findings, the matches that the
 *       # exceptions committed at <rev> would admit once they reach the default branch; they still
 *       # fail, and so does an exceptions change mixed with other files.
 *
 * Pinned by `tests/prepush-scan-smoke.ts`. It is a local guard against mistakes, not a boundary:
 * `git push --no-verify` skips it, so the `leak-scan` pull-request job in `security.yml`, the
 * public CI secret scan and code-owner review of the exceptions file stay the gate.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blockedMatches, isExcepted, parseScanExceptions, SCAN_EXCEPTIONS_FILE, type ScanException } from "./lib/leak-scan.ts";

/** Paths that belong to the private sidecar and must never appear in the public repository. */
export const PRIVATE_PATH_PREFIXES: readonly string[] = ["internal/", "reviews/", "examples/engagement/"];

export interface Finding { commit: string; where: string; problem: string }

/** What one scan found: the findings, plus what the exceptions-file rule needs. */
export interface ScanResult { commits: number; findings: Finding[]; pending: Finding[]; exceptionsChanged: boolean; otherChanged: boolean }

const ZERO = /^0+$/;

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
}

function hasCommit(repo: string, oid: string): boolean {
  try { git(repo, ["cat-file", "-e", `${oid}^{commit}`]); return true; } catch { return false; }
}

/** The rev-list arguments for one pre-push stdin line, or null for a branch deletion. */
export function rangeFor(repo: string, remote: string, line: string): string[] | null {
  const [localRef, localOid, , remoteOid] = line.trim().split(/\s+/);
  if (!localRef || !localOid || remoteOid === undefined) throw new Error(`unexpected pre-push input line: ${line}`);
  if (ZERO.test(localOid)) return null;
  if (!ZERO.test(remoteOid) && hasCommit(repo, remoteOid)) return [`${remoteOid}..${localOid}`];
  // A new branch, or a remote tip this clone has not fetched: everything not on a known remote ref.
  return [localOid, "--not", `--remotes=${remote}`];
}

/** Repository-relative path from a `+++ b/<path>` header, or null for `/dev/null`. */
function newPath(header: string): string | null {
  let p = header.slice(4);
  if (p === "/dev/null") return null;
  if (p.startsWith("\"") && p.endsWith("\"")) p = p.slice(1, -1); // escapes stay: no exception can match, so it fails closed
  return p.startsWith("b/") ? p.slice(2) : p;
}

/** Added lines of a unified diff produced with -U0, by file. */
export function addedLines(patch: string): Array<{ file: string; lineNo: number; text: string }> {
  const out: Array<{ file: string; lineNo: number; text: string }> = [];
  const lines = patch.split("\n");
  let file: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("+++ ")) { file = newPath(line); continue; }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    let removed = hunk[1] === undefined ? 1 : Number(hunk[1]);
    let added = hunk[3] === undefined ? 1 : Number(hunk[3]);
    let lineNo = Number(hunk[2]);
    // Consume exactly the hunk's lines, so an added line that itself starts with "+++ " or "@@"
    // is read as content, not as a header.
    while ((removed > 0 || added > 0) && i + 1 < lines.length) {
      const body = lines[++i] ?? "";
      if (body.startsWith("\\")) continue; // "\ No newline at end of file"
      if (body.startsWith("-")) { removed--; continue; }
      if (body.startsWith("+")) { added--; if (file !== null) out.push({ file, lineNo, text: body.slice(1).replace(/\r$/, "") }); lineNo++; continue; }
      break;
    }
  }
  return out;
}

/**
 * Scan the commits that `revArgs` (rev-list arguments) selects against `exceptions` (from the
 * trusted base). A match admitted only by `pending` (exceptions a pull request adds) goes to
 * `pending` instead of `findings`.
 */
export function scanCommits(repo: string, revArgs: string[], exceptions: readonly ScanException[], pending: readonly ScanException[] = []): ScanResult {
  const shas = git(repo, ["rev-list", "--reverse", ...revArgs, "--"]).split("\n").filter(Boolean);
  const findings: Finding[] = [];
  const pendingFindings: Finding[] = [];
  let exceptionsChanged = false, otherChanged = false;
  for (const sha of shas) {
    const short = sha.slice(0, 12);
    const meta = git(repo, ["show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%B", sha]).split("\n");
    meta.forEach((text, i) => {
      if (blockedMatches(text).length) findings.push({ commit: short, where: i < 2 ? "author or committer" : `message line ${i - 1}`, problem: "blocked identifier (value redacted)" });
    });
    const parents = git(repo, ["rev-list", "--parents", "-n", "1", sha]).trim().split(" ").slice(1);
    const base = parents[0] === undefined ? ["--root", sha] : [parents[0], sha];
    const changed = git(repo, ["diff-tree", "-r", "-z", "--no-commit-id", "--name-only", "--no-renames", "--diff-filter=d", ...base]).split("\0").filter(Boolean);
    for (const file of changed) {
      if (PRIVATE_PATH_PREFIXES.some((prefix) => file.startsWith(prefix))) findings.push({ commit: short, where: file, problem: "adds or changes a private path" });
      if (file === SCAN_EXCEPTIONS_FILE) exceptionsChanged = true;
      else otherChanged = true;
    }
    const patch = git(repo, ["diff-tree", "-r", "-p", "--text", "-U0", "--no-renames", "--no-ext-diff", "--no-color", ...base]);
    for (const { file, lineNo, text } of addedLines(patch)) {
      for (const match of blockedMatches(text)) {
        if (isExcepted(exceptions, file, match, text)) continue;
        const finding = { commit: short, where: `${file}:${lineNo}`, problem: "blocked identifier (value redacted)" };
        (isExcepted(pending, file, match, text) ? pendingFindings : findings).push(finding);
      }
    }
  }
  return { commits: shas.length, findings, pending: pendingFindings, exceptionsChanged, otherChanged };
}

/** The exceptions file as committed at `rev`, or none when `rev` has no such file. */
export function exceptionsAt(repo: string, rev: string): ScanException[] {
  let text: string;
  try { text = git(repo, ["show", `${rev}:${SCAN_EXCEPTIONS_FILE}`]); } catch { return []; }
  return parseScanExceptions(text);
}

/** The trusted base for a remote: its default branch as last fetched (`<remote>/HEAD`, else `<remote>/main`), or null. */
export function trustedBase(repo: string, remote: string): string | null {
  for (const ref of [`refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/main`]) {
    try { return git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim(); } catch { /* try the next */ }
  }
  return null;
}

function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/**
 * Print a result and return the exit status. Every caller applies the same rules: a match
 * no trusted-base exception admits fails, including one admitted only by an exception the scanned
 * commits add (`pending`, named as such), and an exceptions change mixed with other files fails.
 */
export function report(result: ScanResult, base: string | null): number {
  const findings = [...result.findings, ...result.pending.map((f) => ({ ...f, problem: `${f.problem} (admitted only by an exception these commits add: land it on the default branch first, in its own owner-reviewed change)` }))];
  if (result.exceptionsChanged && result.otherChanged) {
    findings.push({ commit: "range", where: SCAN_EXCEPTIONS_FILE, problem: "changed together with other files; land new exceptions in their own owner-reviewed change first (exceptions are read from the trusted base, not the pushed commits). A release pull request stacked on its release/<tag>-exceptions pull request passes once that one is merged with a merge commit and this branch is updated from the default branch" });
  }
  console.error(`pre-push scan: exceptions read from ${base === null ? "nowhere (no trusted base: none apply)" : `trusted base ${base.slice(0, 12)}`}`);
  if (result.exceptionsChanged) console.error(`pre-push scan: the pushed commits change ${SCAN_EXCEPTIONS_FILE}; every added exception needs owner review`);
  for (const f of findings) console.error(`pre-push scan: commit ${f.commit} ${f.where}: ${f.problem}`);
  if (findings.length) {
    console.error(`pre-push scan: ${findings.length} finding(s) in ${result.commits} commit(s); push refused. Fix the commits (rewrite before pushing), or land a reviewed exception in ${SCAN_EXCEPTIONS_FILE} on the default branch first.`);
    return 1;
  }
  console.error(`pre-push scan: ${result.commits} commit(s) checked, no blocked identifiers or private paths`);
  return 0;
}

const HOOK = "#!/bin/sh\n# Installed by packages/core/prepush-scan.ts install.\nexec node \"$(git rev-parse --show-toplevel)/packages/core/prepush-scan.ts\" hook \"$@\"\n";

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Write the pre-push hook; refuses to replace a different existing hook. Returns the hook path.
 * The hook is created with an exclusive open, so a file that appears at the hook path at any
 * point before the write is never overwritten. An existing hook is read and re-moded through one
 * descriptor; anything there that cannot be read as this hook (including a dangling symlink) is
 * refused.
 */
export function installHook(cwd: string): string {
  const root = repoRoot(cwd);
  const hook = path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks/pre-push"]).trim());
  const refuse = (): Error => new Error(`${hook} already exists and is not this hook; merge it by hand`);
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(hook, "wx", 0o755);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    try {
      fd = fs.openSync(hook, "r");
    } catch (inner) {
      if (hasCode(inner, "ENOENT")) throw refuse();
      throw inner;
    }
    try {
      if (fs.readFileSync(fd, "utf8") !== HOOK) throw refuse();
      fs.fchmodSync(fd, 0o755);
    } finally {
      fs.closeSync(fd);
    }
    return hook;
  }
  try {
    fs.writeFileSync(fd, HOOK);
    fs.fchmodSync(fd, 0o755);
  } finally {
    fs.closeSync(fd);
  }
  return hook;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const cwd = process.cwd();
  if (command === "install") { console.log(`installed ${installHook(cwd)}`); return 0; }
  if (command === "hook") {
    const remote = rest[0] ?? "origin";
    const root = repoRoot(cwd);
    const revs = fs.readFileSync(0, "utf8").split("\n").filter((l) => l.trim()).map((l) => rangeFor(root, remote, l)).filter((r): r is string[] => r !== null);
    const base = trustedBase(root, remote);
    const exceptions = base === null ? [] : exceptionsAt(root, base);
    const total: ScanResult = { commits: 0, findings: [], pending: [], exceptionsChanged: false, otherChanged: false };
    for (const r of revs) {
      const res = scanCommits(root, r, exceptions);
      total.commits += res.commits; total.findings.push(...res.findings);
      total.exceptionsChanged ||= res.exceptionsChanged; total.otherChanged ||= res.otherChanged;
    }
    return report(total, base);
  }
  if (command === "range") {
    const root = repoRoot(cwd);
    let baseArg: string | null = null, pendingFrom: string | null = null;
    const args = [...rest];
    while (args[0] === "--base" || args[0] === "--pending-from") {
      const [flag, value] = [args.shift(), args.shift()];
      if (value === undefined) { console.error(`pre-push scan: ${String(flag)} needs a revision`); return 2; }
      if (flag === "--base") baseArg = value; else pendingFrom = value;
    }
    if (args.length) {
      const base = baseArg === null ? trustedBase(root, "origin") : git(root, ["rev-parse", "--verify", `${baseArg}^{commit}`]).trim();
      const exceptions = base === null ? [] : exceptionsAt(root, base);
      const pending = pendingFrom === null ? [] : exceptionsAt(root, pendingFrom);
      return report(scanCommits(root, args, exceptions, pending), base);
    }
  }
  console.error("usage: prepush-scan.ts install | hook <remote> <url> | range [--base <rev>] [--pending-from <rev>] <rev-list args...>");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) {
    console.error(`pre-push scan: ${error instanceof Error ? error.message : String(error)}; push refused`);
    process.exitCode = 2;
  }
}
