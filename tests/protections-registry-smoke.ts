#!/usr/bin/env node
// Protections registry: tool-firewall, secret-guard and protected-paths each record their name in
// globalThis[Symbol.for("pi-kit.protections")] once their hooks are installed, so a trusted
// launcher can check that a session loaded its mandatory protections. Offline; no model.
import assert from "node:assert/strict";
import path from "node:path";
import { loadExtension, fakePi, setEnv, tmpWorkspace, rmWorkspace, isolateKitEnv } from "../packages/core/eval/harness.ts";

/** The registry the protections publish: a Set of names with a sorted list() helper. */
interface ProtectionsRegistry extends Set<string> {
  list(): string[];
}

type Factory = (api: unknown) => void;

const KEY = Symbol.for("pi-kit.protections");
// globalThis has no symbol index signature, so the key is read and written through Reflect.
const slot = (): unknown => Reflect.get(globalThis, KEY);
const setSlot = (value: unknown): void => {
  Reflect.set(globalThis, KEY, value);
};
/** A Set of names: what another extension using only the bare global key creates. */
const isNameSet = (value: unknown): value is Set<string> =>
  value instanceof Set && [...value].every((name) => typeof name === "string");
/** A name Set carrying the list() helper the protections install. */
const isRegistry = (value: unknown): value is ProtectionsRegistry =>
  isNameSet(value) && typeof Reflect.get(value, "list") === "function";
const nameSet = (): Set<string> => {
  const value = slot();
  assert.ok(isNameSet(value), "the global key holds a Set of names");
  return value;
};
const protections = (): ProtectionsRegistry => {
  const value = slot();
  assert.ok(isRegistry(value), "the global key holds the protections registry (a Set of names with list())");
  return value;
};
const maybeProtections = (): ProtectionsRegistry | undefined => (slot() === undefined ? undefined : protections());
const ALL = ["protected-paths", "secret-guard", "tool-firewall"];
const ws = tmpWorkspace("pi-kit-protections-");
const restores = [isolateKitEnv(), setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")), setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(ws, "audit.jsonl"))];
let checks = 0;
const ok = (label: string) => {
  checks++;
  console.log(`  OK: ${label}`);
};
const reset = () => {
  Reflect.deleteProperty(globalThis, KEY);
};

const firewall: Factory = await loadExtension("extensions/tool-firewall/index.ts");
const guard: Factory = await loadExtension("extensions/secret-guard/index.ts");
const paths: Factory = await loadExtension("vendor/protected-paths/index.ts");
const loaders: Record<string, Factory> = { "tool-firewall": firewall, "secret-guard": guard, "protected-paths": paths };

try {
  // 1. Nothing is registered until a factory runs; each factory registers at factory time (no
  //    session_start needed) and only its own name.
  reset();
  assert.equal(slot(), undefined);
  for (const [name, factory] of Object.entries(loaders)) {
    const pi = fakePi();
    factory(pi.api);
    const reg = protections();
    assert.ok(reg, `${name} creates the registry when it is the first to load`);
    assert.equal(reg.has(name), true, `${name} registered itself`);
    assert.equal(typeof reg.list, "function");
  }
  assert.deepEqual(protections().list(), ALL, "list() is the sorted set of registered names");
  assert.equal(protections().has("tool-capture"), false, "has() is false for a protection that did not load");
  ok("each protection registers itself at factory time; has()/list() report exactly what loaded");

  // 2. Load order does not matter and a partial load is visible (a launcher can tell what is missing).
  for (const order of [["secret-guard", "protected-paths"], ["protected-paths", "tool-firewall", "secret-guard"]]) {
    reset();
    for (const name of order) {
      const load = loaders[name];
      assert.ok(load, `${name} is a known protection`);
      load(fakePi().api);
    }
    assert.deepEqual(protections().list(), [...order].sort());
    assert.equal(protections().has("tool-firewall"), order.includes("tool-firewall"));
  }
  ok("registration is order independent and a missing protection is visible");

  // 3. /reload-style re-instantiation: the factories run again with a fresh pi API. The registry
  //    stays complete, holds no duplicates, and each fresh instance has its own hooks.
  reset();
  const first = { firewall: fakePi(), guard: fakePi(), paths: fakePi() };
  firewall(first.firewall.api);
  guard(first.guard.api);
  paths(first.paths.api);
  const registry = slot();
  const second = { firewall: fakePi(), guard: fakePi(), paths: fakePi() };
  firewall(second.firewall.api);
  guard(second.guard.api);
  paths(second.paths.api);
  assert.equal(slot(), registry, "the registry object survives re-instantiation");
  assert.deepEqual(protections().list(), ALL);
  assert.equal(protections().size, 3, "no duplicate entries after a reload");
  for (const p of Object.values(second)) assert.equal(typeof p.handlers.get("tool_call"), "function", "the re-instantiated protection installed its hook");
  ok("registered again after a /reload-style re-instantiation, without duplicates");

  // 4. A factory that fails before its hooks are installed does not register (a launcher must not be
  //    told a protection is present when it never armed).
  reset();
  const broken = { on() { throw new Error("cannot install hook"); }, registerTool() {}, registerCommand() {} };
  for (const [name, factory] of Object.entries(loaders)) {
    assert.throws(() => factory(broken), /cannot install hook/);
    assert.equal(maybeProtections()?.has(name) ?? false, false, `${name} must not register when its hook could not be installed`);
  }
  ok("a protection whose hooks failed to install is not registered");

  // 5. A foreign or stale object under the key never prevents registration and never breaks a protection.
  for (const foreign of [new Set(["legacy"]), {}, "junk", 42, null]) {
    setSlot(foreign);
    guard(fakePi().api);
    const reg = protections();
    assert.equal(reg.has("secret-guard"), true);
    assert.equal(typeof reg.list, "function");
    assert.ok(reg.list().includes("secret-guard"));
  }
  setSlot(Object.freeze(new Set()));
  assert.doesNotThrow(() => firewall(fakePi().api), "an unusable registry must not break the protection itself");
  ok("a foreign, frozen or garbage registry object is tolerated");

  // 6. The registry is a Set of names: enumerable and iterable by other extensions.
  reset();
  for (const factory of Object.values(loaders)) factory(fakePi().api);
  assert.deepEqual([...protections()].sort(), ALL);
  assert.equal(Object.keys(protections()).length, 0, "list() is not an enumerable own property");
  ok("registry is iterable like a Set of names");

  // 7. Interoperability with another extension that only uses the bare global key: it creates a plain
  //    Set<string> when the key is absent, or calls .add(name) when it exists, and reads with .has()
  //    and iteration. Both directions work, and the registry is a real Set.
  const lead = (name: string) => {
    if (slot() === undefined || slot() === null) setSlot(new Set());
    nameSet().add(name);
  };
  reset();
  lead("delegation");
  for (const factory of Object.values(loaders)) factory(fakePi().api);
  assert.ok(slot() instanceof Set);
  assert.deepEqual([...protections()].sort(), ["delegation", ...ALL].sort(), "protections are added to a Set another extension created first");
  assert.equal(protections().has("tool-firewall"), true);
  assert.deepEqual(protections().list(), ["delegation", ...ALL].sort(), "list() is available even on a Set the other extension created");
  reset();
  for (const factory of Object.values(loaders)) factory(fakePi().api);
  assert.ok(slot() instanceof Set, "the registry created by a protection is a Set (subclass)");
  lead("delegation");
  assert.deepEqual([...protections()].sort(), ["delegation", ...ALL].sort(), "another extension can .add(name) to it and iterate it");
  ok("interoperates with an extension that only uses new Set()/.add()/.has()/iteration on the global key");

  console.log(`[protections-registry-smoke] all ${checks} checks passed`);
} finally {
  reset();
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
