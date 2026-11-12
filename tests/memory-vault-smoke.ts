#!/usr/bin/env node
// Offline checks for memory-vault (no model, no network: the recap model is a stub).
//   1. save creates a note; the same or a near-duplicate memory updates it instead of copying.
//   2. recall is scoped: this project + global, never another project's memories.
//   3. relevance gating: stopword-only prompts and single shared words inject nothing.
//   4. concurrent writers in separate processes lose nothing.
//   5. per-turn recaps: substantive turns are recapped into Projects/<p>/Recaps/<date>.md,
//      flagged decisions are promoted (project-scoped, never global), trivial turns and
//      subagent children are skipped.
//   6. recall injection: continuity on the first prompt, each memory at most once per session per
//      unchanged content, delivered as a hidden message (never a system prompt).
//  6b. a note updated mid-session (memory_save or /remember) is offered again with its new body.
//   7. secrets are redacted before anything is written.
//   8. memory-local's store is imported exactly once; a malformed or unreadable store is not
//      tombstoned, so a repaired store imports on the next call.
//   9. Obsidian compatibility: frontmatter round-trips; MEMORY.md and the hub use wikilinks.
//  12. projects are keyed by canonical root, so same-named repositories never share recall;
//      symlinked roots never split, a moved root is reported rather than taken over.
//  13. the first-prompt recall is framed as background history, never a resume prompt; a huge
//      recap body is truncated with the header and footer kept; oversized recaps leave room
//      for pinned/relevant memories, and with none present the recap is still truncated.
//  14. oversized recaps with no pinned or matching memory are truncated, not dropped.
//  15. pinned memories that outrank a relevant one do not crowd it out of the first-prompt recall.
//  16. the stemmer makes inflectional forms meet: exact outputs, and a memory saved with a plural
//      is found by a singular query and vice versa.
//  17. a throw during first-prompt recall does not consume the first-prompt flag: the
//      earlier-session recap is still offered on the next turn.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evalCacheDir, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.ts";
import type * as Vault from "../packages/extensions/src/memory-vault/vault.ts";
import type * as Search from "../packages/extensions/src/memory-vault/search.ts";
import type { MemoryVaultDeps } from "../packages/extensions/src/memory-vault/index.ts";
import { isRecord, object, optional, parseJson, parseJsonAs, record, unknownValue } from "../packages/core/lib/guard.ts";
import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";

/** memory-vault's before_agent_start result when it injects: a hidden text message, never a system prompt. */
type Recall = BeforeAgentStartEventResult & { message: { display: boolean; content: string } };

// The on-disk search index (.pi-index/index.json), as far as the rebuild check reads it.
const IndexFile = object({ notes: record(object({ meta: object({ tags: optional(unknownValue()) }) })) });

/** The memory-vault extension as the test drives it: createMemoryVault is called with the fake pi API. */
interface MemoryVaultExtension {
  createMemoryVault(api: unknown, deps?: MemoryVaultDeps): void;
}

const run = promisify(execFile);
const ws = tmpWorkspace("pi-kit-memory-vault-");
const vaultRoot = path.join(ws, "vault");
const restores = [isolateKitEnv(), setEnv("PI_KIT_VAULT", vaultRoot), setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")), setEnv("PI_KIT_INTERNAL_CHILD", undefined), setEnv("PI_KIT_MEMORY_DIR", undefined)];
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

try {
  const vault = await loadModule<typeof Vault>("extensions/memory-vault/vault.ts");
  const ext = await loadModule<MemoryVaultExtension>("extensions/memory-vault/index.ts");
  const search = await loadModule<typeof Search>("extensions/memory-vault/search.ts");

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
    const compiled = path.join(evalCacheDir(), "packages_extensions_src_memory-vault_vault.mjs");
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
    const calls: Array<{ system: string; prompt: string }> = [];
    const reply = JSON.stringify({ title: "Fix login redirect", did: "Fixed the redirect loop in auth.ts.", next: "Add a regression test.", decisions: ["Keep redirects server-side"], memory_candidates: [{ type: "decision", title: "Redirects stay server-side", body: "Auth redirects are handled server-side because the SPA router loops." }, { type: "preference", title: "Prefers tabs for indentation", body: "Indent new files with tabs." }, { type: "fact", title: "ignored fact", body: "not promoted" }] });
    const pi = fakePi();
    ext.createMemoryVault(pi.api, { complete: async (system: string, prompt: string) => { calls.push({ system, prompt }); return `Here you go:\n${reply}`; }, now: () => new Date(2026, 8, 23, 14, 5) });
    const statuses: Array<[string, string]> = [];
    const ctx = { cwd: repo, hasUI: true, ui: { notify() {}, setStatus: (k: string, v: string) => statuses.push([k, v]) }, sessionManager: { getSessionId: () => "sess-1" } };
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
    assert.deepEqual(promoted.sort(), ["prefers-tabs-for-indentation.md", "redirects-stay-server-side.md"], "decisions and preferences are promoted; plain facts are not");
    assert.ok(!fs.existsSync(path.join(vaultRoot, "Memory", "prefers-tabs-for-indentation.md")), "an auto-promoted preference stays in its project, never global");
    assert.ok(statuses.some(([k, v]) => k === "memory" && /Fix login redirect/.test(v)));

    // A new session: continuity on the first prompt, relevant memory once.
    const pi2 = fakePi();
    ext.createMemoryVault(pi2.api, { complete: async () => reply });
    await pi2.handlers.get("session_start")({}, ctx);
    // A run started by an extension custom message must not consume the first-user-prompt recall.
    const custom = await pi2.handlers.get("before_agent_start")({ messageType: "custom", message: { customType: "x", content: "hi" }, systemPrompt: "SYS" }, ctx);
    assert.equal(custom, undefined, "a custom-message run recalls nothing and keeps the first-user-prompt flag");
    const first = (await pi2.handlers.get("before_agent_start")({ prompt: "continue with the auth redirects work", systemPrompt: "SYS" }, ctx)) as Recall;
    assert.equal(first.systemPrompt, undefined, "memory never rewrites the system prompt");
    assert.equal(first.message.display, false);
    assert.match(first.message.content, /Earlier sessions \(beta\) - history only/);
    assert.match(first.message.content, /Redirects stay server-side/);
    const second = await pi2.handlers.get("before_agent_start")({ prompt: "more on the auth redirects server-side please", systemPrompt: "SYS" }, ctx);
    assert.equal(second, undefined, "an already-injected memory is not injected again");

    // Children neither recap nor recall.
    const restoreChild = setEnv("PI_KIT_INTERNAL_CHILD", "1");
    try {
      const pi3 = fakePi();
      const childCalls: number[] = [];
      ext.createMemoryVault(pi3.api, { complete: async () => { childCalls.push(1); return reply; } });
      await pi3.handlers.get("session_start")({}, ctx);
      assert.equal(await pi3.handlers.get("before_agent_start")({ prompt: "auth redirects server-side", systemPrompt: "S" }, ctx), undefined);
      await pi3.handlers.get("agent_end")({ messages: turn }, ctx);
      await pi3.handlers.get("session_shutdown")({}, ctx);
      assert.equal(childCalls.length, 0);
    } finally {
      restoreChild();
    }
    ok("recaps land in the daily log, decisions are promoted (project-scoped), recall is once-per-session, children are skipped");
  }

  // 6b. A note updated mid-session is offered again with its new body. saveMemory rewrites the
  //     note in place and returns the same rel, so a path-only once-per-session record hid the
  //     fresh body for the rest of the session. On the base the second recall is undefined.
  {
    const updateRoot = path.join(ws, "vault-updated-recall");
    const repo = path.join(ws, "updated-recall");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const restoreUpdateVault = setEnv("PI_KIT_VAULT", updateRoot);
    const restoreUpdateFloor = setEnv("PI_KIT_MEMORY_MIN_SCORE", "0.1");
    try {
      const pi = fakePi();
      ext.createMemoryVault(pi.api, { complete: async () => "{}" });
      const ctx = { cwd: repo, hasUI: false, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => "sess-updated-recall" } };
      await pi.handlers.get("session_start")({}, ctx);
      // Resolve the key the extension recorded rather than guessing the folder basename.
      const project = vault.resolveProject(updateRoot, repo);
      vault.saveMemory(updateRoot, { title: "Deploy target selection", body: "Deploy to the amber cluster by default.", project });
      const first = (await pi.handlers.get("before_agent_start")({ prompt: "which cluster do we deploy to", systemPrompt: "SYS" }, ctx)) as Recall;
      assert.match(first.message.content, /amber cluster/);
      vault.saveMemory(updateRoot, { title: "Deploy target selection", body: "Deploy to the birch cluster now; the amber cluster is retired.", project });
      const second = (await pi.handlers.get("before_agent_start")({ prompt: "which cluster do we deploy to now", systemPrompt: "SYS" }, ctx)) as Recall;
      assert.ok(second, "an updated memory is offered again in the same session");
      assert.match(second.message.content, /birch cluster now/);
      assert.doesNotMatch(second.message.content, /amber cluster by default/);
    } finally {
      restoreUpdateFloor();
      restoreUpdateVault();
    }
    ok("an updated memory is offered again with its new body in the same session");
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

  // 8b. A malformed store is not tombstoned: no marker, and a repaired store imports next call.
  {
    const repairRoot = path.join(ws, "vault-repair");
    const legacy = path.join(ws, "agent", "memory-local");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "memories.json"), "{ not json");
    assert.equal(vault.migrateMemoryLocal(repairRoot, "alpha"), 0, "an unreadable store imports nothing");
    assert.ok(!fs.existsSync(path.join(repairRoot, ".pi-index", "migrated-memory-local")), "an unreadable store leaves no migration marker");
    fs.writeFileSync(path.join(legacy, "memories.json"), JSON.stringify([{ id: "1", text: "A repaired memory-local store imports on the next call.", tags: [] }]));
    assert.equal(vault.migrateMemoryLocal(repairRoot, "alpha"), 1, "the repaired store imports");
    ok("a malformed memory-local store is retried, not tombstoned");
  }

  // 9. Obsidian compatibility.
  {
    const file = path.join(vaultRoot, "Projects", "alpha", "Memory", "prefers-small-scoped-commits.md");
    const note = vault.parseNote(fs.readFileSync(file, "utf8"), file);
    assert.ok(note);
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
    let hits: Vault.SearchHit[] | undefined;
    assert.doesNotThrow(() => {
      hits = vault.searchMemories(guardRoot, "zorblat protocol", { project: "guard" });
    }, "a malformed cached entry must not crash searchMemories");
    assert.ok(hits);
    assert.ok(hits.some((h) => h.meta.title === "Zorblat protocol quirk"), "the note is still found after the index is rebuilt");
    let found: ReturnType<typeof Vault.findMemory> | undefined;
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
    // Tampered in place as raw JSON, so every other field of the index survives the rewrite.
    const index = parseJson(fs.readFileSync(indexFile, "utf8"));
    assert.ok(isRecord(index) && isRecord(index.notes), "the index has a notes map");
    const entry = index.notes[first.rel];
    assert.ok(isRecord(entry) && isRecord(entry.meta), "the saved note is indexed with its meta");
    index.notes[first.rel] = { ...entry, meta: { title: entry.meta.title } };
    fs.writeFileSync(indexFile, JSON.stringify(index));
    let later: Vault.SaveResult | undefined;
    assert.doesNotThrow(() => {
      later = vault.saveMemory(metaRoot, { title: "Wombat logging invariant", body: "Wombat logging always includes the request id.", project: "guard" });
    }, "a cached entry missing meta.tags must not break the next save");
    assert.ok(later);
    assert.equal(later.action, "created");
    const hits = vault.searchMemories(metaRoot, "quokka cache tags", { project: "guard", gate: true });
    assert.ok(hits.some((h) => h.meta.title === "Quokka cache invariant"), "the tampered note is still searchable");
    const rebuilt = parseJsonAs(IndexFile, fs.readFileSync(indexFile, "utf8"), indexFile);
    assert.ok(Array.isArray(rebuilt.notes[first.rel]?.meta.tags), "the rebuilt index still carries the note's tags");
    ok("a cached entry missing meta.tags is rejected and the index is rebuilt");
  }

  // 12. Projects are keyed by their canonical root, not just the directory name: a same-named
  //     repository elsewhere gets its own folder and never sees the other's recaps or
  //     memories, while a folder written before ownership was recorded stays with the root
  //     that opens it first (nothing is moved or deleted).
  {
    const keyRoot = path.join(ws, "vault-keys");
    const legacy = vault.saveMemory(keyRoot, { title: "Acme staging bastion", body: "Acme deploys go through the client staging bastion.", project: "api" });
    vault.appendRecap(keyRoot, "api", { title: "Acme deploy pipeline", did: "Wired the acme deploy pipeline." }, new Date(2026, 8, 20, 9, 0));
    const mine = path.join(ws, "work", "api");
    const other = path.join(ws, "clients", "acme", "api");
    for (const d of [mine, other]) fs.mkdirSync(path.join(d, ".git"), { recursive: true });
    fs.mkdirSync(path.join(mine, "src"), { recursive: true });
    const link = path.join(ws, "api-link");
    fs.symlinkSync(mine, link);
    assert.equal(vault.resolveProject(keyRoot, path.join(mine, "src")), "api", "the first root to open an unowned folder keeps it, from any subdirectory");
    assert.equal(vault.resolveProject(keyRoot, link), "api", "a symlink to the same root resolves to the same project");
    const otherKey = vault.resolveProject(keyRoot, other);
    assert.match(otherKey, /^api-[0-9a-f]{12}$/, "a same-named root elsewhere gets a hashed key");
    assert.equal(vault.resolveProject(keyRoot, other), otherKey, "the hashed key is stable");
    assert.equal(vault.resolveProject(keyRoot, mine), "api", "the first root keeps its folder after the other claims its own");
    assert.ok(fs.existsSync(legacy.file), "the pre-existing memory is kept in place");
    assert.deepEqual(vault.searchMemories(keyRoot, "acme staging bastion deploys", { project: otherKey }), [], "the other root never recalls the first root's memories");
    assert.ok(vault.searchMemories(keyRoot, "acme staging bastion deploys", { project: "api" }).some((h) => h.rel === legacy.rel), "the first root still recalls its memories");
    assert.deepEqual(vault.recentRecaps(keyRoot, otherKey, 3), [], "the other root never gets the first root's recaps");

    // Through the extension: the first prompt in the same-named repository has no continuity.
    const restoreVault = setEnv("PI_KIT_VAULT", keyRoot);
    try {
      const say = async (cwd: string): Promise<unknown> => {
        const p = fakePi();
        ext.createMemoryVault(p.api, { complete: async () => "{}" });
        const c = { cwd, hasUI: false, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => "sess-keys" } };
        await p.handlers.get("session_start")({}, c);
        return p.handlers.get("before_agent_start")({ prompt: "continue the acme deploy pipeline via the staging bastion", systemPrompt: "SYS" }, c);
      };
      assert.equal(await say(other), undefined, "nothing from the first root is injected into the same-named repository");
      const back = (await say(mine)) as Recall;
      assert.match(back.message.content, /Earlier sessions \(api\) - history only/);
      assert.match(back.message.content, /Acme deploy pipeline/);
    } finally {
      restoreVault();
    }
    ok("projects are keyed by canonical root; same-named repositories never share recaps or memories");

    // A root first opened through a symlink with another name keeps that folder from the real path too.
    const svc = path.join(ws, "c", "svc");
    fs.mkdirSync(path.join(svc, ".git"), { recursive: true });
    const svcLink = path.join(ws, "svc-link");
    fs.symlinkSync(svc, svcLink);
    assert.equal(vault.resolveProject(keyRoot, svcLink), "svc-link", "the first path to open a root names its folder");
    assert.equal(vault.resolveProject(keyRoot, svc), "svc-link", "the real path finds the folder its symlink claimed");
    assert.equal(vault.resolveProject(keyRoot, svcLink), "svc-link", "and the symlink keeps it");
    assert.ok(!fs.existsSync(path.join(keyRoot, "Projects", "svc")), "no second folder is claimed for the same root");

    // An owner already recorded is found without the vault lock, so a held lock never forks it.
    const lock = path.join(keyRoot, ".pi-index", "lock");
    fs.writeFileSync(lock, "1");
    try {
      const started = Date.now();
      assert.equal(vault.resolveProject(keyRoot, mine), "api", "a recorded owner resolves while the lock is held");
      assert.ok(Date.now() - started < 1000, "resolving a recorded owner does not wait for the lock");
    } finally {
      fs.rmSync(lock, { force: true });
    }

    // A moved repository is not silently orphaned: its new path gets a hashed key (the old folder
    // is not taken over) and the operator is told how to reassign the old folder.
    const moved = path.join(ws, "moved", "api");
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(mine, moved);
    const notices: string[] = [];
    const restoreMoved = setEnv("PI_KIT_VAULT", keyRoot);
    try {
      const p = fakePi();
      ext.createMemoryVault(p.api, { complete: async () => "{}" });
      await p.handlers.get("session_start")({}, { cwd: moved, hasUI: true, ui: { notify: (m: string) => notices.push(m), setStatus() {} }, sessionManager: { getSessionId: () => "sess-moved" } });
    } finally {
      restoreMoved();
    }
    const movedKey = vault.resolveProject(keyRoot, moved);
    assert.match(movedKey, /^api-[0-9a-f]{12}$/, "the moved root does not take over the old folder");
    assert.equal(notices.length, 1, "the session UI is told the old owner path is gone");
    assert.ok(notices[0]?.includes(`Projects/api/.pi-project.json`) && notices[0].includes(JSON.stringify(fs.realpathSync(moved))), "the notice names the record and the path to set");
    assert.match(fs.readFileSync(path.join(keyRoot, ".pi-index", "errors.log"), "utf8"), /Projects\/api\/ belongs to .*which no longer exists/);
    fs.writeFileSync(path.join(keyRoot, "Projects", "api", ".pi-project.json"), `${JSON.stringify({ path: fs.realpathSync(moved) })}\n`);
    assert.equal(vault.resolveProject(keyRoot, moved), "api", "editing the record reassigns the old folder and its history");
    fs.renameSync(moved, mine);
    fs.writeFileSync(path.join(keyRoot, "Projects", "api", ".pi-project.json"), `${JSON.stringify({ path: fs.realpathSync(mine) })}\n`);

    // forget/find prefer this project's note, then global, never a same-named root's "api-<hash>".
    vault.saveMemory(keyRoot, { title: "Shared ref note", body: "Global copy.", scope: "global", project: "api" });
    const sibling = vault.saveMemory(keyRoot, { title: "Shared ref note", body: "The other api repository's copy.", project: otherKey });
    assert.equal(vault.findMemory(keyRoot, "shared-ref-note", "api")?.rel, path.join("Memory", "shared-ref-note.md"), "a hashed sibling is not treated as the current project");
    assert.equal(vault.findMemory(keyRoot, "shared-ref-note", otherKey)?.rel, sibling.rel);
    ok("symlinked roots never split; recorded owners skip the lock; moved roots are reported; find never favours a hashed sibling");
  }

  // 13. A greeting must not read as "resume old work": the first-prompt recall is framed as
  //     background history, and truncation of a huge body keeps the header and the footer.
  {
    const truncRoot = path.join(ws, "vault-trunc");
    const repo = path.join(ws, "trunc");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const restoreTrunc = setEnv("PI_KIT_VAULT", truncRoot);
    try {
      const date = new Date(2026, 8, 24, 9, 0);
      const longDid = "Moved the auth module. ".repeat(60);
      const longNext = "Finish migrating the auth module. ".repeat(60);
      for (let i = 0; i < 5; i++) vault.appendRecap(truncRoot, "trunc", { title: `Auth migration ${i}`, did: longDid, next: longNext }, date);
      // Pinned and relevant memories must survive the oversized recaps, and must be marked
      // injected only if their own line survives truncation.
      vault.saveMemory(truncRoot, { title: "Pinned anchor memory", body: "The operator pinned this for every session.", pinned: true, project: "trunc" });
      vault.saveMemory(truncRoot, { title: "Auth migration checkpoint", body: "The auth module migration was paused mid-move; resume it next.", project: "trunc" });
      const recapFile = path.join(truncRoot, "Projects", "trunc", "Recaps", "2026-09-24.md");
      const before = fs.readFileSync(recapFile);
      const pi = fakePi();
      ext.createMemoryVault(pi.api, { complete: async () => "{}" });
      const ctx = { cwd: repo, hasUI: false, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => "sess-trunc" } };
      await pi.handlers.get("session_start")({}, ctx);
      const result = (await pi.handlers.get("before_agent_start")({ prompt: "hello, continue the auth migration", systemPrompt: "SYS" }, ctx)) as Recall;
      assert.equal(result.message.display, false);
      assert.equal(result.systemPrompt, undefined);
      assert.ok(result.message.content.startsWith("[Memory vault: background history"), "the recall starts with the history header");
      assert.match(result.message.content, /background history/i);
      assert.match(result.message.content, /not instructions/i);
      assert.match(result.message.content, /current message/i);
      assert.doesNotMatch(result.message.content, /Where we left off/);
      assert.doesNotMatch(result.message.content, /\*\*Next:\*\*/);
      assert.match(result.message.content, /### Pinned memories/, "the pinned block survives the oversized recaps");
      assert.match(result.message.content, /Pinned anchor memory/, "the pinned memory survives the cap");
      assert.match(result.message.content, /### Relevant memories/, "the relevant block survives the oversized recaps");
      assert.match(result.message.content, /Auth migration checkpoint/, "the relevant memory survives the cap");
      assert.match(result.message.content, /\[End of background history\. Reply to the user's current message\.\]$/);
      assert.ok(result.message.content.length <= 2400, "recall stays within the budget");
      assert.deepEqual(fs.readFileSync(recapFile), before, "the on-disk recap is unchanged");
      ok("a greeting gets background history, not a resume prompt; oversized recaps leave room for pinned and relevant memories");
    } finally {
      restoreTrunc();
    }
  }

  // 14. Oversized recaps with no pinned and no matching memory are still truncated (header,
  //     marker and footer kept), not dropped when the recap cannot share room.
  {
    const soloRoot = path.join(ws, "vault-trunc-solo");
    const repo = path.join(ws, "trunc-solo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const restoreSolo = setEnv("PI_KIT_VAULT", soloRoot);
    try {
      const date = new Date(2026, 8, 24, 9, 0);
      const longDid = "Moved the auth module. ".repeat(60);
      const longNext = "Finish migrating the auth module. ".repeat(60);
      for (let i = 0; i < 5; i++) vault.appendRecap(soloRoot, "trunc-solo", { title: `Solo migration ${i}`, did: longDid, next: longNext }, date);
      const pi = fakePi();
      ext.createMemoryVault(pi.api, { complete: async () => "{}" });
      const ctx = { cwd: repo, hasUI: false, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => "sess-trunc-solo" } };
      await pi.handlers.get("session_start")({}, ctx);
      const result = (await pi.handlers.get("before_agent_start")({ prompt: "hello", systemPrompt: "SYS" }, ctx)) as Recall;
      assert.ok(result.message.content.startsWith("[Memory vault: background history"), "the header survives a recap-only truncation");
      assert.match(result.message.content, /### Earlier sessions/, "an oversized recap is still shown");
      assert.match(result.message.content, /truncated; use memory_search for more/, "the recap is truncated, not dropped");
      assert.match(result.message.content, /\[End of background history\. Reply to the user's current message\.\]$/);
      assert.ok(result.message.content.length <= 2400, "recall stays within the budget");
      ok("oversized recaps alone are truncated, not dropped");
    } finally {
      restoreSolo();
    }
  }

  // 15. Pinned memories ranking above a relevant one must not crowd it out of the first-prompt
  //     recall: the search over-fetches by the pinned count, so filtering the pins (which are
  //     shown in their own block) still leaves a slot for the relevant hit behind them.
  {
    const pinRoot = path.join(ws, "vault-pinned-recall");
    const repo = path.join(ws, "pinned-recall");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const restorePin = setEnv("PI_KIT_VAULT", pinRoot);
    // Keep the relevance floor out of this check: the defect is the over-fetch limit, not the
    // gate, and a lower floor makes every candidate eligible so only the limit decides.
    const restoreFloor = setEnv("PI_KIT_MEMORY_MIN_SCORE", "0.1");
    try {
      // Distinct bodies (a shared body would be deduplicated into one note) that all outrank the
      // non-pinned memory for the query. Three pins fill `recallLimit` on the first turn.
      const markers = ["amber", "birch", "cobalt"];
      for (const marker of markers) vault.saveMemory(pinRoot, { title: `Kestrel migration rollout ${marker}`, body: `Kestrel migration rollout ${marker}.`, pinned: true, project: "pinned-recall" });
      const relevant = vault.saveMemory(pinRoot, { title: "Kestrel migration rollback", body: "A kestrel migration rollout can be rolled back safely.", project: "pinned-recall" });
      const pi = fakePi();
      ext.createMemoryVault(pi.api, { complete: async () => "{}" });
      const ctx = { cwd: repo, hasUI: false, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => "sess-pinned-recall" } };
      await pi.handlers.get("session_start")({}, ctx);
      const result = (await pi.handlers.get("before_agent_start")({ prompt: "kestrel migration rollout", systemPrompt: "SYS" }, ctx)) as Recall;
      assert.match(result.message.content, /### Pinned memories/, "the pinned block is shown");
      assert.match(result.message.content, /### Relevant memories/, "a relevant memory still appears when pinned memories rank above it");
      assert.match(result.message.content, /Kestrel migration rollback/, "the non-pinned relevant memory survives the pinned block");
      assert.ok(result.message.content.includes(`[${relevant.rel}]`), "the relevant memory is named by its rel");
    } finally {
      restoreFloor();
      restorePin();
    }
    ok("pinned memories ranking above a relevant one do not crowd it out of the first-prompt recall");
  }

  // 16. Plurals and singulars meet: the exact stemmer outputs, plus a round trip where a note
  //     saved with a plural is found by the singular query and a note saved with a singular is
  //     found by the plural query. On the base, "files" -> "fil" and "processes" -> "proces",
  //     so neither direction matched; the 4-character case was also broken, since the early
  //     guard returned before the -s rule (minimum 4) could run, leaving "logs" as "logs".
  {
    assert.equal(search.stem("files"), "file");
    assert.equal(search.stem("notes"), "note");
    assert.equal(search.stem("values"), "value");
    assert.equal(search.stem("processes"), "process");
    assert.equal(search.stem("classes"), "class");
    assert.equal(search.stem("addresses"), "address");
    assert.equal(search.stem("commits"), "commit");
    assert.equal(search.stem("response"), "respons");
    assert.equal(search.stem("responses"), "respons");
    assert.equal(search.stem("logs"), "log");
    assert.equal(search.stem("docs"), "doc");
    assert.equal(search.stem("cars"), "car");
    assert.equal(search.stem("cases"), "case");
    const stemRoot = path.join(ws, "vault-stem");
    const pluralNote = vault.saveMemory(stemRoot, { title: "Config files layout", body: "Config files live under the etc directory.", project: "stem" });
    const singularNote = vault.saveMemory(stemRoot, { title: "Process class address", body: "The process class address is stable.", project: "stem" });
    assert.ok(vault.searchMemories(stemRoot, "config file", { project: "stem" }).some((h) => h.rel === pluralNote.rel), "a plural note is found by a singular query");
    assert.ok(vault.searchMemories(stemRoot, "addresses", { project: "stem" }).some((h) => h.rel === singularNote.rel), "a singular note is found by a plural query");
    const logNote = vault.saveMemory(stemRoot, { title: "Server logs rotation", body: "Server logs rotate nightly.", project: "stem" });
    assert.ok(vault.searchMemories(stemRoot, "log", { project: "stem" }).some((h) => h.rel === logNote.rel), "a 4-character plural note is found by the singular query");
    assert.ok(vault.searchMemories(stemRoot, "logs", { project: "stem" }).some((h) => h.rel === logNote.rel), "a 4-character plural note is found by the plural query");
    ok("the stemmer makes singular and plural forms meet in search");
  }

  // 17. A throw during first-prompt recall must not consume the first-prompt flag. The handler
  //     accepts `event.prompt` without a type guard and passes it to searchMemories; a non-string
  //     prompt makes tokenize throw after the flag used to be cleared, and the catch returns
  //     undefined, so the recap and pinned block were never offered again that session. The flag
  //     is now consumed only after recall succeeds (or decides to inject nothing). On the base the
  //     second call returns undefined and this check fails.
  {
    const throwRoot = path.join(ws, "vault-recall-throw");
    const repo = path.join(ws, "recall-throw");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const restoreThrow = setEnv("PI_KIT_VAULT", throwRoot);
    try {
      const project = vault.resolveProject(throwRoot, repo);
      vault.appendRecap(throwRoot, project, { title: "Guard the recall throw", did: "Added the recall guard.", next: "Keep the recap." }, new Date(2026, 8, 24, 9, 0));
      const pi = fakePi();
      ext.createMemoryVault(pi.api, { complete: async () => "{}" });
      const ctx = { cwd: repo, hasUI: false, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => "sess-recall-throw" } };
      await pi.handlers.get("session_start")({}, ctx);
      const thrown = await pi.handlers.get("before_agent_start")({ prompt: 123, systemPrompt: "SYS" }, ctx);
      assert.equal(thrown, undefined, "a malformed prompt is caught, not thrown");
      const recalled = (await pi.handlers.get("before_agent_start")({ prompt: "continue where we left off", systemPrompt: "SYS" }, ctx)) as Recall;
      assert.match(recalled.message.content, /Earlier sessions \(/, "the recap is still offered after the throw");
      assert.match(recalled.message.content, /Guard the recall throw/);
    } finally {
      restoreThrow();
    }
    ok("a throw during first-prompt recall does not consume the first-prompt flag");
  }

  console.log(`[memory-vault-smoke] all ${checks} checks passed`);
} finally {
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
