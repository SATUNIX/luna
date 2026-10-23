// `export`: take a run's results out of the run directory. Everything in state.json that points
// at a file (check evidence, review, per-step summaries) is copied and hashed, together with a
// git bundle and a patch of the work, the acceptance results, usage, decisions and the resolved
// contract. Nothing is executed; the host only reads files it owns and the mirror it wrote.
import fs from "node:fs";
import path from "node:path";
import { sha256, writeJsonAtomic } from "./fsutil.ts";
import type { HostRepo } from "./hostrepo.ts";
import type { RunPaths } from "./docker.ts";

/** A state.json artefact: a run-directory-relative file worth exporting (its other fields are copied as they are). */
export interface ExportArtefact {
  readonly path: string;
}

/** The fields of state.json the export reads; each is copied as it is. */
export interface ExportState {
  readonly status?: unknown;
  readonly outcome?: unknown;
  readonly phase?: unknown;
  readonly contractDigest?: unknown;
  readonly boundaryDigest?: unknown;
  readonly acceptance?: unknown;
  readonly usage?: unknown;
  readonly limits?: unknown;
  readonly effort?: unknown;
  readonly sessions?: number | undefined;
  readonly recovery?: unknown;
  readonly ui?: unknown;
  readonly history?: unknown;
  readonly steers?: unknown;
  readonly pendingQuestions?: unknown;
  readonly reconfigurations?: unknown;
  readonly promotion?: unknown;
  readonly authorisation?: unknown;
  readonly artefacts: readonly ExportArtefact[];
  readonly setup?: { readonly base?: string | null | undefined } | null | undefined;
}

/** One exported file, hashed. */
export interface ExportedFile {
  path: string;
  sha256: string;
  bytes: number;
  refs?: string[];
  from?: string;
  to?: string;
}

export interface ExportManifest<S extends ExportState = ExportState> {
  schemaVersion: 1;
  run: string;
  template: string;
  status: S["status"];
  outcome: S["outcome"];
  phase: S["phase"];
  exportedAt: string;
  contractDigest: S["contractDigest"];
  boundaryDigest: S["boundaryDigest"];
  base: string | null;
  head: string | null;
  promotion: S["promotion"];
  artefacts: (S["artefacts"][number] & { exported: boolean })[];
  files: ExportedFile[];
  missing: string[];
}

export interface ExportOptions<S extends ExportState> {
  store: { readonly p: Pick<RunPaths, "root" | "results" | "steps" | "log"> };
  repo: Pick<HostRepo, "head" | "exportBundle" | "exportPatch">;
  /** The resolved contract; written out whole. */
  contract: { readonly run: string; readonly template: string };
  state: S;
  out: string;
  now?: () => Date;
}

const inside = (child: string, parent: string): boolean => { const r = path.relative(parent, child); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };

/** Destinations inside the run directory are refused unless they are its results/ folder: never write where a worker can read or write. */
export function checkExportTarget(out: string, p: Pick<RunPaths, "root" | "results">): string {
  const target = path.resolve(out);
  if (inside(target, p.root) && !inside(target, p.results)) throw new Error(`refusing to export into ${target}: inside the run directory but outside results/ (worker-visible or supervisor-held locations are never export targets)`);
  return target;
}

/** Export a run's results to `out`; returns the directory and the manifest written there. */
export function exportRun<S extends ExportState>({ store, repo, contract, state, out, now = () => new Date() }: ExportOptions<S>): { dir: string; manifest: ExportManifest<S> } {
  const p = store.p;
  const dir = checkExportTarget(out, p);
  fs.mkdirSync(dir, { recursive: true });
  const files: ExportedFile[] = [];
  const missing: string[] = [];
  const put = (rel: string, data: string | Buffer): void => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); files.push({ path: rel, sha256: sha256(data), bytes: Buffer.byteLength(data) }); };
  const copy = (srcRel: string, destRel: string = srcRel): void => {
    const src = path.join(p.root, srcRel);
    if (!inside(src, p.root)) { missing.push(srcRel); return; }
    try {
      // Lexically inside is not enough: a symlink in the run directory (the worker writes work/ and
      // agent-state/) could carry a file from anywhere on the host into the export.
      if (!inside(fs.realpathSync(src), fs.realpathSync(p.root))) { missing.push(srcRel); return; }
      put(destRel, fs.readFileSync(src));
    } catch { missing.push(srcRel); }
  };

  put("contract.json", `${JSON.stringify(contract, null, 2)}\n`);
  put("state.json", `${JSON.stringify(state, null, 2)}\n`);
  put("acceptance/acceptance.json", `${JSON.stringify(state.acceptance, null, 2)}\n`);
  put("usage.json", `${JSON.stringify({ usage: state.usage, limits: state.limits, effort: state.effort, sessions: state.sessions ?? 0, recovery: state.recovery, ui: state.ui ?? null }, null, 2)}\n`);
  put("decisions.json", `${JSON.stringify({ history: state.history, steers: state.steers ?? [], questions: state.pendingQuestions ?? [], reconfigurations: state.reconfigurations, recovery: state.recovery, promotion: state.promotion, authorisation: state.authorisation }, null, 2)}\n`);
  for (const a of state.artefacts) copy(a.path, path.join("evidence", a.path));
  for (const n of fs.existsSync(p.steps) ? fs.readdirSync(p.steps).sort() : []) {
    for (const f of ["summary.json", "events.jsonl"]) if (fs.existsSync(path.join(p.steps, n, f))) copy(path.join(path.basename(p.steps), n, f), path.join("steps", n, f));
  }
  try { put("supervisor.log", fs.readFileSync(p.log, "utf8").split("\n").slice(-2000).join("\n")); } catch { missing.push("supervisor.log"); }

  let head: string | null = null;
  const base = state.setup?.base ?? null;
  try {
    head = repo.head();
    const bundle = path.join(dir, "work", `${contract.run}.bundle`);
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    const refs = repo.exportBundle(bundle);
    const data = fs.readFileSync(bundle);
    files.push({ path: `work/${contract.run}.bundle`, sha256: sha256(data), bytes: data.length, refs });
    if (base && base !== head) {
      const patch = path.join(dir, "work", `${contract.run}.patch`);
      repo.exportPatch(patch, base, head);
      const pd = fs.readFileSync(patch);
      files.push({ path: `work/${contract.run}.patch`, sha256: sha256(pd), bytes: pd.length, from: base, to: head });
    }
  } catch (e) { missing.push(`work (${e instanceof Error ? e.message : String(e)})`); }

  const manifest: ExportManifest<S> = {
    schemaVersion: 1, run: contract.run, template: contract.template, status: state.status, outcome: state.outcome, phase: state.phase,
    exportedAt: now().toISOString(), contractDigest: state.contractDigest, boundaryDigest: state.boundaryDigest, base, head, promotion: state.promotion,
    artefacts: state.artefacts.map((a) => ({ ...a, exported: files.some((f) => f.path === path.join("evidence", a.path)) })),
    files, missing,
  };
  writeJsonAtomic(path.join(dir, "manifest.json"), manifest);
  return { dir, manifest };
}
