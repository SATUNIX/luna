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
 *   node packages/core/prepush-scan.ts install            # write .git/hooks/pre-push
 *   node packages/core/prepush-scan.ts hook <remote> <url> # what the hook runs (refs on stdin)
 *   node packages/core/prepush-scan.ts range <rev-list args...>   # scan by hand, e.g. origin/main..HEAD
 *
 * Pinned by `tests/prepush-scan-smoke.ts`. It is a local guard against mistakes, not a boundary:
 * `git push --no-verify` skips it, so the public CI secret scan and owner review stay the gate.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blockedMatches, isExcepted, readScanExceptions, SCAN_EXCEPTIONS_FILE, type ScanException } from "./lib/leak-scan.ts";

/** Paths that belong to the private sidecar and must never appear in the public repository. */
export const PRIVATE_PATH_PREFIXES: readonly string[] = ["internal/", "reviews/", "examples/engagement/"];

export interface Finding { commit: string; where: string; problem: string }

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

/** Scan the commits that `revArgs` (rev-list arguments) selects. */
export function scanCommits(repo: string, revArgs: string[], exceptions: readonly ScanException[]): { commits: number; findings: Finding[]; exceptionsChanged: boolean } {
  const shas = git(repo, ["rev-list", "--reverse", ...revArgs, "--"]).split("\n").filter(Boolean);
  const findings: Finding[] = [];
  let exceptionsChanged = false;
  for (const sha of shas) {
    const short = sha.slice(0, 12);
    const meta = git(repo, ["show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%B", sha]).split("\n");
    meta.forEach((text, i) => {
      if (blockedMatches(text).length) findings.push({ commit: short, where: i < 2 ? "author or committer" : `message line ${i - 1}`, problem: "blocked identifier (value redacted)" });
    });
    const parents = git(repo, ["rev-list", "--parents", "-n", "1", sha]).trim().split(" ").slice(1);
    const base = parents[0] === undefined ? ["--root", sha] : [parents[0], sha];
    const changed = git(repo, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--diff-filter=d", ...base]).split("\0").filter(Boolean);
    for (const file of changed) {
      if (PRIVATE_PATH_PREFIXES.some((prefix) => file.startsWith(prefix))) findings.push({ commit: short, where: file, problem: "adds or changes a private path" });
      if (file === SCAN_EXCEPTIONS_FILE) exceptionsChanged = true;
    }
    const patch = git(repo, ["diff-tree", "-r", "-p", "--text", "-U0", "--no-renames", "--no-ext-diff", "--no-color", ...base]);
    for (const { file, lineNo, text } of addedLines(patch)) {
      for (const match of blockedMatches(text)) {
        if (!isExcepted(exceptions, file, match, text)) findings.push({ commit: short, where: `${file}:${lineNo}`, problem: "blocked identifier (value redacted)" });
      }
    }
  }
  return { commits: shas.length, findings, exceptionsChanged };
}

function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

function loadExceptions(root: string): ScanException[] {
  const file = path.join(root, SCAN_EXCEPTIONS_FILE);
  return fs.existsSync(file) ? readScanExceptions(file) : [];
}

function report(result: { commits: number; findings: Finding[]; exceptionsChanged: boolean }): number {
  if (result.exceptionsChanged) console.error(`pre-push scan: the pushed commits change ${SCAN_EXCEPTIONS_FILE}; every added exception needs owner review`);
  for (const f of result.findings) console.error(`pre-push scan: commit ${f.commit} ${f.where}: ${f.problem}`);
  if (result.findings.length) {
    console.error(`pre-push scan: ${result.findings.length} finding(s) in ${result.commits} commit(s); push refused. Fix the commits (rewrite before pushing), or add a reviewed exception to ${SCAN_EXCEPTIONS_FILE}.`);
    return 1;
  }
  console.error(`pre-push scan: ${result.commits} commit(s) checked, no blocked identifiers or private paths`);
  return 0;
}

const HOOK = "#!/bin/sh\n# Installed by packages/core/prepush-scan.ts install.\nexec node \"$(git rev-parse --show-toplevel)/packages/core/prepush-scan.ts\" hook \"$@\"\n";

/** Write the pre-push hook; refuses to replace a different existing hook. Returns the hook path. */
export function installHook(cwd: string): string {
  const root = repoRoot(cwd);
  const hook = path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks/pre-push"]).trim());
  if (fs.existsSync(hook) && fs.readFileSync(hook, "utf8") !== HOOK) throw new Error(`${hook} already exists and is not this hook; merge it by hand`);
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, HOOK, { mode: 0o755 });
  fs.chmodSync(hook, 0o755);
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
    const exceptions = loadExceptions(root);
    const findings: Finding[] = [];
    let commits = 0, exceptionsChanged = false;
    for (const r of revs) { const res = scanCommits(root, r, exceptions); commits += res.commits; findings.push(...res.findings); exceptionsChanged ||= res.exceptionsChanged; }
    return report({ commits, findings, exceptionsChanged });
  }
  if (command === "range" && rest.length) { const root = repoRoot(cwd); return report(scanCommits(root, rest, loadExceptions(root))); }
  console.error("usage: prepush-scan.ts install | hook <remote> <url> | range <rev-list args...>");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) {
    console.error(`pre-push scan: ${error instanceof Error ? error.message : String(error)}; push refused`);
    process.exitCode = 2;
  }
}
