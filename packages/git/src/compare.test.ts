import { initRepo } from '@gitsquid/fixtures'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

function setup() {
  const r = initRepo()
  const A = r.commit('A', { 'a.txt': 'one\ntwo\n', 'gone.txt': 'bye\n' })
  r.git('rm', '-q', 'gone.txt')
  const B = r.commit('B', { 'a.txt': 'one\nTWO\n', 'b.txt': 'b\n' })
  return { r, A, B }
}

describe('comparing and files at a revision', () => {
  it('lists the files that differ between revisions, and against the working tree', async () => {
    const { r, A, B } = setup()
    const repo = await Repo.open(r.dir, {})
    const files = await repo.compareFiles(A, B)
    expect(files.map((f) => `${f.change} ${f.path}`).sort()).toEqual(['added b.txt', 'deleted gone.txt', 'modified a.txt'])
    writeFileSync(join(r.dir, 'b.txt'), 'b changed\n')
    expect((await repo.compareFiles(B, null)).map((f) => f.path)).toEqual(['b.txt'])
    const diff = await repo.diff({ kind: 'range', from: A, to: B, path: 'a.txt' })
    expect(diff!.hunks[0]!.lines.map((l) => `${l.kind}${l.text}`)).toEqual([' one', '-two', '+TWO'])
    expect(await repo.mergeBase(A, B)).toBe(A)
    repo.dispose()
  })

  it('reads a file at a revision, and restores the working copy to it, undoably', async () => {
    const { r, A } = setup()
    const repo = await Repo.open(r.dir, {})
    expect((await repo.fileAt(A, 'a.txt')).toString()).toBe('one\ntwo\n')
    writeFileSync(join(r.dir, 'a.txt'), 'local edit\n')
    const id = await repo.restoreFile('a.txt', A)
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    await repo.undo(id)
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('local edit\n')
    // A file that did not exist at that revision is removed (and comes back on undo).
    const id2 = await repo.restoreFile('b.txt', A)
    expect(() => readFileSync(join(r.dir, 'b.txt'))).toThrow()
    await repo.undo(id2)
    expect(readFileSync(join(r.dir, 'b.txt'), 'utf8')).toBe('b\n')
    repo.dispose()
  })
})
