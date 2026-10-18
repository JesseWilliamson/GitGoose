import { initRepo } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { parseReflog } from './reflog'
import { Repo } from './repo'

describe('reflog', () => {
  it('parses moves newest first, with when each move happened and a branch name to restore under', () => {
    const out = [
      ['c'.repeat(40), 'HEAD@{1700000300}', 'checkout: moving from topic to main', 'on main'],
      ['b'.repeat(40), 'HEAD@{1700000200}', 'commit: on topic', 'on topic'],
      ['a'.repeat(40), 'HEAD@{1700000100}', 'commit (initial): root', 'root'],
    ].map((f) => f.join('\0') + '\x1e').join('\n')
    const e = parseReflog(out)
    expect(e.map((x) => [x.index, x.action, x.message, x.date])).toEqual([
      [0, 'checkout', 'moving from topic to main', 1700000300],
      [1, 'commit', 'on topic', 1700000200],
      [2, 'commit (initial)', 'root', 1700000100],
    ])
    // Leaving topic was recorded on arrival at main: topic's tip is the entry before it.
    expect(e[1]!.branchHint).toBe('topic')
    expect(e[0]!.branchHint).toBeUndefined()
  })

  it('finds the commits of a deleted branch, marked lost, and restores one as a branch', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'a\n' })
    r.git('checkout', '-q', '-b', 'experiment')
    const tip = r.commit('try something', { 'b.txt': 'b\n' })
    r.checkout('main')
    r.git('branch', '-D', 'experiment')
    const repo = await Repo.open(r.dir, {})
    const entries = await repo.reflog()
    const lost = entries.find((x) => x.hash === tip)!
    expect(lost.lost).toBe(true)
    expect(lost.branchHint).toBe('experiment')
    expect(entries[0]!.lost).toBeUndefined()
    await repo.createBranch('experiment', { at: tip })
    expect((await repo.reflog()).find((x) => x.hash === tip)!.lost).toBeUndefined()
    repo.dispose()
  })

  it('has nothing to say about a repository with no commits', async () => {
    const repo = await Repo.open(initRepo().dir, {})
    expect(await repo.reflog()).toEqual([])
    repo.dispose()
  })
})
