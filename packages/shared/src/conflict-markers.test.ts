import { describe, expect, it } from 'vitest'
import { countConflicts, parseConflicts, resolveBlocks } from './conflict-markers'

const FILE = ['top', '<<<<<<< HEAD', 'ours 1', 'ours 2', '=======', 'theirs', '>>>>>>> feature', 'middle', '<<<<<<< HEAD', 'a', '||||||| base', 'o', '=======', 'b', '>>>>>>> feature', 'end', ''].join('\n')

describe('conflict markers', () => {
  it('reads blocks with their labels and the base when diff3 markers have one', () => {
    const blocks = parseConflicts(FILE).filter((s) => s.kind === 'conflict')
    expect(blocks).toMatchObject([
      { ours: ['ours 1', 'ours 2'], theirs: ['theirs'], base: null, oursLabel: 'HEAD', theirsLabel: 'feature' },
      { ours: ['a'], theirs: ['b'], base: ['o'] },
    ])
    expect(countConflicts(FILE)).toBe(2)
  })

  it('writes each choice, both orders of "both" included, and leaves undecided blocks marked', () => {
    expect(resolveBlocks(FILE, ['both-theirs-first', 'base'])).toBe('top\ntheirs\nours 1\nours 2\nmiddle\no\nend\n')
    expect(resolveBlocks(FILE, ['both', 'theirs'])).toBe('top\nours 1\nours 2\ntheirs\nmiddle\nb\nend\n')
    expect(countConflicts(resolveBlocks(FILE, ['ours']))).toBe(1)
  })
})
