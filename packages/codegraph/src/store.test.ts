import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodeParser } from './extract'
import { GraphStore } from './store'

const parser = new CodeParser()
const tempDir = () => mkdtempSync(join(tmpdir(), 'gitgoose-graph-'))
const open = () => new GraphStore(join(tempDir(), 'graph.sqlite'))

describe('GraphStore', () => {
  it('stores parsed blobs once and answers definitions and uses per tree', async () => {
    const s = open()
    const price = await parser.parse('src/price.ts', 'export function total(a: number, b: number) {\n  return a + b\n}\n')
    const cart = await parser.parse('src/cart.ts', "import { total } from './price'\nexport function checkout() {\n  return total(1, 2)\n}\n")
    s.putBlob('b1', price)
    s.putBlob('b2', cart)
    s.putBlob('b3', null)
    expect(s.knownBlobs(['b1', 'b2', 'b3', 'b9'])).toEqual(new Set(['b1', 'b2', 'b3']))
    // HEAD has both files; an older commit only price.ts.
    s.setTree('HEAD', [{ path: 'src/price.ts', blob: 'b1' }, { path: 'src/cart.ts', blob: 'b2' }])
    s.setTree('old', [{ path: 'src/price.ts', blob: 'b1' }])
    expect(s.definitions('total', 'HEAD')).toMatchObject([{ path: 'src/price.ts', kind: 'function', line: 1, endLine: 3 }])
    expect(s.references('total', 'HEAD').map((r) => `${r.kind} ${r.path}:${r.line}${r.within ? ` in ${r.within}` : ''}`)).toEqual([
      'import src/cart.ts:1', 'call src/cart.ts:3 in function checkout',
    ])
    expect(s.references('total', 'old')).toEqual([])
    expect(s.definitions('total', 'nowhere')).toEqual([])
    expect(s.blobOf('HEAD', 'src/cart.ts')).toBe('b2')
    expect(s.symbolsIn('b2').map((x) => x.name)).toEqual(['checkout'])
    expect(s.stats()).toMatchObject({ blobs: 3, symbols: 2, refs: 2 })
    expect(s.stats().trees.sort()).toEqual(['HEAD', 'old'])
    s.close()
  })

  it('replaces a tree and prunes trees it is told to forget', () => {
    const s = open()
    s.setTree('HEAD', [{ path: 'a.ts', blob: 'x' }])
    s.setTree('HEAD', [{ path: 'b.ts', blob: 'y' }])
    expect(s.tree('HEAD')).toEqual([{ path: 'b.ts', blob: 'y' }])
    s.setTree('worktree', [{ path: 'b.ts', blob: 'y' }])
    s.keepTrees(['worktree'])
    expect(s.trees()).toEqual(['worktree'])
    s.close()
  })

  it('a reader sees what the writer commits; an old schema is rebuilt', () => {
    const file = join(tempDir(), 'graph.sqlite')
    const w = new GraphStore(file)
    const r = new GraphStore(file, true)
    w.setTree('HEAD', [{ path: 'a.ts', blob: 'x' }])
    expect(r.hasTree('HEAD')).toBe(true)
    w.setMeta('schema', '0')
    w.close()
    r.close()
    const again = new GraphStore(file)
    expect(again.hasTree('HEAD')).toBe(false)
    again.close()
  })
})
