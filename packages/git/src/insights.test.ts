import { initRepo } from '@gitsquid/fixtures'
import { describe, expect, it } from 'vitest'
import { coChanges, oldRanges, parseFilesPerCommit } from './insights'
import { Repo } from './repo'

describe('change insights', () => {
  it('parses files per commit and finds usual companions, ignoring huge commits', () => {
    expect(parseFilesPerCommit('\x01aaa\0\na.ts\0a.test.ts\0\x01bbb\0\na.ts\0')).toEqual([['a.ts', 'a.test.ts'], ['a.ts']])
    const commits = [['a', 'b'], ['a', 'b'], ['a', 'b', 'c'], ['a'], Array.from({ length: 50 }, (_, i) => (i ? `x${i}` : 'a'))]
    expect(coChanges('a', commits)).toEqual([{ path: 'b', with: 'a', together: 3, total: 4 }])
  })

  it('reads the old side of -U0 hunks', () => {
    expect(oldRanges('@@ -3,2 +3,2 @@\n-a\n-b\n+c\n+d\n@@ -10 +10 @@\n-x\n+y\n@@ -20,0 +21,3 @@\n+new\n')).toEqual([{ start: 3, count: 2 }, { start: 10, count: 1 }])
  })

  it('warns about a usual companion left out, and names whose lines are changing', async () => {
    const r = initRepo()
    r.commit('root', { 'price.ts': '1\n2\n3\n', 'price.test.ts': 't\n', 'other.ts': 'o\n' })
    for (let i = 0; i < 4; i++) r.commit(`change ${i}`, { 'price.ts': `1\n2\n${i}\n`, 'price.test.ts': `t${i}\n` })
    // Grace rewrites line 1; then the uncommitted change touches lines 1 and 2.
    r.write('price.ts', 'one\n2\n3\n')
    r.git('commit', '-q', '-am', 'by grace', '--author=Grace Hopper <grace@example.com>')
    r.write('price.ts', 'ONE\nTWO\n3\n')
    const repo = await Repo.open(r.dir, {})
    await repo.snapshot()
    const ins = await repo.changeInsights()
    expect(ins.coChange).toEqual([{ path: 'price.test.ts', with: 'price.ts', together: 5, total: 6 }])
    expect(ins.owners.sort((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: 'Ada Lovelace', lines: 1 }, { name: 'Grace Hopper', lines: 1 }])

    // Once the test file is part of the change, there is nothing to warn about.
    r.write('price.test.ts', 'updated\n')
    await repo.snapshot()
    expect((await repo.changeInsights()).coChange).toEqual([])
    repo.dispose()
  })
})
