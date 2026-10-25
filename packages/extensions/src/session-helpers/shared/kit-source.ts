// GENERATED from packages/core/shared/kit-source.ts by packages/core/gen-shared.ts. Do not edit this copy:
// change the source and run `npm run gen:shared` (`npm run verify` fails when a copy differs).
/**
 * Whether an install marker's `kitSource` may name a code location the kit runs from.
 *
 * A project marker (`.pi/.pi-kit.json`) is repository content, so its `kitSource` is untrusted:
 * every consumer that turns it into a path it executes (session-helpers' installer, web-console's
 * server, remote-control's host) asks `trustedMarkerKitRoot` first. A source is accepted only when
 * it is absolute, resolves (through any links) outside the workspace, holds the code the caller
 * wants, and its package.json names the kit. Anything else is refused with a reason, so an opened
 * repository can never choose what runs.
 *
 * Canonical source: packages/core/shared/kit-source.ts. Extensions hold generated, byte-checked
 * copies (`npm run gen:shared`; `npm run verify` fails on drift).
 */
import fs from "node:fs";
import path from "node:path";

/** The kit's scoped package names, on any channel or version. */
export const KIT_PACKAGE_NAMES: ReadonlySet<string> = new Set(["@satunix/pi-system", "@satunix/luna"]);

/** A kit package name, or the unscoped name a local checkout of the kit carries. */
export function isKitLocalPackageName(name: unknown): boolean {
  return typeof name === "string" && (KIT_PACKAGE_NAMES.has(name) || name === "pi-system");
}

/** `p` resolved through symbolic links, or just resolved when it does not exist. */
export function realDir(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `child` is `parent` or below it (both already resolved). */
export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The workspace a session opened: the enclosing git work tree of `cwd`, else `cwd` itself.
 * Both are resolved through symbolic links, so a link cannot hide a path inside it.
 */
export function workspaceRoot(cwd: string): string {
  const start = realDir(cwd);
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}

function packageName(root: string): unknown {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "name" in parsed ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/** The accepted kit root, the reason a code location was refused, or null (not a code location). */
export type MarkerKitRoot = { root: string } | { ignored: string } | null;

/**
 * Check a marker's `kitSource` before anything under it is run. `hasCode(dir)` says whether `dir`
 * holds what the caller would run (a kit layout, a web UI server). A source that does not is not a
 * code location (an npm or git source, a stale path) and returns null without a reason; one that
 * does but is relative, inside the workspace of `cwd`, or not the kit by package name returns the
 * reason it was ignored.
 */
export function trustedMarkerKitRoot(kitSource: string, cwd: string, hasCode: (dir: string) => boolean): MarkerKitRoot {
  if (!path.isAbsolute(kitSource)) {
    if (!hasCode(path.resolve(cwd, kitSource))) return null;
    return { ignored: `the install marker's kitSource "${kitSource}" is relative` };
  }
  const real = realDir(kitSource);
  if (!hasCode(real)) return null;
  if (isWithin(real, workspaceRoot(cwd))) return { ignored: `the install marker's kitSource "${kitSource}" is inside the workspace` };
  if (!isKitLocalPackageName(packageName(real))) return { ignored: `the install marker's kitSource "${kitSource}" is not a pi-system kit` };
  return { root: real };
}
