import { initRepo } from '@gitsquid/fixtures'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

describe('ask context', () => {
  it('gathers the lines, their function, definitions of what they use, and their history', async () => {
    const r = initRepo()
    r.commit('add pricing', {
      'src/tax.ts': 'export function taxRate(country: string): number {\n  return country === "NZ" ? 0.15 : 0.2\n}\n',
      'src/price.ts': 'export function gross(net: number, country: string): number {\n  return net\n}\n',
    })
    r.git('commit', '-q', '--allow-empty', '-m', 'unrelated')
    r.write('src/price.ts', "import { taxRate } from './tax'\nexport function gross(net: number, country: string): number {\n  return net * (1 + taxRate(country))\n}\n")
    r.git('commit', '-q', '-am', 'apply tax', '--author=Grace Hopper <grace@example.com>')
    const repo = await Repo.open(r.dir, {})
    const c = await repo.askContext(r.head(), 'src/price.ts', 3, 3)
    expect(c.lines).toEqual(['  return net * (1 + taxRate(country))'])
    expect(c.within).toMatchObject({ name: 'gross', kind: 'function', line: 2 })
    expect(c.used.map((u) => `${u.name} ${u.path}:${u.line}`)).toEqual(['taxRate src/tax.ts:1'])
    expect(c.history).toHaveLength(2)
    expect(c.history[0]).toMatch(/Grace Hopper: apply tax$/)
    expect(c.history[1]).toMatch(/Ada Lovelace: add pricing$/)
    expect(c.blame).toEqual([{ author: 'Grace Hopper', summary: 'apply tax', lines: 1 }])
    await expect(repo.askContext(null, 'missing.ts', 1, 1)).rejects.toThrow(/not there/)
    repo.dispose()
  })
})
