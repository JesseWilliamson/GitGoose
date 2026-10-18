import { initRepo } from '@gitsquid/fixtures'
import { describe, expect, it } from 'vitest'
import { graphRevs } from './log'
import { Repo } from './repo'

describe('hiding and soloing branches', () => {
  it('builds per-namespace excludes, or only the soloed refs plus HEAD', () => {
    expect(graphRevs('h')).toEqual(['--branches', '--remotes', '--tags', 'HEAD'])
    expect(graphRevs('h', { hidden: ['refs/heads/wip', 'refs/remotes/origin/*', 'refs/tags/old'], solo: [] })).toEqual([
      '--exclude=wip', '--branches', '--exclude=origin/*', '--remotes', '--exclude=old', '--tags', 'HEAD',
    ])
    expect(graphRevs('h', { hidden: [], solo: ['refs/heads/a', 'refs/heads/gone', 'refs/remotes/up/*'] }, new Set(['refs/heads/a']))).toEqual([
      'refs/heads/a', '--glob=refs/remotes/up/*', 'HEAD',
    ])
    expect(graphRevs(undefined, { hidden: [], solo: ['refs/heads/a'] })).toEqual(['refs/heads/a'])
  })

  it('leaves out commits only hidden branches reach; solo shows one branch and HEAD', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'a\n' })
    r.git('checkout', '-q', '-b', 'wip')
    r.commit('on wip', { 'w.txt': 'w\n' })
    r.checkout('main')
    r.git('checkout', '-q', '-b', 'other')
    r.commit('on other', { 'o.txt': 'o\n' })
    r.checkout('main')
    r.commit('on main', { 'm.txt': 'm\n' })
    const repo = await Repo.open(r.dir, {})
    const subjects = async () => (await repo.logPage(0, 100)).commits.map((c) => c.subject).sort()
    await repo.snapshot()
    expect(await subjects()).toEqual(['on main', 'on other', 'on wip', 'root'])

    repo.setGraphFilter({ hidden: ['refs/heads/wip'], solo: [] })
    const snap = await repo.snapshot()
    expect(snap.filter.hidden).toEqual(['refs/heads/wip'])
    expect(await subjects()).toEqual(['on main', 'on other', 'root'])
    expect(await repo.search('all', 'on wip')).toEqual([])

    repo.setGraphFilter({ hidden: [], solo: ['refs/heads/other'] })
    await repo.snapshot()
    expect(await subjects()).toEqual(['on main', 'on other', 'root'])
    r.git('branch', '-D', 'other') // a soloed branch that disappears must not break the walk
    await repo.snapshot()
    expect(await subjects()).toEqual(['on main', 'root'])
    repo.dispose()
  })
})
