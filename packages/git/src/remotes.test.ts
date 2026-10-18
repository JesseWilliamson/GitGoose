import { makeFixture, tempDir } from '@gitgoose/fixtures'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

const bareOf = (r: ReturnType<typeof makeFixture>) => r.git('remote', 'get-url', 'origin').trim()
const lsRemote = (bare: string) => execFileSync('git', ['ls-remote', bare], { encoding: 'utf8' })

describe('remotes', () => {
  it('adds, renames, re-points and removes remotes, each undoable', async () => {
    const r = makeFixture('with-remote')
    const repo = await Repo.open(r.dir, {})
    const other = tempDir('gitgoose-other-')
    const add = await repo.addRemote('backup', other)
    expect((await repo.remotes()).map((x) => x.name).sort()).toEqual(['backup', 'origin'])
    const ren = await repo.renameRemote('backup', 'mirror')
    const url = await repo.setRemoteUrl('mirror', '/somewhere/else.git')
    const push = await repo.setRemoteUrl('mirror', '/push/only.git', true)
    expect((await repo.remotes()).find((x) => x.name === 'mirror')).toEqual({ name: 'mirror', fetchUrl: '/somewhere/else.git', pushUrl: '/push/only.git' })
    await repo.undo(push)
    await repo.undo(url)
    expect((await repo.remotes()).find((x) => x.name === 'mirror')).toEqual({ name: 'mirror', fetchUrl: other })
    await repo.undo(ren)
    await repo.undo(add)
    expect((await repo.remotes()).map((x) => x.name)).toEqual(['origin'])
    // Removing keeps enough to bring it back.
    const bare = bareOf(r)
    const rm = await repo.removeRemote('origin')
    expect(await repo.remotes()).toEqual([])
    await repo.undo(rm)
    expect(await repo.remotes()).toEqual([{ name: 'origin', fetchUrl: bare }])
    repo.dispose()
  })

  it('pushes tags, lists them on the remote, deletes them there; pushes to another branch name', async () => {
    const r = makeFixture('with-remote')
    r.git('tag', 'v1')
    r.git('tag', 'v2')
    const repo = await Repo.open(r.dir, {})
    await repo.pushTags('origin', 'v1')
    expect(await repo.remoteTags('origin')).toEqual(['v1'])
    await repo.pushTags('origin', null)
    expect((await repo.remoteTags('origin')).sort()).toEqual(['v1', 'v2'])
    await repo.deleteRemoteTag('origin', 'v1')
    expect(await repo.remoteTags('origin')).toEqual(['v2'])
    await repo.push({ remoteBranch: 'review/mine' })
    expect(lsRemote(bareOf(r))).toContain('refs/heads/review/mine')
    expect(r.git('rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/review/mine')
    repo.dispose()
  })
})

describe('branches', () => {
  it('sets and unsets upstreams undoably, and fast-forwards a branch that is not checked out', async () => {
    const r = makeFixture('with-remote')
    r.git('branch', 'stale', 'HEAD~2')
    const repo = await Repo.open(r.dir, {})
    const id = await repo.setUpstream('stale', 'refs/remotes/origin/main')
    expect(r.git('rev-parse', '--abbrev-ref', 'stale@{upstream}').trim()).toBe('origin/main')
    const before = r.git('rev-parse', 'stale').trim()
    const ff = await repo.fastForward('stale')
    expect(r.git('rev-parse', 'stale').trim()).toBe(r.git('rev-parse', 'origin/main').trim())
    await repo.undo(ff)
    expect(r.git('rev-parse', 'stale').trim()).toBe(before)
    await repo.undo(id)
    expect(() => r.git('rev-parse', '--abbrev-ref', 'stale@{upstream}')).toThrow()
    // The checked-out branch pulls instead; a diverged branch cannot fast-forward.
    await expect(repo.fastForward('main')).rejects.toThrow('pull it instead')
    repo.dispose()
  })

  it('lists merged branches and deletes several in one undoable step', async () => {
    const r = makeFixture('branches')
    r.git('branch', 'old-1', 'HEAD~1')
    r.git('branch', 'old-2', 'HEAD~2')
    const repo = await Repo.open(r.dir, {})
    const merged = await repo.mergedBranches()
    expect(merged).toEqual(expect.arrayContaining(['feature', 'main', 'old-1', 'old-2']))
    expect(merged).not.toContain('wip')
    const id = await repo.deleteBranches(['feature', 'old-1', 'old-2'])
    expect(r.git('branch', '--format=%(refname:short)').trim().split('\n').sort()).toEqual(['main', 'wip'])
    await repo.undo(id)
    expect(r.git('branch', '--format=%(refname:short)').trim().split('\n').sort()).toEqual(['feature', 'main', 'old-1', 'old-2', 'wip'])
    repo.dispose()
  })
})
