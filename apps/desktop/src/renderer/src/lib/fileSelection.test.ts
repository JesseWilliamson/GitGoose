import { describe, expect, it } from 'vitest'
import { actOn, clickFile, NO_FILES, pruneFiles } from './fileSelection'

const order = ['a', 'b', 'c', 'd', 'e']

describe('clickFile', () => {
  it('a plain click selects one file and sets the anchor', () => {
    expect(clickFile({ paths: ['a', 'b'], anchor: 'a' }, order, 'd')).toEqual({ paths: ['d'], anchor: 'd' })
  })

  it('shift-click selects the rows between the anchor and here, either direction, keeping the anchor', () => {
    const one = clickFile(NO_FILES, order, 'b')
    expect(clickFile(one, order, 'd', { range: true })).toEqual({ paths: ['b', 'c', 'd'], anchor: 'b' })
    // A second shift-click re-draws the range from the same anchor (it does not add to it).
    const down = clickFile(one, order, 'e', { range: true })
    expect(clickFile(down, order, 'a', { range: true })).toEqual({ paths: ['a', 'b'], anchor: 'b' })
  })

  it('uses the order on screen, not the alphabet', () => {
    const tree = ['src/z.ts', 'src/a.ts', 'README.md']
    expect(clickFile(clickFile(NO_FILES, tree, 'src/z.ts'), tree, 'README.md', { range: true }).paths).toEqual(tree)
  })

  it('shift-click without an anchor (or with one filtered away) is a plain click', () => {
    expect(clickFile(NO_FILES, order, 'c', { range: true })).toEqual({ paths: ['c'], anchor: 'c' })
    expect(clickFile({ paths: ['x'], anchor: 'x' }, order, 'c', { range: true })).toEqual({ paths: ['c'], anchor: 'c' })
  })

  it('ctrl-click adds and removes one file, keeping the list order', () => {
    let s = clickFile(NO_FILES, order, 'd')
    s = clickFile(s, order, 'b', { toggle: true })
    expect(s).toEqual({ paths: ['b', 'd'], anchor: 'b' })
    s = clickFile(s, order, 'd', { toggle: true })
    expect(s.paths).toEqual(['b'])
  })
})

describe('pruneFiles and actOn', () => {
  it('forgets files that went away', () => {
    expect(pruneFiles({ paths: ['a', 'b', 'c'], anchor: 'c' }, ['a', 'c'])).toEqual({ paths: ['a', 'c'], anchor: 'c' })
    expect(pruneFiles({ paths: ['a'], anchor: 'a' }, ['b'])).toEqual(NO_FILES)
    const same = { paths: ['a'], anchor: 'a' }
    expect(pruneFiles(same, ['a', 'b'])).toBe(same)
  })

  it('acts on the selection only from a row inside a selection of several', () => {
    const s = { paths: ['a', 'b'], anchor: 'a' }
    expect(actOn(s, 'b')).toEqual(['a', 'b'])
    expect(actOn(s, 'c')).toEqual(['c'])
    expect(actOn({ paths: ['a'], anchor: 'a' }, 'a')).toEqual(['a'])
  })
})
