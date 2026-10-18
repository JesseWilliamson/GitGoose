import { GraphStore } from '@gitgoose/codegraph/node'
import { initRepo, tempDir } from '@gitgoose/fixtures'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blobId, Repo } from './repo'
import { CodeIndexer } from './codeindex'
import { contextBudget, renderCodeContext } from './codecontext'

/**
 * A small project: price.ts is changed (total gets a parameter and calls clamp, legacy is
 * removed, discount is new), while cart.ts, old.ts and the test keep using the old names.
 * README.md mentions `total` in prose: a word match, not a use.
 */
function project() {
  const r = initRepo()
  r.commit('root', {
    'src/price.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n\nexport function legacy() {\n  return 0\n}\n',
    'src/util.ts': 'export function clamp(x: number, lo: number, hi: number) {\n  return Math.min(hi, Math.max(lo, x))\n}\n',
    'src/cart.ts': "import { total } from './price'\nexport function checkout() {\n  return total(1, 2)\n}\n",
    'src/old.ts': "import { legacy } from './price'\nexport function tidy() {\n  return legacy()\n}\n",
    'src/price.test.ts': "import { total } from './price'\ntest('total', () => expect(total(1, 2)).toBe(3))\n",
    'README.md': 'Call total to add things up.\n',
  })
  r.write('src/price.ts', "import { clamp } from './util'\nexport function total(a: number, b: number, cap = 100) {\n  return clamp(Math.round(a + b), 0, cap)\n}\n\nexport function discount(x: number) {\n  return x * 0.9\n}\n")
  return r
}

async function withGraph(r: ReturnType<typeof project>) {
  const repo = await Repo.open(r.dir, { env: r.env() as Record<string, string> })
  const file = join(tempDir('gitgoose-graph-'), 'graph.sqlite')
  const ix = new CodeIndexer(repo.runner, r.dir, new GraphStore(file))
  await ix.syncRev('HEAD')
  await ix.syncWorktree()
  repo.attachGraph(new GraphStore(file, true))
  return { repo, ix }
}

describe('code context for the AI', () => {
  it('a blob id is a hash of the text, as git computes it', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'hello\n' })
    expect(blobId('hello\n')).toBe(r.git('rev-parse', 'HEAD:a.txt').trim())
  })

  it('from the graph: changed definitions with their uses, what the added lines call, and the tests', async () => {
    const r = project()
    const { repo, ix } = await withGraph(r)
    const input = await repo.reviewInput({ kind: 'working' })
    const ctx = await repo.codeContext(input)
    expect(ctx.source).toBe('graph')
    expect(ctx.symbols.map((s) => `${s.change} ${s.kind} ${s.name} uses=${s.uses} tests=${s.testUses}`)).toEqual([
      'changed function total uses=4 tests=2',
      'added function discount uses=0 tests=0',
      'removed function legacy uses=2 tests=0',
    ])
    const total = ctx.symbols[0]!
    expect(total.oldSignature).toBe('export function total(a: number, b: number) {')
    expect(total.signature).toBe('export function total(a: number, b: number, cap = 100) {')
    // Non-test uses first; the README's prose mention is not a use.
    expect(total.callers.map((c) => `${c.path}:${c.line}${c.within ? ` in ${c.within}` : ''}${c.test ? ' (test)' : ''}`)).toEqual([
      'src/cart.ts:1', 'src/cart.ts:3 in function checkout', 'src/price.test.ts:1 (test)', 'src/price.test.ts:2 (test)',
    ])
    expect(ctx.symbols[2]!.callers.map((c) => c.text)).toEqual(["import { legacy } from './price'", 'return legacy()'])
    // The added lines call clamp (defined elsewhere: shown) and Math.round (no definition here: dropped).
    expect(ctx.used).toEqual([{ name: 'clamp', kind: 'function', path: 'src/util.ts', line: 1, endLine: 3, uses: 1, preview: ['export function clamp(x: number, lo: number, hi: number) {', '  return Math.min(hi, Math.max(lo, x))', '}'] }])
    expect(ctx.tests).toEqual([{ path: 'src/price.test.ts', inChange: false }])

    const { text, truncated } = renderCodeContext(ctx, contextBudget(2_000))
    expect(truncated).toBe(false)
    expect(text).toContain('- function legacy (src/price.ts:5) removed, STILL USED\n  used in 2 places outside the change:\n    src/old.ts:1: import { legacy }')
    expect(text).toContain('- function total (src/price.ts:2) changed\n  was: export function total(a: number, b: number) {\n  now: export function total(a: number, b: number, cap = 100) {\n  used in 4 places outside the change (2 in tests):')
    expect(text).toContain('- function discount (src/price.ts:6) added\n  no uses outside the change yet')
    expect(text).toContain('- function clamp (src/util.ts:1), used 1 time:\n  ```\n  export function clamp')
    expect(text).toContain('Tests that cover the change:\n- not changed: src/price.test.ts')
    // The removed-but-used definition comes first: it is the one thing only the graph can see.
    expect(text.indexOf('legacy')).toBeLessThan(text.indexOf('function total'))
    ix.dispose()
    repo.dispose()
  })

  it('without the graph: line patterns and git grep, less precise but never waiting', async () => {
    const r = project()
    const repo = await Repo.open(r.dir, {})
    const ctx = await repo.codeContext(await repo.reviewInput({ kind: 'working' }))
    expect(ctx.source).toBe('patterns')
    const total = ctx.symbols.find((s) => s.name === 'total')!
    // A word match: the README's sentence counts as a use here.
    expect(total.callers.map((c) => c.path)).toContain('README.md')
    expect(ctx.symbols.find((s) => s.name === 'legacy')).toMatchObject({ change: 'removed', uses: 2 })
    expect(ctx.used.map((u) => `${u.name} ${u.path}`)).toEqual(['clamp src/util.ts'])
    expect(ctx.tests).toEqual([{ path: 'src/price.test.ts', inChange: false }])
    repo.dispose()
  })

  it('stays within its budget, most useful first, and says when it cut', async () => {
    const r = project()
    const repo = await Repo.open(r.dir, {})
    const ctx = await repo.codeContext(await repo.reviewInput({ kind: 'working' }))
    const small = renderCodeContext(ctx, 560)
    expect(small.truncated).toBe(true)
    // The removed-but-used definition, with its uses; the changed one shrinks to its headline.
    expect(small.text).toContain('- function legacy (src/price.ts:5) removed, STILL USED\n  used in 2 places outside the change:\n    src/old.ts:1')
    expect(small.text).toContain('- function total (src/price.ts:2) changed\n  was:')
    expect(small.text).toContain('used in 5 places outside the change (2 in tests)\n') // five: the README's prose counts without the graph
    expect(small.text).not.toContain('src/cart.ts')
    expect(small.text).not.toContain('clamp')
    expect(small.text.endsWith('(… more context left out for size)')).toBe(true)
    expect(small.text.length).toBeLessThan(700)
    expect(contextBudget(100)).toBe(8_000)
    expect(contextBudget(20_000)).toBe(20_000)
    expect(contextBudget(1_000_000)).toBe(30_000)
    repo.dispose()
  })

  it('reads the commit messages of a committed change as its intent; uncommitted changes have none', async () => {
    const r = project()
    const c1 = r.commit('feat: cap totals\n\nLarge carts were overflowing the display.')
    const c2 = r.commit('chore: tidy', { 'README.md': 'Call total.\n' })
    const repo = await Repo.open(r.dir, {})
    expect(await repo.scopeCommits(await repo.reviewInput({ kind: 'commits', hashes: [c2, c1] }))).toEqual([
      { subject: 'chore: tidy', body: '' },
      { subject: 'feat: cap totals', body: 'Large carts were overflowing the display.' },
    ])
    r.write('src/util.ts', '// changed\n')
    expect(await repo.scopeCommits(await repo.reviewInput({ kind: 'working' }))).toEqual([])
    repo.dispose()
  })
})
