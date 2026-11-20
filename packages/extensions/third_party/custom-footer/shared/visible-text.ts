// GENERATED from packages/core/shared/visible-text.ts by packages/core/gen-shared.ts. Do not edit this copy:
// change the source and run `npm run gen:shared` (`npm run verify` fails when a copy differs).
/**
 * The kit's one hidden-character filter and one-line rule for repository-controlled text.
 *
 * Text that a worker, a run file or the repository itself can write reaches a terminal, a log line
 * or a footer through these helpers: every consumer holds this behaviour rather than its own copy of
 * the Unicode class. Extensions that cannot import packages/core hold generated, byte-checked copies
 * (`npm run gen:shared`; `npm run verify` fails on drift).
 *
 * `HIDDEN_CHARS` matches every Unicode control (Cc: C0, DEL, C1, which holds the single-byte CSI
 * U+009B) and format (Cf: zero-width, bidi embedding/override/isolate and marks, soft hyphen, BOM,
 * U+180E, tag characters U+E0000-U+E007F, ...) character, plus every Default_Ignorable_Code_Point
 * (combining grapheme joiner, variation selectors, Hangul fillers, ...). The match is by Unicode
 * property, not by a list, so an invisible character cannot hide inside `<\u200b/untrusted>` or
 * reorder text in a terminal. Tab and newline are in Cc but are kept by `stripHiddenChars` for
 * callers that need line structure.
 *
 * Canonical source: packages/core/shared/visible-text.ts.
 */

/** Every control, format and default-ignorable code point, tab and newline included. */
export const HIDDEN_CHARS = /[\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/gu;

/** True when `ch` is exactly one code point the filter removes; tab and newline are not. */
export function isHiddenChar(ch: string): boolean {
  return ch !== "\n" && ch !== "\t" && Array.from(ch).length === 1 && ch.replace(HIDDEN_CHARS, "") === "";
}

/** `text` with every hidden character removed; tab and newline are kept as written. */
export function stripHiddenChars(text: string): string {
  return text.replace(HIDDEN_CHARS, (ch) => (ch === "\n" || ch === "\t" ? ch : ""));
}

/**
 * `text` as one visible line: hidden characters removed, tab and newline turned into a space, runs of
 * whitespace collapsed to one space, and the result trimmed. The one rule for a string shown in a
 * footer, a list or a log line.
 */
export function oneVisibleLine(text: string): string {
  return stripHiddenChars(text).replace(/[\n\t]/g, " ").replace(/\s+/g, " ").trim();
}
