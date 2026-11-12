# Review — cycle 02, run `luna-core-01`, stream `core`

Start `06b4d3d7f3a3` (head of `stream/core`). Charter read in full
(`autonomy/CHARTER.md`). Previous cycle report
(`autonomy/cycles/luna-core-01/01/report.md`) and run handoff
(`autonomy/runs/luna-core-01/HANDOFF.md`) read. `git log --oneline
06b4d3d7f3a3..HEAD` is empty: no commits this cycle yet. Diff size 0.

## Candidate items checked against the code

### V-11 (P1) — greeting must not resume old work

Evidence in `packages/extensions/src/memory-vault/index.ts`:
- `before_agent_start` (l.120-150) builds the first-prompt recall from
  `recentRecaps(...)` under the heading `### Where we left off (<project>)`
  (l.127), then `### Pinned memories` (l.129) and `### Relevant memories`
  (l.139).
- The injected text (l.147) is
  `[Memory vault <root> — recalled automatically; verify before relying on it]`
  followed by the raw recap sections. `appendRecap` writes a `**Next:** ...`
  line (`packages/extensions/src/memory-vault/vault.ts:636`), so the injected
  text tells the model a line of work is open.
- Nothing labels the block as background history, so a bare `hello` is framed
  as "resume this". Existing test `tests/memory-vault-smoke.ts` only asserts the
  `Where we left off (beta)` heading (l.132) and `Where we left off (api)`
  (l.276), i.e. it pins the current framing as correct.
- This session's own injected vault recall at the top of the task prompt shows
  the defect live: "Where we left off (work) ... **Next:** ...". Confirmed.

This is a real, evidenced agent-efficacy defect and the first assigned board
item. Fix mode.

### V-101 (P1) — finish the Luna rename and guard the brand

The bulk of the rename is already in place: `README.md:1` is `# Luna`,
`mkdocs.yml` `site_name: Luna`, docs-smoke already rejects `node pi-system/...`,
and `docs/assets/` holds `luna-*.svg`, not `pi-system-logo.png`. What is left,
measured with `grep -rni "pi-system"` over the item's file list:

- bare (non-backticked) prose uses that still name the old package:
  `README.md:32` (`**pi-system**`), `docs/index.md:6` (`**pi-system**`),
  `docs/updates.md:163` ("every pi-system form"), and
  `docs/proposals/agentic-security-and-alignment.md` lines 18, 45, 126 (x2),
  128, 297, 303, 323, 430 ("pi-system commit", "pi-system compatibility run",
  "in pi-system", "Pi-system's", "pi-system must prove", ...).
- legitimate backticked identity `@satunix/pi-system` (npm package name) in
  `CODE_OF_CONDUCT.md`, `docs/ARCHITECTURE.md`, `docs/INSTALL.md`,
  `docs/index.md`, `docs/migration.md`, `docs/profiles.md`,
  `docs/releasing.md`, `docs/roadmap.md`, `docs/updates.md`,
  `docs/architecture/profiles-and-install.md`,
  `packages/extensions/README.md`, `packages/kit/README.md`.
- no `docs/branding.md`, and no check that keeps the brand from drifting back.

`packages/container/**` is explicitly out of scope (sub-item 3). Generated
pages (`docs/EXTENSIONS.md`, `docs/skills-catalogue.md`, `docs/reference.md`,
`docs/capability-matrix.md`) must not be hand-edited.

The acceptance is explicit that the brand check goes in a new
`tests/brand-smoke.ts` with `npm run smoke:brand` and that `tests/docs-smoke.ts`
is owned by another stream this wave and must not be edited. Improve mode.

## Other checks (no action this cycle)

- No failing branch/acceptance check: base `06b4d3d7f3a3` is the merged head and
  the working tree is clean.
- No upstream merge conflict reported.
- Handoff carry-overs are proposals (env-manifest ownership), `.github/`
  (`CODEOWNERS` dead path) and cosmetic `docs/releasing.md` versions. The first
  is a proposal the steward has not assigned; `.github/` and cosmetic release
  docs are out of this stream's edit scope. Not taken.
