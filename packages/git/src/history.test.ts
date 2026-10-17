import { initRepo } from '@gitsquid/fixtures'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

/** root - A - B - C - D (main), each commit adding its own file. */
function setup() {
  const r = initRepo()
  r.commit('root', { 'root.txt': 'root\n' })
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((n) => r.commit(n, { [`${n}.txt`]: `${n}\n` }))
  return { r, A: A!, B: B!, C: C!, D: D! }
}
const subjects = (r: ReturnType<typeof setup>['r']) => r.git('log', '--format=%s').trim().split('\n')

describe('editing history', () => {
  it('drops commits, keeping uncommitted work, and undoes', async () => {
    const { r, B, D } = setup()
    writeFileSync(join(r.dir, 'root.txt'), 'dirty\n')
    const repo = await Repo.open(r.dir, {})
    const id = await repo.dropCommits([B])
    expect(subjects(r)).toEqual(['D', 'C', 'A', 'root'])
    expect(readFileSync(join(r.dir, 'root.txt'), 'utf8')).toBe('dirty\n')
    await repo.undo(id!)
    expect(r.head()).toBe(D)
    // Dropping the newest commit (nothing to replay after it).
    await repo.dropCommits([D])
    expect(subjects(r)).toEqual(['C', 'B', 'A', 'root'])
    repo.dispose()
  })

  it('moves one or several commits above or below another', async () => {
    const { r, B, D } = setup()
    const repo = await Repo.open(r.dir, {})
    await repo.moveCommits([D], B, 'below')
    expect(subjects(r)).toEqual(['C', 'B', 'D', 'A', 'root'])
    const [c, b, d, a] = r.git('log', '--format=%H', '-4').trim().split('\n')
    // Several at once keep their relative order: B and D (older first) above C.
    await repo.moveCommits([b!, d!], c!, 'above')
    expect(subjects(r)).toEqual(['B', 'D', 'C', 'A', 'root'])
    // Moving a commit onto itself changes nothing.
    expect(await repo.moveCommits([a!], a!, 'above')).toBeNull()
    repo.dispose()
  })

  it('stops on a conflict like any rebase, and refuses what it cannot edit', async () => {
    const r = initRepo()
    r.commit('root', { 'f.txt': '1\n' })
    const X = r.commit('X', { 'f.txt': '2\n' })
    const Y = r.commit('Y', { 'f.txt': '3\n' })
    const repo = await Repo.open(r.dir, {})
    // Y changes the line X wrote: swapping them conflicts.
    await expect(repo.moveCommits([Y], X, 'below')).rejects.toThrow()
    expect(repo.operation()).toBe('rebase')
    await repo.abortOperation()
    expect(r.head()).toBe(Y)
    // The root commit and anything before a merge are out of reach.
    const root = r.git('rev-list', '--max-parents=0', 'HEAD').trim()
    await expect(repo.dropCommits([root])).rejects.toThrow('after its last merge')
    expect(await repo.editableCommits()).toEqual([Y, X])
    repo.dispose()
  })
})
