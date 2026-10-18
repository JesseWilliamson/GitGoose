import { GraphStore } from '@gitgoose/codegraph/node'
import { initRepo, tempDir } from '@gitgoose/fixtures'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodeIndexer, INDEX, WORKTREE } from './codeindex'
import { GitRunner } from './runner'

function setup() {
  const r = initRepo()
  r.commit('root', {
    'src/price.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n',
    'src/cart.ts': "import { total } from './price'\nexport function checkout() {\n  return total(1, 2)\n}\n",
    'README.md': '# not code\n',
  })
  const store = new GraphStore(join(tempDir('gitgoose-graph-'), 'graph.sqlite'))
  const runner = new GitRunner({ cwd: r.dir, env: r.env() as Record<string, string> })
  return { r, store, ix: new CodeIndexer(runner, r.dir, store) }
}

describe('CodeIndexer', () => {
  it('indexes a commit, then only what later commits change', async () => {
    const { r, store, ix } = setup()
    const progress: number[] = []
    const head = await ix.syncRev('HEAD', (p) => progress.push(p.total))
    expect(head).toBe(r.head())
    expect(progress[0]).toBe(2) // README.md has no grammar
    expect(store.definitions('total', head)).toMatchObject([{ path: 'src/price.ts', kind: 'function', line: 1 }])
    expect(store.references('total', head).map((x) => `${x.kind} ${x.path}:${x.line}`)).toEqual(['import src/cart.ts:1', 'call src/cart.ts:3'])

    // One more file: one more parse. The others are known by blob id.
    r.commit('tax', { 'src/tax.ts': "import { total } from './price'\nexport const withTax = (n: number) => total(n, 1)\n" })
    const again: number[] = []
    const h2 = await ix.syncRev('HEAD', (p) => again.push(p.total))
    expect(again[0]).toBe(1)
    expect(store.references('total', h2)).toHaveLength(4)
    expect(store.references('total', head)).toHaveLength(2) // the old tree still answers as it was
    expect(store.stats().blobs).toBe(3)
    ix.dispose()
    store.close()
  })

  it('indexes the index and the working tree, hashing modified and untracked files like git', async () => {
    const { r, store, ix } = setup()
    r.write('src/price.ts', 'export function total(a: number, b: number) {\n  return Math.round(a + b)\n}\nexport function tax() { return 1 }\n')
    r.write('src/new.ts', 'export function fresh() { return total(1, 1) }\n')
    await ix.syncIndex()
    await ix.syncWorktree()
    expect(store.definitions('tax', INDEX)).toEqual([])
    expect(store.definitions('tax', WORKTREE)).toMatchObject([{ path: 'src/price.ts', line: 4 }])
    expect(store.references('total', WORKTREE).map((x) => x.path).sort()).toEqual(['src/cart.ts', 'src/cart.ts', 'src/new.ts'])
    // Unchanged content, same blob: a second sync parses nothing.
    const progress: number[] = []
    await ix.syncWorktree((p) => progress.push(p.total))
    expect(progress[0]).toBe(0)
    // Staging makes the index catch up, and the staged blob is the one already parsed from the worktree.
    r.git('add', 'src/price.ts')
    const staged: number[] = []
    await ix.syncIndex((p) => staged.push(p.total))
    expect(staged[0]).toBe(0)
    expect(store.definitions('tax', INDEX)).toHaveLength(1)
    ix.dispose()
    store.close()
  })
})
