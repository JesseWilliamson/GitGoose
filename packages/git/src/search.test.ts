import { makeFixture, makeLargeRepo, tempDir } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

const subjects = async (repo: Repo, hashes: string[]) =>
  Promise.all(hashes.map(async (h) => (await repo.runner.run(['log', '-1', '--format=%s', h], { readOnly: true })).stdout.trim()))

describe('search across every field', () => {
  it('matches message, author, SHA prefix, branch and tag names, in graph order', async () => {
    const r = makeFixture('branches')
    r.git('commit', '-q', '--allow-empty', '-m', 'Subject line', '-m', 'A body mentioning Lattice work')
    r.git('commit', '-q', '--allow-empty', '-m', 'by grace', '--author', 'Grace Hopper <grace@navy.mil>')
    r.git('tag', 'v9.9-rc', 'HEAD~1')
    const repo = await Repo.open(r.dir, {})
    const log = (await repo.runner.run(['log', '--topo-order', '--format=%H', '--branches', '--tags', 'HEAD'], { readOnly: true })).stdout.split('\n').filter(Boolean)

    // Body text, case-insensitively.
    expect(await subjects(repo, await repo.search('all', 'lattice'))).toEqual(['Subject line'])
    // Author email.
    expect(await subjects(repo, await repo.search('all', 'NAVY.mil'))).toEqual(['by grace'])
    // A SHA prefix.
    const target = log[3]!
    expect(await repo.search('all', target.slice(0, 7))).toContain(target)
    // A tag name, and a branch name: the commits they point at.
    expect(await subjects(repo, await repo.search('all', 'v9.9'))).toEqual(['Subject line'])
    expect(await subjects(repo, await repo.search('all', 'wip'))).toEqual(['F'])
    // Several fields at once, in the order the graph shows them.
    const both = await repo.search('all', 'e')
    expect(both).toEqual(log.filter((h) => both.includes(h)))
    expect(await repo.search('all', '   ')).toEqual([])
    repo.dispose()
  })

  it('a newer search cancels the one still running', async () => {
    const dir = makeLargeRepo(20_000, tempDir('gitgoose-search-'))
    const repo = await Repo.open(dir, {})
    const t = performance.now()
    const slow = repo.search('all', 'zzz-not-there')
    const fast = repo.search('all', 'commit 19999')
    expect(await slow).toEqual([])
    expect((await fast).length).toBeGreaterThan(0)
    // One walk of 20,000 commits, not two.
    expect(performance.now() - t).toBeLessThan(5_000)
    repo.dispose()
  }, 30_000)
})
