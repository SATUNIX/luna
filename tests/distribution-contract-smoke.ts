#!/usr/bin/env node
/**
 * Pins the derived distribution contract (mission ADR 2): every shipped profile carries the
 * mandatory base declared in distribution.json, and every capability's curated-profile
 * `profileRequires` companion is present wherever the capability ships, and no two capabilities
 * one profile loads declare the same tool name. The contract is a derivation of package.json,
 * distribution.json, extension.json files and profiles/*.json, so these checks read derived data
 * rather than a hand-kept fixture.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "../packages/core/lib/guard.ts";
import { buildDistributionContract, distributionContractProblems, readDistributionMetadata } from "../packages/core/distribution-contract.ts";

const contract = buildDistributionContract();
assert.deepEqual(distributionContractProblems(contract), [], "every shipped profile must compose its declared contracts");
assert.equal(contract.profiles.length, 7);
assert.ok(isRecord(contract.distribution.git));
assert.equal(contract.distribution.git.source, "git:github.com/SATUNIX/luna");
assert.deepEqual(contract.distribution.git.previousSources, ["git:github.com/SATUNIX/pi-system"]);
assert.deepEqual(buildDistributionContract(), contract, "derivation is deterministic");

// The same validation is used by verify and distribution:inspect, including file reads.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-contract-previous-"));
try {
  const file = path.join(scratch, "distribution.json");
  for (const previousSources of [null, "wrong", [42], [""], ["npm:luna"]]) {
    const bad = structuredClone(contract);
    bad.distribution.git = { previousSources };
    assert.ok(distributionContractProblems(bad).some((problem) => problem.includes("git.previousSources")));
    fs.writeFileSync(file, JSON.stringify(bad.distribution));
    assert.throws(() => readDistributionMetadata(file), /git.previousSources/);
  }
  const good = structuredClone(contract);
  good.distribution.git = { source: "git:github.com/SATUNIX/luna", previousSources: ["git:github.com/SATUNIX/pi-system"] };
  fs.writeFileSync(file, JSON.stringify(good.distribution));
  assert.deepEqual(readDistributionMetadata(file), good.distribution);
  assert.deepEqual(distributionContractProblems(good), []);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

const required = contract.distribution.requiredProfileExtensions ?? [];

for (const profile of contract.profiles) {
  for (const name of required) {
    const bad = structuredClone(contract);
    const target = bad.profiles.find((candidate) => candidate.name === profile.name);
    assert.ok(target, `profile ${profile.name} is present in the clone`);
    target.include = profile.include.filter((included) => included !== name);
    assert.ok(distributionContractProblems(bad).includes(`${profile.name}: missing distribution base ${name}`), `${profile.name} must retain ${name}`);
  }
}

const missingReader = structuredClone(contract);
const quick = missingReader.profiles.find((profile) => profile.name === "quick");
assert.ok(quick, "quick is a shipped profile");
quick.include = quick.include.filter((name) => name !== "context-sieve");
assert.ok(distributionContractProblems(missingReader).some((problem) => problem === "quick: goal-core requires context-sieve"), "a profile may not silently discard goal instructions");

// Two capabilities in one profile that declare the same tool name: pi keeps only one, silently.
// memory-local is in no shipped profile, so adding it next to memory-vault must be reported.
const collision = structuredClone(contract);
const balanced = collision.profiles.find((profile) => profile.name === "balanced");
assert.ok(balanced, "balanced is a shipped profile");
assert.ok(balanced.include.includes("memory-vault"), "balanced loads memory-vault");
balanced.include.push("memory-local");
assert.deepEqual(
  distributionContractProblems(collision).filter((problem) => problem.includes(" tool ")),
  ["balanced: tool memory_search is registered by memory-local, memory-vault; pi keeps only one"],
  "a tool name declared by two capabilities in one profile must be reported",
);

const unknown = structuredClone(contract);
const first = unknown.profiles[0];
assert.ok(first, "the contract has at least one profile");
first.include.push("missing-capability");
assert.ok(distributionContractProblems(unknown).some((problem) => problem.includes("unknown capability")));

const invalid = structuredClone(contract);
delete invalid.distribution.requiredProfileExtensions;
assert.match(distributionContractProblems(invalid)[0] ?? "", /nonempty set/);

console.log("[distribution-contract-smoke] base protections, context-producer composition and unique tool names pass for all seven profiles");
