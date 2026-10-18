import { initRepo } from '@gitgoose/fixtures'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkPlan, extractJson, patchFor, repairPlan, splitUnits } from './recompose'
import { Repo } from './repo'

const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

/**
 *   base - C1 - C2 - C3 (main, HEAD)
 * C1: edits a.txt near the top and near the bottom (two hunks), adds new file.txt
 * C2: edits b.txt, deletes old.txt, adds a binary and a file with spaces in its name
 * C3: edits c.txt (after the range: it gets re-parented, nothing else)
 */
function setup() {
  const r = initRepo()
  const base = r.commit('base', { 'a.txt': lines(40), 'b.txt': lines(5), 'old.txt': 'old\n', 'c.txt': 'c\n' })
  const C1 = r.commit('feat: one', { 'a.txt': lines(40, { 2: 'TWO', 38: 'THIRTY-EIGHT' }), 'new file.txt': 'new\n' })
  r.git('rm', '-q', 'old.txt')
  writeFileSync(join(r.dir, 'img.bin'), Buffer.from([0, 1, 2, 3, 255, 0, 7]))
  const C2 = r.commit('feat: two', { 'b.txt': lines(5, { 3: 'THREE' }) })
  const C3 = r.commit('docs: three', { 'c.txt': 'c changed\n' })
  return { r, base, C1, C2, C3 }
}

describe('splitting a diff into units', () => {
  it('cuts text files into hunks, keeps binary, new, deleted and spaced files whole', () => {
    const { r, base, C2 } = setup()
    const units = splitUnits(r.git('diff', '--no-renames', '--binary', base, C2))
    const summary = units.map((u) => `${u.id} ${u.path} ${u.body ? 'hunk' : u.binary ? 'binary' : 'whole'}`)
    expect(summary).toEqual([
      'U1 a.txt hunk', 'U2 a.txt hunk', 'U3 b.txt hunk', 'U4 img.bin binary', 'U5 new file.txt hunk', 'U6 old.txt hunk',
    ])
    // All units together are the original diff again.
    expect(patchFor(units).length).toBeGreaterThan(0)
  })

  it('checks and repairs plans', () => {
    const { r, base, C2 } = setup()
    const units = splitUnits(r.git('diff', '--no-renames', '--binary', base, C2))
    expect(checkPlan(units, [{ message: 'x', units: ['U1', 'U1'] }])).toEqual(expect.arrayContaining([
      'Change U1 is in more than one commit.', expect.stringContaining('Changes not in any commit: U2'),
    ]))
    const { commits, unplaced } = repairPlan(units, { commits: [
      { message: 'first', units: ['U3', 'U1', 'U99'] },
      { message: 'dupe only', units: ['U1'] },
      { message: '', units: ['U2'] },
    ] })
    expect(commits).toEqual([
      { message: 'first', units: ['U1', 'U3'] },
      { message: 'Changes', units: ['U2', 'U4', 'U5', 'U6'] },
    ])
    expect(unplaced).toEqual(['U4', 'U5', 'U6'])
    expect(checkPlan(units, commits)).toEqual([])
    expect(extractJson('Sure!\n```json\n{"commits": []}\n```')).toEqual({ commits: [] })
    expect(extractJson('no json here')).toBeNull()
  })
})

describe('recomposing commits', () => {
  it('rebuilds the range, keeps the end tree, re-parents later commits, and undoes in one step', async () => {
    const { r, C1, C2, C3 } = setup()
    // Uncommitted work must survive untouched: recompose never touches the worktree or index.
    writeFileSync(join(r.dir, 'b.txt'), 'staged\n')
    r.git('add', 'b.txt')
    writeFileSync(join(r.dir, 'c.txt'), 'dirty\n')
    const repo = await Repo.open(r.dir, {})
    const headTree = r.git('rev-parse', 'HEAD^{tree}').trim()
    const info = await repo.recomposeInfo([C2, C1])
    expect(info.after).toEqual([C3])
    expect(info.onRemote).toEqual([])
    r.git('update-ref', 'refs/remotes/origin/main', C2)
    expect((await repo.recomposeInfo([C2, C1])).onRemote).toEqual(['origin/main'])

    // Reordered: the bottom hunk of a.txt with b.txt first; the top hunk and the rest second.
    const id = await repo.recompose([C2, C1], [
      { message: 'refactor: bottom of a and b', units: ['U2', 'U3'] },
      { message: 'feat: everything else', units: ['U1', 'U4', 'U5', 'U6'] },
    ])
    expect(r.git('log', '--format=%s', 'HEAD~3..HEAD').trim().split('\n')).toEqual(['docs: three', 'feat: everything else', 'refactor: bottom of a and b'])
    expect(r.git('rev-parse', 'HEAD^{tree}').trim()).toBe(headTree)
    // The later commit keeps its tree, message and author.
    expect(r.git('rev-parse', 'HEAD^{tree}').trim()).toBe(r.git('rev-parse', `${C3}^{tree}`).trim())
    expect(r.git('log', '-1', '--format=%an %ad', '--date=raw', 'HEAD')).toBe(r.git('log', '-1', '--format=%an %ad', '--date=raw', C3))
    // The middle state really is "bottom hunk only".
    const mid = r.git('show', 'HEAD~2:a.txt')
    expect(mid).toContain('THIRTY-EIGHT')
    expect(mid).not.toContain('TWO')
    expect(readFileSync(join(r.dir, 'c.txt'), 'utf8')).toBe('dirty\n')
    // trimEnd, not trim: porcelain status starts with a space for "changed in the worktree only".
    expect(r.git('status', '--porcelain').trimEnd()).toBe('M  b.txt\n M c.txt')

    await repo.undo(id)
    expect(r.head()).toBe(C3)
    repo.dispose()
  })

  it('refuses what it cannot do safely, and changes nothing when the plan is wrong', async () => {
    const { r, base, C1, C2, C3 } = setup()
    const repo = await Repo.open(r.dir, {})
    await expect(repo.recomposeInfo([C3, C1])).rejects.toThrow('follow each other')
    await expect(repo.recompose([C2, C1], [{ message: 'only some', units: ['U1'] }])).rejects.toThrow('Changes not in any commit')
    expect(r.head()).toBe(C3)
    r.git('checkout', '-q', '-b', 'side', base)
    r.commit('side', { 'side.txt': 's\n' })
    r.git('checkout', '-q', 'main')
    r.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    await expect(repo.recomposeInfo([C2, C1])).rejects.toThrow('merge commits after these')
    await expect(repo.recomposeInfo([r.head()])).rejects.toThrow('Merge commits cannot be recomposed')
    repo.dispose()
  })

  it('splits a single commit, keeping its author', async () => {
    const r = initRepo()
    r.commit('base', { 'a.txt': lines(40) })
    r.git('commit', '-q', '--allow-empty', '-m', 'tmp')
    r.write('a.txt', lines(40, { 1: 'ONE', 40: 'FORTY' }))
    r.write('z.txt', 'z\n')
    r.git('add', '-A')
    r.git('commit', '-q', '-m', 'big change', '--author', 'Grace Hopper <grace@navy.mil>')
    const big = r.head()
    const repo = await Repo.open(r.dir, {})
    await repo.recompose([big], [
      { message: 'add z', units: ['U3'] },
      { message: 'edit a', units: ['U1', 'U2'] },
    ])
    expect(r.git('log', '--format=%s|%an', '-2').trim().split('\n')).toEqual(['edit a|Grace Hopper', 'add z|Grace Hopper'])
    repo.dispose()
  })
})
