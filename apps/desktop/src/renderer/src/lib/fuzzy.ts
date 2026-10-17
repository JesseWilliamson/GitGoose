/**
 * Matching for the omni search: how well a query fits a piece of text, and which characters
 * matched (to highlight them).
 *
 * Each word of the query must be found in the text, in any order. A word found as a run of
 * characters scores far above one found only as scattered letters ("fbr" in "feature/branch"),
 * and a run scores more where a reader would start reading: at the start of the text, after a
 * separator (/ - _ . space), or at a camelCase hump. Shorter texts win ties, so "main" beats
 * "maintenance" for the query "main".
 */

export interface FuzzyMatch {
  score: number
  /** Matched character ranges, [start, end) in the text, sorted and merged. */
  ranges: [number, number][]
}

const isBoundary = (text: string, i: number): boolean => {
  if (i === 0) return true
  const prev = text[i - 1]!
  const cur = text[i]!
  if (/[\s/\\\-_.:@#(]/.test(prev)) return true
  return /[a-z0-9]/.test(prev) && /[A-Z]/.test(cur)
}

function matchWord(word: string, text: string, lower: string): FuzzyMatch | null {
  // A run: take the best-placed occurrence.
  let best: FuzzyMatch | null = null
  for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + 1)) {
    const score = 100 + (at === 0 ? 60 : isBoundary(text, at) ? 40 : 0) - Math.min(at, 40) * 0.5
    if (!best || score > best.score) best = { score, ranges: [[at, at + word.length]] }
  }
  if (best) return best
  // Scattered letters, in order. Worth little, and less the more spread out they are.
  const ranges: [number, number][] = []
  let from = 0
  let gaps = 0
  for (const ch of word) {
    const at = lower.indexOf(ch, from)
    if (at < 0) return null
    if (ranges.length && ranges[ranges.length - 1]![1] === at) ranges[ranges.length - 1]![1] = at + 1
    else {
      if (ranges.length) gaps += at - from
      ranges.push([at, at + 1])
    }
    from = at + 1
  }
  // Scattered letters only count as a match when the pieces start words ("fbl": feature/branch-list),
  // allowing one that does not. Otherwise "fetch" would find "snapshot of the working tree (changes)".
  const starts = ranges.filter(([s]) => isBoundary(text, s)).length
  if (ranges.length - starts > 1) return null
  return { score: 20 + starts * 8 - Math.min(gaps, 40) - ranges.length * 2, ranges }
}

export function fuzzy(query: string, text: string): FuzzyMatch | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return { score: 0, ranges: [] }
  const lower = text.toLowerCase()
  let score = 0
  const ranges: [number, number][] = []
  for (const w of words) {
    const m = matchWord(w, text, lower)
    if (!m) return null
    score += m.score
    ranges.push(...m.ranges)
  }
  if (lower === query.trim().toLowerCase()) score += 200
  score -= Math.min(text.length, 200) * 0.1
  return { score, ranges: merge(ranges) }
}

function merge(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/** Text cut into plain and matched pieces, for rendering with <mark>. */
export function pieces(text: string, ranges: [number, number][]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = []
  let at = 0
  for (const [s, e] of ranges) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false })
    out.push({ text: text.slice(s, e), hit: true })
    at = e
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out
}
