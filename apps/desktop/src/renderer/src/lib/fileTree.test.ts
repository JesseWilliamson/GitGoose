import { describe, expect, it } from 'vitest'
import { matchesFilter, treeRows } from './fileTree'

const shape = (rows: ReturnType<typeof treeRows>) => rows.map((r) => `${'  '.repeat(r.depth)}${r.kind === 'dir' ? `${r.name}/ (${r.files.length})` : r.name}`)

describe('file tree', () => {
  it('nests folders before files, merges single-folder chains, sorts naturally', () => {
    const paths = ['src/app/main.ts', 'src/app/file10.ts', 'src/app/file2.ts', 'src/lib/deep/er/x.ts', 'README.md', 'src/index.ts']
    expect(shape(treeRows(paths))).toEqual([
      'src/ (5)',
      '  app/ (3)',
      '    file2.ts',
      '    file10.ts',
      '    main.ts',
      '  lib/deep/er/ (1)',
      '    x.ts',
      '  index.ts',
      'README.md',
    ])
  })

  it('hides what is under a collapsed folder, which still counts its files', () => {
    const rows = treeRows(['a/one.txt', 'a/two.txt', 'b.txt'], new Set(['a']))
    expect(shape(rows)).toEqual(['a/ (2)', 'b.txt'])
    expect(rows[0]).toMatchObject({ kind: 'dir', files: ['a/one.txt', 'a/two.txt'] })
  })

  it('filters on every word', () => {
    expect(matchesFilter('src/renderer/Graph.tsx', 'graph tsx')).toBe(true)
    expect(matchesFilter('src/renderer/Graph.tsx', 'graph css')).toBe(false)
    expect(matchesFilter('anything', '  ')).toBe(true)
  })
})
