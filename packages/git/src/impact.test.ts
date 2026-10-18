import { initRepo } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { testsByName } from './impact'
import { Repo } from './repo'

describe('impact', () => {
  it('pairs files with their tests by name', () => {
    const all = ['src/price.ts', 'src/price.test.ts', 'src/price.spec.tsx', 'tests/test_price.py', 'pkg/price_test.go', 'src/priceless.test.ts']
    expect(testsByName('src/price.ts', all)).toEqual(['src/price.test.ts', 'src/price.spec.tsx', 'tests/test_price.py', 'pkg/price_test.go'])
  })

  it('finds touched, added and removed definitions, their uses outside the change, and tests', async () => {
    const r = initRepo()
    r.commit('root', {
      'src/price.ts': 'export function total(a: number, b: number) {\n  return a + b\n}\n\nexport function legacy() {\n  return 0\n}\n',
      'src/cart.ts': "import { total } from './price'\nexport function checkout() {\n  return total(1, 2)\n}\n",
      'src/price.test.ts': "import { total } from './price'\ntest('total', () => expect(total(1, 2)).toBe(3))\n",
    })
    r.write('src/price.ts', 'export function total(a: number, b: number) {\n  return Math.round(a + b)\n}\n\nexport function discount(x: number) {\n  return x * 0.9\n}\n')
    const repo = await Repo.open(r.dir, {})
    const im = await repo.impact({ kind: 'working' })
    expect(im.symbols.map((s) => `${s.change} ${s.name}`).sort()).toEqual(['added discount', 'changed total', 'removed legacy'])
    expect(im.callers.map((c) => `${c.id} ${c.symbol} ${c.path}:${c.line} ${c.within ?? ''} ${c.test ? 'test' : ''}`.trim())).toEqual([
      'C1 total src/cart.ts:1',
      'C2 total src/cart.ts:3 function checkout',
      'C3 total src/price.test.ts:1  test',
      'C4 total src/price.test.ts:2  test',
    ])
    expect(im.tests).toEqual(['src/price.test.ts'])
    repo.dispose()
  })
})
