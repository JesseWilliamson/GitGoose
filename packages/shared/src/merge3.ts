/**
 * Three-way merge, line by line: the algorithm behind the three-pane conflict view.
 *
 * Given the common ancestor (base) and two descendants (ours, theirs):
 *   1. diff base -> ours and base -> theirs (Myers' algorithm, below)
 *   2. put both lists of changed regions in base order, and cluster regions that overlap or
 *      touch in base (git treats adjacent changes as conflicting too)
 *   3. a cluster changed by one side only is not a conflict: take that side; changed by both
 *      sides identically, also fine; otherwise it is a conflict the user must decide
 *   4. the stretches between clusters are unchanged on all three sides
 *
 * `git merge-file --diff3` does the same thing and is the reference in the tests.
 */

/** Split into lines, each keeping its "\n", so joining them gives the text back exactly. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** A changed region: lines [aStart, aEnd) of A became lines [bStart, bEnd) of B. */
export interface Hunk {
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

/**
 * Above this many edits, stop searching for the shortest script and report the rest as one big
 * change. The backtracking trace costs about D² integers, so this bounds memory (~16 MB) and time
 * on files that were rewritten wholesale, where a minimal diff would not help anyone anyway.
 */
export const MAX_EDITS = 2000

/**
 * Myers' O((N+M)D) diff. Walks diagonals of the edit graph, furthest-reaching path per number of
 * edits D, until it reaches the end; then backtracks through the saved frontiers to recover the
 * path, and turns runs of non-diagonal steps into hunks.
 *
 * The common prefix and suffix are stripped first (most edits touch a small part of a file), and
 * each saved frontier keeps only the diagonals -d..d it can actually have reached.
 */
export function diffLines(a: readonly string[], b: readonly string[], maxEdits = MAX_EDITS): Hunk[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const hunks = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf), maxEdits)
  return hunks.map((h) => ({ aStart: h.aStart + pre, aEnd: h.aEnd + pre, bStart: h.bStart + pre, bEnd: h.bEnd + pre }))
}

function myers(a: readonly string[], b: readonly string[], maxEdits: number): Hunk[] {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0 || m === 0) return [{ aStart: 0, aEnd: n, bStart: 0, bEnd: m }]
  const max = n + m
  const offset = max
  const v = new Int32Array(2 * max + 2)
  // trace[d] = the frontier before round d, diagonals -d..d (index k + d).
  const trace: Int32Array[] = []
  let done = false
  for (let d = 0; d <= max && !done; d++) {
    if (d > maxEdits) return [{ aStart: 0, aEnd: n, bStart: 0, bEnd: m }]
    trace.push(v.slice(offset - d, offset + d + 1))
    for (let k = -d; k <= d; k += 2) {
      // Down (insertion) when we cannot go right, or the down path reaches further.
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        done = true
        break
      }
    }
  }
  // Backtrack: for each D, which diagonal did we come from?
  const steps: [number, number][] = [] // matched (x, y) points, from the end
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]!
    const k = x - y
    const prevK = k === -d || (k !== d && vd[k - 1 + d]! < vd[k + 1 + d]!) ? k + 1 : k - 1
    const prevX = d > 0 ? vd[prevK + d]! : 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      steps.push([x, y])
    }
    if (d > 0) {
      x = prevX
      y = prevY
    }
  }
  steps.reverse()
  // Everything not on a matched diagonal is a change; group consecutive changes.
  const hunks: Hunk[] = []
  let ai = 0
  let bi = 0
  const flush = (aTo: number, bTo: number) => {
    if (aTo > ai || bTo > bi) hunks.push({ aStart: ai, aEnd: aTo, bStart: bi, bEnd: bTo })
  }
  for (const [mx, my] of steps) {
    flush(mx, my)
    ai = mx + 1
    bi = my + 1
  }
  flush(n, m)
  return hunks
}

export type BlockKind = 'same' | 'ours' | 'theirs' | 'both-same' | 'conflict'

export interface Range {
  start: number
  end: number
}

export interface MergeBlock {
  kind: BlockKind
  base: Range
  ours: Range
  theirs: Range
}

export interface Merge3 {
  base: string[]
  ours: string[]
  theirs: string[]
  blocks: MergeBlock[]
}

export function merge3(baseText: string, oursText: string, theirsText: string): Merge3 {
  const base = splitLines(baseText)
  const ours = splitLines(oursText)
  const theirs = splitLines(theirsText)
  const changes = [
    ...diffLines(base, ours).map((h) => ({ ...h, side: 'ours' as const })),
    ...diffLines(base, theirs).map((h) => ({ ...h, side: 'theirs' as const })),
  ].sort((p, q) => p.aStart - q.aStart || p.aEnd - q.aEnd)

  const blocks: MergeBlock[] = []
  // How far ours/theirs line numbers are shifted from base by the changes already passed.
  let dOurs = 0
  let dTheirs = 0
  let pos = 0 // base position consumed so far
  let i = 0
  while (i < changes.length) {
    // Cluster: everything overlapping or touching [start, end) in base.
    const start = changes[i]!.aStart
    let end = changes[i]!.aEnd
    const members = [changes[i]!]
    i++
    while (i < changes.length && changes[i]!.aStart <= end) {
      end = Math.max(end, changes[i]!.aEnd)
      members.push(changes[i]!)
      i++
    }
    if (start > pos) {
      blocks.push({ kind: 'same', base: { start: pos, end: start }, ours: { start: pos + dOurs, end: start + dOurs }, theirs: { start: pos + dTheirs, end: start + dTheirs } })
    }
    const o = members.filter((c) => c.side === 'ours')
    const t = members.filter((c) => c.side === 'theirs')
    // Each side's version of the cluster's base range: unchanged lines map through, changed ones
    // through its hunks. Its length is the base length plus that side's net change in here.
    const oGrow = o.reduce((s, c) => s + (c.bEnd - c.bStart) - (c.aEnd - c.aStart), 0)
    const tGrow = t.reduce((s, c) => s + (c.bEnd - c.bStart) - (c.aEnd - c.aStart), 0)
    const oursR = { start: start + dOurs, end: end + dOurs + oGrow }
    const theirsR = { start: start + dTheirs, end: end + dTheirs + tGrow }
    let kind: BlockKind
    if (!t.length) kind = 'ours'
    else if (!o.length) kind = 'theirs'
    else kind = ours.slice(oursR.start, oursR.end).join('') === theirs.slice(theirsR.start, theirsR.end).join('') ? 'both-same' : 'conflict'
    blocks.push({ kind, base: { start, end }, ours: oursR, theirs: theirsR })
    dOurs += oGrow
    dTheirs += tGrow
    pos = end
  }
  if (pos < base.length) {
    blocks.push({ kind: 'same', base: { start: pos, end: base.length }, ours: { start: pos + dOurs, end: base.length + dOurs }, theirs: { start: pos + dTheirs, end: base.length + dTheirs } })
  }
  return { base, ours, theirs, blocks }
}

export type BlockChoice = 'ours' | 'theirs' | 'both' | 'base'

/** The text of one block for a choice (non-conflicting blocks have only one sensible answer). */
export function blockText(m: Merge3, b: MergeBlock, choice?: BlockChoice): string {
  const slice = (lines: string[], r: Range) => lines.slice(r.start, r.end).join('')
  switch (b.kind) {
    case 'same': return slice(m.base, b.base)
    case 'ours':
    case 'both-same': return slice(m.ours, b.ours)
    case 'theirs': return slice(m.theirs, b.theirs)
    case 'conflict':
      if (choice === 'ours') return slice(m.ours, b.ours)
      if (choice === 'theirs') return slice(m.theirs, b.theirs)
      if (choice === 'both') return withNewline(slice(m.ours, b.ours)) + slice(m.theirs, b.theirs)
      return slice(m.base, b.base)
  }
}

function withNewline(s: string): string {
  return s && !s.endsWith('\n') ? s + '\n' : s
}

/** Merge with every non-conflicting change applied; conflicts keep the base text (or a choice). */
export function mergedText(m: Merge3, choices: (BlockChoice | undefined)[] = []): string {
  return m.blocks.map((b, i) => blockText(m, b, choices[i])).join('')
}

export function conflictCount(m: Merge3): number {
  return m.blocks.filter((b) => b.kind === 'conflict').length
}
