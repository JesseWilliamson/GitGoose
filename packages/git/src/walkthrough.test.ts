import { initRepo } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'
import { describeHunks, layerOf, verifyWalkthrough, walkthroughHunks } from './walkthrough'

describe('walkthrough', () => {
  it('places files in reading layers', () => {
    expect(layerOf('src/api.ts')).toBe('contract')
    expect(layerOf('src/types.d.ts')).toBe('contract')
    expect(layerOf('src/cart.ts', { kind: 'interface' })).toBe('contract')
    expect(layerOf('src/cart.ts')).toBe('implementation')
    expect(layerOf('src/style.css')).toBe('implementation')
    expect(layerOf('src/cart.test.ts')).toBe('tests')
    expect(layerOf('tests/test_cart.py')).toBe('tests')
    expect(layerOf('package.json')).toBe('config')
    expect(layerOf('docs/guide.md')).toBe('docs')
  })

  it('orders hunks by layer and folds trivial ones; checks what the model says', async () => {
    const r = initRepo()
    r.commit('root', {
      'src/api.ts': 'export interface Cart {\n  items: string[]\n}\n',
      'src/cart.ts': `import { a } from './a'\n${'// filler\n'.repeat(8)}export function add(c: Cart, x: string) {\n  c.items.push(x)\n}\n`,
      'src/cart.test.ts': 'test("add", () => {})\n',
    })
    r.write('src/api.ts', 'export interface Cart {\n  items: string[]\n  total: number\n}\n')
    r.write('src/cart.ts', `import { a, b } from './a'\n${'// filler\n'.repeat(8)}export function add(c: Cart, x: string) {\n  c.items.push(x)\n  c.total += 1\n  return c\n}\n`)
    r.write('src/cart.test.ts', 'test("add", () => {\n  expect(add(cart, "x").total).toBe(1)\n})\n')
    const repo = await Repo.open(r.dir, {})
    const input = await repo.reviewInput({ kind: 'working' })
    const hunks = walkthroughHunks(input.files, (p) => input.texts.get(p) ?? null)
    expect(hunks.map((h) => `${h.id} ${h.path} ${h.layer} ${h.trivial ? 'trivial' : ''}`.trim())).toEqual([
      'H1 src/api.ts contract',
      'H2 src/cart.ts implementation trivial', // the import line
      'H3 src/cart.ts implementation',
      'H4 src/cart.test.ts tests',
    ])
    expect(hunks[2]!.within).toBe('function add')
    expect(describeHunks(input.files, hunks)).toContain('[H3] src/cart.ts:9-14 implementation, in function add (+2 -0)')

    const v = verifyWalkthrough({
      summary: 'Adds a running total to carts.', effort: 9, effortWhy: 'small',
      groups: [{ title: 'Total', description: 'The new field and its upkeep', files: ['src/api.ts', 'src/cart.ts', 'src/invented.ts'] }],
      hunks: { H3: 'Keeps the total in step', H99: 'nope' },
      sequence: { participants: ['Test', 'add'], messages: [{ from: 'Test', to: 'add', label: 'add(cart, x)' }, { from: 'Ghost', to: 'add', label: 'x' }] },
    }, input.files.map((f) => f.path), hunks)
    expect(v.effort).toBe(5)
    expect(v.groups).toEqual([
      { title: 'Total', description: 'The new field and its upkeep', files: ['src/api.ts', 'src/cart.ts'] },
      { title: 'Other changes', description: '', files: ['src/cart.test.ts'] },
    ])
    expect(hunks[2]!.summary).toBe('Keeps the total in step')
    expect(v.sequence).toEqual({ participants: ['Test', 'add'], messages: [{ from: 'Test', to: 'add', label: 'add(cart, x)' }] })
    expect(verifyWalkthrough(null, ['a'], []).groups).toEqual([{ title: 'Changes', description: '', files: ['a'] }])
    repo.dispose()
  })
})
