import { initRepo } from '@gitgoose/fixtures'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

describe('snapshots', () => {
  it('saves tracked and untracked changes as a stash without touching a file; apply restores them', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
    r.write('a.txt', 'a changed\n').write('new.txt', 'brand new\n')
    r.git('add', 'a.txt')
    r.write('b.txt', 'b changed\n')
    const before = r.git('status', '--porcelain')
    const mtime = statSync(join(r.dir, 'a.txt')).mtimeMs
    const repo = await Repo.open(r.dir, {})
    const id = await repo.snapshotWorkTree('before refactor')
    expect(r.git('status', '--porcelain')).toBe(before)
    expect(statSync(join(r.dir, 'a.txt')).mtimeMs).toBe(mtime)
    expect(r.git('stash', 'list')).toContain('On main: before refactor')

    // Throw everything away, then apply the snapshot: all of it is back.
    r.git('reset', '-q', '--hard')
    r.git('clean', '-qfd')
    await repo.stashApply(0)
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('a changed\n')
    expect(readFileSync(join(r.dir, 'b.txt'), 'utf8')).toBe('b changed\n')
    expect(readFileSync(join(r.dir, 'new.txt'), 'utf8')).toBe('brand new\n')
    // The staged part was recorded as staged (the index commit), as with any stash.
    expect(r.git('diff', '--name-only', 'stash@{0}^1', 'stash@{0}^2').trim()).toBe('a.txt')
    // Undo of the snapshot only drops the entry.
    await repo.undo(id!)
    expect(r.git('stash', 'list')).toBe('')
    repo.dispose()
  })

  it('works with only untracked files; undo drops the entry; nothing to save is nothing', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'a\n' })
    const repo = await Repo.open(r.dir, {})
    expect(await repo.snapshotWorkTree()).toBeNull()
    r.write('only-new.txt', 'n\n')
    const id = await repo.snapshotWorkTree()
    expect(r.git('show', '--name-only', '--format=', 'stash@{0}^3').trim()).toBe('only-new.txt')
    await repo.undo(id!)
    expect(r.git('stash', 'list')).toBe('')
    expect(r.git('status', '--porcelain').trim()).toBe('?? only-new.txt')
    repo.dispose()
  })
})
