import { diffLines, type Hunk } from '@gitgoose/shared'

/**
 * Layout for the diff view: rows for the side-by-side view, and word-level changes inside
 * changed lines. Pure, so it is unit-tested; DiffView only draws.
 *
 * Pairing: in a hunk, a run of removed lines followed by a run of added lines is a "change
 * block". Its lines are paired top to bottom (removed line k beside added line k), which is what
 * every side-by-side diff does; unpaired leftovers sit next to an empty cell.
 */

/** One row of the split view: line indexes into hunk.lines, either side may be empty. */
export interface SplitRow {
  left: number | null
  right: number | null
}

export function splitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = []
  const lines = hunk.lines
  let i = 0
  while (i < lines.length) {
    if (lines[i]!.kind === ' ') {
      rows.push({ left: i, right: i })
      i++
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    while (i < lines.length && lines[i]!.kind === '-') dels.push(i++)
    while (i < lines.length && lines[i]!.kind === '+') adds.push(i++)
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null })
  }
  return rows
}

/** For each changed line, the line it is paired with (removed with added and back), or none. */
export function pairs(hunk: Hunk): Map<number, number> {
  const out = new Map<number, number>()
  for (const r of splitRows(hunk)) {
    if (r.left !== null && r.right !== null && r.left !== r.right) {
      out.set(r.left, r.right)
      out.set(r.right, r.left)
    }
  }
  return out
}

/** Character ranges [start, end) that changed within a line. */
export type Ranges = [number, number][]

const TOKEN = /\w+|\s+|[^\w\s]/g

/**
 * The words that differ between a removed line and the added line paired with it. Lines that
 * have little in common return null: highlighting most of a line tells the reader nothing more
 * than the line colour already does.
 */
export function wordDiff(oldText: string, newText: string): { old: Ranges; new: Ranges } | null {
  if (oldText === newText) return { old: [], new: [] }
  if (oldText.length + newText.length > 4000) return null
  const a = oldText.match(TOKEN) ?? []
  const b = newText.match(TOKEN) ?? []
  const hunks = diffLines(a, b)
  const offsets = (tokens: string[]) => {
    const at = [0]
    for (const t of tokens) at.push(at[at.length - 1]! + t.length)
    return at
  }
  const oa = offsets(a)
  const ob = offsets(b)
  const old: Ranges = []
  const nu: Ranges = []
  let changed = 0
  for (const h of hunks) {
    if (h.aEnd > h.aStart) old.push([oa[h.aStart]!, oa[h.aEnd]!])
    if (h.bEnd > h.bStart) nu.push([ob[h.bStart]!, ob[h.bEnd]!])
    changed += oa[h.aEnd]! - oa[h.aStart]! + (ob[h.bEnd]! - ob[h.bStart]!)
  }
  if (changed > 0.6 * (oldText.length + newText.length)) return null
  return { old, new: nu }
}

/** A piece of a line to draw: its text, its syntax colour, and whether it is a changed word. */
export interface Segment {
  text: string
  color?: string
  changed: boolean
}

/**
 * Cut a line into segments at both its syntax-token boundaries and its changed-word ranges, so
 * one span can carry a token's colour and a changed-word background.
 */
export function segments(text: string, tokens: { content: string; color?: string }[] | null, ranges: Ranges): Segment[] {
  const toks = tokens ?? [{ content: text }]
  const out: Segment[] = []
  let pos = 0
  let r = 0
  for (const t of toks) {
    let start = 0
    while (start < t.content.length) {
      const at = pos + start
      while (r < ranges.length && ranges[r]![1] <= at) r++
      const inRange = r < ranges.length && ranges[r]![0] <= at
      // Next boundary: end of this token, or the start / end of the current range.
      const boundary = inRange ? ranges[r]![1] : r < ranges.length ? ranges[r]![0] : Infinity
      const len = Math.min(t.content.length - start, boundary - at)
      out.push({ text: t.content.slice(start, start + len), color: t.color, changed: inRange })
      start += len
    }
    pos += t.content.length
  }
  return out
}

/** One row of a whole-file comparison: unchanged, removed or added, or "…" for skipped context. */
export type FileDiffRow = { kind: ' ' | '-' | '+'; text: string } | { kind: 'skip'; count: number }

/**
 * Two versions of a file as unified diff rows, keeping `context` unchanged lines around each
 * change and folding the rest (for showing an AI's proposed fix before it is written).
 */
export function fileDiffRows(before: string, after: string, context = 3): FileDiffRow[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const hunks = diffLines(a, b)
  const rows: FileDiffRow[] = []
  let ai = 0
  const keep = (from: number, to: number, isFirst: boolean, isLast: boolean) => {
    // Unchanged a[from..to): show `context` lines after the previous change and before the next.
    const head = isFirst ? 0 : context
    const tail = isLast ? 0 : context
    if (to - from <= head + tail + 1) {
      for (let i = from; i < to; i++) rows.push({ kind: ' ', text: a[i]! })
      return
    }
    for (let i = from; i < from + head; i++) rows.push({ kind: ' ', text: a[i]! })
    rows.push({ kind: 'skip', count: to - from - head - tail })
    for (let i = to - tail; i < to; i++) rows.push({ kind: ' ', text: a[i]! })
  }
  hunks.forEach((h, n) => {
    keep(ai, h.aStart, n === 0, false)
    for (let i = h.aStart; i < h.aEnd; i++) rows.push({ kind: '-', text: a[i]! })
    for (let i = h.bStart; i < h.bEnd; i++) rows.push({ kind: '+', text: b[i]! })
    ai = h.aEnd
  })
  if (hunks.length) keep(ai, a.length, false, true)
  return rows
}
