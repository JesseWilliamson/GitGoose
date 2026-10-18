import { makeFixture } from '@gitsquid/fixtures'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

describe('stashes in the graph', () => {
  it('shows each stash as one node on its base commit, hiding the helper commits', async () => {
    const r = makeFixture('stash')
    r.write('new.txt', 'untracked\n')
    r.git('stash', 'push', '-q', '-u', '-m', 'with untracked')
    const base = r.head()
    const repo = await Repo.open(r.dir, {})
    await repo.snapshot()
    const { commits } = await repo.logPage(0, 100)
    const stashes = commits.filter((c) => c.stash)
    expect(stashes.map((c) => c.subject)).toEqual(['On main: with untracked', 'On main: second stash', 'On main: first stash'])
    for (const s of stashes) expect(s.parents).toEqual([base])
    // Only the stashes and the real history: no "index on main" or "untracked files on main".
    expect(commits.map((c) => c.subject).filter((s) => /^(index|untracked files) on /.test(s))).toEqual([])
    expect(commits).toHaveLength(4)
    repo.dispose()
  })

  it('notices a dropped stash (only the reflog changes), and can be turned off', async () => {
    const r = makeFixture('stash')
    const repo = await Repo.open(r.dir, {})
    const v1 = (await repo.snapshot()).refsVersion
    r.git('stash', 'drop', '-q', 'stash@{1}')
    const v2 = (await repo.snapshot()).refsVersion
    expect(v2).toBeGreaterThan(v1)
    expect((await repo.logPage(0, 100)).commits.filter((c) => c.stash)).toHaveLength(1)
    repo.setShowStashes(false)
    expect((await repo.snapshot()).refsVersion).toBeGreaterThan(v2)
    expect((await repo.logPage(0, 100)).commits.filter((c) => c.stash)).toHaveLength(0)
    repo.dispose()
  })
})
