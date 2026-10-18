import { initRepo } from '@gitsquid/fixtures'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

function setup() {
  const r = initRepo()
  r.commit('root', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  return r
}
const status = (r: ReturnType<typeof setup>) => r.git('status', '--porcelain').trimEnd()

describe('partial stashes', () => {
  it('stashes only the chosen files; undo brings them back', async () => {
    const r = setup()
    r.write('a.txt', 'a2\n').write('b.txt', 'b2\n')
    const repo = await Repo.open(r.dir, {})
    const id = await repo.stashPush({ paths: ['a.txt'] })
    expect(status(r)).toBe(' M b.txt')
    expect(r.git('stash', 'list')).toContain('stash@{0}')
    await repo.undo(id!)
    expect(status(r)).toBe(' M a.txt\n M b.txt')
    expect(r.git('stash', 'list')).toBe('')
    repo.dispose()
  })

  it('stashes only what is staged, or everything while keeping the staged changes', async () => {
    const r = setup()
    r.write('a.txt', 'a2\n').write('b.txt', 'b2\n')
    r.git('add', 'a.txt')
    const repo = await Repo.open(r.dir, {})
    const staged = await repo.stashPush({ staged: true })
    expect(status(r)).toBe(' M b.txt')
    expect(r.git('show', '--stat', '--format=', 'stash@{0}')).toContain('a.txt')
    await repo.undo(staged!)
    expect(status(r)).toBe('M  a.txt\n M b.txt')

    // Keep index: the staged change stays put (to test it alone); the stash holds everything.
    const kept = await repo.stashPush({ keepIndex: true })
    expect(status(r)).toBe('M  a.txt')
    await repo.undo(kept!)
    expect(status(r)).toBe('M  a.txt\n M b.txt')
    repo.dispose()
  })
})

describe('stash to a branch, and one file from a stash', () => {
  it('makes a branch where the stash was made, applies it, and undoes back', async () => {
    const r = setup()
    const base = r.head()
    r.write('a.txt', 'stashed\n')
    r.git('stash', '-q')
    r.commit('main moves on', { 'a.txt': 'conflicting\n' })
    const repo = await Repo.open(r.dir, {})
    const id = await repo.stashBranch(0, 'rescued')
    expect(r.git('branch', '--show-current').trim()).toBe('rescued')
    expect(r.git('rev-parse', 'HEAD').trim()).toBe(base)
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('stashed\n')
    expect(r.git('stash', 'list')).toBe('')
    // Undo refuses while the applied changes have been edited (it could not tell them apart)...
    r.write('a.txt', 'stashed, then edited\n')
    await expect(repo.undo(id)).rejects.toThrow(/working tree changed since/)
    expect(r.git('branch', '--show-current').trim()).toBe('rescued')
    // ...and goes all the way back once they are as the stash left them.
    r.write('a.txt', 'stashed\n')
    await repo.undo(id)
    expect(status(r)).toBe('')
    expect(r.git('branch', '--show-current').trim()).toBe('main')
    expect(r.git('branch', '--list', 'rescued')).toBe('')
    expect(r.git('stash', 'list')).toContain('stash@{0}')
    repo.dispose()
  })

  it('undoes a stash-to-branch of a stash with untracked files', async () => {
    const r = setup()
    r.write('a.txt', 'changed\n').write('new.txt', 'new\n')
    r.git('stash', 'push', '-q', '-u')
    const repo = await Repo.open(r.dir, {})
    const id = await repo.stashBranch(0, 'rescued')
    expect(readFileSync(join(r.dir, 'new.txt'), 'utf8')).toBe('new\n')
    await repo.undo(id)
    expect(status(r)).toBe('')
    expect(r.git('stash', 'show', '--include-untracked', '--name-only', 'stash@{0}').trim().split('\n').sort()).toEqual(['a.txt', 'new.txt'])
    repo.dispose()
  })

  it('takes one file from a stash, an untracked one included, undoably', async () => {
    const r = setup()
    r.write('a.txt', 'from stash\n').write('new.txt', 'brand new\n')
    r.git('stash', 'push', '-q', '-u')
    const hash = r.git('rev-parse', 'stash@{0}').trim()
    const repo = await Repo.open(r.dir, {})
    await repo.restoreFile('a.txt', hash, { stash: true })
    const id = await repo.restoreFile('new.txt', hash, { stash: true })
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('from stash\n')
    expect(readFileSync(join(r.dir, 'new.txt'), 'utf8')).toBe('brand new\n')
    await repo.undo(id)
    expect(status(r)).toBe(' M a.txt')
    repo.dispose()
  })
})
