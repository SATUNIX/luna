/**
 * A conservative syntactic check for regular expressions that come from outside the program (a
 * result schema's "pattern", a project skill's `re:` trigger), and the one place such text is
 * compiled (`compileCheckedRegex`). eslint.config.ts refuses `new RegExp` with a non-literal
 * pattern elsewhere unless the file is on its reviewed list.
 *
 * The check refuses the shapes that backtrack exponentially and the long optional runs that are
 * slow to compile. It does not bound polynomial backtracking (`.*.*x`): a caller that tests a
 * checked pattern against long text still caps the text and the time.
 *
 * Canonical source: packages/core/shared/safe-regex.ts. Extensions hold generated, byte-checked
 * copies (`npm run gen:shared`; `npm run verify` fails on drift).
 */
/** Longest "pattern" accepted, in characters. */
export const MAX_PATTERN_LENGTH = 256;
/**
 * Most choice points a "pattern" may have: quantifiers whose minimum and maximum differ (?, *, +,
 * {n,}, {n,m} with n < m) plus "|" alternatives. V8's compile time grows exponentially with a run
 * of optional atoms ahead of literals: on node 26, a?×50 then a×50 (150 characters) takes about 5 s
 * to compile and (?:a|)×36 then a×36 about a second, while the slowest 16-choice shapes measured,
 * such as [ab]{0,3}×16 then literals, compile in about 15 ms.
 */
export const MAX_PATTERN_CHOICES = 16;

/**
 * The quantifier starting at `i`, if any: where it ends, whether it can repeat its atom, and
 * whether it is a choice point (its minimum and maximum differ).
 */
function quantifierAt(pattern: string, i: number): { end: number; repeats: boolean; variable: boolean } | null {
  const c = pattern[i];
  let end: number;
  let repeats: boolean;
  let variable = true;
  if (c === "*" || c === "+") {
    end = i + 1;
    repeats = true;
  } else if (c === "?") {
    end = i + 1;
    repeats = false;
  } else if (c === "{") {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
    if (!m) return null;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === "" ? Number.POSITIVE_INFINITY : Number(m[3]);
    end = i + m[0].length;
    repeats = max > 1;
    variable = max !== min;
  } else return null;
  if (pattern[end] === "?") end++;
  return { end, repeats, variable };
}

/**
 * Why a (compiling) pattern is refused, or null. Conservative and syntactic: a backreference, a
 * repeating quantifier (*, +, {n,} or {n,m} with m > 1) on a group that contains a quantifier or
 * an alternation, at any depth, or more than MAX_PATTERN_CHOICES choice points. That refuses the
 * shapes that backtrack exponentially, such as (a+)+, (a|a)* and (x*y?)*, along with some harmless
 * ones like (-[a-z]+)*, and the long optional runs that are slow to compile.
 */
export function patternProblem(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return `longer than ${MAX_PATTERN_LENGTH} characters`;
  // One frame per open group; `risky` is set once it contains a quantifier or an alternation.
  const root = { risky: false };
  const stack: Array<{ risky: boolean }> = [];
  let choices = 0;
  const tooManyChoices = `more than ${MAX_PATTERN_CHOICES} quantifiers and alternatives, which can be slow to compile (use fewer optional parts)`;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    const top = stack[stack.length - 1] ?? root;
    if (c === "(") {
      if (pattern.startsWith("(?<=", i) || pattern.startsWith("(?<!", i)) i += 4;
      else if (pattern.startsWith("(?<", i)) {
        const close = pattern.indexOf(">", i);
        i = close < 0 ? pattern.length : close + 1;
      } else if (pattern[i + 1] === "?") i += 3;
      else i += 1;
      stack.push({ risky: false });
      continue;
    }
    if (c === ")") {
      const group = stack.pop();
      const q = quantifierAt(pattern, i + 1);
      if (group && q?.repeats && group.risky) return "a repeated group contains a quantifier or an alternation, which can backtrack exponentially (use a character class, or drop the outer quantifier)";
      if (q?.variable && ++choices > MAX_PATTERN_CHOICES) return tooManyChoices;
      const parent = stack[stack.length - 1] ?? root;
      if (group && (group.risky || q)) parent.risky = true;
      i = q ? q.end : i + 1;
      continue;
    }
    if (c === "|") {
      top.risky = true;
      if (++choices > MAX_PATTERN_CHOICES) return tooManyChoices;
      i++;
      continue;
    }
    if (c === "^" || c === "$") {
      i++;
      continue;
    }
    if (c === "\\") {
      const next = pattern[i + 1] ?? "";
      if (/[1-9]/.test(next) || (next === "k" && pattern[i + 2] === "<")) return "backreferences are not allowed";
      if ((next === "u" || next === "p" || next === "P") && pattern[i + 2] === "{") {
        const close = pattern.indexOf("}", i);
        i = close < 0 ? pattern.length : close + 1;
      } else i += 2;
    } else if (c === "[") {
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
      i = j + 1;
    } else i++;
    // The atom just passed may carry a quantifier.
    const q = quantifierAt(pattern, i);
    if (q) {
      top.risky = true;
      if (q.variable && ++choices > MAX_PATTERN_CHOICES) return tooManyChoices;
      i = q.end;
    }
  }
  return null;
}

/** Compiles `pattern` when it compiles and patternProblem accepts it; otherwise says why not. */
export function compileCheckedRegex(pattern: string, flags = ""): { ok: true; re: RegExp } | { ok: false; problem: string } {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return { ok: false, problem: "not a valid regular expression" };
  }
  const problem = patternProblem(pattern);
  return problem ? { ok: false, problem } : { ok: true, re };
}
