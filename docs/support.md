# Distribution support and compatibility

Pi-system curates upstream Pi, profiles and extensions as one distribution. Upstream Pi owns
the agent engine, provider clients and extension API; pi-system owns selection, integration,
governance and lifecycle tooling. It is independently maintained and does not imply upstream
endorsement. [Architecture](ARCHITECTURE.md) describes the package and runtime boundaries.

## Canonical metadata

| Fact | Authoritative source |
|---|---|
| Name, version, licence, Node requirement, Pi peer range and tested pin | Root `package.json` |
| Delivery source, former public sources (`git.previousSources`), retired-source fingerprints and mandatory profile base | `packages/core/distribution.json` |
| Official/vendored capability, status, platforms, hooks, tools, services and profile dependencies | Each `extension.json` |
| Active extensions, firewall policy, skill and prompt filters | `packages/kit/profiles/*.json` |
| Reviewed external sources, exact pins and provenance | `packages/core/sources.json` |

`npm run -s distribution:inspect` prints a deterministic JSON view of those sources, including
declared tools and services per profile. It neither installs nor enables anything. Tool counts
are declarations, not measurements of dynamic tool visibility. `smoke:distribution-contract`
and `verify` reject profiles missing the base or a declared `profileRequires` companion, and
profiles in which two extensions declare the same tool name in `registers.tools` (pi keeps the
first registration of a name and drops the other without a diagnostic). The tool check covers
shipped profiles only: `--all`, `--only` and overrides that add `memory-local` next to
`memory-vault` still load two `memory_search` tools.
`profileRequires` describes curated profile composition; extraction stays self-contained and
installing an individual extension does not automatically install its companions.

The [capability matrix](capability-matrix.md) and [extension catalogue](EXTENSIONS.md) are
generated with `npm run catalog`; stale generated pages fail verification. Profiles are
curated selections of one package, not independent releases. See [Profiles](profiles.md).

## Compatibility and support tiers

Node.js must satisfy `engines.node`. Node ESM is the runtime; extensions use TypeScript through
Pi's loader. CI runs the whole suite at the development pin and at the Pi versions listed in the
`pi-compat` job of `.github/workflows/ci.yml`, which include the supported floor. A green pin does
not certify every version in the open peer range. A compatibility change requires the full gate
against the proposed version and review of Pi's API changes before changing pins.

Linux and Windows have profile-loading CI. A passing load test does not prove every optional
service, container or native client works there. macOS, Android devices and container engines
need their own evidence. [Beta status](beta.md) and each feature's page state those limits.

- First-party and adapted vendored capabilities are maintained together; their manifest status
  is `stable`, `beta`, `experimental` or `stub`. A stable capability is not a stable distribution.
- Experimental/stub capabilities carry limited compatibility expectations. Self-improvement is
  opt-in through its profile; services must be provisioned explicitly.
- External/community packages are separately maintained, pinned and reviewed at the recorded
  version. Catalogue inclusion grants no permission or assurance about future upstream releases.
- In-process extensions execute with Pi's privileges. [Security](security.md) describes what
  the policy guards and the separate container boundary actually enforce.

## Channels, changes and recovery

Public GitHub `main` is the `next` channel. Private integration commits are not public channel
updates. `latest` chooses the newest stable public tag when one exists, otherwise the newest
prerelease. Explicit versions remain pinned. Beta/RC names indicate prereleases; stable
promotion requires the same artefact, compatibility and security gates plus operator review.
There is no automatic stable promotion or promise of production readiness during beta.

Releases move forward. Security fixes use a reviewed patch/prerelease and an advisory with
affected versions and mitigation. Consumed tags must not silently change. During beta there
is no guaranteed maintenance window; report vulnerabilities via `SECURITY.md`, which states the
response targets (targets, not a contractual service level) and the supported versions.
Breaking migrations and removals must explain affected profiles, preserved user state,
replacement and rollback; deprecate before removing when a safe overlap is possible.

Before updating, preserve the current tag and back up the agent directory. Configuration
rollback is narrower than restoring package contents or a whole interrupted update. Follow
[Updates](updates.md) for verified steps, uninstall retry and current concurrency/recovery
limits. [Releasing](releasing.md) owns promotion and operator-only publication, and
[Incident response](incident-response.md) what to do when a secret, credential, dependency or
release is compromised.
