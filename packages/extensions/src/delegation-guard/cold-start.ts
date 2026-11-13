// A one-line "first start" notice, drawn before pi has anything on screen and gone before pi draws.
//
// pi draws nothing until every extension has loaded, and it compiles each extension on the first
// start after an install, an update or a reboot (its compile cache lives in the OS temporary
// directory, which a reboot empties). That start takes about ten seconds with nothing visible, so
// the terminal looks hung. pi loads extensions in file-name order, and delegation-guard is the first
// of the extensions every Luna install loads, so calling this first there makes it
// run as early as Luna can run at all (no extension may import a sibling's files).
// It prints one transient line without a newline, and erases it the moment pi first writes to the
// terminal, which is the TUI taking over. A start that already has a compile cache prints nothing.
//
// It writes only to a terminal, never in a child pi, a print or rpc run, CI or TERM=dumb, and only
// once per process (a /reload loads this file again and must not write into the running TUI).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NOTICE = "Luna: first start since an update or reboot, compiling, one time only";
const ERASE_LINE = "\r\x1b[2K";
const NON_INTERACTIVE_ARGS = new Set(["-p", "--print", "--mode", "--version", "-v", "--help", "-h"]);

export interface ColdStartEnv {
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: { readonly isTTY?: boolean };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  /** Where the "already compiled" stamp lives; pi's compile cache sits in the same directory. */
  readonly stampDir: string;
  /** Identifies this install of the kit, so an update makes the next start cold again. */
  readonly kitKey: string;
}

/** The kit's version, so an update makes the next start cold again (packages/core/lib/cold-stamp.ts derives the same key; tests pin that they agree), so an update (or a move) changes the stamp name. */
export function kitKey(here: string = path.dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = here, i = 0; i < 4; dir = path.dirname(dir), i += 1) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") return `kit@${parsed.version}`;
    } catch {
      /* no package.json at this level */
    }
  }
  return here;
}

export const stampPath = (e: Pick<ColdStartEnv, "stampDir" | "kitKey">): string => path.join(e.stampDir, `pi-luna-compiled-${crypto.createHash("sha256").update(e.kitKey).digest("hex").slice(0, 16)}`);

/** Record that this kit's extensions are compiled (exclusive, never through a symlink: the name is predictable and /tmp is shared). */
export function writeColdStartStamp(e: Pick<ColdStartEnv, "stampDir" | "kitKey">): void {
  try {
    fs.closeSync(fs.openSync(stampPath(e), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600));
  } catch {
    /* a missing stamp only means the notice shows once more */
  }
}

/**
 * Draw the notice when this looks like a cold first start, and arrange for it to be erased when pi first writes to stdout (which also
 * writes the stamp) or the process exits (which does not). Returns whether it drew.
 */
export function showColdStartNotice(e: ColdStartEnv): boolean {
  if (!e.stdout.isTTY || e.stdin.isTTY !== true) return false;
  if (e.env.CI || e.env.TERM === "dumb" || e.argv.slice(2).some((a) => NON_INTERACTIVE_ARGS.has(a))) return false;
  if ((e.stdout.columns ?? 80) <= NOTICE.length) return false;
  const stamp = stampPath(e);
  if (fs.existsSync(stamp)) return false;

  const out = e.stdout;
  const write = out.write.bind(out);
  let done = false;
  // Only pi's first write (the TUI taking over) proves compilation finished; an exit during the
  // compile (Ctrl-C, a config error) erases the line without stamping, so the next start still warns.
  const finish = (stampIt: boolean): void => {
    if (done) return;
    done = true;
    write(ERASE_LINE);
    if (stampIt) writeColdStartStamp(e);
  };
  // Every later write passes straight through; only the first one erases the notice.
  out.write = ((...args: Parameters<typeof write>): boolean => {
    finish(true);
    return write(...args);
  }) as typeof out.write;
  process.once("exit", () => finish(false));
  write(NOTICE);
  return true;
}

/** Called once, first thing, from the extension's entry; only the first load in a process draws (a /reload is inside the TUI). */
export function announceColdStart(): void {
  const once = Symbol.for("luna.coldStartNotice");
  if (Reflect.get(globalThis, once) === true) return;
  Reflect.set(globalThis, once, true);
  try {
    showColdStartNotice({ stdout: process.stdout, stdin: process.stdin, env: process.env, argv: process.argv, stampDir: os.tmpdir(), kitKey: kitKey() });
  } catch {
    /* a notice must never stop the guard from loading */
  }
}
