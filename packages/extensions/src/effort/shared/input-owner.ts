// GENERATED from packages/core/shared/input-owner.ts by packages/core/gen-shared.ts. Do not edit this copy:
// change the source and run `npm run gen:shared` (`npm run verify` fails when a copy differs).
/**
 * Input ownership between extensions: while a full-screen overlay holds the keyboard, an approval
 * prompt must wait for it to close instead of stealing focus from it.
 *
 * Why it exists: pi's `ctx.ui.select()` pushes a dialog and calls `tui.setFocus()`, so a card shown
 * while `ctx.ui.custom()` has an overlay open takes the keyboard away from that overlay. Keys the
 * operator is typing into the box then answer the card, and Enter picks its first choice. The
 * firewall, the human console, the engagement gate and every other prompt an agent can raise on its own
 * (the list is in docs/security.md) ask this registry before they prompt, and the two overlays in the
 * kit (control-center's hub and the subagent workflow panel) hold input while they are open, through
 * `withInputHold`. A holder also calls `releaseInputHolds` on `session_shutdown`: pi's reload removes an
 * overlay without settling `ui.custom`, so a `finally` alone would leave the hold in this process-wide
 * registry until a restart.
 *
 * Extensions are self-contained and may not import each other, so this module is the canonical
 * source and every consumer holds a generated, byte-checked copy (`npm run gen:shared`; `npm run
 * verify` fails on drift). The copies share one registry through `globalThis[Symbol.for(...)]`, so a
 * hold taken by one extension is seen by another; the shape is checked rather than trusted, so a
 * stale or foreign registry degrades to "input is free" instead of breaking the caller.
 */

/** The `globalThis` key every copy shares. */
const KEY = Symbol.for("pi-kit.input-owner");

const DEFAULT_CARD_TIMEOUT_MS = 900_000;

/** A delay for setTimeout, which fires at once above 2^31-1 ms: a very long limit must not become an instant one. */
export const timerMs = (ms: number): number => Math.min(ms, 2_147_483_647);

/** How long a prompt with no timeout of its own waits for an overlay and for its answer: the console's timeout. */
export function cardTimeoutMs(): number {
  return Math.max(1, Number(process.env.PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS) || DEFAULT_CARD_TIMEOUT_MS);
}

interface InputOwner {
  /** Take a hold for the overlay named `label`; returns an idempotent release. */
  holdInput(label: string): () => void;
  /** The label of the overlay holding input (the most recent hold), or undefined when input is free. */
  inputHeld(): string | undefined;
  /** Resolve "free" when no overlay holds input; "aborted" when `signal` aborts first. */
  whenInputFree(signal?: AbortSignal): Promise<"free" | "aborted">;
}

function createOwner(): InputOwner {
  let nextToken = 1;
  // Nested or concurrent overlays each hold their own token; input is free only when all are released.
  const held = new Map<number, string>();
  const waiters = new Set<(result: "free" | "aborted") => void>();

  const settle = (result: "free" | "aborted"): void => {
    const pending = [...waiters];
    waiters.clear();
    for (const resolve of pending) resolve(result);
  };

  return {
    holdInput(label: string): () => void {
      const token = nextToken++;
      held.set(token, label);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.delete(token);
        if (held.size === 0) settle("free");
      };
    },
    inputHeld(): string | undefined {
      let label: string | undefined;
      for (const value of held.values()) label = value;
      return label;
    },
    whenInputFree(signal?: AbortSignal): Promise<"free" | "aborted"> {
      if (signal?.aborted) return Promise.resolve("aborted");
      if (held.size === 0) return Promise.resolve("free");
      return new Promise<"free" | "aborted">((resolve) => {
        let settled = false;
        const finish = (result: "free" | "aborted"): void => {
          if (settled) return;
          settled = true;
          waiters.delete(finish);
          signal?.removeEventListener?.("abort", onAbort);
          resolve(result);
        };
        const onAbort = (): void => finish("aborted");
        waiters.add(finish);
        signal?.addEventListener?.("abort", onAbort, { once: true });
      });
    },
  };
}

function isOwner(value: unknown): value is InputOwner {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.holdInput === "function" && typeof candidate.inputHeld === "function" && typeof candidate.whenInputFree === "function";
}

/** The one registry every copy shares. */
function inputOwnerRegistry(): InputOwner {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[KEY];
  if (isOwner(existing)) return existing;
  const owner = createOwner();
  global[KEY] = owner;
  return owner;
}

/** Take a hold for the overlay named `label`; returns an idempotent release. */
export function holdInput(label: string): () => void {
  return inputOwnerRegistry().holdInput(label);
}

/** The label of the overlay holding input (the most recent hold), or undefined when input is free. */
export function inputHeld(): string | undefined {
  return inputOwnerRegistry().inputHeld();
}

// The releases of the holds this copy took and has not given back. Module state, so each extension's
// generated copy keeps its own: one extension's shutdown must not drop another's hold.
const scopedHolds = new Set<() => void>();

/** Run `body` while the overlay named `label` holds input. See releaseInputHolds for what `finally` misses. */
export async function withInputHold<T>(label: string, body: () => Promise<T>): Promise<T> {
  const release = holdInput(label);
  scopedHolds.add(release);
  try {
    return await body();
  } finally {
    scopedHolds.delete(release);
    release();
  }
}

/** Drop the holds of any overlay the session is ending under: call it from `session_shutdown`. */
export function releaseInputHolds(): void {
  for (const release of scopedHolds) release();
  scopedHolds.clear();
}

/**
 * Resolve "free" when no overlay holds input, "aborted" when `signal` aborts first, "timeout" when
 * `timeoutMs` passes first. A request for a card must pass a timeout: nothing waits forever unattended.
 */
export async function whenInputFree(signal?: AbortSignal, timeoutMs?: number): Promise<"free" | "aborted" | "timeout"> {
  // The registry's shape is checked on every call: it guards against a mismatched copy.
  const owner = inputOwnerRegistry();
  if (signal?.aborted) return "aborted";
  if (!owner.inputHeld()) return "free";
  const expiry = new AbortController();
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => expiry.abort(), timerMs(timeoutMs));
  timer?.unref();
  const wait = signal ? AbortSignal.any([signal, expiry.signal]) : expiry.signal;
  try {
    // Re-check after each wait: another overlay can take the keyboard before the card is shown.
    for (;;) {
      const result = await owner.whenInputFree(wait);
      if (signal?.aborted) return "aborted";
      if (result === "aborted") return "timeout";
      if (!owner.inputHeld()) return "free";
    }
  } finally {
    clearTimeout(timer);
  }
}

/** The options a held card is opened with: pi dismisses it at `timeout`, or when `signal` aborts. */
export interface CardOptions {
  timeout: number;
  signal?: AbortSignal;
}

export interface ShowWhenFreeOptions {
  signal?: AbortSignal | undefined;
  /** The bound on the hold and the card together. */
  timeoutMs?: number | undefined;
  /** Called once, with the holder's label, when the card has to wait. */
  onHeld?: ((holder: string) => void) | undefined;
  /**
   * Give the card the time left as it stands, not bounded for setTimeout. The firewall, console and
   * engagement prompts take this: a configured value past the timer's range ends their card at once,
   * which refuses, and bounding it would turn that refusal into an open card.
   */
  rawTimeout?: boolean | undefined;
}

/**
 * Show a card once no overlay holds input. The wait and the card share one deadline, and pi is given
 * what is left of it, so an overlay left open fails closed instead of parking the caller.
 */
export async function showWhenFree<T>(show: (card: CardOptions) => Promise<T>, options: ShowWhenFreeOptions = {}): Promise<{ kind: "shown"; value: T } | { kind: "aborted" | "timeout" }> {
  const { signal, timeoutMs = cardTimeoutMs(), onHeld, rawTimeout = false } = options;
  const deadline = Date.now() + timeoutMs;
  const holder = inputHeld();
  if (holder) onHeld?.(holder);
  const waited = await whenInputFree(signal, timeoutMs);
  if (waited !== "free") return { kind: waited };
  const left = Math.max(1, deadline - Date.now());
  const card: CardOptions = { timeout: rawTimeout ? left : timerMs(left), ...(signal ? { signal } : {}) };
  return { kind: "shown", value: await show(card) };
}
