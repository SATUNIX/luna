#!/usr/bin/env node
// tool-firewall parser: exec-trace oracle.
//
// Each corpus entry is run through real bash with a PATH that holds only stub programs. A stub records the
// argv it was started with and does nothing else. The oracle then checks the firewall's parse of the same
// text: every argv bash actually executed must be one of the parsed segments, or the parse must report the
// text as opaque (and the classifier must then never call it routine). That is the parser's coverage
// contract (docs/autonomy-gate.md, "Parser coverage").
//
// Isolation: when bubblewrap works on the host the run is also inside `bwrap` (read-only root, private
// /tmp, no network, its own namespaces); when it does not (an unprivileged CI runner without user
// namespaces), the same corpus runs with the stub-only PATH, `env -i`, a scratch HOME and a scratch working
// directory. The corpus is benign either way: the only program it names is the `pimarker` stub, plus a few
// real wrappers (`env`, `timeout`, `nice`, `xargs`, `find`, `bash`) whose inner command is the stub.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadModule, isolateKitEnv } from "../packages/core/eval/harness.ts";
import type * as Classify from "../packages/extensions/src/tool-firewall/classify.ts";
import type * as Shell from "../packages/extensions/src/tool-firewall/shell.ts";

const restoreIsolation = isolateKitEnv();
const C = await loadModule<typeof Classify>("extensions/tool-firewall/classify.ts");
const S = await loadModule<typeof Shell>("extensions/tool-firewall/shell.ts");

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) return fs.realpathSync(p); } catch { /* not here */ }
  }
  return null;
}

const bash = process.platform === "win32" ? null : which("bash");
if (!bash) {
  restoreIsolation();
  console.log("[firewall-exec-oracle-smoke] SKIP: no bash on this platform (the oracle needs a real bash)");
  process.exit(0);
}

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-exec-oracle-")));
const stubs = path.join(scratch, "bin");
const home = path.join(scratch, "home");
const work = path.join(scratch, "work");
const log = path.join(scratch, "argv.log");
for (const d of [stubs, home, work]) fs.mkdirSync(d, { recursive: true });

// The stub: its own name, then each argument, one line per execution. Only shell builtins are used, so it
// needs nothing on PATH.
// The line is written in one append, so stubs running at the same time (a pipeline) do not interleave.
const STUB = `#!${bash}\nline="\${0##*/}"\nfor a in "$@"; do line="$line $a"; done\nprintf '%s\\n' "$line" >> "$ORACLE_LOG"\n`;
for (const name of ["pimarker", "cat"]) fs.writeFileSync(path.join(stubs, name), STUB, { mode: 0o755 });
// Real wrappers, linked in so their inner command resolves to the stub through PATH.
const realWrappers = new Set<string>();
for (const name of ["bash", "sh", "env", "timeout", "nice", "xargs", "find"]) {
  const real = name === "bash" || name === "sh" ? bash : which(name);
  if (!real) continue;
  fs.symlinkSync(real, path.join(stubs, name));
  realWrappers.add(name);
}

function bwrapWorks(): boolean {
  if (!which("bwrap")) return false;
  const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-all", "--die-with-parent", "true"], { stdio: "ignore", timeout: 10_000 });
  return r.status === 0;
}
const useBwrap = bwrapWorks();

function runInBash(command: string): string[] {
  fs.writeFileSync(log, "");
  const env = { PATH: stubs, HOME: home, ORACLE_LOG: log, LC_ALL: "C" };
  const args = ["--noprofile", "--norc", "-c", command];
  const r = useBwrap
    ? spawnSync("bwrap", ["--ro-bind", "/", "/", "--tmpfs", "/tmp", "--bind", scratch, scratch, "--dev", "/dev", "--proc", "/proc", "--unshare-all", "--die-with-parent", "--new-session", "--chdir", work, "--clearenv", ...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]), bash ?? "bash", ...args], { input: "", timeout: 15_000, encoding: "utf8" })
    : spawnSync(bash ?? "bash", args, { cwd: work, env, input: "", timeout: 15_000, encoding: "utf8" });
  if (r.error) throw r.error;
  return fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
}

type Entry = { cmd: string; runs: boolean; needs?: string[]; nonRoot?: boolean };
// `runs`: bash must have executed the marker (so the entry cannot pass by running nothing).
// `nonRoot`: bash runs the construct only for a non-root user. As root (GitLab CI's containers) the
// entry is still classified, but bash cannot exercise it.
const corpus: Entry[] = [
  { cmd: "pimarker plain", runs: true },
  { cmd: "pimarker a && pimarker b || pimarker c; ! pimarker bang", runs: true },
  { cmd: "pimarker pipe | pimarker pipe2", runs: true },
  { cmd: "pimarker $(pimarker inner)", runs: true },
  { cmd: "echo $(( $(pimarker arith) + 1 ))", runs: true },
  { cmd: "echo \"$(( $(pimarker arithq) + 0 ))\"", runs: true },
  { cmd: "(( x = $(pimarker arithcmd) + 0 ))", runs: true },
  { cmd: "(( $(pimarker dblparen) + 0 ))", runs: true },
  { cmd: "{pimarker,brace}", runs: true },
  { cmd: "pimarker {a,b}c x{1..2}", runs: true },
  { cmd: "f() { pimarker fbody; }; f", runs: true },
  { cmd: "function g { pimarker kwbody; }; g", runs: true },
  { cmd: "function h() ( pimarker kwsub ); h", runs: true },
  { cmd: "coproc C { pimarker coproc; }; wait", runs: true },
  { cmd: "trap 'pimarker trap' EXIT", runs: true },
  { cmd: "trap 'pimarker err' ERR; false", runs: true },
  { cmd: "shopt -s expand_aliases\nalias t='pimarker alias'\nt", runs: true },
  { cmd: "mapfile -C 'pimarker mapfile' -c 1 arr <<< $'a\\nb'", runs: true },
  { cmd: "source /dev/stdin <<< 'pimarker source'", runs: true },
  { cmd: ". /dev/stdin <<< 'pimarker dot'", runs: true },
  { cmd: "bash /dev/stdin <<< 'pimarker bashstdin'", runs: true, needs: ["bash"] },
  { cmd: "bash -c 'pimarker bashc'", runs: true, needs: ["bash"] },
  { cmd: "sh -c 'pimarker shc'", runs: true, needs: ["sh"] },
  { cmd: "bash <<'EOF'\npimarker hdbash\nEOF", runs: true, needs: ["bash"] },
  { cmd: "cat <<EOF\n$(pimarker heredoc)\nEOF", runs: true },
  { cmd: "cat <(pimarker procsub); wait $!", runs: true },
  { cmd: "eval 'pimarker eval'", runs: true },
  { cmd: "builtin eval 'pimarker builtin'; command pimarker command", runs: true },
  { cmd: "time pimarker time", runs: true },
  { cmd: "for i in 1; do pimarker loop; done; while false; do :; done", runs: true },
  { cmd: "case a in a) pimarker case;; esac", runs: true },
  { cmd: "if true; then pimarker if; fi", runs: true },
  { cmd: "{ pimarker group; }; ( pimarker subshell )", runs: true },
  { cmd: "PS4='$(pimarker ps4) '; set -x; :", runs: true },
  { cmd: "export PS4='$(pimarker ps4export) '; set -x; :", runs: true },
  { cmd: "x='a[$(pimarker subscript)]'; echo $((x))", runs: true },
  { cmd: "let 'a[$(pimarker let)]=1'", runs: true },
  { cmd: "[[ 1 -eq 'a[$(pimarker dbl)]' ]]", runs: true },
  { cmd: "printf -v 'a[$(pimarker printfv)]' x", runs: true },
  { cmd: "c=pimarker; $c dyn", runs: true },
  { cmd: "IFS=,; c='pimarker,ifs'; $c", runs: true },
  { cmd: "$(echo pimarker) subst", runs: true },
  { cmd: "echo ${x:-$(pimarker paramdefault)}", runs: true },
  { cmd: ": ${x:=$(pimarker paramassign)}", runs: true },
  { cmd: "echo ${x:-\"$(pimarker paramquoted)\"}", runs: true },
  { cmd: "case x in $(pimarker casepattern)) ;; esac", runs: true },
  { cmd: "shopt -s expand_aliases\nalias ls=pimarker\nls aliasarg", runs: true },
  { cmd: `hash -p ${stubs}/pimarker ls; ls hashed`, runs: true },
  { cmd: "f() { pimarker \"$1\"; }; f fnarg", runs: true },
  // bash does not import PS4 from the environment when its effective uid is 0 (CVE-2016-7543).
  { cmd: "env 'PS4=$(pimarker envps4) ' bash -xc true", runs: true, needs: ["env", "bash"], nonRoot: true },
  { cmd: "env pimarker env", runs: true, needs: ["env"] },
  { cmd: "env -S 'pimarker envs'", runs: true, needs: ["env"] },
  { cmd: "timeout 5 pimarker timeout", runs: true, needs: ["timeout"] },
  { cmd: "nice -n 1 pimarker nice", runs: true, needs: ["nice"] },
  { cmd: "echo a | xargs pimarker xargs", runs: true, needs: ["xargs"] },
  { cmd: "find . -maxdepth 0 -exec pimarker find {} \\;", runs: true, needs: ["find"] },
  // Data, not code: bash runs nothing here, and the parser must not invent a command either way.
  { cmd: "cat <<'EOF'\npimarker quoted-heredoc\nEOF", runs: false },
  { cmd: "echo 'pimarker in quotes'; # pimarker comment", runs: false },
];

const WS = work;
const env: Classify.ClassifyEnv = { cwd: WS, workspace: WS, home, tmpRoots: [os.tmpdir()], knownHosts: new Set(), policy: "coding" };

// A parsed word holding an expansion (`$(…)`, `$x`) stands for whatever it expands to at run time: zero or
// more words after word splitting. Every literal word must match exactly.
function argvMatches(words: { text: string; dynamic: boolean }[], run: string[]): boolean {
  const [w, ...rest] = words;
  if (!w) return run.length === 0;
  if (w.dynamic) {
    for (let k = 0; k <= run.length; k++) if (argvMatches(rest, run.slice(k))) return true;
    return false;
  }
  return run[0] === w.text && argvMatches(rest, run.slice(1));
}

const isRoot = process.geteuid?.() === 0;
let checked = 0;
const rootOnlyClassified: string[] = [];
const problems: string[] = [];
for (const entry of corpus) {
  if (entry.needs?.some((n) => !realWrappers.has(n))) continue;
  if (entry.nonRoot && isRoot) {
    if (C.effectiveTier(C.classifyCommand(entry.cmd, env), true) === "low") problems.push(`${JSON.stringify(entry.cmd)}: classifies as routine`);
    rootOnlyClassified.push(entry.cmd);
    continue;
  }
  const executed = runInBash(entry.cmd).filter((line) => line.startsWith("pimarker"));
  const parsed = S.parseShell(entry.cmd, { cwd: WS, home });
  const segs = parsed.segments.map((s) => ({ argv: [S.basenameOf(s.argv[0] ?? ""), ...s.argv.slice(1)].join(" "), words: [S.basenameOf(s.argv[0] ?? ""), ...s.argv.slice(1)].map((text, i) => ({ text, dynamic: s.words[i]?.dynamic ?? false })), open: s.unknownArgs, dynamic: s.dynamicName || s.evalOf === true }));
  const tier = C.effectiveTier(C.classifyCommand(entry.cmd, env), true);
  if (entry.runs && !executed.length) problems.push(`${JSON.stringify(entry.cmd)}: bash ran no marker (the corpus entry does not exercise its construct)`);
  for (const line of executed) {
    const seen = segs.some((s) => s.argv === line || (s.open && line.startsWith(`${s.argv} `)) || argvMatches(s.words, line.split(" ")));
    // A command name computed at runtime is not known to the parser, but the classifier fails closed on it.
    const failClosed = (parsed.opaque.length > 0 || segs.some((s) => s.dynamic)) && tier !== "low";
    if (!seen && !failClosed) problems.push(`${JSON.stringify(entry.cmd)}: bash executed "${line}", which is neither a parsed segment nor reported as opaque (parsed: ${JSON.stringify(segs.map((s) => s.argv))}, opaque: ${JSON.stringify(parsed.opaque)}, tier ${tier})`);
    if (tier === "low") problems.push(`${JSON.stringify(entry.cmd)}: bash executed "${line}" but the command classifies as routine`);
  }
  checked++;
}

fs.rmSync(scratch, { recursive: true, force: true });
restoreIsolation();
assert.deepEqual(problems, [], `exec-trace oracle found ${problems.length} problem(s):\n${problems.join("\n")}`);
assert.ok(checked >= 48, `the oracle checked ${checked} entries; the corpus should not shrink below 48`);
console.log(`  OK: ${checked} corpus entries: every argv bash executed is a parsed segment or the text is opaque (${useBwrap ? "inside bwrap" : "stub PATH only; bwrap unavailable"})`);
if (rootOnlyClassified.length) console.log(`  NOTE: running as root, so ${rootOnlyClassified.length} entr${rootOnlyClassified.length === 1 ? "y was" : "ies were"} classified but not executed: ${rootOnlyClassified.map((c) => JSON.stringify(c)).join(", ")}`);
console.log("[firewall-exec-oracle-smoke] OK");
