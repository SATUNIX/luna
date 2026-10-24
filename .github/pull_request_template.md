## What and why

<!-- The finding or need, its root cause, and what this change does about it. -->

## Verification

<!-- The commands you ran and their result. A behaviour change names the test that pins it. -->

- [ ] `npm run verify`
- [ ] `npm run test:typecheck` and `npm run test:lint`
- [ ] `npm run test:security` (for changes to `packages/core/`, `packages/extensions/` or `packages/kit/`)
- [ ] Documentation and `CHANGELOG.md` (under `## [Unreleased]`) describe the new behaviour

## Checklist

- [ ] No secrets, private host names, private addresses or machine paths (`node packages/core/prepush-scan.ts install` runs the leak scan before each push)
- [ ] Scoped: no unrelated reformatting
- [ ] Agent-authored: say so here; an agent never approves or merges its own pull request
