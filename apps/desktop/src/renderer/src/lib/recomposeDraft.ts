/**
 * The plan being edited in the recompose dialog: an ordered list of commits, each a message and
 * the changes ("units": one hunk, or one whole file) it contains. Every edit here keeps the one
 * rule that makes recomposing safe: each unit is in exactly one commit. Moving a unit takes it
 * out of where it was; squashing joins several lists; a commit is only deleted once it is empty.
 * Main checks the rule again before writing anything (checkPlan in @gitsquid/git).
 */

export interface DraftCommit {
  message: string
  units: string[]
}

export type Draft = DraftCommit[]

/** Move commit `from` to position `to` (both before the move). */
export function moveCommit(d: Draft, from: number, to: number): Draft {
  if (from === to || to < 0 || to >= d.length) return d
  const next = [...d]
  const [c] = next.splice(from, 1)
  next.splice(to, 0, c!)
  return next
}

/**
 * Squash the commits at `indexes` into one, where the earliest of them was. Messages follow in
 * commit order, oldest first (as git's own squash writes them); units go back into diff order.
 */
export function squashCommits(d: Draft, indexes: number[], order: string[]): Draft {
  const picked = [...new Set(indexes)].filter((i) => i >= 0 && i < d.length).sort((a, b) => a - b)
  if (picked.length < 2) return d
  const parts = picked.map((i) => d[i]!)
  const rank = new Map(order.map((id, i) => [id, i]))
  const merged: DraftCommit = {
    message: parts.map((c) => c.message.trim()).filter(Boolean).join('\n\n'),
    units: parts.flatMap((c) => c.units).sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)),
  }
  const set = new Set(picked)
  return d.flatMap((c, i) => (i === picked[0] ? [merged] : set.has(i) ? [] : [c]))
}

/**
 * Move one unit into commit `to`; `to === d.length` makes a new commit for it at the end. Units
 * keep the diff's order inside a commit (the order they come in `order`), so a commit reads
 * file by file, top to bottom, however it was assembled.
 */
export function moveUnit(d: Draft, unit: string, to: number, order: string[]): Draft {
  const rank = new Map(order.map((id, i) => [id, i]))
  const byRank = (a: string, b: string) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)
  const next = d.map((c) => ({ ...c, units: c.units.filter((u) => u !== unit) }))
  if (to >= next.length) next.push({ message: '', units: [unit] })
  else next[to] = { ...next[to]!, units: [...next[to]!.units, unit].sort(byRank) }
  return next
}

export function addCommit(d: Draft): Draft {
  return [...d, { message: '', units: [] }]
}

/** Drop commits with no changes (there is nothing to commit in them). */
export function removeEmpty(d: Draft): Draft {
  const next = d.filter((c) => c.units.length)
  return next.length === d.length ? d : next
}

export function editMessage(d: Draft, i: number, message: string): Draft {
  return d.map((c, j) => (j === i ? { ...c, message } : c))
}

/** What stops "Create commits", in words; empty when the plan can be applied. */
export function draftProblems(d: Draft): string[] {
  const out: string[] = []
  if (!d.length) out.push('There are no commits.')
  d.forEach((c, i) => {
    if (!c.units.length) out.push(`Commit ${i + 1} has no changes: move some into it, or remove it.`)
    if (!c.message.trim()) out.push(`Commit ${i + 1} needs a message.`)
  })
  return out
}
