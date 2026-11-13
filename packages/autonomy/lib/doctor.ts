// `pi-autonomy doctor --setup`: what this host can and cannot do for an unattended run, before one
// is started. Every fact comes from the container engine's own answers or the environment; nothing
// here changes anything, and the inference key is only ever reported as present or absent.
import { engineIsRootless } from "./docker.ts";
import { isRecord, parseJson } from "../../core/lib/guard.ts";

/** One engine invocation: its exit code and standard output. Injected so the report is testable offline. */
export type EngineCli = (engine: string, args: readonly string[]) => { code: number; stdout: string; stderr?: string };

export type SetupStatus = "ok" | "warn" | "fail";
export interface SetupFinding { id: string; status: SetupStatus; detail: string }

export interface SetupInput {
  engine: "podman" | "docker";
  image: string;
  /** This kit's version, as the image's `pi-autonomy.kit-ref` label would name it (`v<version>`). */
  kitVersion: string;
  /** The run asks for unattended operation (permissions.unattended.authorised); false when there is no contract. */
  unattendedRequested: boolean;
  /** Whether the provider key resolves (providerKey did not throw). Never the key itself. */
  keyPresent: boolean | null;
  cli: EngineCli;
}

export interface SetupReport {
  ok: boolean;
  engine: string;
  rootless: boolean | null;
  /** True only when the firewall's unattended mode can activate: an engine that is not rootless. */
  unattendedEnforced: boolean | null;
  findings: SetupFinding[];
}

const json = (text: string): unknown => { try { return parseJson(text); } catch { return null; } };

/**
 * Whether unattended mode is enforced on an engine. The tool firewall activates it only when the
 * worker sees the contract from the initial user namespace (packages/extensions/src/tool-firewall/
 * unattended.ts), and a worker under a rootless engine (the default rootless Podman) is in a user
 * namespace its user made. So: enforced on a rootful engine, not enforced on a rootless one.
 */
export const unattendedEnforcedOn = (rootless: boolean): boolean => !rootless;

/** The one line `plan` and `doctor --setup` both show about unattended operation on this engine. */
export function unattendedLine(rootless: boolean | null): string {
  if (rootless === null) return "unattended: unknown (the container engine did not answer; run `pi-autonomy doctor --setup`)";
  return unattendedEnforcedOn(rootless)
    ? "unattended: enforced (the engine is not rootless, so the firewall's unattended mode can activate)"
    : "unattended: NOT enforced on this engine (rootless: the worker runs under the normal headless rules, and an approval it needs fails or blocks the run; use a rootful engine for unattended mode)";
}

/** `info` of the engine, or null when it cannot be read. */
export function engineInfo(cli: EngineCli, engine: string): unknown {
  return engineInfoResult(cli, engine).info;
}

/** `info` of the engine and, when it cannot be read, the first line of the engine's own complaint. */
function engineInfoResult(cli: EngineCli, engine: string): { info: unknown; why: string } {
  const r = cli(engine, ["info", "--format", engine === "podman" ? "json" : "{{json .}}"]);
  if (r.code !== 0) return { info: null, why: `${engine} info exited ${r.code}${r.stderr?.trim() ? `: ${r.stderr.trim().split("\n")[0]?.slice(0, 200) ?? ""}` : ""}` };
  const info = json(r.stdout);
  return { info, why: isRecord(info) ? "" : `${engine} info did not return JSON` };
}

export function setupReport(i: SetupInput): SetupReport {
  const findings: SetupFinding[] = [];
  const add = (id: string, status: SetupStatus, detail: string): void => { findings.push({ id, status, detail }); };

  const version = i.cli(i.engine, ["version"]);
  const reachable = version.code === 0;
  add("engine", reachable ? "ok" : "fail", reachable ? `${i.engine} answers` : `${i.engine} is not installed or its service is not reachable; install it or set runtime.engine`);

  const read = reachable ? engineInfoResult(i.cli, i.engine) : { info: null, why: "" };
  const rootless = isRecord(read.info) ? engineIsRootless(read.info) : null;
  if (rootless === null) add("rootless", reachable ? "warn" : "fail", `could not read the engine's own info${read.why ? ` (${read.why})` : ""}`);
  else add("rootless", "ok", rootless ? "rootless (workers cannot reach host root)" : "rootful (runtime.user must not be 0:0)");

  const enforced = rootless === null ? null : unattendedEnforcedOn(rootless);
  if (i.unattendedRequested) add("unattended", enforced === true ? "ok" : "warn", unattendedLine(rootless));
  else add("unattended", "ok", `not requested by the contract; ${unattendedLine(rootless)}`);

  if (!reachable) add("image", "fail", `cannot inspect ${i.image} without the engine`);
  else {
    const r = i.cli(i.engine, ["image", "inspect", i.image, "--format", "{{json .Config.Labels}}"]);
    if (r.code !== 0) add("image", "fail", `image ${i.image} is not built; run packages/autonomy/build-image.sh`);
    else {
      const labels = json(r.stdout);
      const ref = isRecord(labels) && typeof labels["pi-autonomy.kit-ref"] === "string" ? labels["pi-autonomy.kit-ref"] : null;
      const want = `v${i.kitVersion}`;
      if (ref === null) add("image", "warn", `image ${i.image} carries no pi-autonomy.kit-ref label (not built by build-image.sh); its kit version is unknown`);
      else if (ref !== want) add("image", "warn", `image ${i.image} was built from kit ${ref}, this checkout is ${want}; rebuild with packages/autonomy/build-image.sh`);
      else add("image", "ok", `image ${i.image} matches kit ${want}`);
    }
  }

  if (i.keyPresent === null) add("key", "warn", "no contract given, so the provider key was not checked (pass --config run.json)");
  else add("key", i.keyPresent ? "ok" : "fail", i.keyPresent ? "an inference key resolves (its value is never printed)" : "no inference key resolves; set the provider's key variable or log in to pi");

  return { ok: findings.every((f) => f.status !== "fail"), engine: i.engine, rootless, unattendedEnforced: enforced, findings };
}

export function setupText(r: SetupReport): string {
  const mark: Record<SetupStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  return [...r.findings.map((f) => `${mark[f.status]} ${f.id}: ${f.detail}`), r.ok ? "setup: usable" : "setup: NOT ready"].join("\n");
}
