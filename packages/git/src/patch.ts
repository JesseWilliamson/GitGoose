import type { FileDiff, Hunk, HunkSelection } from '@gitsquid/shared'

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
  const out: string[] = [...diff.header]
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

interface RewrittenHunk {
  lines: string[]
  oldCount: number
  newCount: number
}

function rewriteHunk(hunk: Hunk, chosen: Set<number> | null, reverse: boolean): RewrittenHunk | null {
  const lines: string[] = []
  let oldCount = 0
  let newCount = 0
  let changes = 0

  const emit = (prefix: ' ' | '+' | '-', text: string, noNewline: boolean | undefined) => {
    lines.push(prefix + text)
    if (noNewline) lines.push('\\ No newline at end of file')
    if (prefix !== '+') oldCount++
    if (prefix !== '-') newCount++
  }

  hunk.lines.forEach((line, i) => {
    const selected = chosen === null || chosen.has(i)
    if (line.kind === ' ') emit(' ', line.text, line.noNewline)
    else if (selected) {
      emit(line.kind, line.text, line.noNewline)
      changes++
    } else if (line.kind === (reverse ? '+' : '-')) {
      // Not selected, and still present in the file the patch applies to: keep as context.
      emit(' ', line.text, line.noNewline)
    }
    // Otherwise: not selected and absent from the target file. Drop it.
  })
  return changes > 0 ? { lines, oldCount, newCount } : null
}
