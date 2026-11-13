/**
 * Background text an extension adds to a request without writing it into the session.
 *
 * A message returned from `before_agent_start` is stored in the session and replayed as a
 * user-role turn until compaction: it persists, it sits in the middle of the transcript, and a
 * note that frames itself as "not written by the user" looks like an injection to a provider's
 * prompt-injection filter. A carried note is added by the `context` event for each request
 * instead: after the real messages, never stored, never replayed from the session file, and
 * dropped by the owner when it stops being true (compaction, a new session, the end of a run).
 *
 * Extensions are self-contained, so each consumer holds a generated copy (`npm run gen:shared`).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface CarriedNotes {
  /** Carry `text` under `id`; the same id again replaces it. Empty text drops the note. */
  set(id: string, text: string): void;
  /** Carry `text` as one more note, after those already carried. */
  add(text: string): void;
  /** Drop the note with this id, or every note when none is given. */
  clear(id?: string): void;
  /** The notes now carried, in the order they are appended. */
  list(): readonly string[];
}

/** Register the `context` handler that appends the notes, and return the handle that owns them. */
export function carryNotes(pi: Pick<ExtensionAPI, "on">, customType: string): CarriedNotes {
  const named = new Map<string, string>();
  const added: string[] = [];
  const list = (): readonly string[] => [...named.values(), ...added];
  pi.on("context", (event) => {
    const notes = list();
    if (notes.length === 0) return undefined;
    const now = Date.now();
    const extra = notes.map((content) => ({ role: "custom" as const, customType, content, display: false, timestamp: now }));
    return { messages: [...event.messages, ...extra] };
  });
  return {
    set(id, text) {
      if (text === "") named.delete(id);
      else named.set(id, text);
    },
    add(text) {
      if (text !== "") added.push(text);
    },
    clear(id) {
      if (id === undefined) {
        named.clear();
        added.length = 0;
      } else named.delete(id);
    },
    list,
  };
}
