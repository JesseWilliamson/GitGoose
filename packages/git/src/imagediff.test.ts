import { initRepo } from '@gitsquid/fixtures'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

const bytes = (...b: number[]) => Buffer.from([0x89, 0x50, 0x4e, 0x47, ...b])

describe('image diffs', () => {
  it('reads both sides of every kind of target; missing sides are null; big files only report their size', async () => {
    const r = initRepo()
    r.commit('root', { 'keep.txt': 'k\n' })
    writeFileSync(join(r.dir, 'logo.png'), bytes(1))
    r.git('add', 'logo.png')
    r.git('commit', '-q', '-m', 'add logo')
    const added = r.head()
    writeFileSync(join(r.dir, 'logo.png'), bytes(2))
    r.git('commit', '-q', '-am', 'change logo')
    const changed = r.head()
    writeFileSync(join(r.dir, 'logo.png'), bytes(3))
    r.git('add', 'logo.png')
    writeFileSync(join(r.dir, 'logo.png'), bytes(4))
    writeFileSync(join(r.dir, 'new.png'), bytes(5))
    const repo = await Repo.open(r.dir, {})
    const last = (s: { data?: Uint8Array } | null) => (s?.data ? s.data[s.data.length - 1] : null)

    let p = await repo.imagePair({ kind: 'commit', hash: added, path: 'logo.png' })
    expect([p.old, last(p.new)]).toEqual([null, 1])
    p = await repo.imagePair({ kind: 'commit', hash: changed, path: 'logo.png' })
    expect([last(p.old), last(p.new)]).toEqual([1, 2])
    p = await repo.imagePair({ kind: 'staged', path: 'logo.png' })
    expect([last(p.old), last(p.new)]).toEqual([2, 3])
    p = await repo.imagePair({ kind: 'unstaged', path: 'logo.png' })
    expect([last(p.old), last(p.new)]).toEqual([3, 4])
    p = await repo.imagePair({ kind: 'untracked', path: 'new.png' })
    expect([p.old, last(p.new)]).toEqual([null, 5])
    p = await repo.imagePair({ kind: 'range', from: added, to: null, path: 'logo.png' })
    expect([last(p.old), last(p.new)]).toEqual([1, 4])

    p = await repo.imagePair({ kind: 'commit', hash: changed, path: 'logo.png' }, 3)
    expect(p.new).toEqual({ size: 5 })
    repo.dispose()
  })
})
