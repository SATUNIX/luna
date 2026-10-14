# Future work and known limitations

Open items, each stated as a limitation that exists today, with what would close it. Nothing here
is a commitment or a schedule; see [Roadmap](roadmap.md) for direction and [Beta status](beta.md)
for what the beta does and does not cover. An item is removed when the code and a test close it,
not when it is written up.

Where an item implies a behaviour change in a safety mechanism (approvals, compaction,
delegation), the change is reviewed as a change to that mechanism, not as a bug fix.

## Verification that was not possible for this release

These are gaps in *evidence*, not known bugs. Each names the person or environment that can close
it.

| Not verified | Why | Who can close it |
|---|---|---|
| Behaviour against real model providers: the effort prompts, the auto-mode judge's verdicts, the completion reviewer, delegation quality | The release was prepared without provider credentials; every suite uses deterministic fakes or the real pi runtime without a model | An operator with a provider, running a representative task at each effort tier |
| The autonomous runner on rootless Podman, on macOS and Windows, and in a run of hours or days | `smoke:autonomy-container` ran on Docker only, in a disposable sandbox; the in-container boundary probe (`packages/autonomy/tests/boundary-probe.mjs`) is manual-only | An operator, per [Autonomous runs](autonomy.md) |
| A full autonomous run against a real model provider | The relay talks to a local fake upstream in every test | An operator with a provider key and a small budget |
| The web console's Content-Security-Policy in a browser | No browser was used | Anyone with a browser: open the console and check the progress bars render |
| The full check suite on Windows and on Node 24 | CI runs the suite on Linux with Node 22; Windows runs the per-profile install check only | CI matrix extension |
| `git` and `npm` delivery for `/profile` and for the update path against the real public repository | No release tag exists yet, and local mode is what the suites can exercise | The first release, then a run of `/update` from an install of it |
| pi 0.99.x | It was run once against the whole suite; it is advisory in CI, not supported | Review when pi 0.99 is adopted |

## Delegation and recovery

- **A child that fills its context window** is now told why (compaction off, a failed recovery,
  clamped output) and is not retried in a loop, but `subagent`'s failure hints do not yet mention
  overflow or compaction outcomes, so the parent sees the child's own message rather than a
  kit-authored hint.
- **`trigger-compact`'s mid-run resume** sends a visible user message and has been tested only
  with fakes. It never runs inside child sessions.
- **Effort budgets are accounting, not enforcement.** A hostile process owned by the same user can
  edit the ledger. Enforcing tiers at the operating-system level would need a supervisor outside
  the session.

## Approvals and the firewall

The [Agentic security, alignment and autonomy proposal](proposals/agentic-security-and-alignment.md)
sets out coordinated security levels, trusted content admission, intent review, OpenAPPA integration
and verified container autonomy. It includes a staged pi 0.99.2 compatibility workstream and
acceptance gates; these are proposed changes, not current guarantees.

- **It is a guard rail, not a sandbox.** Containing what an allowed tool can reach needs an
  operating-system or container boundary (the autonomous runner provides one).
- **Low-tier actions run unasked in every mode**, including reads by tools whose name says they only
  read, and plain network GETs. Tightening this would prompt on every MCP `get_*`.
- **Package-manager and opaque-tool network use cannot be attributed to a host** in unattended
  runs; the container network is the stop.
- **`secret-guard` is opt-in.** The firewall already classifies credential files; whether the
  stricter pattern layer should be default needs data on its false-positive rate.
- **Companion tools that add their own shell or edit tools** (for example `pi-lean-ctx`) are seen
  only as unknown tools. Teaching the firewall the names of specific companions would make them
  first-class, and would need each one reviewed.
- **Unattended mode trusts the supervisor's claim** that its boundary exists. It now requires the
  contract to be on a read-only mount (or another user's unwritable file), which an agent's shell
  cannot fake, and a forged launch from an interpreter is a safety-setting override. What remains:
  something that can mount filesystems, run code inside the pi process, or act as root. Tying the
  contract to a secret only the supervisor holds would close the last gap.
- **Approvals bind command text, not effect.** An approved `git push` follows a re-pointed remote,
  and an approved script runs after an edit. Binding an approval to the resolved effect (the remote
  URL, the script's content hash) would close it, at the cost of more prompts.
- **A script the agent wrote can set the unattended variables** where the classifier sees only
  `bash run.sh`. The provenance rule stops it from working; the classifier cannot see it.

## Profiles and compaction

- **A profile switch cannot undo** package payloads that `pi install` already fetched, a
  concurrent write to pi's settings, or a hard kill of pi part-way through. Rollback restores the
  settings files it snapshotted. The verifier may also roll back a good switch where the kit's
  entry cannot be identified (symlinked or unusual npm layouts); git and npm delivery of `/profile`
  are less exercised than local mode.
- **`lite` and small windows.** pi's default compaction reserve (16384 tokens) on a 32k window makes
  pi compact almost every turn; `/compaction status` now warns, but the `lite` profile does not yet
  carry its own `compaction` settings.
- **`autonomous` and `long-horizon`** load nearly the same set; the difference is the autonomous run
  tooling ([Autonomous runs](autonomy.md)).

## Web console

- Two version constants still read `0.1.0` (`routes.js`, `configinfo.js`); the session panel shows an
  unknown context percentage as 0%.
- The login link is passed to `xdg-open` as an argument, and the token file is readable by the agent
  the console drives (both are documented in [Web console](web-console.md); the firewall classifies
  reading the token file as a credential read, which asks you but is not a lock). Moving the token
  behind a one-time exchange, so it never appears in a command line, would close the first.

## Dependencies

Candidates that were evaluated and deliberately not adopted for the beta (`pi-lens` 4.x,
`pi-readseek` 0.10.x, `pi-mcp-adapter` 3.x, `pi-subagents`, TypeScript 7) are recorded in
[Supply chain](supply-chain.md) with their reasons. Revisit each with its own review.

## Quality of long-running work

- **Long-context reliability in planning and assessment.** Plan quality can degrade silently in very
  long sessions. Open question: which of the sieve, the goal file and the task graph carries the
  load, and how to measure it.
- **Skill disclosure and use.** How often skills are actually loaded when relevant, and whether the
  routing hints help or duplicate machinery, has not been measured.
- **Injection review.** A written review of untrusted-content handling across context contributions,
  tool results and memory recall (an injection inventory with a test per path) is still to be done.

## Related records

- [Roadmap](roadmap.md)
- [Security model](security.md)
- [Recovery orchestration mode](recovery-orchestration-mode.md): the design behind `recovery-orchestrator`
