#!/usr/bin/env node
/**
 * `/packages`: search, review, add and remove pi packages the operator chooses, outside the kit's
 * reviewed companions (lib/user-packages.ts holds the rules; tests/user-packages-smoke.ts pins them).
 * An operator command: the kit registers no model tool for it.
 *
 *   node packages/core/packages.ts search [words]          read-only: npm keyword pi-package
 *   node packages/core/packages.ts review <name>[@version] [--json]   read-only: what an add would accept
 *   node packages/core/packages.ts add <name>@<version>    shows the review, asks at the terminal
 *   node packages/core/packages.ts remove <name>           asks at the terminal
 *   node packages/core/packages.ts list
 *
 * `add` and `remove` need a person at an interactive terminal: they ask there and refuse when standard
 * input or output is not a TTY, so a model's shell (pipes) cannot run them. User scope only: the
 * packages go into pi's global settings.
 */
import path from "node:path";
import readline from "node:readline/promises";
import { globalAgentDir } from "./lib/settings.ts";
import { readSources } from "./lib/sources.ts";
import { npmSpec } from "./lib/companions.ts";
import { runPi } from "./lib/pi-cli.ts";
import { SOURCES_PATH } from "./lib/paths.ts";
import { KIT_PACKAGE_NAMES } from "./shared/kit-source.ts";
import { addPackage, formatReview, readLedger, registryUrl, removePackage, reviewPackage, searchPackages, userPackagesPath } from "./lib/user-packages.ts";

/** The packages the kit owns: its companions (current and retired) and itself. */
function kitPackages(): Set<string> {
  const { external, retired } = readSources(SOURCES_PATH);
  const names = new Set<string>(KIT_PACKAGE_NAMES);
  for (const e of external) {
    const spec = npmSpec(e.source);
    if (spec) names.add(spec.name);
  }
  for (const r of retired ?? []) names.add(r.package);
  return names;
}

/** `name` or `name@version`, for scoped names too. */
function splitSpec(spec: string): { name: string; version: string | undefined } {
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: undefined };
}

const USAGE = "usage: packages.ts search [words] | review <name>[@version] | add <name>@<version> | remove <name> | list";

/** Asks a person: the question is shown and "yes" typed at an interactive terminal is the only yes. */
export type Confirm = (question: string) => Promise<boolean>;

/** The operator gate: refuses when standard input or output is not a terminal (a pipe, a model's shell). */
function requireTty(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("this needs a person at an interactive terminal: run it in your own shell, not through pi or a pipe");
}

export const ttyConfirm: Confirm = async (question) => {
  requireTty();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} Type yes to continue: `)).trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
};

export async function main(argv: readonly string[], log: (line: string) => void = console.log, confirm: Confirm = ttyConfirm): Promise<number> {
  const [verb, ...rest] = argv;
  const agentDir = globalAgentDir();
  const pi = (args: readonly string[], env: Readonly<Record<string, string>>) => {
    log(`  > pi ${args.join(" ")}`);
    runPi("pi", args, { env });
  };
  switch (verb) {
    case "search": {
      const hits = await searchPackages(rest.join(" "), registryUrl());
      if (hits.length === 0) log("No pi packages matched.");
      for (const h of hits) log(`  ${h.name}@${h.version}${h.description ? ` - ${h.description}` : ""}`);
      if (hits.length) log("UNREVIEWED: search results are not reviewed by Luna. Review one with /packages review <name>.");
      return 0;
    }
    case "review": {
      const specs = rest.filter((a) => a !== "--json");
      if (specs.length !== 1 || !specs[0]) throw new Error(USAGE);
      const { name, version } = splitSpec(specs[0]);
      const review = await reviewPackage(name, version, registryUrl());
      if (rest.includes("--json")) {
        log(JSON.stringify({ review, lines: formatReview(review), kit: kitPackages().has(name) }));
        return 0;
      }
      for (const line of formatReview(review)) log(line);
      if (kitPackages().has(name)) log(`  note: ${name} is a Luna companion or Luna itself; the kit pins it, so /packages will not add it.`);
      log(`To add exactly this, in your own terminal: node ${path.join("packages", "core", "packages.ts")} add ${review.name}@${review.version} (it asks you first)`);
      return 0;
    }
    case "add": {
      if (confirm === ttyConfirm) requireTty(); // before any network work: nobody could answer
      if (rest.length !== 1 || !rest[0]) throw new Error(USAGE);
      const { name, version } = splitSpec(rest[0]);
      if (version === undefined) throw new Error(`name the exact version: ${name}@<version>`);
      const kit = kitPackages();
      if (kit.has(name)) throw new Error(`${name} is a Luna companion or Luna itself; the kit installs and pins it, /packages does not`);
      const registry = registryUrl();
      const review = await reviewPackage(name, version, registry);
      for (const line of formatReview(review)) log(line);
      if (!(await confirm(`Add ${review.source} from ${registry.origin} with this integrity?`))) {
        log("Not added; nothing was changed.");
        return 1;
      }
      const entry = await addPackage({ agentDir, registry, kitPackages: kit, pi }, name, review.version, review.integrity);
      log(`Added ${entry.source} (integrity verified, install scripts off). UNREVIEWED by Luna: you accepted it. Recorded in ${userPackagesPath(agentDir)}.`);
      return 0;
    }
    case "remove": {
      if (confirm === ttyConfirm) requireTty();
      if (rest.length !== 1 || !rest[0]) throw new Error(USAGE);
      const target = rest[0];
      if (!(await confirm(`Remove ${target}, which /packages added?`))) {
        log("Kept; nothing was changed.");
        return 1;
      }
      const entry = removePackage({ agentDir, kitPackages: kitPackages(), pi }, target);
      log(`Removed ${entry.source}.`);
      return 0;
    }
    case "list": {
      const ledger = readLedger(userPackagesPath(agentDir));
      if (ledger.length === 0) log("No packages added with /packages.");
      for (const p of ledger) log(`  ${p.source}  UNREVIEWED (you accepted it ${p.acceptedAt.slice(0, 10)})  ${p.integrity.slice(0, 20)}...`);
      return 0;
    }
    default:
      throw new Error(USAGE);
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked.endsWith(`${path.sep}packages.ts`) || invoked.endsWith(`${path.sep}packages.js`)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`[packages] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
