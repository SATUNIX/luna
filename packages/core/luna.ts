#!/usr/bin/env node
/**
 * The `luna` command: pi, started the way Luna wants.
 *
 *   luna [pi args]            start pi after applying overrides.json (extensions you switched off stay off)
 *   luna --bare [pi args]     pi with no Luna extensions, skills, prompts or themes: the way to tell whether
 *                             a misbehaving session is Luna's doing
 *   luna exec <prompt | ->    one headless run, see docs/headless.md
 *
 * Everything else is pi's own command line, passed through untouched.
 */
import { spawnSync } from "node:child_process";
import { applyPendingDisables, BARE_ARGS, runExec } from "./lib/headless.ts";

const argv = process.argv.slice(2);
if (argv[0] === "exec") {
  applyPendingDisables();
  process.exitCode = await runExec(argv.slice(1));
} else {
  const bare = argv[0] === "--bare";
  const rest = bare ? argv.slice(1) : argv;
  if (!bare) applyPendingDisables();
  const windows = process.platform === "win32";
  // Arguments go to pi as a vector; on Windows pi is a .cmd shim that needs a shell, so refuse metacharacters there.
  if (windows && rest.some((a) => /["&|<>^%!`]/.test(a))) {
    console.error("luna: an argument contains a shell metacharacter, which Windows cannot pass to pi safely");
    process.exit(2);
  }
  const r = spawnSync("pi", [...(bare ? BARE_ARGS : []), ...rest], { stdio: "inherit", shell: windows });
  if (r.error) {
    console.error(`luna: could not start pi: ${r.error.message}`);
    process.exit(127);
  }
  process.exitCode = r.status ?? 1;
}
