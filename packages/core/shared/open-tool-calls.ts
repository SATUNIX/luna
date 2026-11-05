/**
 * Open tool calls of a child's JSONL stream, for an idle watchdog: a long silent tool call is work,
 * not a stall, so the watchdog is held until the last call ends. The caller keeps its own timers and
 * passes each parsed event here.
 *
 * Calls are counted per id, so nested and parallel calls each hold it open even when they share an
 * id; a blank or missing id is one counted key. An end for a key with nothing open changes nothing.
 * Real pi always sends balanced ids.
 *
 * Extensions are self-contained, so each consumer holds a generated copy (`npm run gen:shared`).
 */
export interface OpenToolCalls {
  /** Count a parsed event; anything but `tool_execution_start` and `tool_execution_end` is ignored. */
  note(event: Record<string, unknown>): void;
  /** True while any call is open. */
  open(): boolean;
}

export function openToolCalls(): OpenToolCalls {
  const counts = new Map<string, number>();
  return {
    note(event) {
      if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
      const id = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
      const open = (counts.get(id) ?? 0) + (event.type === "tool_execution_start" ? 1 : -1);
      if (open > 0) counts.set(id, open);
      else counts.delete(id);
    },
    open: () => counts.size > 0,
  };
}
