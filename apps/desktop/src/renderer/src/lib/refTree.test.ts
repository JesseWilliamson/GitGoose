import { describe, expect, it } from 'vitest'
import { buildTree, flattenTree, foldersOf, type TreeRow } from './refTree'

const names = ['fix', 'feature/login', 'feature/ui/menu', 'main', 'feature/search', 'release/1.0']
const tree = (opts = {}) => buildTree(names, (n) => n, opts)
/** A row as a short string: "  feature/" for an open folder at depth 1, "- x" for a closed one. */
const show = (rows: TreeRow<string>[]) => rows.map((r) => '  '.repeat(r.depth) + (r.kind === 'folder' ? `${r.open ? '' : '+'}${r.name}/ (${r.count})` : r.label))

describe('buildTree', () => {
  it('groups names on "/" and keeps their order', () => {
    expect(show(flattenTree(tree(), { isOpen: () => true }))).toEqual([
      'fix',
      'feature/ (3)',
      '  login',
      '  ui/ (1)',
      '    menu',
      '  search',
      'main',
      'release/ (1)',
      '  1.0',
    ])
  })

  it('puts folders first when asked, and keeps each group in order', () => {
    expect(show(flattenTree(tree({ foldersFirst: true }), { isOpen: () => true }))).toEqual([
      'feature/ (3)',
      '  ui/ (1)',
      '    menu',
      '  login',
      '  search',
      'release/ (1)',
      '  1.0',
      'fix',
      'main',
    ])
  })

  it('leaves odd names (empty parts) as one leaf instead of inventing folders', () => {
    const t = buildTree(['a//b', 'x/'], (n) => n)
    expect(show(flattenTree(t, { isOpen: () => true }))).toEqual(['a//b', 'x/'])
  })

  it('keeps the item on each leaf', () => {
    const t = buildTree([{ n: 'a/b', id: 7 }], (x) => x.n)
    const rows = flattenTree(t, { isOpen: () => true })
    expect(rows[1]).toMatchObject({ kind: 'leaf', path: 'a/b', label: 'b', item: { id: 7 } })
  })
})

describe('flattenTree', () => {
  it('hides what is inside a collapsed folder, but still counts it', () => {
    const collapsed = new Set(['feature'])
    expect(show(flattenTree(tree(), { isOpen: (p) => !collapsed.has(p) }))).toEqual([
      'fix', '+feature/ (3)', 'main', 'release/ (1)', '  1.0',
    ])
  })

  it('a collapsed inner folder keeps its outer folder open', () => {
    expect(show(flattenTree(tree(), { isOpen: (p) => p !== 'feature/ui' }))).toContain('  +ui/ (1)')
  })

  it('a filter flattens the tree to matching full names, ignoring case and collapsed folders', () => {
    const rows = flattenTree(tree(), { isOpen: () => false, filter: '  E/L ' })
    expect(rows.map((r) => [r.kind, r.depth, r.kind === 'leaf' ? r.label : r.name])).toEqual([['leaf', 0, 'feature/login']])
    expect(show(flattenTree(tree(), { isOpen: () => false, filter: 'feature' }))).toEqual(['feature/login', 'feature/ui/menu', 'feature/search'])
  })

  it('clearing the filter brings back the tree as it was', () => {
    const isOpen = (p: string) => p !== 'release'
    const before = flattenTree(tree(), { isOpen })
    flattenTree(tree(), { isOpen, filter: 'x' })
    expect(flattenTree(tree(), { isOpen, filter: '' })).toEqual(before)
  })
})

it('foldersOf lists the folders around a name, outermost first', () => {
  expect(foldersOf('a/b/c')).toEqual(['a', 'a/b'])
  expect(foldersOf('main')).toEqual([])
})
