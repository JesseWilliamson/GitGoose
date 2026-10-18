import { describe, expect, it } from 'vitest'
import { addCommit, draftProblems, moveCommit, moveUnit, removeEmpty, squashCommits, type Draft } from './recomposeDraft'

const ORDER = ['U1', 'U2', 'U3', 'U4']
const plan = (): Draft => [{ message: 'feat: a', units: ['U1', 'U3'] }, { message: 'test: b', units: ['U2'] }, { message: 'docs: c', units: ['U4'] }]
const units = (d: Draft) => d.flatMap((c) => c.units).sort()

describe('recompose draft', () => {
  it('moves a change into another commit, keeping each change in exactly one, in diff order', () => {
    const d = moveUnit(plan(), 'U3', 1, ORDER)
    expect(d.map((c) => c.units)).toEqual([['U1'], ['U2', 'U3'], ['U4']])
    expect(units(d)).toEqual(ORDER)
  })

  it('moves a change into a new commit at the end, and flags it until it has a message', () => {
    const d = moveUnit(plan(), 'U1', 3, ORDER)
    expect(d[3]).toEqual({ message: '', units: ['U1'] })
    expect(draftProblems(d)).toEqual(['Commit 4 needs a message.'])
  })

  it('reorders, squashes (all messages kept, units back in diff order) and drops empty commits', () => {
    expect(moveCommit(plan(), 2, 0).map((c) => c.message)).toEqual(['docs: c', 'feat: a', 'test: b'])
    // Non-adjacent commits squash too; the result sits where the earliest one was.
    const squashed = squashCommits(plan(), [2, 0], ORDER)
    expect(squashed).toEqual([{ message: 'feat: a\n\ndocs: c', units: ['U1', 'U3', 'U4'] }, { message: 'test: b', units: ['U2'] }])
    expect(units(squashed)).toEqual(ORDER)
    const one = plan()
    expect(squashCommits(one, [1], ORDER)).toBe(one) // one commit: nothing to squash
    const emptied = moveUnit(plan(), 'U2', 0, ORDER)
    expect(draftProblems(emptied)).toEqual(['Commit 2 has no changes: move some into it, or remove it.'])
    expect(removeEmpty(emptied).map((c) => c.message)).toEqual(['feat: a', 'docs: c'])
    expect(draftProblems(addCommit(plan()))).toHaveLength(2)
  })
})
