// pi-lens fetches missing linters, formatters, scanners and language servers on demand: npm
// installs of unpinned "latest" packages and GitHub release downloads, from inside the pi
// process, where the firewall never sees a tool call. That is outside the kit's pinned,
// sha512-checked supply chain (docs/supply-chain.md), so the kit turns it off unless the
// operator has set a switch to exactly "0", which turns installs back on. pi-lens disables only
// on exactly "1", so any other value ("", "true", "yes") is set to "1" rather than kept.
//
// pi-lens reads both switches when it is about to install, so setting them while the firewall
// loads covers managed tool installs and refreshes in the pinned 4.4.4. Grammar downloads
// have a separate trust gate (docs/supply-chain.md). Tools already on PATH or in
// ~/.pi-lens/tools keep working.
export const LENS_INSTALL_SWITCHES = ["PI_LENS_DISABLE_LSP_INSTALL", "PI_LENS_DISABLE_TOOL_INSTALL"] as const;

/** Sets each switch that is not exactly "0" to "1"; returns the switches it changed. */
export function disableCompanionInstalls(env: NodeJS.ProcessEnv = process.env): string[] {
  const set: string[] = [];
  for (const name of LENS_INSTALL_SWITCHES) {
    if (env[name] !== "0" && env[name] !== "1") {
      env[name] = "1";
      set.push(name);
    }
  }
  return set;
}
