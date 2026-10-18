import { initRepo } from '@gitgoose/fixtures'
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

describe('more history editing', () => {
  it('rewords any commit, including HEAD, with any text', async () => {
    const { r, B } = setup()
    const repo = await Repo.open(r.dir, {})
    await repo.rewordCommit(B, `B, reworded: it's "quoted" \`and\` $(not run)\n\nWith a body.`)
    expect(subjects(r)).toEqual(['D', 'C', `B, reworded: it's "quoted" \`and\` $(not run)`, 'A', 'root'])
    expect(r.git('log', '-1', '--format=%b', 'HEAD~2').trim()).toBe('With a body.')
    const id = await repo.rewordCommit(r.head(), 'D again')
    expect(subjects(r)[0]).toBe('D again')
    await repo.undo(id!)
    expect(subjects(r)[0]).toBe('D')
    repo.dispose()
  })

  it('squashes and fixes up into the commit below, and squashes several onto one', async () => {
    const { r, D } = setup()
    const repo = await Repo.open(r.dir, {})
    await repo.squashCommit(D, 'fixup')
    expect(subjects(r)).toEqual(['C', 'B', 'A', 'root'])
    expect(r.git('show', '--stat', '--format=', 'HEAD')).toContain('D.txt')
    await repo.squashCommit(r.head(), 'squash')
    expect(subjects(r)).toEqual(['B', 'A', 'root'])
    expect(r.git('log', '-1', '--format=%B')).toContain('C')
    // Folding into the root is out of reach.
    const [b, a] = r.git('log', '--format=%H', '-2').trim().split('\n')
    await repo.squashOnto([b!], a!)
    expect(subjects(r)).toEqual(['A', 'root'])
    repo.dispose()
  })

  it('fixes staged changes into an older commit; undo leaves them staged again', async () => {
    const { r, B, D } = setup()
    const repo = await Repo.open(r.dir, {})
    writeFileSync(join(r.dir, 'B.txt'), 'B fixed\n')
    r.git('add', 'B.txt')
    writeFileSync(join(r.dir, 'root.txt'), 'unstaged\n')
    const id = await repo.fixupInto(B)
    expect(subjects(r)).toEqual(['D', 'C', 'B', 'A', 'root'])
    expect(r.git('show', 'HEAD~2:B.txt')).toBe('B fixed\n')
    expect(readFileSync(join(r.dir, 'root.txt'), 'utf8')).toBe('unstaged\n')
    await repo.undo(id!)
    expect(r.head()).toBe(D)
    expect(r.git('diff', '--cached', '--name-only').trim()).toBe('B.txt')
    repo.dispose()
  })

  it('redoes what was undone, until something new happens', async () => {
    const { r, B, D } = setup()
    const repo = await Repo.open(r.dir, {})
    await repo.dropCommits([B])
    const dropped = r.head()
    await repo.undo()
    expect(r.head()).toBe(D)
    expect(repo.redoList().map((e) => e.label)).toEqual([`Drop ${B.slice(0, 7)}`])
    expect(await repo.redo()).toBe(`Drop ${B.slice(0, 7)}`)
    expect(r.head()).toBe(dropped)
    // And it can be undone again.
    await repo.undo()
    expect(r.head()).toBe(D)
    // A new operation clears redo.
    await repo.rewordCommit(D, 'D renamed')
    expect(repo.redoList()).toEqual([])
    expect(await repo.redo()).toBeNull()
    repo.dispose()
  })

  it('squash-merges with a prepared message, or stops before the merge commit', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'a\n' })
    r.git('checkout', '-q', '-b', 'topic')
    r.commit('topic work', { 't.txt': 't\n' })
    r.checkout('main')
    r.commit('main work', { 'm.txt': 'm\n' })
    const before = r.head()
    const repo = await Repo.open(r.dir, {})
    await repo.merge('refs/heads/topic', { squash: true })
    expect(r.head()).toBe(before)
    expect(r.git('diff', '--cached', '--name-only').trim()).toBe('t.txt')
    expect(await repo.preparedMessage()).toContain('topic work')
    r.git('reset', '-q', '--hard')
    await repo.merge('refs/heads/topic', { noCommit: true })
    expect(repo.operation()).toBe('merge')
    expect(r.head()).toBe(before)
    repo.dispose()
  })
})
