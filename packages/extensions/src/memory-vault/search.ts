/**
 * memory-vault — lexical relevance (BM25) with stopword filtering and a relevance floor.
 *
 * The previous recall scored a memory by counting raw query words found anywhere in it as
 * substrings, so "a", "the" and "is" matched nearly everything and every prompt injected the
 * three oldest memories. Here a query made only of stopwords matches nothing, and a result
 * must clear both a score floor and a matched-term floor before it is injected.
 */

const STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are as at be because been before being below between both but by " +
    "can could did do does doing done down during each few for from further had has have having he her here hers herself him " +
    "himself his how i if in into is it its itself just let lets like make me more most my myself no nor not now of off on once " +
    "only or other our ours ourselves out over own please same she should so some such than that the their theirs them " +
    "themselves then there these they this those through to too under until up us use using very want was we were what when " +
    "where which while who whom why will with would you your yours yourself yourselves ok okay yes yeah thanks thank hi hello " +
    "hey also get got go going need needs one two new way thing things something anything really still"
  ).split(" "),
);

// Light suffix stripping so "commits"/"commit", "prefers"/"preferred"/"preference" and
// "crashing"/"crash" meet. Deliberately conservative: a wrong merge costs recall precision.
export function stem(t: string): string {
  // Words shorter than the shortest suffix rule (the -s rule's own minimum is 4) pass through
  // unchanged; a 4-character word may still be a plural of a 3-letter singular ("logs" -> "log").
  if (t.length < 4 || /[._+-]/.test(t)) return t;
  for (const [suffix, min] of [["ations", 7], ["ation", 6], ["ences", 7], ["ence", 6], ["ings", 7], ["ing", 6], ["ies", 5], ["ied", 5], ["ed", 5], ["es", 5], ["s", 4]] as const) {
    if (t.length >= min && t.endsWith(suffix) && !t.endsWith("ss")) {
      const base = t.slice(0, -suffix.length);
      if (suffix === "ies" || suffix === "ied") return `${base}y`;
      // A plural in -es keeps its sibilant base ("classes" -> "class") or restores the silent e
      // of a short singular ("files" -> "file"); a long singular strips its own e in the final
      // rule below ("response"/"responses" -> "respons"), so the base is where they meet.
      if (suffix === "es") {
        if (/(ss|x|z|ch|sh)$/.test(base)) return base;
        const singular = `${base}e`;
        return singular.length > 5 ? base : singular;
      }
      // The doubled-consonant collapse is for -ed/-ing ("preferred" -> "prefer"); a plain
      // plural keeps its base whole ("files" -> "file", "cliffs" -> "cliff").
      if (suffix === "s") return base;
      return base.replace(/(.)\1$/, "$1");
    }
  }
  // "configure" and "configured" -> "configur"
  return t.length > 5 && t.endsWith("e") ? t.slice(0, -1) : t;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").match(/[a-z0-9][a-z0-9_.+-]*[a-z0-9]|[a-z0-9]/g) ?? [])
    .flatMap((t) => (t.includes(".") || t.includes("-") || t.includes("_") ? [t, ...t.split(/[._-]+/)] : [t]))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

export function termFrequencies(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

export interface Doc {
  id: string;
  tf: Record<string, number>;
  len: number;
}

export interface Scored {
  id: string;
  score: number;
  matched: number;
}

const K1 = 1.2;
const B = 0.75;

// Okapi BM25 over the given docs. `matched` counts distinct query terms present in a doc.
export function bm25(query: string, docs: Doc[]): Scored[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || docs.length === 0) return [];
  const avgLen = docs.reduce((n, d) => n + d.len, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, docs.filter((d) => d.tf[t]).length);
  const out: Scored[] = [];
  for (const d of docs) {
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const f = d.tf[t];
      if (!f) continue;
      matched++;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgLen)));
    }
    if (matched > 0) out.push({ id: d.id, score, matched });
  }
  return out.sort((a, b) => b.score - a.score);
}

// Relevance gate for automatic injection: a strong-enough score AND, for multi-term queries,
// at least two distinct matching terms (one shared common word is not relevance).
export function passesFloor(s: Scored, queryTermCount: number, minScore: number): boolean {
  if (s.score < minScore) return false;
  return queryTermCount < 2 || s.matched >= 2;
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B2 = new Set(b);
  if (A.size === 0 && B2.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B2.has(x)) inter++;
  return inter / (A.size + B2.size - inter);
}
