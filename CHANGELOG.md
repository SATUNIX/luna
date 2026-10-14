# Changelog

All notable changes to `@satunix/pi-system` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions before `0.2.1-beta.0` were internal; their numbers do not correspond to public releases.

## [Unreleased]

## [0.2.4-beta.3]

### Security

- **Pin `katex` to 0.18.2.** The docs toolchain pulled `katex@0.16.47` transitively through
  `mermaid`, which the OSV scanner flagged for CVE-2026-103923 (GHSA-238p-pmpm-9mq7), a
  low-severity prototype-pollution gadget. An `overrides` entry moves it to the patched 0.18.2;
  `npm audit` is clean and all 52 Mermaid diagrams still parse.

### Fixed

- **The remote host log tail no longer stats a path it then reopens.** `tailLog()` takes the size
  from the open descriptor (`fstatSync`) instead of `statSync` on the path, removing a
  time-of-check/time-of-use window (CodeQL `js/file-system-race`).
- **Model labels on the phone replace every separator.** The session detail sheet used
  `String.replace`, which rewrites only the first `|`; it now uses `replaceAll` (CodeQL
  `js/incomplete-sanitization`).

## [0.2.4-beta.2]

### Added

- **Reporting skills.** Two `evidence-reporting` skills for the pentest reporting workflow:
  `finding-report` renders a finding-ready observation into the house deliverable format (finding
  data block with CVSS 4.0 vector and MITRE ATT&CK, a "threat actor" risk statement running
  Due to → There is a risk that → Resulting in, a general technology Background, a specific
  Overview, single-sentence Remediation, and evidence by ID plus screenshot captions), and
  `daily-debrief` runs a conversational end-of-day debrief that assesses the agent's own notes,
  interviews the tester for the gaps, reconciles findings through the existing discipline skills,
  and organises everything into that format. Both ship in the `pentest` profile only. See
  `docs/skills-catalogue.md`.
- **Status cat.** The status bar shows a small fixed-width ASCII cat for the agent's state
  (thinking, streaming, running a tool, waiting for you, compacting, and the result of a request).
  It replaces pi's spinner while a request runs, never ticks while idle, and is switched with
  `/footer cat on|off` or `PI_KIT_CAT=0`. See `docs/status-bar-and-costs.md`.
- **Remote control from an Android phone.** `/remote` (the `remote-control` extension, in the
  `balanced`, `long-horizon`, `autonomous` and `self-improving` profiles) starts a pi remote host
  on the computer and shares the terminal's session with **pi remote**, a new Android app in
  `apps/android` that is a phone-sized pi-console. The phone connects directly over the LAN or a
  VPN such as Tailscale. Phones are linked with a one-time code plus approval at the terminal
  after comparing a device ID, keep their key in the Android Keystore, pin the host's
  certificate and use short-lived tokens. From the phone you can prompt, steer and abort the
  terminal session, answer its dialogs, change model and thinking, and start, open and end other
  sessions. See `docs/remote-control.md`.

## [0.2.4-beta.1]

### Fixed

- Public commits retain every allowlisted file, including the autonomy handoff seed matched
  by local ignore rules. Export validation and publication check the staged manifest.
- Handoff notes use an atomic create and an open file descriptor, preserving existing notes
  when another process creates or replaces the destination. New files use owner-only
  permissions; supported platforms refuse final-component symlinks.

### Changed

- Removed generated marketing media from the development repository and updated the public
  export manifest to match.
- Prepared the next public beta through the protected GitLab export pipeline.

## [0.2.4-beta.0]

The first public beta. Delivered from `github.com/SATUNIX/pi-system`; see `docs/beta.md` for what
is and is not covered, and `docs/migration.md` if you installed from the earlier private source.

### Added

- **Public delivery.** The kit installs from `git:github.com/SATUNIX/pi-system` (release tags for
  `latest`, `main` for `next`). Installs registered from the retired private GitLab sources move
  when you install the public kit and run its installer (`docs/migration.md`): the retired host is
  never contacted, the channel, profile and hand edits are kept, and the old registration is
  removed. This release's `/update` also recognises a retired registration or a local checkout with
  a retired `origin` and never contacts that host; an old checkout that has not been brought forward
  runs the old code and cannot migrate itself.
- **Verified updates.** `/update` re-reads the installed state after each step and reports a step
  that ran but left the old state behind as failed, stopping the run without reloading. A step
  nothing could confirm is reported as not verified, and a failed lookup is never reported as
  "up to date". Progress and failures go to standard error when there is no terminal UI.
- **Effort control.** Five tiers (E1 Minimal to E5 Exhaustive; default E3) chosen with `/effort`,
  applied from the next message, shown in the status bar, and independent of the model, thinking
  level, profile and permissions. Delegation limits (concurrent, total, scouts) are enforced by a
  shared ledger at every depth, with a separate recovery budget. See `docs/effort.md`.
- **One governed delegation engine.** `delegation-guard` is the single child-launch contract used
  by the `subagent` tool, workflows, the completion reviewer, the Conductor and recovery: every
  child loads its parent's protections, verifies them itself and fails closed (exit 78), at any
  depth, and is budgeted by the effort ledger.
- **Scoped approvals.** Remembered approvals are bound to the exact action, workspace, directory
  and session, expire, and are stored in one file that `/firewall list` and
  `/firewall revoke` inspect and change. Refusals carry exactly one label. Judge blocks that are
  not high-confidence go to the operator. All approval waits are bounded.
- **Unattended mode** for autonomous workers: activates only from a supervisor-built environment
  and a read-only contract, never from inside a session.
- **Web console authentication.** A per-start token, Host and Origin checks, JSON-only writes and
  an RPC allow-list; loopback by default. See `docs/web-console.md`.
- **Transactional `/profile`.** A switch snapshots settings, runs the installer, judges the result
  by what is on disk and rolls back on any failure. `/profile status` and `/compaction status`
  show the effective state.
- **Status bar.** One renderer with `light`, `default` and `heavy` layouts, prioritised segments,
  terminal-width-safe fitting, effort, unattended and compaction state, and cost provenance
  (measured, estimated or unknown).
- **General autonomous runs.** `packages/autonomy` generalises the self-improvement supervisor
  into a run engine: a versioned, fail-closed run contract; a lifecycle state machine with distinct
  outcomes; templates (`implement`, `deploy`, and `self-improve` as one optional template); a
  boundary you read and authorise by digest before anything runs; scoped unattended authorisation
  with host-side containment of every container; an allowlist egress proxy and run-scoped services;
  trusted acceptance checks and an independent review; bounded recovery and hard budgets; and
  approval-gated promotion. The `pi-autonomy` CLI accepts `--json` on every command, and `/autonomy`
  (autonomous profile) drives it from inside pi as a command the model cannot call. See
  `docs/autonomy.md`.
- `docs/concepts.md`, `docs/effort.md`, `docs/migration.md`, `docs/troubleshooting.md`,
  `docs/web-console.md`, `docs/beta.md` and `docs/private-system-lessons.md`; Mermaid diagrams in
  place of PlantUML, checked by `npm run docs:mermaid`.
- CI: a test-wiring check (`check:all` fails on a test no script runs or that asserts nothing), a
  clean-install test that installs the packed tarball for every profile and starts the real pi, a
  release workflow that is manual and dry-run by default with a static test that it cannot publish
  on a dry run, and a pi-compat matrix at the supported floor and the newest release looked at.

### Changed

- **Requirements:** Node.js 22.19 or newer (pi's own minimum) and pi 0.85.1 or newer (the floor
  moved from 0.76.0). The suite is pinned to and tested against pi 0.87.1.
- Approvals learned in one workspace no longer run unasked in another; session allows expire after
  24 hours and learned ones after 30 days; an unanswered approval card is refused as uncertain
  after 15 minutes.
- `/footer <unknown>` is rejected instead of toggling the bar; `/footer` on its own still toggles.
- `trigger-compact` no longer compacts in the middle of a run, stands down when pi's own trigger is
  earlier, and never runs in child sessions; `context-sieve` budgets scale with the real context
  window; a full window with compaction off is explained rather than retried.
- Firewall, profile and overrides configuration that is unsafe (an unknown mode or policy, an
  unparseable `firewall.json`, an override that removes a mandatory protection) fails before
  anything is written instead of being silently replaced.
- `pi-lean-ctx` is pinned at 3.10.5 and is in no profile (opt-in); its review now states that it
  registers shell and edit tools outside the firewall's shell and secret classification.
- `dream.mjs` no longer writes trace-derived notes into `AGENTS.md`.
- Completion gates (verifier-board, orchestrator, conductor) require at least one passing trusted
  source (`verify`, `review` or `validator:<id>`); self-recorded passes alone do not count.
- A project install keeps its state marker in `<project>/.pi/.pi-kit.json`, and `/profile`,
  `/update`, uninstall and the web UI read it before the global one.
- Context contributions are scoped per session.
- `PI_KIT_SUBAGENT_ISOLATE=0` no longer disables child isolation.

### Removed

- The private GitLab pipeline and release script; the `roles/` contracts and `packages/role-runner`
  (they target a private platform); `pi-impact-analyzer` and the unused `pi-subagents` reference;
  the historical design, review and campaign documents. Git history keeps them; see
  `docs/private-system-lessons.md`.
- Machine paths, private host names and account names from tracked files. The retired private
  source URLs remain only in `git.legacySources` and the migration tests and page, because
  migration has to recognise them.

### Fixed

- Readers of persisted state ignore malformed or wrong-shaped data instead of crashing the host.
- Approval brokers always settle, remove their pending and resolved files, and quarantine malformed
  requests.
- A killed or timed-out profile switch no longer counts as success (`pi.exec` resolves a
  signal-killed child as code 0).
- `echo path | xargs touch` and similar wrappers are no longer routine actions.
- The web console shuts down cleanly on SIGTERM with an open event stream.
- `/console stop` stops a hung web UI and never signals a pid that is not the console.
- `THIRD_PARTY_NOTICES.md` reproduces the upstream licence with its holder and year, and states the
  licence position of the caveman concept source.

### Security

- Web console: authentication, Host, Origin and content-type checks, an RPC allow-list, a
  Content-Security-Policy. See `docs/web-console.md`.
- Approvals cannot be broader than the operator's choice; malformed approval files fail closed.
- Every child agent is at least as protected as its parent, at every depth; a missing protection
  stops it.
- pentest-governance blocks an action whose audit record cannot be written.

## [0.2.1-beta.0]

First versioned release, delivered from a private GitLab project (since retired).

### Added

- One package, one install: `node packages/core/install.mjs --channel latest --profile <name>`
  from any clone registers the newest release with pi; or `pi install
  git:<the private source>@v<version>` (the first interactive start then applies
  the `balanced` profile; `PI_KIT_AUTO_PROFILE=<name>|0` changes or turns this off).
- Release channels: `latest` (the newest `vX.Y.Z` tag), `next` (every commit on `main`) and
  pinned versions. `install.mjs --channel <latest|next|X.Y.Z>` picks one.
- Kit delivery setting, `packages/core/distribution.json`: `git` (release tags and `main` of the
  kit's repository, the current setting) or `npm` (dist-tags of `@satunix/pi-system`). The
  installer, `/profile` and `/update` follow it; `PI_KIT_DELIVERY` and `PI_SYSTEM_GIT_SOURCE`
  override it per machine. When a release changes it, `/update kit` moves installs over.
- `kit-update` extension, in every profile: a daily background check for new versions of pi,
  the kit (release tags or `main` over `git ls-remote`, never prompting for credentials) and
  linked packages, and `/update` (`status`, `all`, `kit`, `pi`, `packages`, `channel <name>`) to
  apply them, re-applying the current profile and companion pins.
- `lite` profile: the small-model set formerly shipped as the separate lite package, with
  `skills.only` / `prompts.only` allowlists (new profile fields).
- GitLab release stage: a pushed `vX.Y.Z` tag that passes every check and scan, matches
  `package.json` and is on `main` gets a GitLab Release with notes from this changelog
  (`packages/core/release-notes.mjs`). A private CA is
  supported, and every other pipeline runs the release path read-only (`release-preflight`).
- Security scanning in the GitLab pipeline: gitleaks over full history, Semgrep, `npm audit`,
  `npm audit signatures`, lockfile integrity, and GitLab's SAST and Secret Detection. The same
  checks plus CodeQL, OSV-Scanner, dependency review, zizmor, OpenSSF Scorecard and Dependabot
  are ready in `.github/workflows/` for when the repository is on GitHub.
- npm delivery, built and paused: `.github/workflows/release.yml` (trusted publishing with
  provenance, dist-tags from `packages/core/publish-plan.mjs`), runnable only by hand.
- `npm run smoke:package` (tarball contents and per-profile resolution from the packed copy),
  `npm run smoke:distribution` (delivery, channels and installer source selection) and
  `npm run security:lockfile` (registry-only sources, integrity hashes, install-script
  allowlist).

### Changed

- The installer registers a checkout in place by default, the released kit when given
  `--channel`, and keeps the existing git or npm registration when run from pi's own copy of
  the kit. It keeps exactly one registered copy of the kit (git sources match on repository,
  whatever the ref), removing other checkouts, other deliveries and legacy exports.
- `release.mjs` accepts prerelease versions, bumps every workspace manifest, and runs the
  package check instead of generating surfaces.
- `install.mjs --uninstall` removes the companions it registered, not just the kit.

### Removed

- Generated install surfaces (`packages/kit/surfaces/`, `export-package.mjs`,
  `export-all.mjs`) and the `@satunix/pi-system-lite` package. `--surface lite` still works as a
  deprecated alias for `--profile lite`.
- The `export:*`, `install:lite`, `publish:dry-run` and `smoke:export-package` scripts.
