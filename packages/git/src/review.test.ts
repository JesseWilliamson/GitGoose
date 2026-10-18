/**
 * Regression tests for bugs found by the code review (one per finding, numbered as in the review).
 * Each reproduces the original failure against real git.
 */
import { initRepo, makeFixture, tempDir, type FixtureRepo } from '@gitsquid/fixtures'
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

const open = (r: FixtureRepo) => Repo.open(r.dir, { env: r.env() as Record<string, string> })
const read = (r: FixtureRepo, p: string) => readFileSync(join(r.dir, p), 'utf8')
const staged = (r: FixtureRepo, p: string) => r.git('show', `:${p}`)

describe('review findings', () => {
  it('#1 stages and discards lines next to a missing final newline without joining lines', async () => {
    const r = initRepo()
    r.commit('base', { 'f.txt': 'a\nb' })
    r.write('f.txt', 'a\nc')
    const repo = await open(r)
    let diff = (await repo.diff({ kind: 'unstaged', path: 'f.txt' }))!
    const plus = diff.hunks[0]!.lines.findIndex((l) => l.kind === '+')
    await repo.applySelection({ target: { kind: 'unstaged', path: 'f.txt' }, action: 'stage', hunks: [{ hunk: 0, lines: [plus] }] })
    expect(staged(r, 'f.txt')).toBe('a\nb\nc')

    const r2 = initRepo()
    r2.commit('base', { 'f.txt': 'a\nb' })
    r2.write('f.txt', 'a\nc')
    const repo2 = await open(r2)
    diff = (await repo2.diff({ kind: 'unstaged', path: 'f.txt' }))!
    const minus = diff.hunks[0]!.lines.findIndex((l) => l.kind === '-')
    await repo2.applySelection({ target: { kind: 'unstaged', path: 'f.txt' }, action: 'discard', hunks: [{ hunk: 0, lines: [minus] }] })
    expect(read(r2, 'f.txt')).toBe('a\nb\nc')
  })

  it('#2 treats file names literally, never as glob patterns', async () => {
    const r = initRepo()
    // Windows does not allow * in a file name, so there only the [] case can be tested.
    const star = process.platform !== 'win32'
    r.commit('base', { 'a[1].txt': 'one\n', 'a1.txt': 'two\n', ...(star ? { '*.md': 'star\n' } : {}), 'x.md': 'x\n' })
    r.write('a[1].txt', 'changed\n').write('a1.txt', 'changed too\n').write('x.md', 'changed\n')
    if (star) r.write('*.md', 'changed\n')
    const repo = await open(r)
    await repo.discardPaths(['a[1].txt', ...(star ? ['*.md'] : [])])
    expect(read(r, 'a1.txt')).toBe('changed too\n')
    expect(read(r, 'x.md')).toBe('changed\n')
    expect(read(r, 'a[1].txt')).toBe('one\n')
    await repo.stagePaths(['a[1].txt'])
    if (star) await repo.stagePaths(['*.md'])
    expect(r.git('diff', '--cached', '--name-only').trim()).toBe('')
    // Path search still uses glob matching on purpose.
    expect((await repo.search('path', '.md')).length).toBeGreaterThan(0)
  })

  it('#3 restores discarded files byte for byte, even with autocrlf', async () => {
    const r = initRepo()
    r.git('config', 'core.autocrlf', 'true')
    r.commit('base', { 'w.txt': 'mine\r\n' })
    r.write('w.txt', 'mine\r\nedited\r\n')
    const repo = await open(r)
    await repo.discardPaths(['w.txt'])
    await repo.undo()
    expect(read(r, 'w.txt')).toBe('mine\r\nedited\r\n')
  })

  it('#4 undoing a mixed reset restores the index, leaving nothing extra staged', async () => {
    const r = makeFixture('linear')
    const repo = await open(r)
    const before = r.head()
    await repo.reset(r.git('rev-parse', 'HEAD~2').trim(), 'mixed')
    await repo.undo()
    expect(r.head()).toBe(before)
    expect(r.git('diff', '--cached', '--stat').trim()).toBe('')
    expect(r.git('status', '--porcelain').trim()).toBe('')
  })

  it('#5 undoing a stash pops that stash even after other stash operations moved it', async () => {
    const r = makeFixture('linear')
    r.write('file.txt', 'OLD\n')
    r.git('stash', 'push', '-q', '-m', 'old')
    const repo = await open(r)
    r.write('file.txt', 'NEW\n')
    await repo.stashPush({ message: 'new' })
    await repo.stashDrop(1) // drop "old"
    await repo.undo() // brings "old" back, on top
    await repo.undo() // undo the stash push: must pop "new", not whatever is on top
    expect(read(r, 'file.txt')).toBe('NEW\n')
    expect((await repo.stashList()).map((s) => s.message)).toEqual(['On main: old'])
  })

  it('#6 returns no undo id when nothing changed, and refuses to undo a stale id', async () => {
    const r = makeFixture('branches')
    const repo = await open(r)
    r.write('e.txt', 'mine\n')
    await repo.stagePaths(['e.txt'])
    const commitId = await repo.commit('my commit')
    expect(await repo.merge('refs/heads/feature')).toBeNull() // already merged
    const tagId = await repo.createTag('t', r.head())
    await expect(repo.undo(commitId)).rejects.toThrow(/Something else happened since/)
    expect(await repo.undo(tagId)).toBe('Create tag t')
    expect(await repo.undo(commitId)).toBe('Commit "my commit"')
  })

  it('#7 shows other branches in the graph while on an orphan branch', async () => {
    const r = makeFixture('linear')
    r.git('checkout', '-q', '--orphan', 'fresh')
    const repo = await open(r)
    expect((await repo.logPage(0, 100)).commits).toHaveLength(5)
    expect(await repo.search('message', 'Commit 3')).toHaveLength(1)
  })

  it('#8 unstages some lines of a newly added file, and stages some lines of a deletion', async () => {
    const r = makeFixture('linear')
    r.write('new.txt', 'one\ntwo\nthree\n')
    r.git('add', 'new.txt')
    const repo = await open(r)
    await repo.snapshot()
    await repo.applySelection({ target: { kind: 'staged', path: 'new.txt' }, action: 'unstage', hunks: [{ hunk: 0, lines: [0] }] })
    expect(staged(r, 'new.txt')).toBe('two\nthree\n')

    const d = initRepo()
    d.commit('base', { 'gone.txt': 'one\ntwo\nthree\n' })
    rmSync(join(d.dir, 'gone.txt')) // deleted in the working tree: a "deleted file" diff
    const repoD = await open(d)
    await repoD.applySelection({ target: { kind: 'unstaged', path: 'gone.txt' }, action: 'stage', hunks: [{ hunk: 0, lines: [1] }] })
    expect(staged(d, 'gone.txt')).toBe('one\nthree\n')
  })

  it('#9 unstaging lines of a staged rename keeps the rename', async () => {
    const r = makeFixture('renames')
    r.git('mv', 'new name.txt', 'moved.txt')
    writeFileSync(join(r.dir, 'moved.txt'), read(r, 'moved.txt') + 'extra 1\nextra 2\n')
    r.git('add', '-A')
    const repo = await open(r)
    await repo.snapshot()
    const diff = (await repo.diff({ kind: 'staged', path: 'moved.txt' }))!
    const plus = diff.hunks[0]!.lines.findIndex((l) => l.text === 'extra 1')
    await repo.applySelection({ target: { kind: 'staged', path: 'moved.txt' }, action: 'unstage', hunks: [{ hunk: 0, lines: [plus] }] })
    const status = r.git('status', '--porcelain').trim().split('\n').sort()
    expect(status).toEqual(['RM "new name.txt" -> moved.txt'])
    expect(staged(r, 'moved.txt')).toContain('extra 2')
    expect(staged(r, 'moved.txt')).not.toContain('extra 1')
  })

  it('#10 unstaging a renamed file unstages both halves of the rename', async () => {
    const r = makeFixture('renames')
    r.git('mv', 'new name.txt', 'third name.txt')
    const repo = await open(r)
    await repo.unstagePaths(['third name.txt'])
    expect(r.git('diff', '--cached', '--name-only').trim()).toBe('')
  })

  it('#11 hard-resets during a conflicted merge, and undo brings the files back', async () => {
    const r = makeFixture('conflict')
    const repo = await open(r)
    await expect(repo.merge('refs/heads/other')).rejects.toThrow()
    const conflicted = read(r, 'story.txt')
    await repo.reset(r.head(), 'hard')
    expect((await repo.snapshot()).operation).toBeNull()
    expect(read(r, 'story.txt')).toBe('one\nTwo (ours)\nthree\n')
    await repo.undo()
    expect(read(r, 'story.txt')).toBe(conflicted)
  })

  // A git wrapper that delays the first `status` call by a second makes the race deterministic:
  // the first snapshot reads status before a commit but finishes after a second snapshot.
  it.skipIf(process.platform === 'win32')('#12 overlapping snapshots never leave an older result in place', async () => {
    const r = makeFixture('linear')
    const dir = tempDir('gitsquid-slowgit-')
    const wrapper = join(dir, 'git')
    writeFileSync(wrapper, `#!/bin/sh
case "$*" in
  *" status "*)
    if [ ! -e "${dir}/slowed" ]; then
      touch "${dir}/slowed"
      out=$(git "$@"); code=$?
      sleep 1
      printf '%s' "$out"
      exit $code
    fi ;;
esac
exec git "$@"
`)
    chmodSync(wrapper, 0o755)
    const repo = await Repo.open(r.dir, { env: r.env() as Record<string, string>, gitPath: wrapper })
    const first = repo.snapshot() // reads status now, returns in a second
    await new Promise((res) => setTimeout(res, 200))
    r.commit('made while the first snapshot ran')
    const second = repo.snapshot()
    const [a, b] = await Promise.all([first, second])
    expect(b.head.hash).toBe(r.head())
    expect(repo.lastSnapshot!.head.hash).toBe(r.head())
    expect(b.refsVersion).toBeGreaterThan(a.refsVersion)
  })

  it('#13 undo refuses to delete a branch that gained commits elsewhere', async () => {
    const r = makeFixture('linear')
    const repo = await open(r)
    await repo.createBranch('topic')
    r.git('checkout', '-q', 'topic')
    r.commit('work on topic')
    r.git('checkout', '-q', 'main')
    await expect(repo.undo()).rejects.toThrow()
    expect(r.git('log', '-1', '--format=%s', 'topic').trim()).toBe('work on topic')
  })
})

