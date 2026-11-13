# Branding

The product is **Luna**. The npm package is still named `@satunix/pi-system`, so install commands,
settings entries, environment variables, paths and container images are unchanged. This page lists
every place that deliberately keeps the old `pi-system` identity and why. Everything else that users
read should say Luna.

## Deliberate identities

Each entry is an external contract: a name another system stores, resolves, compares or displays.

- **npm package names.** `@satunix/pi-system` is the published package name, and
  `@satunix/pi-system-lite` is the retired generated package that an old local registration may
  still name. Renaming either would break installs. `packages/core/lib/identity.ts` accepts both
  package names (plus `@satunix/luna`) and `packages/core/lib/settings.ts` cleans up the retired
  split packages.
- **bin names.** The root package exposes `pi-system`, and `packages/core/package.json` exposes
  `pi-system-install` and `pi-system-verify`. Users and scripts call these commands by name.
- **`PI_SYSTEM_*` environment variables.** `PI_SYSTEM_GIT_SOURCE` is documented in
  `docs/migration.md` and `docs/updates.md` and read by the installer, `distribution.ts` and
  `kit-update`. Existing shells and deployment files set it.
- **install and data paths.** `/srv/data/pi-system*` (including `/srv/data/pi-system-engagement`) and
  `/opt/pi-system` are mounted by the container, referenced by `secret-guard` and
  `engagement-governance`, and hold an operator's existing state.
- **compose project and container names.** The compose project is `pi-system`, the agent container
  is `pi-system-pi-agent-1`, the governance MCP container is `pi-system-governance-mcp`, and the
  locally built image tag is `pi-system:local`. Operators run `docker exec` and `docker inspect`
  against these names.
- **`Symbol.for("pi-system.remote-control.*")` keys.** `remote-control`, `session-helpers`,
  `tool-firewall` and `control-center` share state through global symbols such as
  `pi-system.remote-control.mirror` and `pi-system.remote-control.shared`; the string is the
  cross-extension contract, not a display name.
- **`urn:pi-system:*` identifiers.** The autonomy run-contract schema is
  `urn:pi-system:autonomy:run-contract:1`. Changing it would invalidate stored contracts.
- **`CAPABILITY_ID`.** `engagement-governance` and the governance MCP server send
  `capability_id: "pi-system"` in their records, so ledgers and downstream checks compare that
  exact value.
- **Governance MCP server protocol name.** The governance server identifies itself as
  `pi-system-governance` in the MCP handshake and its smoke client as `pi-system-governance-smoke`;
  the local server key `pi_system_governance` that settings and tool policies use is its
  underscore form. The names are a client-facing contract, not display prose.
- **TLS organisation string.** `packages/web-ui/server/remote/tls.ts` writes `pi-system` as the
  certificate organisation name (`O`); a different value changes every generated certificate.
- **Identity sets and regexes.** The package-name sets in `packages/core/lib/identity.ts`, the
  kit-source sets in `packages/core/lib/settings.ts`, and the `isKit*` helpers in `kit-update` and
  `session-helpers` recognise the legacy package name, local checkout name and git repository path
  (`/pi-system`, any ref). These are how an existing install is recognised as Luna.
- **`previousSources` and `legacySources`.** `packages/core/distribution.json` keeps
  `git:github.com/SATUNIX/pi-system` under `git.previousSources` and the retired private-source
  fingerprints under `git.legacySources`. They migrate an existing registration without contacting
  a retired source; `tests/distribution-smoke.ts` and `tests/kit-update-smoke.ts` pin the behaviour.
- **CHANGELOG history.** `CHANGELOG.md` records the old name in released entries. History is not
  rewritten; only new entries use Luna.
- **Legacy-source tests.** Tests that name old sources (for example `tests/distribution-smoke.ts`
  and `tests/kit-update-smoke.ts`) use the retired identities as fixtures, so they must keep them.
- **internal temp-directory prefixes.** `packages/core/build-npm.ts` and
  `packages/core/pack-check.ts` pass `pi-system-build-npm-` and `pi-system-pack-` to
  `fs.mkdtempSync`. They are scratch-directory path values, never user-facing names, and the
  cycle-20 review (commit `c3ca15c`) ruled they stay as-is.

Nothing in the test suite pins this page: the identities above are a reference, not a checked contract. The pre-push leak scan (`docs/repository-topology.md`) is what protects against private names reaching the public repository.

## Rename proposal

The identities above are deliberately **not** renamed: they are external contracts that existing
installs, recorded data, deployment files and operator commands depend on. Changing any of them
needs an operator decision and a migration (compatibility aliases, a settings/path migration, or a
major version), not a branding edit. Until then, display strings and documentation use Luna, and
the contracts above keep their historical names.
