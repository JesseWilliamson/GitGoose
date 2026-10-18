import { initRepo } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

describe('code peek', () => {
  it('finds where a name is defined and used, at a revision or in the working tree', async () => {
    const r = initRepo()
    const v1 = r.commit('root', {
      'src/price.ts': 'export function total(price: number, count: number): number {\n  return price * count\n}\n',
      'src/cart.ts': "import { total } from './price'\nexport const sum = total(2, 3)\n",
      'README.md': 'Call total to add things up.\n',
    })
    r.write('src/price.ts', 'export function subtotal(price: number): number {\n  return price\n}\n\nexport function total(price: number, count: number): number {\n  return subtotal(price) * count\n}\n')
    const repo = await Repo.open(r.dir, {})

    const now = await repo.codePeek('total', null)
    expect(now.definitions).toEqual([expect.objectContaining({ path: 'src/price.ts', line: 5, endLine: 7, kind: 'function' })])
    expect(now.definitions[0]!.preview[0]).toBe('export function total(price: number, count: number): number {')
    expect(now.references.map((x) => `${x.path}:${x.line}`).sort()).toEqual(['README.md:1', 'src/cart.ts:1', 'src/cart.ts:2'])

    const then = await repo.codePeek('total', v1)
    expect(then.definitions.map((d) => d.line)).toEqual([1])
    // A word inside another word does not count: "subtotal" is not "total".
    expect((await repo.codePeek('subtotal', v1)).references).toEqual([])
    await expect(repo.codePeek('not an identifier', null)).rejects.toThrow()
    repo.dispose()
  })
})
