import { GraphStore } from '@gitgoose/codegraph/node'
import { initRepo, tempDir } from '@gitgoose/fixtures'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodeIndexer } from './codeindex'
import { Repo } from './repo'

/** A repository with its graph built and attached, as the app has it once indexing is done. */
async function withGraph() {
  const r = initRepo()
  const v1 = r.commit('root', {
    'src/price.ts': 'export function total(price: number, count: number): number {\n  return price * count\n}\n',
    'src/cart.ts': "import { total } from './price'\nexport function checkout() {\n  return total(2, 3)\n}\n",
    'src/price.test.ts': "import { total } from './price'\ntest('total', () => expect(total(1, 2)).toBe(2))\n",
    'README.md': 'Call total to add things up.\n',
    'notes.ts': '// total: mentioned in a comment only\nexport const label = "total"\n',
  })
  const repo = await Repo.open(r.dir, { env: r.env() as Record<string, string> })
  const file = join(tempDir('gitgoose-graph-'), 'graph.sqlite')
  const ix = new CodeIndexer(repo.runner, r.dir, new GraphStore(file))
  await ix.syncRev('HEAD')
  await ix.syncIndex()
  await ix.syncWorktree()
  repo.attachGraph(new GraphStore(file, true))
  return { r, repo, ix, v1 }
}

describe('Repo with a code graph', () => {
  it('peeks from parsed definitions and uses: no hits in comments, strings or prose', async () => {
    const { repo, ix, v1 } = await withGraph()
    const peek = await repo.codePeek('total', null)
    expect(peek.definitions).toEqual([expect.objectContaining({ path: 'src/price.ts', line: 1, endLine: 3, kind: 'function' })])
    expect(peek.definitions[0]!.preview[0]).toBe('export function total(price: number, count: number): number {')
    expect(peek.references.map((x) => `${x.path}:${x.line}`)).toEqual(['src/cart.ts:1', 'src/cart.ts:3', 'src/price.test.ts:1', 'src/price.test.ts:2'])
    // The same answer for the commit, through its own tree.
    expect((await repo.codePeek('total', v1)).references).toHaveLength(4)
    ix.dispose()
  })

  it('impact lists parsed uses with the definition each sits in', async () => {
    const { r, repo, ix } = await withGraph()
    r.write('src/price.ts', 'export function total(price: number, count: number): number {\n  return Math.round(price * count)\n}\n')
    await ix.syncWorktree()
    const out = await repo.impact({ kind: 'working' })
    expect(out.symbols).toEqual([expect.objectContaining({ name: 'total', change: 'changed' })])
    expect(out.callers.map((c) => `${c.path}:${c.line}${c.within ? ` in ${c.within}` : ''}${c.test ? ' (test)' : ''}`)).toEqual([
      'src/cart.ts:1', 'src/cart.ts:3 in function checkout', 'src/price.test.ts:1 (test)', 'src/price.test.ts:2 (test)',
    ])
    expect(out.tests).toEqual(['src/price.test.ts'])
    ix.dispose()
  })

  it('definitions of a file come from the graph when it has that content', async () => {
    const { repo, ix } = await withGraph()
    const d = await repo.definitionsIn(null, 'src/cart.ts')
    expect(d!.defs.map((x) => `${x.kind} ${x.name} ${x.line}-${x.endLine}`)).toEqual(['function checkout 2-4'])
    ix.dispose()
  })
})
