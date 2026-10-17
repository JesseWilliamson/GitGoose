import { initRepo, makeFixture, type FixtureRepo } from '@gitsquid/fixtures'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { Repo } from './repo'

const open = (r: FixtureRepo) => Repo.open(r.dir, { env: r.env() as Record<string, string> })
const read = (r: FixtureRepo, p: string) => readFileSync(join(r.dir, p), 'utf8')

describe('repro2', () => {
  it('S1 undo stash push after undoing a drop pops the wrong stash', async () => {
    const r = initRepo()
    r.commit('base', { 'x.txt': 'base\n', 'y.txt': 'base\n' })
    r.write('y.txt', 'OLD stash content\n'); r.git('stash', 'push', '-q', '-m', 'old')
    const repo = await open(r)
    r.write('x.txt', 'NEW work\n')
    await repo.stashPush({ message: 'new' })
    await repo.stashDrop(1) // drop "old"
    await repo.undo() // restore old -> lands at stash@{0}
    await repo.undo() // undo "Stash changes": should bring back NEW work
    console.log('S1 x.txt:', JSON.stringify(read(r, 'x.txt')), 'y.txt:', JSON.stringify(read(r, 'y.txt')), 'stashes:', JSON.stringify(r.git('stash', 'list')))
  })

  it('S2 undo create-branch deletes commits added to it since', async () => {
    const r = makeFixture('linear')
    const repo = await open(r)
    await repo.createBranch('topic')
    // elsewhere (terminal / other worktree) someone commits onto topic without moving HEAD
    const tree = r.git('rev-parse', 'HEAD^{tree}').trim()
    const c = r.git('commit-tree', tree, '-p', 'topic', '-m', 'work on topic').trim()
    r.git('update-ref', 'refs/heads/topic', c)
    await repo.undo()
    console.log('S2 topic after undo:', JSON.stringify(r.git('branch', '--list', 'topic')), 'lost commit', c.slice(0, 7))
  })

  it('S3 unstage one line of a staged rename+modify', async () => {
    const r = makeFixture('renames')
    r.git('mv', 'new name.txt', 'moved.txt')
    const body = read(r, 'moved.txt')
    r.write('moved.txt', body + 'extra 1\nextra 2\n'); r.git('add', '-A')
    const repo = await open(r)
    await repo.snapshot()
    const diff = (await repo.diff({ kind: 'staged', path: 'moved.txt' }))!
    console.log('S3 header', JSON.stringify(diff.header))
    const idx = diff.hunks[0]!.lines.findIndex((l) => l.text === 'extra 2')
    try {
      await repo.applySelection({ target: { kind: 'staged', path: 'moved.txt' }, action: 'unstage', hunks: [{ hunk: 0, lines: [idx] }] })
    } catch (e) { console.log('S3 error', (e as Error).message) }
    console.log('S3 status after:', JSON.stringify(r.git('status', '--porcelain')))
  })
})
