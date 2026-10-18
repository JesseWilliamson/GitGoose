import type { FileDiff, Hunk, HunkSelection } from '@gitgoose/shared'

/**
 * Turn a selection of lines in a diff into a patch that `git apply` accepts.
 *
 * git has no "stage these three lines" command. Every GUI does this instead: take the diff,
 * rewrite it so it contains only the chosen changes, and feed it to `git apply --cached`.
 *
 * The rewrite depends on which way the patch will be applied:
 *
 * Forward (staging: index -> worktree diff applied to the index)
 *   - an unselected '+' line is dropped (we are not adding it)
 *   - an unselected '-' line becomes context (we are not removing it, so it is still there)
 *
 * Reverse (unstaging: HEAD -> index diff reverse-applied to the index; discarding: index ->
 * worktree diff reverse-applied to the worktree). `git apply --reverse` swaps + and -, so the
 * patch's "new" side must match the current file:
 *   - an unselected '+' line becomes context (it stays in the file)
 *   - an unselected '-' line is dropped (it is not in the file)
 *
 * After rewriting, each hunk header's line counts are recomputed, and the start line of the side
 * that changed is shifted by the net lines added or removed by the hunks kept before it.
 */
export function buildPatch(diff: FileDiff, selection: HunkSelection[], reverse: boolean): string | null {
  const out: string[] = [...patchHeader(diff, isPartial(diff, selection), reverse)]
  // Net lines (new side minus old side) added by the hunks already written.
  let shift = 0
  let any = false

  for (const sel of selection.slice().sort((a, b) => a.hunk - b.hunk)) {
    const hunk = diff.hunks[sel.hunk]
    if (!hunk) continue
    const chosen = sel.lines ? new Set(sel.lines) : null
    const body = rewriteHunk(hunk, chosen, reverse)
    if (!body) continue
    any = true

    // Work in "first line of this side" terms, then convert to git's header convention, where a
    // side with zero lines names the line *before* the hunk (e.g. "-0,0" for a new file).
    // Forward: the old side is untouched by the rewrite, so it anchors; the new side shifts.
    // Reverse: the new side is untouched, so it anchors; the old side shifts.
    let oldFirst: number
    let newFirst: number
    if (!reverse) {
      oldFirst = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart
      newFirst = oldFirst + shift
    } else {
      newFirst = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart
      oldFirst = newFirst - shift
    }
    const oldStart = body.oldCount === 0 ? oldFirst - 1 : oldFirst
    const newStart = body.newCount === 0 ? newFirst - 1 : newFirst
    out.push(`@@ -${oldStart},${body.oldCount} +${newStart},${body.newCount} @@${hunk.section ? ' ' + hunk.section : ''}`)
    out.push(...body.lines)
    shift += body.newCount - body.oldCount
  }
  return any ? out.join('\n') + '\n' : null
}

/** True unless the selection covers every change line of every hunk. */
function isPartial(diff: FileDiff, selection: HunkSelection[]): boolean {
  return diff.hunks.some((h, i) => {
    const sel = selection.find((s) => s.hunk === i)
    if (!sel) return h.lines.some((l) => l.kind !== ' ')
    if (!sel.lines) return false
    const chosen = new Set(sel.lines)
    return h.lines.some((l, j) => l.kind !== ' ' && !chosen.has(j))
  })
}

/**
 * The header lines for the patch. Usually the diff's own header, but two cases need a plain
 * "modify this file" header instead:
 *
 * - Part of a new or deleted file. "new file" means "create it with exactly this content";
 *   keeping a few lines of a new file is a modification of the file that already exists.
 * - A rename, applied in reverse (unstaging lines of a staged rename). Its header would also
 *   reverse the rename itself; we only want to change lines in the file under its new name.
 */
function patchHeader(diff: FileDiff, partial: boolean, reverse: boolean): string[] {
  const renamed = reverse && diff.oldPath !== undefined && diff.oldPath !== diff.path
  const addOrDelete = partial && (diff.change === 'added' || diff.change === 'deleted')
  if (!renamed && !addOrDelete) return diff.header
  const a = quotePath(`a/${diff.path}`)
  const b = quotePath(`b/${diff.path}`)
  return [`diff --git ${a} ${b}`, `--- ${a}`, `+++ ${b}`]
}

/** Quote a path the way git does when it contains characters that would be ambiguous in a header. */
function quotePath(p: string): string {
  if (!/["\\\t\n\r]/.test(p)) return p
  return '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
}

interface RewrittenHunk {
  lines: string[]
  oldCount: number
  newCount: number
}

interface Kept {
  kind: ' ' | '+' | '-'
  text: string
  noNewline: boolean
}

function rewriteHunk(hunk: Hunk, chosen: Set<number> | null, reverse: boolean): RewrittenHunk | null {
  const kept: Kept[] = []
  let changes = 0
  hunk.lines.forEach((line, i) => {
    const selected = chosen === null || chosen.has(i)
    const noNewline = line.noNewline === true
    if (line.kind === ' ') kept.push({ kind: ' ', text: line.text, noNewline })
    else if (selected) {
      kept.push({ kind: line.kind, text: line.text, noNewline })
      changes++
    } else if (line.kind === (reverse ? '+' : '-')) {
      // Not selected, and still present in the file the patch applies to: keep as context.
      kept.push({ kind: ' ', text: line.text, noNewline })
    }
    // Otherwise: not selected and absent from the target file. Drop it.
  })
  if (changes === 0) return null

  // "\ No newline at end of file" may only follow the *last* line of a side (old side: context and
  // '-' lines; new side: context and '+' lines). A rewrite can leave a marked line with more lines
  // after it on one side, e.g. staging "+c" after an unselected "-b" that had no newline. Such a
  // line gains a newline on that side. For a context line that changes it on one side only, so it
  // is written as a '-'/'+' pair with the marker on just one of them.
  let lastOld = -1
  let lastNew = -1
  kept.forEach((k, i) => {
    if (k.kind !== '+') lastOld = i
    if (k.kind !== '-') lastNew = i
  })
  const lines: string[] = []
  const NO_NL = '\\ No newline at end of file'
  let oldCount = 0
  let newCount = 0
  kept.forEach((k, i) => {
    if (k.kind !== '+') oldCount++
    if (k.kind !== '-') newCount++
    const markOld = k.noNewline && i === lastOld
    const markNew = k.noNewline && i === lastNew
    if (k.kind === '-') {
      lines.push('-' + k.text)
      if (markOld) lines.push(NO_NL)
    } else if (k.kind === '+') {
      lines.push('+' + k.text)
      if (markNew) lines.push(NO_NL)
    } else if (markOld === markNew) {
      lines.push(' ' + k.text)
      if (markOld) lines.push(NO_NL)
    } else {
      lines.push('-' + k.text)
      if (markOld) lines.push(NO_NL)
      lines.push('+' + k.text)
      if (markNew) lines.push(NO_NL)
    }
  })
  return { lines, oldCount, newCount }
}
