/**
 * Input ownership between extensions: while a full-screen overlay holds the keyboard, an approval
 * prompt must wait for it to close instead of stealing focus from it.
 *
 * Why it exists: pi's `ctx.ui.select()` pushes a dialog and calls `tui.setFocus()`, so a card shown
 * while `ctx.ui.custom()` has an overlay open takes the keyboard away from that overlay. Keys the
 * operator is typing into the box then answer the card, and Enter picks its first choice. The
 * firewall, the human console and the pentest gate ask this registry before they prompt, and the two overlays in the
 * kit (control-center's hub and the subagent workflow panel) hold input while they are open.
 *
 * Extensions are self-contained and may not import each other, so this module is the canonical
 * source and every consumer holds a generated, byte-checked copy (`npm run gen:shared`; `npm run
 * verify` fails on drift). The copies share one registry through `globalThis[Symbol.for(...)]`, so a
 * hold taken by one extension is seen by another; the shape is checked rather than trusted, so a
 * stale or foreign registry degrades to "input is free" instead of breaking the caller.
 */

/** The `globalThis` key every copy shares. */
const KEY = Symbol.for("pi-kit.input-owner");

export interface InputOwner {
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
export function inputOwnerRegistry(): InputOwner {
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

/** Resolve "free" when no overlay holds input; "aborted" when `signal` aborts first. */
export function whenInputFree(signal?: AbortSignal): Promise<"free" | "aborted"> {
  return inputOwnerRegistry().whenInputFree(signal);
}
