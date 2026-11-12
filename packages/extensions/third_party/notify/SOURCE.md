# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/notify.ts`
- Date: 2026-06-17
- Changes:
  - **Vendored upstream (2026-06-17):** initial import of the upstream example; the changes below are Luna's.
  - Upstream uses `require("child_process")` dynamically; changed to static `import { execFile } from "node:child_process"` for clarity and self-containment compliance
  - Windows notification path unchanged (upstream already handles WT_SESSION)
  - `provenance.origin` set to `"vendored"`
  - Kit changes (UX-08): skips print/JSON sessions (no UI) and delegated children, only notifies for runs of at least 10 s (`PI_KIT_NOTIFY_MIN_SECONDS`), adds `PI_KIT_NOTIFY=off|osc|bell|notify-send`, and escapes single quotes in the Windows toast script
