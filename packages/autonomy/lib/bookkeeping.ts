// Repository paths are derived from the immutable run contract, not persisted in state.json.
// Only proposals are still written to the repository: a cycle's report, plan, verification, review,
// handoff and journal line are the host's receipt and the worker's note in the run state home
// (lib/receipt.ts), not files on the product branch.
export interface BookkeepingPaths {
  proposals: string;
}

export function bookkeepingPaths(cfg: { readonly run: string; readonly integrationUpstream?: string | null | undefined }, cycle: number): BookkeepingPaths {
  return cfg.integrationUpstream
    ? { proposals: `autonomy/proposals/${cfg.run}-${String(cycle).padStart(2, "0")}-<slug>.md` }
    : { proposals: "autonomy/BACKLOG.md" };
}
