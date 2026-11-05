---
name: wrapper-runtime-maintainer
category: maintainer
description: Maintain the Luna container wrapper without forking upstream Pi core. Use when editing the Dockerfile, entrypoint, compose, env defaults, or health checks — preserve the security posture and keep project resources under .pi/.
disable-model-invocation: true
triggers: ["dockerfile", "docker compose", "docker-compose", "container entrypoint", "healthcheck", "container wrapper"]
---

# Wrapper Runtime Maintainer

The wrapper packages upstream Pi for Luna; it must not fork Pi core, and it must preserve
the container's security posture.

## When to use
- Editing the Dockerfile, entrypoint, compose files, env defaults, or health checks.

## Invariants to preserve
1. **Upstream Pi stays a dependency** — installed, not vendored/modified. No forking core.
2. **Project resources live under `.pi/`.**
3. **Compose stays aligned** — the canonical compose and the root compose must not drift
   apart.
4. **Security posture holds:** read-only root filesystem, non-root user, defined data root,
   working healthcheck, and host-gateway wiring — none silently removed.

## Procedure
1. Make the minimal change (`patch-hygiene`); keep the security flags intact.
2. If you add a required file/env/contract, add a validation check
   (`validation-test-maintainer`).
3. Verify the container still builds and the healthcheck passes as non-root on a read-only
   root FS.
4. Update runtime docs to match (`documentation-workflow`).

## Anti-patterns
- Patching Pi core instead of configuring the wrapper.
- Dropping non-root / read-only-root / healthcheck to "make it work."
- Letting canonical and root compose diverge.

## Done
The wrapper change keeps Pi upstream, preserves the security posture, keeps compose aligned,
has checks for any new contract, and matches the docs.
