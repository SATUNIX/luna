#!/usr/bin/env node
// Offline checks for memory-vault (no model, no network: the recap model is a stub).
//   1. save creates a note; the same or a near-duplicate memory updates it instead of copying.
//   2. recall is scoped: this project + global, never another project's memories.
//   3. relevance gating: stopword-only prompts and single shared words inject nothing.
//   4. concurrent writers in separate processes lose nothing.
//   5. per-turn recaps: substantive turns are recapped into Projects/<p>/Recaps/<date>.md,
//      flagged decisions are promoted, trivial turns and subagent children are skipped.
//   6. recall injection: continuity on the first prompt, each memory at most once per session,
//      delivered as a hidden message (never a system prompt).
//   7. secrets are redacted before anything is written.
//   8. memory-local's store is imported exactly once.
//   9. Obsidian compatibility: frontmatter round-trips; MEMORY.md and the hub use wikilinks.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.mjs";

const run = promisify(execFile);
const ws = tmpWorkspace("pi-kit-memory-vault-");
const vaultRoot = path.join(ws, "vault");
const restores = [isolateKitEnv(), setEnv("PI_KIT_VAULT", vaultRoot), setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")), setEnv("PI_KIT_INTERNAL_CHILD", undefined), setEnv("PI_KIT_MEMORY_DIR", undefined)];
let checks = 0;
const ok = (label) => {
  checks++;
  console.log(`  OK: ${label}`);
};

try {
  const vault = await loadModule("extensions/memory-vault/vault.ts");
  const ext = await loadModule("extensions/memory-vault/index.ts");

  // 1. Save / update / dedupe.
  {
    const a = vault.saveMemory(vaultRoot, { title: "Prefers small scoped commits", body: "The user wants small, scoped commits with a why in the body.", type: "preference", project: "alpha" });
    assert.equal(a.action, "created");
    assert.equal(a.rel, path.join("Projects", "alpha", "Memory", "prefers-small-scoped-commits.md"));
    const b = vault.saveMemory(vaultRoot, { title: "Prefers small scoped commits", body: "Small scoped commits; explain the why.", type: "preference", project: "alpha", tags: ["git"] });
    assert.equal(b.action, "updated");
    const c = vault.saveMemory(vaultRoot, { title: "Small scoped commits preferred", body: "The user wants small scoped commits with a why in the body.", project: "alpha" });
    assert.equal(c.action, "updated", "a near-duplicate updates the existing note");
    assert.equal(fs.readdirSync(path.join(vaultRoot, "Projects", "alpha", "Memory")).length, 1);
    ok("save creates, and same/near-duplicate memories update in place");
  }

  // 2 + 3. Scoping and gating.
  {
    vault.saveMemory(vaultRoot, { title: "Hyprland crash workaround", body: "Waybar crashes Hyprland when the tray module reloads; disable tray reload.", type: "gotcha", project: "dotfiles" });
    vault.saveMemory(vaultRoot, { title: "Uses bun for scripts", body: "Scripts in every repo run with bun, not npm.", type: "preference", scope: "global", project: "alpha" });
    const inAlpha = vault.searchMemories(vaultRoot, "hyprland waybar crash", { project: "alpha" });
    assert.equal(inAlpha.length, 0, "another project's memories are never recalled");
    const inDot = vault.searchMemories(vaultRoot, "hyprland waybar crash", { project: "dotfiles", gate: true });
    assert.equal(inDot[0]?.meta.title, "Hyprland crash workaround");
    const global = vault.searchMemories(vaultRoot, "run scripts with bun", { project: "dotfiles", gate: true });
    assert.ok(global.some((h) => h.meta.title === "Uses bun for scripts"), "global memories are recalled in every project");
    assert.deepEqual(vault.searchMemories(vaultRoot, "what is the and is it for you", { project: "alpha", gate: true }), [], "stopword-only prompts recall nothing");
    assert.deepEqual(vault.searchMemories(vaultRoot, "please review the commits in the auth refactor branch", { project: "alpha", gate: true, minScore: 1.5 }), [], "one shared common word is not relevance");
    ok("recall is project/global scoped and relevance-gated");
  }

  // 4. Concurrent writers (separate processes).
  {
    const compiled = path.join(ROOT, "node_modules", ".cache", "pi-kit-eval", "packages_extensions_src_memory-vault_vault.mjs");
    const script = path.join(ws, "writer.mjs");
    // Distinct content words per write (digits are not content words, so "note 1"/"note 2"
    // would rightly be merged as duplicates).
    const words = ["amber", "birch", "cobalt", "dune", "ember", "fjord", "glacier", "harbor", "indigo", "jasper", "kelp", "lagoon", "marble", "nectar", "onyx", "prairie", "quartz", "reef", "sierra", "tundra"];
    fs.writeFileSync(script, `const v = await import(${JSON.stringify(new URL(`file://${compiled}`).href)}); const words = ${JSON.stringify(words)}; const i = Number(process.argv[2]); for (let k = 0; k < 5; k++) { const w = words[i * 5 + k]; v.saveMemory(process.env.PI_KIT_VAULT, { title: "Concurrent " + w + " memory", body: "Writer notes about " + w + " only.", project: "conc" }); }`);
    await Promise.all([0, 1, 2, 3].map((i) => run(process.execPath, [script, String(i)], { env: process.env })));
    const files = fs.readdirSync(path.join(vaultRoot, "Projects", "conc", "Memory"));
    assert.equal(files.length, 20, `4 processes x 5 writes must all land (got ${files.length})`);
    ok("concurrent writers in separate processes lose nothing");
  }

  // 5 + 6. Recaps and recall injection through the extension.
  {
    const repo = path.join(ws, "beta");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const calls = [];
    const reply = JSON.stringify({ title: "Fix login redirect", did: "Fixed the redirect loop in auth.ts.", next: "Add a regression test.", decisions: ["Keep redirects server-side"], memory_candidates: [{ type: "decision", title: "Redirects stay server-side", body: "Auth redirects are handled server-side because the SPA router loops." }, { type: "fact", title: "ignored fact", body: "not promoted" }] });
    const pi = fakePi();
    ext.createMemoryVault(pi.api, { complete: async (system, prompt) => { calls.push({ system, prompt }); return `Here you go:\n${reply}`; }, now: () => new Date(2026, 8, 23, 14, 5) });
    const statuses = [];
    const ctx = { cwd: repo, hasUI: true, ui: { notify() {}, setStatus: (k, v) => statuses.push([k, v]) }, sessionManager: { getSessionId: () => "sess-1" } };
    await pi.handlers.get("session_start")({}, ctx);
    const turn = [
      { role: "user", content: [{ type: "text", text: "fix the login redirect loop" }] },
      { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: "src/auth.ts" } }] },
      { role: "toolResult", content: [{ type: "text", text: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "Fixed." }] },
    ];
    await pi.handlers.get("agent_end")({ messages: turn }, ctx);
    await pi.handlers.get("agent_end")({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "Hello!" }] }] }, ctx);
    await pi.handlers.get("session_shutdown")({}, ctx);
    assert.equal(calls.length, 1, "trivial turns are not recapped");
    const recap = fs.readFileSync(path.join(vaultRoot, "Projects", "beta", "Recaps", "2026-09-23.md"), "utf8");
    assert.match(recap, /## 14:05 — Fix login redirect/);
    assert.match(recap, /\*\*Files:\*\* `src\/auth.ts`/);
    assert.match(recap, /\[\[Projects\/beta\/beta\|beta\]\]/);
    const promoted = fs.readdirSync(path.join(vaultRoot, "Projects", "beta", "Memory"));
    assert.deepEqual(promoted, ["redirects-stay-server-side.md"], "decisions are promoted; plain facts are not");
    assert.ok(statuses.some(([k, v]) => k === "memory" && /Fix login redirect/.test(v)));

    // A new session: continuity on the first prompt, relevant memory once.
    const pi2 = fakePi();
    ext.createMemoryVault(pi2.api, { complete: async () => reply });
    await pi2.handlers.get("session_start")({}, ctx);
    const first = await pi2.handlers.get("before_agent_start")({ prompt: "continue with the auth redirects work", systemPrompt: "SYS" }, ctx);
    assert.equal(first.systemPrompt, undefined, "memory never rewrites the system prompt");
    assert.equal(first.message.display, false);
    assert.match(first.message.content, /Where we left off \(beta\)/);
    assert.match(first.message.content, /Redirects stay server-side/);
    const second = await pi2.handlers.get("before_agent_start")({ prompt: "more on the auth redirects server-side please", systemPrompt: "SYS" }, ctx);
    assert.equal(second, undefined, "an already-injected memory is not injected again");

    // Children neither recap nor recall.
    const restoreChild = setEnv("PI_KIT_INTERNAL_CHILD", "1");
    try {
      const pi3 = fakePi();
      const childCalls = [];
      ext.createMemoryVault(pi3.api, { complete: async () => { childCalls.push(1); return reply; } });
      await pi3.handlers.get("session_start")({}, ctx);
      assert.equal(await pi3.handlers.get("before_agent_start")({ prompt: "auth redirects server-side", systemPrompt: "S" }, ctx), undefined);
      await pi3.handlers.get("agent_end")({ messages: turn }, ctx);
      await pi3.handlers.get("session_shutdown")({}, ctx);
      assert.equal(childCalls.length, 0);
    } finally {
      restoreChild();
    }
    ok("recaps land in the daily log, decisions are promoted, recall is once-per-session, children are skipped");
  }

  // 7. Redaction.
  {
    const r = vault.saveMemory(vaultRoot, { title: "Deploy token location", body: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789 and sk-ant-api03-SECRETSECRETSECRETSECRET", project: "alpha" });
    const saved = fs.readFileSync(r.file, "utf8");
    assert.doesNotMatch(saved, /ghp_abcdef|SECRETSECRET/);
    assert.match(saved, /\[REDACTED\]/);
    ok("secrets are redacted before writing");
  }

  // 8. memory-local migration, once.
  {
    const legacy = path.join(ws, "agent", "memory-local");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "memories.json"), JSON.stringify([{ id: "1", text: "Hyprland crashes after sleep. Restart waybar.", tags: ["hyprland"], createdAt: "x" }]));
    assert.equal(vault.migrateMemoryLocal(vaultRoot, "alpha"), 1);
    assert.equal(vault.migrateMemoryLocal(vaultRoot, "alpha"), 0, "migration runs once");
    assert.ok(fs.existsSync(path.join(vaultRoot, "Memory", "hyprland-crashes-after-sleep.md")));
    ok("memory-local store imported exactly once");
  }

  // 9. Obsidian compatibility.
  {
    const file = path.join(vaultRoot, "Projects", "alpha", "Memory", "prefers-small-scoped-commits.md");
    const note = vault.parseNote(fs.readFileSync(file, "utf8"), file);
    assert.equal(note.meta.type, "preference");
    assert.deepEqual(note.meta.tags, ["git"]);
    assert.match(fs.readFileSync(file, "utf8"), /^---\nid: prefers-small-scoped-commits\ntitle: Prefers small scoped commits\n/);
    const index = fs.readFileSync(path.join(vaultRoot, "MEMORY.md"), "utf8");
    assert.match(index, /\[\[Projects\/alpha\/Memory\/prefers-small-scoped-commits\|Prefers small scoped commits\]\]/);
    assert.match(fs.readFileSync(path.join(vaultRoot, "Projects", "beta", "beta.md"), "utf8"), /\[\[Projects\/beta\/Recaps\/2026-09-23\|2026-09-23\]\]/);
    const forgot = vault.forgetMemory(vaultRoot, "deploy-token-location", "alpha");
    assert.ok(forgot && fs.readdirSync(path.join(vaultRoot, ".trash")).length === 1, "forget moves the note to .trash");
    ok("frontmatter round-trips; MEMORY.md and hubs use wikilinks; forget is recoverable");
  }

  // 10. A valid-JSON index entry that keeps the real mtime but lacks meta/tf/len/tokens must
  //     be rejected, not trusted, or callers crash on e.meta.
  {
    const guardRoot = path.join(ws, "vault-badindex");
    const saved = vault.saveMemory(guardRoot, { title: "Zorblat protocol quirk", body: "The zorblat protocol needs frobnicating twice before it settles.", project: "guard" });
    const mtimeMs = fs.statSync(saved.file).mtimeMs;
    const indexFile = path.join(guardRoot, ".pi-index", "index.json");
    fs.writeFileSync(indexFile, JSON.stringify({ version: 1, notes: { [saved.rel]: { mtimeMs } } }));
    let hits;
    assert.doesNotThrow(() => {
      hits = vault.searchMemories(guardRoot, "zorblat protocol", { project: "guard" });
    }, "a malformed cached entry must not crash searchMemories");
    assert.ok(hits.some((h) => h.meta.title === "Zorblat protocol quirk"), "the note is still found after the index is rebuilt");
    let found;
    assert.doesNotThrow(() => {
      found = vault.findMemory(guardRoot, saved.id, "guard");
    }, "a malformed cached entry must not crash findMemory");
    assert.equal(found?.meta.id, saved.id);
    ok("malformed cached index entries are rejected and rebuilt");
  }

  // 11. A cached entry that keeps the note's real mtime but has a partial `meta` (title only,
  //     no `tags`) must be rejected, not trusted: writeIndexPages reads e.meta.tags.length, so
  //     trusting it makes the next save throw until .pi-index/index.json is deleted.
  {
    const metaRoot = path.join(ws, "vault-meta-tags");
    const first = vault.saveMemory(metaRoot, { title: "Quokka cache invariant", body: "The quokka cache carries every tag.", tags: ["marsupial"], project: "guard" });
    const indexFile = path.join(metaRoot, ".pi-index", "index.json");
    const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    const entry = index.notes[first.rel];
    index.notes[first.rel] = { ...entry, meta: { title: entry.meta.title } };
    fs.writeFileSync(indexFile, JSON.stringify(index));
    let later;
    assert.doesNotThrow(() => {
      later = vault.saveMemory(metaRoot, { title: "Wombat logging invariant", body: "Wombat logging always includes the request id.", project: "guard" });
    }, "a cached entry missing meta.tags must not break the next save");
    assert.equal(later.action, "created");
    const hits = vault.searchMemories(metaRoot, "quokka cache tags", { project: "guard", gate: true });
    assert.ok(hits.some((h) => h.meta.title === "Quokka cache invariant"), "the tampered note is still searchable");
    const rebuilt = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    assert.ok(Array.isArray(rebuilt.notes[first.rel].meta.tags), "the rebuilt index still carries the note's tags");
    ok("a cached entry missing meta.tags is rejected and the index is rebuilt");
  }

  console.log(`[memory-vault-smoke] all ${checks} checks passed`);
} finally {
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
