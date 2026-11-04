// Repository paths are derived from the immutable run contract, not persisted in state.json.
export interface BookkeepingPaths {
  handoff: string;
  proposals: string;
}

export function bookkeepingPaths(cfg: { readonly run: string; readonly integrationUpstream?: string | null | undefined }, cycle: number): BookkeepingPaths {
  return cfg.integrationUpstream
    ? { handoff: `autonomy/runs/${cfg.run}/HANDOFF.md`, proposals: `autonomy/proposals/${cfg.run}-${String(cycle).padStart(2, "0")}-<slug>.md` }
    : { handoff: "autonomy/HANDOFF.md", proposals: "autonomy/BACKLOG.md" };
}
