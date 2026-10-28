import { initRepo } from '@gitgoose/fixtures'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

describe('diffStream: every file of a target from one git diff', () => {
  it('a commit: its files with numbers and diffs, renames paired, binary files listed', async () => {
    const r = initRepo()
    r.commit('A', { 'a.txt': 'one\ntwo\n', 'old name.txt': 'same\ncontent\nhere\n' })
    r.git('mv', 'old name.txt', 'new name.txt')
    writeFileSync(join(r.dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
    r.git('add', 'bin.dat')
    const B = r.commit('B', { 'a.txt': 'one\nTWO\n', 'é 日本.md': '# 見出し\n' })
    const repo = await Repo.open(r.dir, {})
    const files = await repo.diffStream({ kind: 'commit', hash: B })
    const by = new Map(files.map((f) => [f.path, f]))
    expect([...by.keys()].sort()).toEqual(['a.txt', 'bin.dat', 'new name.txt', 'é 日本.md'])
    expect(by.get('a.txt')!.diff!.hunks[0]!.lines.map((l) => `${l.kind}${l.text}`)).toEqual([' one', '-two', '+TWO'])
    expect(by.get('new name.txt')).toMatchObject({ change: 'renamed', oldPath: 'old name.txt' })
    expect(by.get('new name.txt')!.diff).toMatchObject({ path: 'new name.txt', oldPath: 'old name.txt', hunks: [] })
    expect(by.get('é 日本.md')!.diff!.hunks[0]!.lines[0]).toMatchObject({ kind: '+', text: '# 見出し' })
    expect(by.get('bin.dat')).toMatchObject({ binary: true })
    expect(by.get('bin.dat')!.diff).toBeUndefined()
    repo.dispose()
  })

  it('stops fetching diffs at the line budget; the rest come back as numbers', async () => {
    const r = initRepo()
    r.commit('A', { 'x.txt': 'x\n' })
    const big = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const B = r.commit('B', { 'a.txt': big, 'b.txt': big, 'c.txt': big })
    const repo = await Repo.open(r.dir, {})
    const files = await repo.diffStream({ kind: 'commit', hash: B }, { maxLines: 60 })
    expect(files.map((f) => [f.path, f.additions, !!f.diff])).toEqual([['a.txt', 50, true], ['b.txt', 50, true], ['c.txt', 50, false]])
    // A later page asks for the rest by path.
    const rest = await repo.diffStream({ kind: 'commit', hash: B }, { paths: ['c.txt'] })
    expect(rest.map((f) => [f.path, !!f.diff])).toEqual([['c.txt', true]])
    repo.dispose()
  })

  it('the working copy: unstaged with untracked files, and staged', async () => {
    const r = initRepo()
    r.commit('A', { 'a.txt': 'one\n', 'b.txt': 'b\n' })
    writeFileSync(join(r.dir, 'a.txt'), 'one\nmore\n')
    writeFileSync(join(r.dir, 'b.txt'), 'B\n')
    r.git('add', 'b.txt')
    writeFileSync(join(r.dir, 'new.ts'), 'export {}\n')
    const repo = await Repo.open(r.dir, {})
    const unstaged = await repo.diffStream({ kind: 'unstaged' })
    expect(unstaged.map((f) => [f.path, f.untracked ?? false, f.additions])).toEqual([['a.txt', false, 1], ['new.ts', true, 1]])
    expect(unstaged[1]!.diff!.hunks[0]!.lines[0]!.text).toBe('export {}')
    const staged = await repo.diffStream({ kind: 'staged' })
    expect(staged.map((f) => f.path)).toEqual(['b.txt'])
    expect(staged[0]!.diff!.hunks[0]!.lines.map((l) => `${l.kind}${l.text}`)).toEqual(['-b', '+B'])
    repo.dispose()
  })
})
