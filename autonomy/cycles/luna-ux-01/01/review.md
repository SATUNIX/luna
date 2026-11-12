# Cycle 01 — Review (run luna-ux-01, stream `ux`)

- Base: `5fda5d526514` (head of `stream/ux`), branch `pi/luna-ux-01`.
- This cycle restarted on a clean base after the interrupted session; the earlier cycle-01
  records in this directory described an ancestor lineage's launch-screen work. They are
  replaced below with the evidence for this cycle.
- Charter read in full. No red gate or upstream conflict at the base: the worktree is clean and
  `git rev-parse HEAD` equals the base.

## Assigned board items

### DE-98 — CHANGELOG entries for five merged ux cycles (P1)

**Already satisfied on this base; nothing to change.**

- `CHANGELOG.md` has an `## [Unreleased]` section and an entry for each named change:
  - `/workflows` panel cursor/tail clamp: line 213 (`selection ... short terminals`);
  - Security page effective level: line 215 (`Effective row ... guarded`);
  - `/remote` pairing wrap: line 219 (`wraps by terminal columns`);
  - footer `toolPhrase` clipping and ASCII working line: line 221;
  - status bar / todo widget column truncation: line 223.
- The QR fixture in `tests/tui-layout-smoke.ts:227` is `const size = 25;` and the address list
  (`tests/tui-layout-smoke.ts:233-234`) is the longer IPv4/IPv6 pair, so the reported coverage
  reduction was restored upstream. No fixture change is needed.

Evidence: `grep -n "workflows panel\|Security page\|pairing panel\|toolPhrase\|todo checklist" CHANGELOG.md`
returns those five entries; `git status --short` is empty at the base.

### DE-101 — control-centre and owner-inbox hardening (P1)

Confirmed in the code at this base:

1. **Hub sanitisation is incomplete and unbounded.** `packages/extensions/src/control-center/hub.ts`
   uses pi-tui's `stripTerminalSequences` at lines 174-177, 239, 245, 255, 313; it removes colour,
   cursor CSI, OSC and APC only. `docs/control-center.md:92-96` states that other escapes, C1
   controls and bidirectional overrides are not removed, and that the strip runs on the whole
   repository-controlled string with no length bound. `HIDDEN_CHARS`
   (`packages/autonomy/lib/notebook.ts:126`) is the repository's whole-class filter
   (`\p{Cf}`, `\p{Cc}`, `\p{Default_Ignorable_Code_Point}`), but control-center cannot import
   autonomy (self-containment rule, `hub.ts:20-22`), so the filter must be local to control-center.
2. **Card deadlines use `Date.parse` only.** `packages/autonomy/lib/inbox.ts:55` accepts any string
   `Date.parse` understands, while `packages/autonomy/lib/board.ts:50,62-65` already has a strict
   `ISO_TIMESTAMP` plus `Date.parse`; an offset-less deadline is parsed in host local time
   (`docs/autonomy.md:735-736` admits this).
3. **`inbox --answer` on a settled card exits 0 and is ignored.** `packages/autonomy/cli.ts:721-723`
   only sets `answered` when `!card.outcome`; there is no refusal.
4. **The text listing prints card text as written.** `packages/autonomy/cli.ts:730-732` interpolates
   `question`, `default` and `outcome.text` directly; `packages/autonomy/lib/store.ts:148` has the
   one-line `HIDDEN_CHARS` collapse used for other operator-visible text.
5. **`inbox --file` accepts a card that already carries `answer` or `outcome`.**
   `packages/autonomy/lib/inbox.ts:67-68` validates them as ordinary optional fields; an uploaded
   file can therefore pre-settle a card without an owner decision.
6. **`wrap()` drops the rest of a word when a wide character does not fit.**
   `packages/extensions/src/remote-control/index.ts:145-150`: when `sliceByColumn` returns an empty
   chunk for a single wide grapheme, `rest = ""; break;` discards the remaining text instead of
   moving it to the next line.

## New problems found

None outside the assigned items. The older follow-ups recorded in the handoff (array-shaped
`ui.json`, non-atomic `saveSettings`, idle-cat blink, older CHANGELOG entries) remain proposals or
handoff notes, not this cycle's work.
