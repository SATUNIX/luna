# Roadmap

Direction for the kit. It states intent, not a schedule, and is revised when the code changes.
What the current release contains is in [Beta status](beta.md) and `CHANGELOG.md`; open problems
are in [Future work](future-work.md).

## Principles

- `@satunix/pi-system` is **one package**. Profiles, not separate packages, choose what loads;
  `lite` is the small-model profile.
- Releases are git tags on the public repository: `next` follows `main`, `latest` follows release
  tags, and `/update` keeps pi, the kit and linked packages current, verifying each step. npm
  delivery is built and tested but not enabled ([Releasing](releasing.md#npm-publication-optional)).
- A safety mechanism changes only with its tests. Documentation is a release criterion: a feature
  is not done until the page that describes it is true.
- A new profile is added only when it serves a clear audience.

## Next

In rough priority order:

1. **Cut the first release** and run the operator checks the beta could not:
   an `/update` from an install of the tag, a representative task at more than one effort tier
   with a real provider, a small autonomous run with a real provider on the default rootless
   Podman engine, and the web console in a browser. Results feed back into [Future work](future-work.md).
2. **Keep up with pi 1.x.** The suite now runs against pi 1.4.0. Move the pin with each pi minor
   after a whole-suite run, and review new extension events (project trust, UI prompt events) for
   the security work.
3. **Companion packages.** Review `pi-readseek` 0.12.x as a whole, with a real-terminal check,
   and adopt it or record why not ([Supply chain](supply-chain.md)).
4. **Wider coverage in CI.** The full suite on Windows and macOS, and on Node 24.
5. **Firewall and approvals.** Extend [Security level](security-level.md) with authenticated
   operator events and verified off-boundary attestation; implement content screening, the
   OpenAPPA flow engine, intent ledger and detector before advertising their protection.
   Review any additional relaxed admissions against narrower classifier effects.
   Decide whether `secret-guard` should be a default layer; teach the
   classifier the names of reviewed companion tools; tighten manual-mode reads if the prompt
   volume proves acceptable.
6. **Autonomous runs.** More run templates, and operator-facing tooling to inspect and resume a
   run ([Autonomous runs](autonomy.md)).
7. **Standalone extensions.** Promote proven extensions into their own repositories only when
   ownership or release cadence requires it (`npm run extract`).

## Not planned

- Turning the firewall into a sandbox. Containment is the container's job; the kit offers a
  hardened container for autonomous runs and documents what it does and does not stop.
- Treating effort as a security control. It is a cost and behaviour policy.
- Scheduled or routine runs inside pi itself: pi has no native trigger. An external scheduler
  starting a pi or autonomous run is the supported shape.
