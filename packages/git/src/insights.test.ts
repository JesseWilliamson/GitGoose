import { initRepo } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { oldRanges } from './insights'
import { Repo } from './repo'

describe('change insights', () => {
  it('reads the old side of -U0 hunks', () => {
    expect(oldRanges('@@ -3,2 +3,2 @@\n-a\n-b\n+c\n+d\n@@ -10 +10 @@\n-x\n+y\n@@ -20,0 +21,3 @@\n+new\n')).toEqual([{ start: 3, count: 2 }, { start: 10, count: 1 }])
  })

  it('names whose lines are changing', async () => {
    const r = initRepo()
    r.commit('root', { 'price.ts': '1\n2\n3\n' })
    // Grace rewrites line 1; then the uncommitted change touches lines 1 and 2.
    r.write('price.ts', 'one\n2\n3\n')
    r.git('commit', '-q', '-am', 'by grace', '--author=Grace Hopper <grace@example.com>')
    r.write('price.ts', 'ONE\nTWO\n3\n')
    const repo = await Repo.open(r.dir, {})
    await repo.snapshot()
    const ins = await repo.changeInsights()
    expect(ins.owners.sort((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: 'Ada Lovelace', lines: 1 }, { name: 'Grace Hopper', lines: 1 }])

    repo.dispose()
  })
})
