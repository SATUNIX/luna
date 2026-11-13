// The installer's half of the first-start notice (the extension's half is
// packages/extensions/src/delegation-guard/cold-start.ts, which cannot be imported from here: the
// published package does not lay the extensions out where core can reach them). Both derive the
// same stamp name from the package root and version; tests/startup-notice-smoke.ts pins that.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The kit's version, as the extension computes it (not its location: the two halves sit in different directories of the published package). */
export function kitKey(from: string = path.dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from, i = 0; i < 4; dir = path.dirname(dir), i += 1) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") return `kit@${parsed.version}`;
    } catch {
      /* no package.json at this level */
    }
  }
  return from;
}

/** Record that this kit's extensions are compiled, so the first real start prints no notice. */
export function stampCompiledKit(stampDir: string = os.tmpdir(), key: string = kitKey()): void {
  const name = `pi-luna-compiled-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  try {
    fs.closeSync(fs.openSync(path.join(stampDir, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600));
  } catch {
    /* a missing stamp only means the notice shows once more */
  }
}
