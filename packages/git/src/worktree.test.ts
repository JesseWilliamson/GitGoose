import { initRepo, tempDir } from '@gitgoose/fixtures'
import { existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'
import { parseWorktrees, realPathOf } from './worktree'

describe('worktrees', () => {
  it('parses the porcelain list: branch, detached, locked, prunable', () => {
    const out = [
      'worktree /r\0HEAD aaa\0branch refs/heads/main\0',
      'worktree /r2\0HEAD bbb\0branch refs/heads/feat\0prunable gitdir file points to non-existent location\0',
      'worktree /r3\0HEAD ccc\0detached\0locked on usb\0',
    ].join('\0')
    expect(parseWorktrees(out + '\0', '/r2')).toEqual([
      { path: '/r', head: 'aaa', branch: 'main', detached: false, main: true, current: false },
      { path: '/r2', head: 'bbb', branch: 'feat', detached: false, main: false, current: true, prunable: 'gitdir file points to non-existent location' },
      { path: '/r3', head: 'ccc', detached: true, main: false, current: false, locked: 'on usb' },
    ])
  })

  it('adds a worktree on a new branch; undo removes both; removing a clean one is undoable', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'a\n' })
    const repo = await Repo.open(r.dir, {})
    const path = join(tempDir('gitgoose-wt-'), 'feature')
    const id = await repo.addWorktree(path, { newBranch: 'feature' })
    const list = await repo.worktrees()
    expect(list.map((w) => [w.branch, w.main, w.current])).toEqual([['main', true, true], ['feature', false, false]])
    await repo.undo(id)
    expect(existsSync(path)).toBe(false)
    expect(r.git('branch', '--list', 'feature')).toBe('')

    await repo.addWorktree(path, { newBranch: 'feature' })
    const rm = await repo.removeWorktree(path)
    expect((await repo.worktrees())).toHaveLength(1)
    await repo.undo(rm!)
    expect((await repo.worktrees()).map((w) => w.branch)).toEqual(['main', 'feature'])
    repo.dispose()
  })

  it('refuses to remove a worktree with changes unless forced; forgets ones whose folder is gone', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'a\n' })
    const repo = await Repo.open(r.dir, {})
    const path = join(tempDir('gitgoose-wt-'), 'w')
    await repo.addWorktree(path, { at: 'HEAD' })
    writeFileSync(join(path, 'a.txt'), 'edited\n')
    await expect(repo.removeWorktree(path)).rejects.toThrow()
    expect(await repo.removeWorktree(path, { force: true })).toBeNull()
    await expect(repo.removeWorktree(r.dir)).rejects.toThrow(/main working tree/)

    const gone = join(tempDir('gitgoose-wt-'), 'gone')
    await repo.addWorktree(gone, { newBranch: 'gone' })
    await repo.lockWorktree(gone, true, 'testing')
    expect((await repo.worktrees())[1]!.locked).toBe('testing')
    await repo.lockWorktree(gone, false)
    rmSync(gone, { recursive: true, force: true })
    expect((await repo.worktrees())[1]!.prunable).toBeTruthy()
    await repo.pruneWorktrees()
    expect(await repo.worktrees()).toHaveLength(1)
    repo.dispose()
  })

  it('finds a worktree given a path through a symlink (git reports the resolved one)', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'a\n' })
    const repo = await Repo.open(r.dir, {})
    const real = tempDir('gitgoose-wt-')
    const link = join(tempDir('gitgoose-wt-'), 'link')
    symlinkSync(real, link)
    await repo.addWorktree(join(link, 'w'), { at: 'HEAD' })
    expect(await repo.removeWorktree(join(link, 'w'))).not.toBeNull()
    expect(await repo.worktrees()).toHaveLength(1)
    repo.dispose()
  })

  it('resolves symlinks in paths that do not exist yet', async () => {
    const real = tempDir('gitgoose-wt-')
    const link = join(tempDir('gitgoose-wt-'), 'link')
    symlinkSync(real, link)
    expect(await realPathOf(join(link, 'not', 'yet'))).toBe(join(await realPathOf(real), 'not', 'yet'))
    expect(await realPathOf(join(link, '..', 'link'))).toBe(await realPathOf(real))
  })
})
