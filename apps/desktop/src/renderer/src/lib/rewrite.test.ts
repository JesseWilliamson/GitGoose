import type { Commit } from '@gitgoose/shared'
import { describe, expect, it } from 'vitest'
import { followRewrite } from './rewrite'

const commit = (hash: string, subject: string, authorDate: number): Commit =>
  ({ hash, subject, authorDate, parents: [], authorName: 'a', authorEmail: 'a@x', commitDate: authorDate })
const log = (...cs: Commit[]) => ({ commits: cs, index: new Map(cs.map((c, i) => [c.hash, i])), done: true })

describe('followRewrite', () => {
  const before = log(commit('c3', 'three', 3), commit('c2', 'two', 2), commit('c1', 'one', 1))

  it('keeps hashes that still exist and finds moved commits by author date and subject', () => {
    // c2 moved above c3: both replayed with new hashes; c1 untouched.
    const after = log(commit('n2', 'two', 2), commit('n3', 'three', 3), commit('c1', 'one', 1))
    expect(followRewrite(['c2'], before, after)).toEqual(['n2'])
    expect(followRewrite(['c3', 'c1'], before, after)).toEqual(['n3', 'c1'])
  })

  it('drops commits with no counterpart, and collapses a squash onto its target', () => {
    // c2 squashed into c3 (the result keeps c3's subject and date); c1 untouched.
    const after = log(commit('n3', 'three', 3), commit('c1', 'one', 1))
    expect(followRewrite(['c2'], before, after)).toEqual([])
    expect(followRewrite(['c2', 'c3'], before, after)).toEqual(['n3'])
  })

  it('ignores hashes it never knew', () => {
    expect(followRewrite(['zzz'], before, before)).toEqual([])
  })

  it('keeps a commit that lies beyond the part of the new log loaded so far', () => {
    // Only the newest row is in yet; c1 was two rows further down, so it may well still exist.
    const partial = { ...log(commit('n3', 'three', 3)), done: false }
    expect(followRewrite(['c1'], before, partial)).toEqual(['c1'])
    // c2 sat within the loaded range and is not there: it is gone.
    const twoRows = { ...log(commit('n3', 'three', 3), commit('c1', 'one', 1)), done: false }
    expect(followRewrite(['c2', 'c1'], before, twoRows)).toEqual(['c1'])
  })
})
