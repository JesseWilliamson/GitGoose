import { chooseLayout, collapseReason, displayColumns, fileShape, type DiffTarget, type FileDiff, type ReaderLayout, type ReaderRoom, type StreamFile, type StreamTarget } from '@gitgoose/shared'
import { splitRows } from './diffLayout'

/**
 * The reader's stream (ADR-012) as rows: every file of every block (a commit, a comparison, the
 * unstaged or staged changes) one after another, in one list. Pure, so the rules are tested here
 * and the component only draws.
 *
 * Every row has a height known before it is drawn: a file header, a hunk header, a line, or a
 * pair of lines (old beside new in split, left column beside right column in flow). A line that
 * does not fit wraps, and since the code font is monospace the number of screen lines it wraps to
 * is known from its display columns. So the list is a fixed-height list like the graph: the
 * virtualizer never measures, and scrolling to a file lands on its first line exactly.
 */

/** Where the reader is: a row and how far into it, so a scene coming back lands on the same line. */
export interface StreamAnchor {
  key: string
  offset: number
}

/** One block of the stream: what it shows and how it is labelled. */
export interface StreamBlock {
  key: string
  target: StreamTarget
  /** A commit block's commit, for its header band. */
  hash?: string
  /** What the block header says: a commit's subject, "Unstaged changes", a comparison. */
  title: string
  /** Files, once loaded (null: not yet). */
  files: StreamFile[] | null
}

export type StreamRow =
  | { kind: 'block'; block: number }
  /** A block whose file list has not arrived: one row that loads it when it comes into view. */
  | { kind: 'block-loading'; block: number }
  | { kind: 'block-empty'; block: number }
  | { kind: 'file'; block: number; file: number }
  | { kind: 'collapsed'; block: number; file: number; reason: string }
  /** A file whose diff has not arrived: room for its lines until it does. */
  | { kind: 'pending'; block: number; file: number; lines: number }
  | { kind: 'note'; block: number; file: number; text: string }
  | { kind: 'hunk'; block: number; file: number; hunk: number }
  | { kind: 'line'; block: number; file: number; hunk: number; line: number; wrap: number }
  | { kind: 'split'; block: number; file: number; hunk: number; left: number | null; right: number | null; wrap: number }
  /** Flow: line `left` of the file's lines on the left, line `right` on the right (indexes into flowLines). */
  | { kind: 'flow'; block: number; file: number; left: number; right: number | null; wrap: number }
  | { kind: 'end' }

/** Pixel sizes of the row kinds that are not code lines. */
export const SIZES = { block: 56, blockLoading: 40, file: 36, collapsed: 32, note: 32, end: 72 }

/**
 * The reader's size in px and its code font, from which each file's room in cells is worked out
 * (cellsFor): the line-number gutters are sized to the file, so a file with short line numbers has
 * a little more room than one with five-digit ones.
 */
export interface StreamRoom {
  width: number
  charPx: number
  /** Code rows on one screen. */
  screenRows: number
  tabSize: number
}

/** The cells a file's code gets in each layout, for a file whose largest line number has `digits` digits. */
export function cellsFor(room: StreamRoom, digits: number): ReaderRoom & { unified: number } {
  const num = numWidth(digits, room.charPx)
  const cells = (px: number) => Math.max(8, Math.floor(px / room.charPx))
  // Each half: a 2 px edge, the number column, 4 px before the text, and 6 px of slack.
  const half = cells(room.width / 2 - 2 - num - 4 - 6)
  return {
    // Unified: old and new numbers, a sign column, 4 px before the text, slack.
    unified: cells(room.width - 2 * num - 16 - 4 - 10),
    splitSide: half,
    flowColumn: half,
    screenRows: room.screenRows,
  }
}

/** A line-number column's width: the digits, and room on either side. */
export const numWidth = (digits: number, charPx: number) => Math.ceil(Math.max(2, digits) * charPx) + 10

/** The digits of a diff's largest line number. */
export function digitsOf(diff: FileDiff): number {
  let max = 1
  for (const h of diff.hunks) max = Math.max(max, h.oldStart + h.oldLines, h.newStart + h.newLines)
  return String(max).length
}

export interface FileState {
  /** The layout the user picked for this file (the header's chip), if any. */
  forced?: ReaderLayout
  /** Opened or collapsed by the user: overrides the default (collapseReason). */
  open?: boolean
}

/** A file's identity within the stream, stable across reloads. */
export const fileKey = (block: StreamBlock, f: StreamFile) => `${block.key}\u0000${f.path}`

/** A file's diff target (for staging, Ask, blame, the editor). */
export function targetOf(t: StreamTarget, f: StreamFile): DiffTarget {
  switch (t.kind) {
    case 'commit': return { kind: 'commit', hash: t.hash, path: f.path }
    case 'range': return { kind: 'range', from: t.from, to: t.to, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}) }
    case 'staged': return { kind: 'staged', path: f.path }
    case 'unstaged': return f.untracked ? { kind: 'untracked', path: f.path } : { kind: 'unstaged', path: f.path }
  }
}

/**
 * What the reader's "viewed" mark is keyed by: the file's two blob ids when the diff header has
 * them, so a file stays viewed through a rebase that did not change it and stops being viewed
 * when it changes again; the path otherwise.
 */
export function viewedKey(f: StreamFile): string {
  const index = f.diff?.header.find((h) => h.startsWith('index '))
  const m = index && /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(index)
  return m ? `${f.path}@${m[1]}..${m[2]}` : `${f.path}@${f.change}:${f.additions}:${f.deletions}`
}

/** A flowed file's lines, in order (one-sided, so every line is an add or every one a delete). */
export function flowLines(diff: FileDiff): { hunk: number; line: number }[] {
  const out: { hunk: number; line: number }[] = []
  diff.hunks.forEach((h, hi) => h.lines.forEach((_, li) => out.push({ hunk: hi, line: li })))
  return out
}

const wraps = (text: string, cells: number, tabSize: number) => Math.max(1, Math.ceil(displayColumns(text, tabSize) / Math.max(8, cells)))

/** The layout a file is drawn in, and the header's reason for it. */
export function layoutOf(f: StreamFile, room: StreamRoom, state: FileState | undefined, workingCopy: boolean): { layout: ReaderLayout; reason: string } {
  if (!f.diff || f.binary) return { layout: 'unified', reason: '' }
  // Line staging works on the unified view of the diff (ADR-006): the working copy stays unified.
  if (workingCopy) return { layout: 'unified', reason: 'staging' }
  return chooseLayout(fileShape(f.diff, room.tabSize), cellsFor(room, digitsOf(f.diff)), state?.forced)
}

export interface Stream {
  rows: StreamRow[]
  /** The first row of each file, by fileKey. */
  fileStart: Map<string, number>
  /** The first row of each block. */
  blockStart: number[]
  /** Each file's layout, by fileKey. */
  layouts: Map<string, { layout: ReaderLayout; reason: string }>
}

/** Build the rows of a stream. */
export function buildStream(blocks: StreamBlock[], room: StreamRoom, states: ReadonlyMap<string, FileState>, opts: { endCard?: boolean } = {}): Stream {
  const rows: StreamRow[] = []
  const fileStart = new Map<string, number>()
  const blockStart: number[] = []
  const layouts = new Map<string, { layout: ReaderLayout; reason: string }>()
  blocks.forEach((b, bi) => {
    blockStart.push(rows.length)
    rows.push({ kind: 'block', block: bi })
    if (!b.files) {
      rows.push({ kind: 'block-loading', block: bi })
      return
    }
    if (!b.files.length) {
      rows.push({ kind: 'block-empty', block: bi })
      return
    }
    const workingCopy = b.target.kind === 'unstaged' || b.target.kind === 'staged'
    b.files.forEach((f, fi) => {
      const key = fileKey(b, f)
      fileStart.set(key, rows.length)
      rows.push({ kind: 'file', block: bi, file: fi })
      const state = states.get(key)
      const reason = collapseReason(f)
      if (state?.open === false || (reason && state?.open !== true)) {
        rows.push({ kind: 'collapsed', block: bi, file: fi, reason: reason ?? 'collapsed' })
        return
      }
      if (f.binary) {
        rows.push({ kind: 'note', block: bi, file: fi, text: 'Binary file' })
        return
      }
      const d = f.diff
      if (!d) {
        rows.push({ kind: 'pending', block: bi, file: fi, lines: Math.max(1, f.additions + f.deletions + 3) })
        return
      }
      if (!d.hunks.length) {
        rows.push({ kind: 'note', block: bi, file: fi, text: f.change === 'renamed' ? `Renamed from ${f.oldPath}, content unchanged` : f.change === 'added' ? 'Empty file' : 'Only the file mode changed' })
        return
      }
      const lay = layoutOf(f, room, state, workingCopy)
      layouts.set(key, lay)
      const cells = cellsFor(room, digitsOf(d))
      if (lay.layout === 'flow') {
        const lines = flowLines(d)
        const half = Math.ceil(lines.length / 2)
        const text = (k: number) => d.hunks[lines[k]!.hunk]!.lines[lines[k]!.line]!.text
        for (let k = 0; k < half; k++) {
          const right = k + half < lines.length ? k + half : null
          const wrap = Math.max(wraps(text(k), cells.flowColumn, room.tabSize), right === null ? 1 : wraps(text(right), cells.flowColumn, room.tabSize))
          rows.push({ kind: 'flow', block: bi, file: fi, left: k, right, wrap })
        }
        return
      }
      d.hunks.forEach((h, hi) => {
        rows.push({ kind: 'hunk', block: bi, file: fi, hunk: hi })
        if (lay.layout === 'split') {
          for (const r of splitRows(h)) {
            const w = (i: number | null) => (i === null ? 1 : wraps(h.lines[i]!.text, cells.splitSide, room.tabSize))
            rows.push({ kind: 'split', block: bi, file: fi, hunk: hi, left: r.left, right: r.right, wrap: Math.max(w(r.left), w(r.right)) })
          }
        } else {
          h.lines.forEach((l, li) => rows.push({ kind: 'line', block: bi, file: fi, hunk: hi, line: li, wrap: wraps(l.text, cells.unified, room.tabSize) }))
        }
      })
    })
  })
  if (opts.endCard) rows.push({ kind: 'end' })
  return { rows, fileStart, blockStart, layouts }
}

/** A row's height in pixels. `lineH` is the code line height, `hunkH` a hunk header's. */
export function rowHeight(r: StreamRow, lineH: number, hunkH: number): number {
  switch (r.kind) {
    case 'block': return SIZES.block
    case 'block-loading': case 'block-empty': return SIZES.blockLoading
    case 'file': return SIZES.file
    case 'collapsed': return SIZES.collapsed
    case 'note': return SIZES.note
    case 'pending': return r.lines * lineH
    case 'hunk': return hunkH
    case 'line': case 'split': case 'flow': return r.wrap * lineH
    case 'end': return SIZES.end
  }
}

/** The block and file a row belongs to (the sticky header shows them), or null for the end card. */
export function ownerOf(r: StreamRow): { block: number; file: number | null } | null {
  if (r.kind === 'end') return null
  return { block: r.block, file: 'file' in r ? r.file : null }
}

/** The room of a reader `width` × `height` px with this code font. */
export function roomFor(width: number, height: number, charPx: number, lineH: number, tabSize: number): StreamRoom {
  return { width, charPx, screenRows: Math.max(10, Math.floor(height / lineH)), tabSize }
}

/** Index of the row at `y` px (binary search over the rows' starts). */
export function rowAt(starts: readonly number[], y: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}
