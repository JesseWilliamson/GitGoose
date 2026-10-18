import { initRepo } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

describe('omni search sources', () => {
  it('describes the commits a search finds, newest first, with the total', async () => {
    const r = initRepo()
    r.commit('feat: price lines', { 'a.txt': 'a\n' })
    const fix = r.commit('fix: round prices', { 'b.txt': 'b\n' })
    r.commit('docs: readme', { 'c.txt': 'c\n' })
    const repo = await Repo.open(r.dir, {})
    const res = await repo.searchCommits('all', 'price', 1)
    expect(res.total).toBe(2)
    expect(res.commits).toEqual([{ hash: fix, subject: 'fix: round prices', authorName: 'Ada Lovelace', authorEmail: 'ada@example.com', authorDate: expect.any(Number) }])
    expect(await repo.searchCommits('all', 'nothing like it')).toEqual({ total: 0, commits: [] })
    repo.dispose()
  })

  it('lists tracked and untracked files once each, not ignored ones', async () => {
    const r = initRepo()
    r.commit('root', { 'src/a.ts': 'a\n', '.gitignore': 'dist/\n' })
    r.write('src/new.ts', 'n\n').write('dist/out.js', 'x\n')
    const repo = await Repo.open(r.dir, {})
    expect((await repo.listFiles()).sort()).toEqual(['.gitignore', 'src/a.ts', 'src/new.ts'])
    repo.dispose()
  })
})
