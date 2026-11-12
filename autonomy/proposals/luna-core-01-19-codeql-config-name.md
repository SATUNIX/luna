# Proposal — rename the CodeQL configuration name in `.github/`

The whole-repository V-10 scan (implemented on
`origin/attempts/luna-core-01/cycle-19-subitem3`, deferred here by the review-diff cap) found exactly
one `pi-system` occurrence under `.github/`:

- `.github/codeql/codeql-config.yml:1` — `name: pi-system CodeQL configuration`

`.github/` is an operator control path, so an agent must not edit it; the brand smoke masks the line
with the generic `name: pi-system` allowance (the same allowance the compose project name uses),
which means a rename here would be invisible to the guard.

**Proposal:** the operator changes the line to `name: Luna CodeQL configuration`. The CodeQL
configuration `name` is a display label in the code-scanning UI; it is not an external contract or
an identifier another system resolves, so changing it is safe. The brand smoke and `docs/branding.md`
already describe the allowance, so no code change is needed beyond that one line.
