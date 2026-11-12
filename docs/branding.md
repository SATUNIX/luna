# Branding

The product is **Luna**. The pi package is still named `@satunix/pi-system`, so install commands,
settings entries and environment variables are unchanged.

Only these backticked identities may still name the old package:

- `@satunix/pi-system` — the npm package name.
- `@satunix/pi-system-lite` — the retired generated package.
- `pi-system` — the historical project name in rename notes.

Every `pi-system` occurrence in the scanned documentation must be inside backticks naming one of
these identities. `tests/brand-smoke.ts` (`npm run smoke:brand`) enforces this.
