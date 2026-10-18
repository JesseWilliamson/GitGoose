/**
 * History-based hints for a change: which files usually change together (a test, a
 * migration, a translation file you forgot), and whose lines you are changing. Pure parts here;
 * Repo.changeInsights runs the git commands.
 */

/** Files per commit from `git log --format=%x01%H -z --name-only --full-diff -- <file>`. */
export function parseFilesPerCommit(out: string): string[][] {
  return out.split('\x01').filter(Boolean).map((chunk) => {
    const parts = chunk.split('\0')
    return parts.slice(1).map((p) => p.replace(/^\n/, '')).filter(Boolean)
  })
}

export interface CoChange {
  /** The file that is not in the change. */
  path: string
  /** The changed file it usually goes with. */
  with: string
  /** Commits that touched both, and commits that touched `with`. */
  together: number
  total: number
}

/**
 * Files that changed together with `file` in at least `minShare` of its commits (and at least
 * `minCount` times), most related first. Commits touching very many files (mass renames,
 * formatting) say nothing about coupling, so they are skipped.
 */
export function coChanges(file: string, commits: string[][], opts: { minCount?: number; minShare?: number; maxFiles?: number } = {}): CoChange[] {
  const { minCount = 3, minShare = 0.5, maxFiles = 40 } = opts
  const relevant = commits.filter((c) => c.includes(file) && c.length <= maxFiles)
  const counts = new Map<string, number>()
  for (const c of relevant) for (const f of c) if (f !== file) counts.set(f, (counts.get(f) ?? 0) + 1)
  return [...counts]
    .filter(([, n]) => n >= minCount && n / relevant.length >= minShare)
    .sort((a, b) => b[1] - a[1])
    .map(([path, together]) => ({ path, with: file, together, total: relevant.length }))
}

/** Line ranges of the old side of `git diff -U0` hunks: the lines being changed or removed. */
export function oldRanges(diff: string): { start: number; count: number }[] {
  const out: { start: number; count: number }[] = []
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const count = m[2] === undefined ? 1 : Number(m[2])
    if (count > 0) out.push({ start: Number(m[1]), count })
  }
  return out
}
