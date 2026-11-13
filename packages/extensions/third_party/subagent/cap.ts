/**
 * A byte-bounded view of text that goes back to the model.
 *
 * Tool results are most of what an agent re-reads on every request, and one unbounded one (a
 * background run's log is JSON events with whole partial results in them) can be larger than the
 * model's window. `capText` keeps the head and the tail, drops the middle, and says where the full
 * text is, so the agent can read a slice of it instead of receiving all of it.
 */

/** Characters a Luna tool result may carry before the middle is dropped; PI_KIT_TOOL_RESULT_MAX_CHARS overrides it. */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 12_000;

/** The cap in force: the environment value when it is a whole number of at least 1,000, else the default. */
export function toolResultMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PI_KIT_TOOL_RESULT_MAX_CHARS);
  return Number.isInteger(raw) && raw >= 1000 ? raw : DEFAULT_TOOL_RESULT_MAX_CHARS;
}

/**
 * `text` unchanged when it fits in `max` characters; otherwise the first two thirds and the last
 * third of the budget around a marker naming how much was dropped and `where` the whole text is.
 */
export function capText(text: string, where: string, max: number = toolResultMaxChars()): string {
  if (text.length <= max) return text;
  const head = Math.floor((max * 2) / 3);
  const tail = max - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[${dropped} characters omitted; the full text is ${where}]\n\n${text.slice(text.length - tail)}`;
}

/** Each line of `text` cut to `max` characters, with the cut marked, so one huge line cannot fill a result. */
export function capLines(text: string, max: number): string {
  return text
    .split("\n")
    .map((line) => (line.length <= max ? line : `${line.slice(0, max)} […${line.length - max} more characters]`))
    .join("\n");
}
