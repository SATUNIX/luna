/**
 * Preflight dependency checks. Warns for optional deps, fails for required ones.
 */
import { spawnSync } from "node:child_process";

// The commands are fixed argument vectors. Windows needs a shell to start `.cmd` shims such as
// pi's, as execSync used one everywhere; no argument here comes from outside, so that is safe.
function check(command: readonly [string, ...string[]], name: string, required = true): boolean {
  const [bin, ...args] = command;
  const r = spawnSync(bin, args, { stdio: "pipe", shell: process.platform === "win32", windowsHide: true });
  if (!r.error && r.status === 0) return true;
  if (required) {
    console.error(`[deps] FAIL: ${name} is required but not found.`);
    process.exit(1);
  }
  console.warn(`[deps] WARN: ${name} not found — some features will be unavailable.`);
  return false;
}

export interface PreflightOptions {
  needsDocker?: boolean;
  needsPi?: boolean;
}

export function preflight({ needsDocker = false, needsPi = true }: PreflightOptions = {}): void {
  check(["node", "--version"], "node");
  check(["git", "--version"], "git");
  if (needsPi) check(["pi", "--version"], "pi");
  if (needsDocker) check(["docker", "info"], "docker", false);
}
