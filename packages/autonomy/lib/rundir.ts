// Creating a run directory: the supervisor-held files a run is made of. Called once by `start`;
// nothing here is ever writable from a worker container.
//
//   contract.json   the resolved contract (read-only file mode); its hash is checked every tick
//   state.json      the authoritative record (lib/lifecycle.ts)
//   checks.json     the acceptance check definitions, mounted read-only into gate containers
//   overlay/        held-out acceptance files copied from the operator's paths, mounted read-only
//   public/         what the worker may read (mounted read-only at /run): the sanitised contract, the spec
import fs from "node:fs";
import path from "node:path";
import { type EffortChoice, type RunContract, isStoredContract, workerContract, contractDigest } from "./contract.ts";
import type { EffortApi } from "./effort.ts";
import { type RunAuthorisation, type RunState, newState } from "./lifecycle.ts";
import { renderBoundary } from "./boundary.ts";
import { sha256, writeJsonAtomic } from "./fsutil.ts";
import { RunStore } from "./store.ts";
import { parseJson } from "../../core/lib/guard.ts";
import { backlogLines } from "./templates/common.ts";

export interface CreateRunOptions {
  contract: RunContract;
  authorisation: RunAuthorisation;
  home?: string | undefined;
  /** The effort the run starts at (default: the contract's). */
  effort?: EffortChoice | undefined;
  now?: () => Date;
  /** The effort API renderBoundary labels tiers with. */
  boundaryEffort?: EffortApi | null | undefined;
}

export function createRun({ contract, authorisation, home, effort, now = () => new Date(), boundaryEffort }: CreateRunOptions): RunStore {
  const store = new RunStore(contract.run, { home, now });
  if (fs.existsSync(store.p.state)) throw new Error(`run ${contract.run} already exists at ${store.p.root}; use \`resume\`, or choose another run id`);
  const p = store.p;
  for (const d of [p.root, p.control, p.public, p.overlay, p.steps, p.meter, p.bundles, p.gateWork, p.tmp, p.egress, p.deploy, p.results, p.references, p.work, p.agentState]) fs.mkdirSync(d, { recursive: true });
  // The overlay is snapshotted into the run directory, so the check definitions and held-out files a run
  // is judged by cannot change under it, and the operator's originals are never mounted.
  const overlay = contract.acceptance.overlay.map((o) => {
    const dest = path.join(p.overlay, o.target);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(o.source, dest);
    return { ...o, snapshot: dest, sha256: sha256(fs.readFileSync(dest)) };
  });
  const resolved: RunContract = { ...contract, acceptance: { ...contract.acceptance, overlay: overlay.map(({ snapshot: _snapshot, ...o }) => o) } };
  writeJsonAtomic(p.contract, resolved, { mode: 0o444 });
  writeJsonAtomic(p.checks, { schemaVersion: 1, run: contract.run, checks: contract.acceptance.checks }, { mode: 0o444 });
  const b = renderBoundary(resolved, { effort: boundaryEffort });
  writeJsonAtomic(path.join(p.public, "contract.json"), workerContract(contract, { boundaryDigest: b.digest }), { mode: 0o444 });
  fs.writeFileSync(path.join(p.public, "spec.md"), `# ${contract.objective.title}\n\n${contract.objective.spec}\n${contract.objective.backlog.length ? `\n## Backlog\n\n${backlogLines(contract, []).join("\n")}\n` : ""}`, { mode: 0o444 });
  const state = newState({ contract: resolved, contractDigest: contractDigest(resolved), boundaryDigest: b.digest, authorisation, effort: effort ?? contract.effort, now: now().toISOString() });
  store.writeState(state);
  store.log(`run ${contract.run} created (template ${contract.template}); boundary ${b.digest.slice(0, 12)} authorised ${authorisation.via}${authorisation.by ? ` by ${authorisation.by}` : ""}`);
  return store;
}

/** loadRunContract's result: `intact` is false when contract.json no longer matches the digest in state. */
export interface LoadedContract {
  contract: RunContract;
  digest: string;
  intact: boolean;
}

/** The contract as the run holds it, with its hash checked against the digest recorded in state. */
export function loadRunContract(store: RunStore, state: Pick<RunState, "contractDigest">): LoadedContract {
  const text = fs.readFileSync(store.p.contract, "utf8");
  const contract = parseJson(text);
  if (!isStoredContract(contract)) throw new Error(`${store.p.contract} is not a run contract`);
  const digest = contractDigest(contract);
  return { contract, digest, intact: digest === state.contractDigest };
}
