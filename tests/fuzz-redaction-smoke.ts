#!/usr/bin/env node
/**
 * Property-based fuzzing of the one redaction table (packages/core/shared/redact.ts).
 *
 * tests/redaction-corpus-smoke.ts checks each synthetic secret in tests/fixtures/secret-corpus.json
 * as written. This test generates new secrets of the same shapes, by replacing every letter and
 * digit of a corpus secret with a random one of the same class (the prefix that identifies the
 * shape is kept), and hides each one in random surrounding text:
 *
 *   1. the generated secret never appears in the redacted output;
 *   2. redaction is idempotent: redacting the output again changes nothing;
 *   3. text with no secret-like key or token prefix is returned unchanged.
 *
 * Inputs come from packages/core/eval/fuzz.ts (fixed seed in check:all, random in the weekly
 * security workflow). Generated values are synthetic and never written to disk.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import { redact } from "../packages/core/shared/redact.ts";
import { fuzzSeed, property, type Rng } from "../packages/core/eval/fuzz.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Entry { id: string; text: string; secret: string }

function joined(value: unknown, where: string): string {
  assert.ok(Array.isArray(value) && value.every((p) => typeof p === "string"), `${where} must be a list of strings`);
  return value.join("");
}

function loadEntries(): Entry[] {
  const raw = parseJson(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "secret-corpus.json"), "utf8"));
  assert.ok(isRecord(raw) && Array.isArray(raw.entries), "secret-corpus.json has entries");
  return raw.entries.map((e: unknown, i: number): Entry => {
    assert.ok(isRecord(e) && typeof e.id === "string", `entry ${i} has an id`);
    return { id: e.id, text: joined(e.text, `${e.id}.text`), secret: joined(e.secret, `${e.id}.secret`) };
  });
}

const entries = loadEntries();
assert.ok(entries.length >= 10, "the corpus has entries to vary");

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const DIGITS = "0123456789";

/**
 * A new secret of the same shape: letters and digits replaced within their class, punctuation and
 * the leading `keep` characters (the shape's identifying prefix, such as a key type) kept.
 */
function vary(r: Rng, secret: string): string {
  // Each dot-separated part keeps its own prefix (a JWT's parts all start with "eyJ").
  return secret.split(".").map((part) => varyPart(r, part, prefixLength(part))).join(".");
}

function varyPart(r: Rng, secret: string, keep: number): string {
  let out = secret.slice(0, keep);
  for (const ch of secret.slice(keep)) {
    if (LOWER.includes(ch)) out += r.string(LOWER, 1);
    else if (UPPER.includes(ch)) out += r.string(UPPER, 1);
    else if (DIGITS.includes(ch)) out += r.string(DIGITS, 1);
    else out += ch;
  }
  return out;
}

/** Leading characters that identify a token shape (kept by vary()). */
function prefixLength(secret: string): number {
  const known = /^(?:AKIA|ASIA|gh[pousr]_|github_pat_|glpat-|xox[abpors]-|sk-ant-|sk-proj-|sk-|[spr]k_(?:live|test)_|pk-|eyJ|AIza|npm_|pypi-|hf_|SG\.|-----BEGIN [A-Z ]+-----)/.exec(secret);
  return known ? known[0].length : 0;
}

/** Harmless words and separators to surround a secret with. Never contains a key name or token prefix. */
const WORDS = ["build", "ok", "the", "deploy", "step", "42", "done", "path/to/file.ts", "line", "value:", "(note)", "-", "#", "*", "->", "INFO", "warn"];
function noise(r: Rng): string {
  const n = r.int(6);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(r.pick(WORDS));
  return words.join(" ");
}
const LINE_BREAKS = ["\n", "\r\n", "\n\n"];

let total = 0;
const ok = (name: string, runs: number): void => {
  total += runs;
  console.log(`  ok  ${name} (${runs} cases)`);
};

ok(
  "a generated secret of a known shape never survives redaction, wherever it sits in the text",
  property(
    "generated secret is redacted",
    600,
    (r) => {
      const entry = r.pick(entries);
      const secret = vary(r, entry.secret);
      const line = entry.text.replace(entry.secret, secret);
      const before = r.chance() ? `${noise(r)}${r.pick(LINE_BREAKS)}` : "";
      const after = r.chance() ? `${r.pick(LINE_BREAKS)}${noise(r)}` : "";
      return { id: entry.id, secret, text: `${before}${line}${after}` };
    },
    ({ secret, text }) => {
      const out = redact(text);
      assert.ok(!out.includes(secret), `the secret survived: ${JSON.stringify(out)}`);
    },
  ),
);

ok(
  "redaction is idempotent",
  property(
    "redact(redact(x)) === redact(x)",
    400,
    (r) => {
      const entry = r.pick(entries);
      return `${noise(r)}\n${entry.text.replace(entry.secret, vary(r, entry.secret))}\n${noise(r)}`;
    },
    (text) => {
      const once = redact(text);
      assert.equal(redact(once), once);
    },
  ),
);

ok(
  "text with no key name or token prefix is returned unchanged",
  property(
    "clean text is unchanged",
    400,
    (r) => {
      const lines: string[] = [];
      for (let i = 0, n = 1 + r.int(4); i < n; i++) lines.push(noise(r));
      return lines.join(r.pick(LINE_BREAKS));
    },
    (text) => {
      assert.equal(redact(text), text);
    },
  ),
);

console.log(`[fuzz-redaction-smoke] OK: ${total} generated cases, seed ${fuzzSeed()}`);
