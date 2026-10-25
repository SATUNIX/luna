#!/usr/bin/env node
// Pin allowlist. The repository only lets workflows run the actions its settings
// list, SHA-exact (`.github/expected-settings.json` mirrors that list; the drift check compares it
// with GitHub). A pin bump is therefore a two-file change: this fails when a workflow uses a
// third-party action SHA the expected list does not name, or the list keeps a SHA nothing uses,
// so the settings change is made deliberately (and first) instead of under release pressure.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { array, boolean, object, optional, parseJsonAs, record, string, type Infer } from "../packages/core/lib/guard.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");
const Actions = object({
  actions: object({
    allowed_actions: string(),
    sha_pinning_required: boolean(),
    github_owned_allowed: boolean(),
    verified_allowed: boolean(),
    patterns_allowed: array(string()),
    indirect: optional(record(string())),
  }),
});
type Settings = Infer<typeof Actions>;
const settings = parseJsonAs(Actions, fs.readFileSync(path.join(ROOT, ".github/expected-settings.json"), "utf8"), "expected-settings");
const GITHUB_OWNED = /^(?:actions|github)\//;

/** Every `uses:` reference in workflow text (local `./` calls excluded). */
export function usesOf(text: string): string[] {
  return [...text.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)].map((m) => m[1] ?? "").filter((u) => !u.startsWith("./"));
}

/** Problems with `uses` against the expected actions settings; [] when they agree. */
export function problems(uses: readonly string[], expected: Settings): string[] {
  const out: string[] = [];
  const a = expected.actions;
  if (a.allowed_actions !== "selected" || !a.sha_pinning_required || a.verified_allowed) out.push("actions must be allowed_actions=selected, sha_pinning_required, verified_allowed false");
  const thirdParty = new Set<string>();
  for (const use of uses) {
    if (!/@[0-9a-f]{40}$/.test(use)) { out.push(`${use}: not pinned to a full commit SHA`); continue; }
    if (GITHUB_OWNED.test(use)) { if (!a.github_owned_allowed) out.push(`${use}: GitHub-owned actions are not allowed`); continue; }
    thirdParty.add(use);
    if (!a.patterns_allowed.includes(use)) out.push(`${use}: not in .github/expected-settings.json actions.patterns_allowed (add it there and to the repository's allowed actions first)`);
  }
  const indirect = a.indirect ?? {};
  for (const p of a.patterns_allowed) {
    if (thirdParty.has(p)) continue;
    const via = indirect[p];
    if (via === undefined) { out.push(`${p}: allowed but used by no workflow (remove it from the settings and the file)`); continue; }
    const caller = via.match(/called by (\S+)$/)?.[1] ?? "";
    if (!caller || ![...thirdParty].some((u) => u.endsWith(`/${caller}`))) out.push(`${p}: its caller ${caller} is no longer used at that SHA`);
  }
  for (const k of Object.keys(indirect)) if (!a.patterns_allowed.includes(k)) out.push(`${k}: listed as indirect but not allowed`);
  return out;
}

const files = fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));
const allUses = files.flatMap((f) => usesOf(fs.readFileSync(path.join(WORKFLOWS, f), "utf8")));
let passed = 0;
const ok = (name: string): void => { passed++; console.log(`  ok  ${name}`); };

assert.ok(allUses.length > 10, "the workflows were read");
assert.deepEqual(problems(allUses, settings), []);
ok(`all ${allUses.length} action references are SHA-pinned and allowed by .github/expected-settings.json`);

const bump = allUses.map((u) => (u.startsWith("zizmorcore/") ? u.replace(/@[0-9a-f]{40}$/, "@" + "1".repeat(40)) : u));
assert.ok(problems(bump, settings).some((p) => /zizmorcore\/zizmor-action@1{40}: not in/.test(p)), "a bumped third-party pin without a settings change fails");
assert.ok(problems(bump, settings).some((p) => /zizmorcore\/zizmor-action@[0-9a-f]{40}: allowed but used by no workflow/.test(p)), "the old pin left in the list fails");
assert.ok(problems([...allUses, "some/action@v1"], settings).some((p) => /not pinned/.test(p)), "a tag reference fails");
const reusableBump = allUses.map((u) => (u.includes("osv-scanner-reusable.yml@") ? u.replace(/@[0-9a-f]{40}$/, "@" + "2".repeat(40)) : u));
assert.ok(problems(reusableBump, settings).some((p) => /caller .* is no longer used/.test(p)), "an indirect pin whose caller moved fails");
ok("a pin bump without the settings change, a stale entry, a tag reference and a moved reusable caller each fail");

console.log(`pin-allowlist smoke: ${passed} checks passed`);
