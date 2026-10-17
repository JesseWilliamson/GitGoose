import { initRepo, makeFixture, type FixtureRepo } from '@gitsquid/fixtures'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

const open = (r: FixtureRepo, dir = r.dir) => Repo.open(dir, { env: r.env() as Record<string, string> })
const read = (r: FixtureRepo, p: string) => readFileSync(join(r.dir, p), 'utf8')

describe('repro', () => {
  it('R1 discard of a glob-like path also discards other files', async () => {
    const r = initRepo()
    r.commit('base', { 'a[1].txt': 'x\n', 'a1.txt': 'y\n' })
    r.write('a[1].txt', 'x changed\n').write('a1.txt', 'y precious edit\n')
    const repo = await open(r)
    await repo.discardPaths(['a[1].txt'])
    const a1 = read(r, 'a1.txt')
    await repo.undo()
    console.log('R1 a1.txt after discard:', JSON.stringify(a1), ' after undo:', JSON.stringify(read(r, 'a1.txt')))
  })

  it('R2 discard+undo with autocrlf loses CRLF', async () => {
    const r = initRepo()
    r.git('config', 'core.autocrlf', 'true')
    r.commit('base', { 'f.txt': 'a\r\nb\r\n' })
    r.write('f.txt', 'mine\r\nedited\r\n')
    const repo = await open(r)
    await repo.discardPaths(['f.txt'])
    await repo.undo()
    console.log('R2 after undo:', JSON.stringify(read(r, 'f.txt')), 'expected', JSON.stringify('mine\r\nedited\r\n'))
  })

  it('R3 undo of mixed reset leaves reversal staged', async () => {
    const r = makeFixture('linear')
    const repo = await open(r)
    await repo.reset(r.git('rev-parse', 'HEAD~2').trim(), 'mixed')
    await repo.undo()
    console.log('R3 staged after undo:', JSON.stringify(r.git('diff', '--cached', '--stat')))
  })

  it('R4 log on an orphan (unborn) branch hides all other branches', async () => {
    const r = makeFixture('linear')
    r.git('checkout', '-q', '--orphan', 'fresh')
    const repo = await open(r)
    const page = await repo.logPage(0, 100)
    console.log('R4 commits:', page.commits.length, 'branches exist:', r.git('branch', '--list').trim())
  })

  it('R5 unstage some lines of a newly added file', async () => {
    const r = makeFixture('linear')
    r.write('new.txt', 'one\ntwo\nthree\n')
    r.git('add', 'new.txt')
    const repo = await open(r)
    try {
      await repo.applySelection({ target: { kind: 'staged', path: 'new.txt' }, action: 'unstage', hunks: [{ hunk: 0, lines: [0] }] })
      console.log('R5 ok, index now:', JSON.stringify(r.git('show', ':new.txt')))
    } catch (e) { console.log('R5 error:', (e as Error).message) }
  })

  it('R6 stage only the added line when last line lacks newline', async () => {
    const r = initRepo()
    r.commit('base', { 'f.txt': 'a\nb' })
    r.write('f.txt', 'a\nc')
    const repo = await open(r)
    const diff = (await repo.diff({ kind: 'unstaged', path: 'f.txt' }))!
    const plus = diff.hunks[0]!.lines.findIndex((l) => l.kind === '+')
    try {
      await repo.applySelection({ target: { kind: 'unstaged', path: 'f.txt' }, action: 'stage', hunks: [{ hunk: 0, lines: [plus] }] })
      console.log('R6 ok, index now:', JSON.stringify(r.git('show', ':f.txt')))
    } catch (e) { console.log('R6 error:', (e as Error).message, (e as any).stderr) }
    r.git('reset', '-q')
    const minus = diff.hunks[0]!.lines.findIndex((l) => l.kind === '-')
    try {
      await repo.applySelection({ target: { kind: 'unstaged', path: 'f.txt' }, action: 'discard', hunks: [{ hunk: 0, lines: [minus] }] })
      console.log('R6b ok, worktree now:', JSON.stringify(read(r, 'f.txt')))
    } catch (e) { console.log('R6b error:', (e as Error).message, (e as any).stderr) }
  })

  it('R7 unstage a staged rename', async () => {
    const r = makeFixture('renames')
    r.git('mv', 'new name.txt', 'third name.txt')
    const repo = await open(r)
    await repo.unstagePaths(['third name.txt'])
    console.log('R7 status after unstage:', JSON.stringify(r.git('status', '--porcelain')))
  })

  it('R8 checkout a branch named like a directory', async () => {
    const r = initRepo()
    r.commit('base', { 'docs/a.txt': 'a\n' })
    r.git('branch', 'docs')
    r.commit('two', { 'x.txt': 'x\n' })
    const repo = await open(r)
    try { await repo.checkout('refs/heads/docs'); console.log('R8 ok', r.git('branch', '--show-current')) } catch (e) { console.log('R8 error:', (e as Error).message) }
  })

  it('R9 reset --hard while a merge has conflicts', async () => {
    const r = makeFixture('conflict')
    r.tryGit('merge', 'other')
    const repo = await open(r)
    try { await repo.reset(r.head(), 'hard'); console.log('R9 ok', r.git('status', '--porcelain')) } catch (e) { console.log('R9 error:', (e as Error).message) }
  })

  it('R10 open from subdirectory of a linked worktree', async () => {
    const r = initRepo()
    r.commit('base', { 'sub/a.txt': 'a\n' })
    const wt = r.dir + '-wt'
    r.git('worktree', 'add', '-q', wt, '-b', 'wtb')
    const repo = await open(r, join(wt, 'sub'))
    console.log('R10', repo.path, repo.gitDir, repo.commonDir, 'hasCommitGraph', repo.hasCommitGraph())
    const repo2 = await open(r, join(r.dir, 'sub'))
    console.log('R10 main', repo2.path, repo2.gitDir, repo2.commonDir)
  })
})
