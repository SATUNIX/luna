// The host's commit ledger for one cycle: what the worker committed, computed from git, never
// from the worker's prose. The merge review treats it as authoritative (lib/review.ts), and the
// cycle loop uses uncoveredCommits to send one follow-up when report.md leaves committed work
// unnamed (lib/cycle.ts reportGaps). tests/autonomy-review-inputs-smoke.ts pins both.
import type { HostGit } from "./gitmirror.ts";

/** One commit of the cycle and the paths it changes. */
export interface LedgerCommit {
  readonly sha: string;
  readonly files: readonly string[];
}

/** Prose and logs under autonomy/: the cycle records, handoffs, proposals and the shared backlog. */
const RECORD = /^autonomy\/.+\.(?:md|txt|log|jsonl)$/;

/** True when the commit changes only record-shaped files under autonomy/. */
export function isRecordCommit(c: LedgerCommit): boolean {
  return c.files.length > 0 && c.files.every((f) => RECORD.test(f));
}

/** The commit-id prefixes (7 to 40 hex characters) named by `Item:` lines of a report. */
export function itemShas(report: string | null | undefined): string[] {
  const out: string[] = [];
  for (const line of (report ?? "").split(/\r?\n/)) {
    if (line.length > 2000 || !/^\s*(?:[-*]\s*)?(?:\*\*)?Item(?:\*\*)?\s*:/i.test(line)) continue;
    for (const m of line.matchAll(/\b[0-9a-f]{7,40}\b/gi)) out.push(m[0].toLowerCase());
  }
  return out;
}

/**
 * The short ids of commits that change more than records and that no `Item:` line names.
 * A commit that writes the report itself is exempt: it cannot name its own id.
 */
export function uncoveredCommits(report: string | null | undefined, commits: readonly LedgerCommit[], reportPath: string): string[] {
  const named = itemShas(report);
  return commits
    .filter((c) => !isRecordCommit(c) && !c.files.includes(reportPath))
    .filter((c) => !named.some((p) => c.sha.toLowerCase().startsWith(p)))
    .map((c) => c.sha.slice(0, 12));
}

/** `git log --no-merges` of `from..to` (minus anything reachable from `also`) with the changed paths of each commit. */
export function ledgerCommits(g: HostGit, from: string, to: string, also: readonly string[] = [], limit = 200): LedgerCommit[] {
  const out = g(["log", "--no-merges", "--format=%x00%H", "--name-only", "--no-renames", `--max-count=${limit}`, `${from}..${to}`, ...also.map((r) => `^${r}`)], { allowFail: true });
  if (!out) return [];
  return out.split("\0").map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
    const [sha = "", ...files] = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    return { sha, files };
  }).filter((c) => /^[0-9a-f]{40,64}$/.test(c.sha));
}
