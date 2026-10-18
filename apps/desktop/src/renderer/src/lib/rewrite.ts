import type { Commit } from '@gitgoose/shared'

/**
 * After a rebase, reorder, squash or reword, the commits are new objects with new hashes, but a
 * replayed commit keeps its author date and (unless reworded) its subject. That pair is how we
 * find "the same commit" in the new history, so the selection follows it instead of pointing at
 * a hash that is no longer on any branch.
 *
 * Returns, for each of `hashes`, its hash in `fresh` (unchanged when still present, matched by
 * author date and subject otherwise), leaving out commits with no counterpart (dropped, or
 * folded into another). A squash keeps the subject of the commit it was squashed into, so the
 * target is found and the folded ones are not: the selection lands on the result.
 *
 * `fresh` may be only the first page of the new log. A commit that sat beyond that page in the
 * old log cannot be judged yet, so it is kept as it is rather than written off.
 */
export interface CommitIndex {
  /** Newest first, as the log lists them. */
  commits: Commit[]
  index: Map<string, number>
  /** Every commit is in `commits` (nothing left to page in). */
  done?: boolean
}

export function followRewrite(hashes: string[], old: CommitIndex, fresh: CommitIndex): string[] {
  let byKey: Map<string, string> | null = null
  const key = (c: Commit) => `${c.authorDate}\0${c.subject}`
  const out: string[] = []
  for (const h of hashes) {
    if (fresh.index.has(h)) {
      out.push(h)
      continue
    }
    const at = old.index.get(h)
    const was = old.commits[at ?? -1]
    if (!was) continue
    if (!fresh.done && at! >= fresh.commits.length) {
      out.push(h)
      continue
    }
    if (!byKey) {
      byKey = new Map()
      // Oldest first, so of two alike (a cherry-pick and its original) the earlier one wins.
      for (let i = fresh.commits.length - 1; i >= 0; i--) byKey.set(key(fresh.commits[i]!), fresh.commits[i]!.hash)
    }
    const found = byKey.get(key(was))
    if (found && !out.includes(found)) out.push(found)
  }
  return out
}
