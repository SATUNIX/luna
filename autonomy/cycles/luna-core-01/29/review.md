# Cycle 29 review — luna-core-01

Base `ddf7084` (`pi/luna-core-01`). Mode: **fix**. Two board items, each checked against the code.

## DE-96 [P0] — leak scan refuses the product's own identifiers

Root cause: the pre-push scan is context-free. `blockedMatches` (`packages/core/lib/leak-scan.ts:85`)
runs the same identifier classes over commit messages and every added line, with no knowledge of
the file or of the product's own CLI/card syntax.

Evidence on the base:

- `leak-scan.ts:47` `\/home\/[a-zA-Z0-9_-]+` matches the documented placeholder home path
  `<home>/user/dev/luna` in `packages/container/capability/compose/compose.dev.yaml:9`
  (a comment example, not a real account).
- `leak-scan.ts:54` `\b[RPMD]-\d{1,2}\b` matches (a) the product's documented inbox card-id
  example `--answer <id>`, (c) a legacy board id cited in a run record under
  `autonomy/cycles/`/`autonomy/proposals/`, and (d) a legacy id cited in a commit subject.
- `prepush-scan.ts:114` scans the commit identity/message with `blockedMatches(text)` and
  `prepush-scan.ts:126` scans every added line the same way; neither passes file or context.
  The four refusals reported by the stream (`docs/autonomy.md` `--answer <id>`, the compose
  placeholder, and two commit-subject/run-record ids) all fall out of these two calls.

Acceptance to implement: (a) the documented inbox card-id example, (b) a documented placeholder
home path, (c) a run record citing a legacy board id, (d) a commit message citing one — all
accepted at head, while every existing true positive (real user-home path, private IP, key shape,
review finding id, bare legacy id in product prose, denylist term) still refuses.

## DE-97 [P1] — brand smoke reads dotfiles, non-deterministic

Found by the cycle-22 review of `cc7f37d2aa`; conflicts with `docs/security-standard.md:119`.

Evidence on the base (`tests/brand-smoke.ts`):

- `:46` `isTextFile` accepts any `*.env`, so `walkText` (`:49`) would read a populated `.env` and
  `:144` would match its values.
- `:145` pushes `file:line: <full text>`, so a finding echoes the matched prose (a secret could be
  printed), against the leak scan's own "names the file and line number only" rule
  (`leak-scan.ts:17`).
- `:50` walks the filesystem with a fixed `SKIP_DIRS`; it never consults `.gitignore`, so the file
  set depends on which untracked ignored files happen to exist in the working tree (a tarball or a
  stray `.md` changes the scope). Not deterministic.

Acceptance to implement: skip every dotenv-named file except `packages/core/.env.example` (the
documented template); report `file:line` only, never the text; make the file set deterministic via
an explicit tracked-file allowlist (`git ls-files`) with the fixed skip list still applied. Keep
`scanned.length > 100` and `packages/core/install.ts` in scope.

## Scope, order, conflicts

Publication is unblocked first: `origin/stream/core` is already at local head, so both items are
new work on top of `ddf7084`. Both are inside the "core" stream. No item touches the charter,
operator control paths or a `package.json` `scripts` map. No upstream/backlog edit.
