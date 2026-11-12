# Proposal: keep one critical footer chip on narrow terminals

Found by the cycle-08 ux review (2026-11-12), from a read-only scout probe of the vendored
`custom-footer`. The file is listed as "do not touch: footer priority/fitting logic" for this
stream, so the fix is proposed rather than taken.

## Evidence

`packages/extensions/third_party/custom-footer/render.ts:229-232` ends `fitLine` with:

```ts
const leftRoom = width - (rw ? rw + 2 : 0);
if (rw && leftRoom >= 12) return `${truncateDisplay(join(l, sep), leftRoom, ellipsis)}  ${join(r, sep)}`;
return truncateDisplay(join(l, sep), width, ellipsis);
```

The left context segment is the anchor (`:201`) and priority-0 chips are merged only when there
are at least two of them (`:216`), so a single right-side critical chip is never moved or merged.
When `leftRoom < 12` the right side is dropped entirely.

Measured with `renderFooter` in default mode (`context: 66%`, status `orchestrator: blocked:
verify`):

```
width 20: keeps-error=false | ● proj        E3 1/3 | ctx 66%
width 24: keeps-error=false | ● proj            E3 1/3 | ctx 66%
width 37: keeps-error=false | ... | ctx 66%
width 38: keeps-error=true  | ... | ctx 66%   orchestrator blocked: verify
```

This contradicts the module contract at `render.ts:8-13`: segments that carry a boundary or
failure warning are never dropped for secondary telemetry. Existing tests cover the `render.ts`
warnings path or two criticals at 40+ columns (`tests/status-bar-smoke.ts:207-249`);
`tests/tui-layout-smoke.ts` only asserts that lines fit, never that the warning survives.

## Suggested fix

In the `total > width` fallback, keep the right side when it holds a priority-0 chip even if
`leftRoom < 12`, truncating the left context (or the chip itself) instead of dropping the
warning. Add a `status-bar-smoke` case at widths 20/32/37 asserting the `orchestrator` chip is
present, the line still fits, and it outranks context. Do not change the existing assertions.

## Related minor drift

`packages/extensions/src/control-center/launch-screen.ts:67-69` (`asciiThemeName`) omits the
`PI_KIT_ASCII === "1"` clause that `footerGlyphs` has (`custom-footer/render.ts:120`). It is
latent because `launchHeader` ORs `opts.ascii` from registration, so no user sees it today; a
later caller or refactor would drift. Fold the env clause into one shared predicate when that
surface is next touched.
