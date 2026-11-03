/**
 * The JavaScript runtime an extension starts a kit script with (`server.ts`, `remote-host.ts`,
 * the autonomy CLI, the installer, the workflow-sandbox runner).
 *
 * Extensions run inside the pi process, so `process.execPath` is whatever runs pi. From source
 * that is node; a compiled pi (a single executable) is pi itself, and `pi <script>.ts` reads the
 * path as a prompt and runs a whole agent turn instead of the script. So execPath is used only
 * when it is a JavaScript runtime, and is never handed back when it is pi.
 *
 * Resolution order:
 *   1. `PI_KIT_NODE`: the operator's choice. It must be an absolute path to an executable file;
 *      when set but unusable the resolution fails with the reason (it never falls through).
 *   2. `process.execPath`, when its name (lower case, without .exe/.cmd/.bat) is node or nodejs,
 *      or bun for a plain script (not for `require: "node"`, and a bun-hosted "node" shim counts
 *      as bun). deno is not used: `deno <file>` runs without the permissions the scripts need.
 *      process.versions.bun alone never makes execPath a runtime: compiled pi is built with
 *      `bun build --compile`, so bun's version is set inside it, yet `pi <script>` is a prompt.
 *   3. `node` (then `nodejs`; `node.exe` on Windows) in an absolute PATH entry, then
 *      /usr/local/bin and /usr/bin. Relative PATH entries are skipped, so a repository cannot
 *      choose the runtime by putting `./node` in front of the operator.
 * Nothing found is a failure with a reason the operator can act on.
 *
 * `require: "node"` (the workflow sandbox, which needs node's `--permission` model and bind-mounts
 * the binary into a jail) returns the real file, through any links, and skips a candidate whose
 * real name is not node or nodejs: a version-manager shim (`~/.../shims/node` -> `mise`) would
 * not run inside a jail with an empty environment.
 *
 * Canonical source: packages/core/shared/node-runtime.ts. Extensions hold generated, byte-checked
 * copies (`npm run gen:shared`; `npm run verify` fails on drift). Pinned by
 * tests/node-runtime-smoke.ts.
 */
import fs from "node:fs";
import path from "node:path";

/** The environment variable that names the Node.js binary to use. */
export const NODE_OVERRIDE_ENV = "PI_KIT_NODE";

export interface NodeRuntimeOptions {
  /** Defaults to process.execPath. */
  execPath?: string;
  /** Defaults to process.env (PI_KIT_NODE and PATH are read from it). */
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /**
   * Defaults to process.versions. `bun` set makes a host named node (bun's node shim) bun; it
   * never makes a non-runtime execPath (a bun-compiled pi) a runtime.
   */
  versions?: Readonly<Record<string, string | undefined>>;
  /** "script" (default): node, nodejs or bun. "node": Node.js only, as its real file. */
  require?: "script" | "node";
  /** Searched after PATH; defaults to /usr/local/bin and /usr/bin (none on Windows). */
  systemDirs?: readonly string[];
}

export type NodeRuntime =
  | { ok: true; command: string; source: "override" | "execPath" | "path" }
  | { ok: false; reason: string };

/** A runtime file's name: lower case, without directory or a Windows .exe/.cmd/.bat suffix. */
export function runtimeName(file: string): string {
  return (file.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

const isNodeName = (name: string): boolean => name === "node" || name === "nodejs";

function realFile(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/** An executable regular file (through links). Windows has no execute bit to check. */
function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The runtime to start a kit script with, or why there is none. Never returns a non-JS execPath. */
export function nodeRuntime(options: NodeRuntimeOptions = {}): NodeRuntime {
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const versions = options.versions ?? process.versions;
  const nodeOnly = options.require === "node";
  const p = platform === "win32" ? path.win32 : path.posix;
  const hostName = runtimeName(execPath);
  // bun only when execPath is named like a runtime. A compiled pi is a `bun build --compile`
  // binary, so process.versions.bun is set inside it too, but `pi <script>` reads the path as a
  // prompt: a non-runtime execPath stays pi (guarded as `self`) whatever versions says.
  const hostIsBun = hostName === "bun" || (isNodeName(hostName) && typeof versions.bun === "string");
  const hostIsNode = isNodeName(hostName) && !hostIsBun;
  // The running pi itself, when it is not a JS runtime: no candidate may resolve to it.
  const self = hostIsNode || hostIsBun ? null : realFile(execPath);
  const isSelf = (file: string): boolean => self !== null && realFile(file) === self;
  const wanted = nodeOnly ? "Node.js" : "Node.js (or bun)";

  const override = env[NODE_OVERRIDE_ENV]?.trim();
  if (override) {
    if (!p.isAbsolute(override)) return { ok: false, reason: `${NODE_OVERRIDE_ENV}=${override} is not an absolute path` };
    if (!isExecutableFile(override, platform)) return { ok: false, reason: `${NODE_OVERRIDE_ENV}=${override} is not an executable file` };
    if (isSelf(override)) return { ok: false, reason: `${NODE_OVERRIDE_ENV}=${override} is pi itself, not ${wanted}` };
    if (!nodeOnly) return { ok: true, command: override, source: "override" };
    const real = realFile(override);
    if (real && isNodeName(runtimeName(real))) return { ok: true, command: real, source: "override" };
    return { ok: false, reason: `${NODE_OVERRIDE_ENV}=${override} resolves to ${real ?? "?"}, which is not a node binary` };
  }

  if (hostIsNode) return { ok: true, command: nodeOnly ? (realFile(execPath) ?? execPath) : execPath, source: "execPath" };
  if (hostIsBun && !nodeOnly) return { ok: true, command: execPath, source: "execPath" };

  const names = platform === "win32" ? ["node.exe"] : ["node", "nodejs"];
  const pathDirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter((d) => d && p.isAbsolute(d));
  const dirs = [...pathDirs, ...(options.systemDirs ?? (platform === "win32" ? [] : ["/usr/local/bin", "/usr/bin"]))];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = p.join(dir, name);
      if (!isExecutableFile(candidate, platform) || isSelf(candidate)) continue;
      if (!nodeOnly) return { ok: true, command: candidate, source: "path" };
      const real = realFile(candidate);
      if (real && isNodeName(runtimeName(real))) return { ok: true, command: real, source: "path" };
    }
  }
  const host = hostIsBun ? `bun (${execPath}), which cannot provide node's permission model` : `${execPath}, which is not a JavaScript runtime (a compiled pi)`;
  return {
    ok: false,
    reason: `pi is running as ${host}, and no ${nodeOnly ? "real node binary" : "node"} was found on PATH. Install Node.js >= 22.19 on PATH or set ${NODE_OVERRIDE_ENV}=/absolute/path/to/node`,
  };
}
