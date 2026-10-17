import type { DiffLine, Hunk } from '@gitsquid/shared'
import { describe, expect, it } from 'vitest'
import { pairs, segments, splitRows, wordDiff } from './diffLayout'

const hunk = (spec: string): Hunk => ({
  oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, section: '',
  lines: spec.split(' ').map((k): DiffLine => ({ kind: k === '=' ? ' ' : (k as '+' | '-'), text: k })),
})

describe('split view rows', () => {
  it('pairs removed and added lines in each change block; context on both sides', () => {
    // = - - + = + - = : a 2-for-1 change, a pure addition, a pure removal.
    expect(splitRows(hunk('= - - + = + - ='))).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: 3 },
      { left: 2, right: null },
      { left: 4, right: 4 },
      { left: null, right: 5 },
      { left: 6, right: null },
      { left: 7, right: 7 },
    ])
    expect([...pairs(hunk('= - - + = + - ='))]).toEqual([[1, 3], [3, 1]])
  })
})

describe('word diff', () => {
  it('finds the changed words', () => {
    const d = wordDiff('const total = price * count', 'const total = price * quantity')!
    expect(d.old).toEqual([[22, 27]])
    expect(d.new).toEqual([[22, 30]])
  })

  it('gives up on lines that have little in common', () => {
    expect(wordDiff('return a', 'throw new Error("nope")')).toBeNull()
    expect(wordDiff('same', 'same')).toEqual({ old: [], new: [] })
  })
})

describe('segments', () => {
  it('cuts at token and changed-range boundaries alike', () => {
    const toks = [{ content: 'let ', color: 'blue' }, { content: 'value', color: 'red' }, { content: ' = 1' }]
    expect(segments('let value = 1', toks, [[6, 11]])).toEqual([
      { text: 'let ', color: 'blue', changed: false },
      { text: 'va', color: 'red', changed: false },
      { text: 'lue', color: 'red', changed: true },
      { text: ' =', color: undefined, changed: true },
      { text: ' 1', color: undefined, changed: false },
    ])
    expect(segments('plain', null, [])).toEqual([{ text: 'plain', color: undefined, changed: false }])
  })
})
