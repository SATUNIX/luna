/** The remote console version, resolved without starting the host's listeners. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, parseJson } from "../../core/lib/guard.ts";
import { isKitLocalPackageName } from "../../core/lib/identity.ts";

function readPackage(file: string): unknown {
  try { return parseJson(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function kitVersion(root: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), fallback: string = path.join(root, "packages", "web-ui", "package.json")): string {
  for (const candidate of [path.join(root, "package.json"), fallback]) {
    const pkg = readPackage(candidate);
    // Preserve the legacy scoped-name matcher used by the remote host.
    if (isRecord(pkg) && typeof pkg.version === "string" && (isKitLocalPackageName(pkg.name) || (typeof pkg.name === "string" && /(^|\/)pi-system$/.test(pkg.name)))) return pkg.version;
  }
  const pkg = readPackage(fallback);
  return isRecord(pkg) && typeof pkg.version === "string" ? pkg.version : "0.0.0";
}
