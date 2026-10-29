import type { FileDiff } from './index'

/**
 * The reader's per-file layout rule (ADR-012). A file's diff is drawn one of three ways, chosen
 * from the file's own content, never from the window alone:
 *
 * - **flow**: an added-only or deleted-only file in two newspaper columns (left column, then
 *   right), when the whole file is at most two screens long and every line fits a column;
 * - **split**: old beside new, when the longest line fits one side;
 * - **unified**: everything else.
 *
 * "Fits" is measured in display columns (a tab runs to the next tab stop, a wide glyph takes
 * two cells), with two columns to spare, because code is never clipped: a line that does not fit
 * wraps, and a layout that would wrap most lines is the wrong layout.
 */
export type ReaderLayout = 'flow' | 'split' | 'unified'

/** Cells a code point takes in a monospace font: East Asian wide and fullwidth forms, and emoji, take two. */
export function cellWidth(cp: number): 1 | 2 {
  if (cp < 0x1100) return 1
  return (cp <= 0x115f) // Hangul Jamo
    || (cp >= 0x2e80 && cp <= 0x303e) // CJK radicals .. CJK symbols
    || (cp >= 0x3041 && cp <= 0x33ff) // kana .. CJK compatibility
    || (cp >= 0x3400 && cp <= 0x4dbf) // CJK extension A
    || (cp >= 0x4e00 && cp <= 0x9fff) // CJK unified ideographs
    || (cp >= 0xa000 && cp <= 0xa4cf) // Yi
    || (cp >= 0xac00 && cp <= 0xd7a3) // Hangul syllables
    || (cp >= 0xf900 && cp <= 0xfaff) // CJK compatibility ideographs
    || (cp >= 0xfe30 && cp <= 0xfe4f) // CJK compatibility forms
    || (cp >= 0xff00 && cp <= 0xff60) // fullwidth forms
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1faff) // emoji and pictographs
    || (cp >= 0x20000 && cp <= 0x3fffd) // CJK extensions B..
    ? 2 : 1
}

/** How many cells a line takes on screen with tabs expanded to `tabSize` stops. */
export function displayColumns(text: string, tabSize = 4): number {
  let col = 0
  for (const ch of text) {
    if (ch === '\t') col += tabSize - (col % tabSize)
    else col += cellWidth(ch.codePointAt(0)!)
  }
  return col
}

/** What the layout rule needs to know about one file's diff. Pure data, computed once per diff. */
export interface FileShape {
  /** Lines in all hunks (context, added and removed). */
  lines: number
  hunks: number
  /** Only added lines (an added file) or only removed lines (a deleted file); null when modified. */
  oneSided: 'added' | 'deleted' | null
  /** The widest line on each side, in display columns. */
  longestOld: number
  longestNew: number
}

export function fileShape(diff: FileDiff, tabSize = 4): FileShape {
  let lines = 0
  let adds = 0
  let dels = 0
  let longestOld = 0
  let longestNew = 0
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      lines++
      const w = displayColumns(l.text, tabSize)
      if (l.kind !== '+' && w > longestOld) longestOld = w
      if (l.kind !== '-' && w > longestNew) longestNew = w
      if (l.kind === '+') adds++
      else if (l.kind === '-') dels++
    }
  }
  const oneSided = lines > 0 && adds === lines ? 'added' : lines > 0 && dels === lines ? 'deleted' : null
  return { lines, hunks: diff.hunks.length, oneSided, longestOld, longestNew }
}

/** The room the reader has, in character cells and rows (measured from the code font). */
export interface ReaderRoom {
  /** Cells for code in one column of a flow layout. */
  flowColumn: number
  /** Cells for code in one side of a split layout. */
  splitSide: number
  /** Code rows on one screen. */
  screenRows: number
}

/** Columns kept free, so a line that "fits" is not touching the edge. */
export const SPARE_COLUMNS = 2

/**
 * The layout for one file, and why, in words short enough for the file header's chip
 * ("longest 64 ≤ 70"). `forced` is the user's choice from the chip; it is honoured except where it
 * cannot apply (flow for a file that has both added and removed lines).
 */
export function chooseLayout(shape: FileShape, room: ReaderRoom, forced?: ReaderLayout): { layout: ReaderLayout; reason: string } {
  const longest = Math.max(shape.longestOld, shape.longestNew)
  if (forced === 'unified') return { layout: 'unified', reason: 'chosen' }
  if (forced === 'split' && !shape.oneSided) return { layout: 'split', reason: 'chosen' }
  if (forced === 'flow' && shape.oneSided) return { layout: 'flow', reason: 'chosen' }
  if (shape.oneSided) {
    if (shape.lines > 2 * room.screenRows * 2) return { layout: 'unified', reason: 'longer than 2 screens' }
    if (longest + SPARE_COLUMNS <= room.flowColumn) return { layout: 'flow', reason: `longest ${longest} ≤ ${room.flowColumn - SPARE_COLUMNS}` }
    return { layout: 'unified', reason: `longest ${longest} > ${room.flowColumn - SPARE_COLUMNS}` }
  }
  if (longest + SPARE_COLUMNS <= room.splitSide) return { layout: 'split', reason: `longest ${longest} ≤ ${room.splitSide - SPARE_COLUMNS} a side` }
  return { layout: 'unified', reason: `longest ${longest} > ${room.splitSide - SPARE_COLUMNS} a side` }
}

/** Lock files and similar: changed by tools, not read by people. */
const GENERATED = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|flake\.lock)$|\.min\.(js|css)$|\.map$/

/** Above this many lines a file starts collapsed: one click opens it, but it never floods the stream. */
export const COLLAPSE_LINES = 400

/**
 * Why a file starts collapsed in the reader, or null to show it. Collapsing is about what a person
 * wants to read first, so every reason is one they would agree with at a glance.
 */
export function collapseReason(file: { path: string; change: string; additions: number; deletions: number; binary: boolean; oldPath?: string }): string | null {
  if (GENERATED.test(file.path)) return 'generated'
  if (file.change === 'renamed' && file.additions === 0 && file.deletions === 0) return `renamed from ${file.oldPath ?? '?'}, unchanged`
  const n = file.additions + file.deletions
  if (n > COLLAPSE_LINES) return `${n.toLocaleString('en-US')} lines`
  return null
}

/** A commit with more files than this opens as a table of its folders: nothing is fetched until asked. */
export const FOLDER_TABLE_FROM = 30
