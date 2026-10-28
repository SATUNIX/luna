#!/usr/bin/env node
/**
 * Property-based fuzzing of the tool-firewall shell classifier
 * (packages/extensions/src/tool-firewall/classify.ts).
 *
 * The fixed tables in tests/firewall-shell-smoke.ts pin known commands; this test generates
 * variations of them, so a construct nobody wrote down is still checked:
 *
 *   1. a write to a persistence, system, git-hook or agent-control file is never rated below high,
 *      whatever write construct, wrapper, quoting or path spelling carries it;
 *   2. a recursive delete of the root or the home directory is always critical;
 *   3. the classifier is total: any string of shell syntax yields a valid tier without throwing.
 *
 * Inputs come from packages/core/eval/fuzz.ts: a fixed seed in check:all, a random one and more
 * runs in the weekly security workflow. A failure prints the seed that reproduces it; a
 * counterexample that reveals a weakness becomes a fixed case in tests/firewall-shell-smoke.ts.
 * Hermetic and offline: pure function calls on synthetic paths.
 */
import assert from "node:assert/strict";
import { isolateKitEnv, loadModule } from "../packages/core/eval/harness.ts";
import { fuzzSeed, property, type Rng } from "../packages/core/eval/fuzz.ts";
import type * as Classify from "../packages/extensions/src/tool-firewall/classify.ts";

isolateKitEnv();
const C = await loadModule<typeof Classify>("packages/extensions/src/tool-firewall/classify.ts");

const WS = "/work/repo";
// Built from parts so no committed line holds a home-directory path (the leak scan refuses one).
const HOME = ["", "home", "op"].join("/");
const env: Classify.ClassifyEnv = { cwd: WS, workspace: WS, home: HOME, tmpRoots: ["/tmp", "/var/tmp"], knownHosts: new Set(), policy: "coding" };

/** Files whose change persists code, widens privilege or alters the agent's own controls. */
const PROTECTED = [
  { home: ".bashrc" },
  { home: ".profile" },
  { home: ".zshrc" },
  { home: ".ssh/authorized_keys" },
  { home: ".config/systemd/user/agent.service" },
  { home: ".config/autostart/agent.desktop" },
  { home: ".pi/agent/settings.json" },
  { home: ".pi/agent/extensions/added.ts" },
  { abs: "/etc/sudoers" },
  { abs: "/etc/cron.d/agent" },
  { abs: "/etc/profile" },
  { abs: `${WS}/.git/hooks/pre-commit` },
] as const;

/** Spellings of one target that a shell resolves to the same file. Tilde is never quoted (a quoted ~ is literal). */
function spell(r: Rng, target: (typeof PROTECTED)[number]): string {
  if ("abs" in target) {
    const dir = target.abs.slice(0, target.abs.lastIndexOf("/"));
    const base = target.abs.slice(target.abs.lastIndexOf("/") + 1);
    const plain = r.pick([target.abs, `${dir}/./${base}`, `${dir}//${base}`, `${dir}/sub/../${base}`]);
    return r.pick([plain, `"${plain}"`, `'${plain}'`]);
  }
  const rel = target.home;
  switch (r.int(6)) {
    case 0: return `~/${rel}`;
    case 1: return `$HOME/${rel}`;
    case 2: return `"$HOME/${rel}"`;
    case 3: return `"\${HOME}/${rel}"`;
    case 4: return `${HOME}/${rel}`;
    default: return `'${HOME}/./${rel}'`;
  }
}

/** Ways to change a file's content or identity. `T` is the target. */
const WRITES = [
  "echo payload > T",
  "printf 'payload\\n' >> T",
  "cat notes.txt > T",
  "echo payload | tee T",
  "echo payload | tee -a T",
  "cp notes.txt T",
  "cp -f notes.txt T",
  "mv notes.txt T",
  "sed -i s/a/b/ T",
  "dd if=notes.txt of=T",
  "touch T",
  "truncate -s 0 T",
  "ln -sf notes.txt T",
  "install -m 644 notes.txt T",
  "rsync notes.txt T",
  "rm -f T",
  ": > T",
];

/** Ways to wrap a command without changing what it does. `X` is the command. */
const WRAPPERS = [
  "X",
  "cd /tmp && X",
  "true; X",
  "X; echo done",
  "X && echo ok",
  "X || true",
  "FOO=bar X",
  "(X)",
  "{ X; }",
  "if true; then X; fi",
  "time X",
  "env X",
  "nice X",
  "ls -la\nX",
];

const atLeastHigh = (tier: Classify.Tier): boolean => C.TIER_RANK[tier] >= C.TIER_RANK.high;

let total = 0;
const ok = (name: string, runs: number): void => {
  total += runs;
  console.log(`  ok  ${name} (${runs} cases)`);
};

ok(
  "a write to a protected file is never rated below high, whatever construct, wrapper or spelling carries it",
  property(
    "protected write >= high",
    400,
    (r) => {
      const target = spell(r, r.pick(PROTECTED));
      const write = r.pick(WRITES).replaceAll("T", target);
      return r.pick(WRAPPERS).replace("X", write);
    },
    (command) => {
      const a = C.classifyCommand(command, env);
      assert.ok(atLeastHigh(a.tier), `rated ${a.tier}: ${C.summarize(a)}`);
    },
  ),
);

ok(
  "a recursive delete of / or the home directory is always critical",
  property(
    "root or home delete is critical",
    300,
    (r) => {
      const flags = r.pick(["-rf", "-fr", "-r -f", "-Rf", "-rf --no-preserve-root", "--recursive --force", "-rfv"]);
      const target = r.pick(["/", "/*", "~", "~/", "$HOME", "\"$HOME\"", HOME, `${HOME}/`, `${HOME}/*`]);
      return r.pick(WRAPPERS).replace("X", `rm ${flags} ${target}`);
    },
    (command) => {
      const a = C.classifyCommand(command, env);
      assert.equal(a.tier, "critical", `rated ${a.tier}: ${C.summarize(a)}`);
    },
  ),
);

const SHELL_ALPHABET = "abcxyz019 -_./~$\"'`\\|&;<>(){}[]*?!#=%:,\n\t";
const TIERS = new Set<string>(["low", "medium", "high", "critical"]);
ok(
  "the classifier is total: any string of shell syntax yields a tier and never throws",
  property(
    "classifier is total",
    1500,
    (r) => r.string(SHELL_ALPHABET, 1 + r.int(80)),
    (command) => {
      const a = C.classifyCommand(command, env);
      assert.ok(TIERS.has(a.tier), `unexpected tier ${a.tier}`);
    },
  ),
);

console.log(`[fuzz-firewall-classifier-smoke] OK: ${total} generated cases, seed ${fuzzSeed()}`);
