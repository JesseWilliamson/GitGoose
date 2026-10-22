/**
 * History-based hints for a change: whose lines you are changing. Pure parts here;
 * Repo.changeInsights runs the git commands.
 */

/** Line ranges of the old side of `git diff -U0` hunks: the lines being changed or removed. */
export function oldRanges(diff: string): { start: number; count: number }[] {
  const out: { start: number; count: number }[] = []
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const count = m[2] === undefined ? 1 : Number(m[2])
    if (count > 0) out.push({ start: Number(m[1]), count })
  }
  return out
}
