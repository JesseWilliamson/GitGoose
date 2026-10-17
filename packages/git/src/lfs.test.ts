import { FAKE_AVATAR_PNG, initRepo } from '@gitsquid/fixtures'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Repo } from './repo'

const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0
const saved = process.env.GIT_CONFIG_GLOBAL
beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = '/dev/null' })
afterAll(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = saved
})

describe.skipIf(!hasLfs)('Git LFS', () => {
  it('costs nothing in a repository without LFS', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'a\n' })
    const repo = await Repo.open(r.dir, {})
    const info = await repo.lfsInfo()
    expect(info).toMatchObject({ installed: true, used: false, patterns: [], files: [] })
    repo.dispose()
  })

  it('sets up, tracks a pattern (undoably), lists LFS files, and shows LFS images in image diffs', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'a\n' })
    const repo = await Repo.open(r.dir, {})
    await repo.lfsInstall()
    const id = await repo.lfsTrack('*.png', true)
    let info = await repo.lfsInfo()
    expect(info).toMatchObject({ used: true, ready: true, patterns: [{ pattern: '*.png', source: '.gitattributes', lockable: false }] })
    await repo.undo(id)
    expect((await repo.lfsInfo()).used).toBe(false)

    await repo.lfsTrack('*.png', true)
    writeFileSync(join(r.dir, 'logo.png'), FAKE_AVATAR_PNG)
    r.git('add', '.gitattributes', 'logo.png')
    r.git('commit', '-q', '-m', 'logo via lfs')
    info = await repo.lfsInfo()
    expect(info.files).toEqual([{ path: 'logo.png', size: FAKE_AVATAR_PNG.length, downloaded: true }])
    // The blob in git is a pointer; the image diff shows the real image from the local store.
    expect(r.git('show', 'HEAD:logo.png')).toContain('git-lfs.github.com/spec/v1')
    const pair = await repo.imagePair({ kind: 'commit', hash: r.head(), path: 'logo.png' })
    expect(Buffer.from(pair.new!.data!)).toEqual(FAKE_AVATAR_PNG)
    repo.dispose()
  })
})
