import { describe, expect, it } from 'vitest'
import { canRestore, centerOf, isRestorable, staleReason } from './basis'
import type { AiThread, AiTurn, ThreadAnchor, ThreadBasis } from './ai'

const review: ThreadAnchor = { kind: 'review', scope: { kind: 'commits', hashes: ['a', 'b'] } }
const branch: ThreadAnchor = { kind: 'review', scope: { kind: 'branch', branch: 'topic' } }
const working: ThreadAnchor = { kind: 'walkthrough', scope: { kind: 'working' } }
const plan: ThreadAnchor = { kind: 'recompose', hashes: ['a'] }

const answered: AiTurn[] = [
  { id: 'u', role: 'user', requestId: 'r', blocks: [], at: 1 },
  { id: 'a', role: 'agent', requestId: 'r', blocks: [], status: 'done', at: 1 },
]

const thread = (anchor: ThreadAnchor, basis: ThreadBasis | undefined, turns = answered): AiThread =>
  ({ id: 't', repoId: 'r', anchor, title: '', turns, createdAt: 1, updatedAt: 1, head: '', ...(basis ? { basis } : {}) })

describe('which conversations own a view', () => {
  it('knows the four that do, and the ones that do not', () => {
    expect(isRestorable(review)).toBe(true)
    expect(isRestorable(plan)).toBe(true)
    expect(isRestorable({ kind: 'free' })).toBe(false)
    expect(isRestorable({ kind: 'explain', hash: 'a' })).toBe(false)
    expect(centerOf(review)).toBe('review')
    expect(centerOf({ kind: 'changestack', scope: { kind: 'staged' } })).toBe('review')
    expect(centerOf(plan)).toBe('recompose')
    expect(centerOf({ kind: 'error', title: 'x', detail: 'y' })).toBe(null)
  })
})

describe('staleReason', () => {
  it('says nothing while the commits are the same', () => {
    expect(staleReason(review, { commits: ['a', 'b'] }, { commits: ['a', 'b'] })).toBe('')
  })

  it('catches commits that changed, were added, or went away entirely', () => {
    expect(staleReason(review, { commits: ['a', 'b'] }, { commits: ['a', 'c'] })).toBe('The commits have changed since.')
    expect(staleReason(review, { commits: ['a', 'b'] }, { commits: ['a', 'b', 'c'] })).toBe('The commits have changed since.')
    expect(staleReason(review, { commits: ['a', 'b'] }, null)).toBe('Those commits are no longer in the repository.')
  })

  it('names the branch when one moved or is gone', () => {
    const was: ThreadBasis = { commits: ['t1'], ref: { name: 'refs/heads/topic', hash: 't1' } }
    expect(staleReason(branch, was, { commits: ['t2'], ref: { name: 'refs/heads/topic', hash: 't2' } })).toBe('topic has moved since.')
    expect(staleReason(branch, was, null)).toBe('topic is gone.')
  })

  it('catches an edit under a conversation about uncommitted work', () => {
    const was: ThreadBasis = { commits: ['h'], dirty: 'aaa' }
    expect(staleReason(working, was, { commits: ['h'], dirty: 'aaa' })).toBe('')
    expect(staleReason(working, was, { commits: ['h'], dirty: 'bbb' })).toBe('The uncommitted changes have changed since.')
  })

  it('says a plan was rewritten, which is what applying it does', () => {
    expect(staleReason(plan, { commits: ['a'] }, { commits: ['z'] })).toBe('Those commits have been rewritten since.')
  })

  it('has nothing to say about a conversation that owns no view, or one with no basis', () => {
    expect(staleReason({ kind: 'free' }, { commits: ['a'] }, { commits: ['b'] })).toBe('')
    expect(staleReason(review, undefined, { commits: ['b'] })).toBe('')
  })
})

describe('canRestore', () => {
  it('needs a view, an answer, a basis and no reason against', () => {
    expect(canRestore(thread(review, { commits: ['a'] }), '')).toBe(true)
    expect(canRestore(thread(review, { commits: ['a'] }), 'The commits have changed since.')).toBe(false)
    expect(canRestore(thread(review, { commits: ['a'] }, []), '')).toBe(false)
    expect(canRestore(thread({ kind: 'free' }, { commits: ['a'] }), '')).toBe(false)
  })

  it('does not restore a conversation saved before basis was recorded: not knowing is not "fine"', () => {
    expect(canRestore(thread(review, undefined), '')).toBe(false)
  })
})
