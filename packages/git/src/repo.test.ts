import { initRepo, makeFixture, makeLargeRepo, tempDir, type FixtureRepo } from '@gitgoose/fixtures'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AskpassServer, isSecretPrompt } from './askpass'
import { buildPatch } from './patch'
import { Repo, supportsAheadBehind } from './repo'
import { resolveBlocks } from '@gitgoose/shared'

const open = (r: FixtureRepo) => Repo.open(r.dir, { env: r.env() as Record<string, string> })
const read = (r: FixtureRepo, p: string) => readFileSync(join(r.dir, p), 'utf8')
const staged = (r: FixtureRepo, p: string) => r.git('show', `:${p}`)

/** A file with two separate changes, far enough apart to be two hunks. */
function twoHunks(): FixtureRepo {
  const r = initRepo()
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
  r.commit('base', { 'f.txt': lines.join('\n') + '\n' })
  const edited = [...lines]
  edited[1] = 'CHANGED 2'
  edited.splice(15, 0, 'ADDED after 15')
  r.write('f.txt', edited.join('\n') + '\n')
  return r
}

describe('snapshot and log', () => {
  it('reports head, refs, status and an operation in progress', async () => {
    const r = makeFixture('conflict')
    const repo = await open(r)
    let s = await repo.snapshot()
    expect(s.head).toMatchObject({ branch: 'main', detached: false })
    expect(s.refs.map((x) => x.shortName).sort()).toEqual(['main', 'other'])
    expect(s.operation).toBeNull()
    r.tryGit('merge', 'other')
    s = await repo.snapshot()
    expect(s.operation).toBe('merge')
  })

  it('bumps refsVersion only when refs or HEAD change', async () => {
    const r = makeFixture('linear')
    const repo = await open(r)
    const v1 = (await repo.snapshot()).refsVersion
    r.write('file.txt', 'dirty\n')
    expect((await repo.snapshot()).refsVersion).toBe(v1)
    r.commit('new')
    expect((await repo.snapshot()).refsVersion).toBe(v1 + 1)
  })

  it('pages a large log from one git process', async () => {
    const dir = makeLargeRepo(3000)
    const repo = await Repo.open(dir)
    const first = await repo.logPage(0, 500)
    expect(first.commits).toHaveLength(500)
    expect(first.done).toBe(false)
    const second = await repo.logPage(500, 500)
    expect(second.commits[0]!.hash).not.toBe(first.commits[0]!.hash)
    const all = await repo.logPage(0, 100_000)
    expect(all.done).toBe(true)
    // Main line plus side commits, all reachable.
    expect(all.commits.length).toBeGreaterThan(2900)
    expect(new Set(all.commits.map((c) => c.hash)).size).toBe(all.commits.length)
    repo.dispose()
  })

  it('returns an empty log for an unborn branch', async () => {
    const repo = await open(makeFixture('empty'))
    expect(await repo.logPage(0, 100)).toMatchObject({ commits: [], done: true })
  })

  it('gives commit details with changed files, including the root commit', async () => {
    const r = makeFixture('branches')
    const repo = await open(r)
    const root = r.git('rev-list', '--max-parents=0', 'HEAD').trim()
    const d = await repo.commitDetails(root)
    expect(d.subject).toBe('A')
    expect(d.files).toEqual([{ path: 'a.txt', change: 'added', additions: 1, deletions: 0, binary: false }])
    const merge = await repo.commitDetails(r.git('rev-parse', 'HEAD~1').trim())
    expect(merge.parents).toHaveLength(2)
    expect(merge.files.map((f) => f.path).sort()).toEqual(['c.txt', 'd.txt'])
  })

  it('lists commits in date or topological order, and a change of order restarts the walk', async () => {
    // Two branches whose commits alternate in time:
    //   main:  A - m1 - m2 - m3
    //           \
    //   side:    s1 - s2 - s3      (s1 before m1, s2 before m2, ...)
    const r = initRepo()
    r.commit('A', { 'a.txt': 'a\n' })
    r.checkout('-b', 'side')
    r.checkout('main')
    for (let i = 1; i <= 3; i++) {
      r.checkout('side')
      r.commit(`s${i}`, { [`s${i}.txt`]: 'x\n' })
      r.checkout('main')
      r.commit(`m${i}`, { [`m${i}.txt`]: 'x\n' })
    }
    const repo = await open(r)
    const subjects = async () => (await repo.logPage(0, 100)).commits.map((c) => c.subject)

    const before = await repo.snapshot()
    expect(before.order).toBe('date')
    // Date order: newest first, the two branches interleaved.
    expect(await subjects()).toEqual(['m3', 's3', 'm2', 's2', 'm1', 's1', 'A'])

    repo.setCommitOrder('topo')
    const after = await repo.snapshot()
    expect(after.order).toBe('topo')
    // A new walk: the renderer sees a new refsVersion and reloads the log.
    expect(after.refsVersion).toBeGreaterThan(before.refsVersion)
    const topo = await subjects()
    // Topological: each branch's commits together (which branch comes first is git's choice).
    expect(topo).not.toEqual(['m3', 's3', 'm2', 's2', 'm1', 's1', 'A'])
    expect([['m3', 'm2', 'm1', 's3', 's2', 's1', 'A'], ['s3', 's2', 's1', 'm3', 'm2', 'm1', 'A']]).toContainEqual(topo)

    // Setting the same order again is not a new walk.
    repo.setCommitOrder('topo')
    expect((await repo.snapshot()).refsVersion).toBe(after.refsVersion)
    repo.setCommitOrder('date')
    await repo.snapshot()
    expect(await subjects()).toEqual(['m3', 's3', 'm2', 's2', 'm1', 's1', 'A'])
    repo.dispose()
  })
})

describe('line staging (patch building)', () => {
  it('stages one hunk and leaves the other unstaged', async () => {
    const r = twoHunks()
    const repo = await open(r)
    const diff = (await repo.diff({ kind: 'unstaged', path: 'f.txt' }))!
    expect(diff.hunks).toHaveLength(2)
    await repo.applySelection({ target: { kind: 'unstaged', path: 'f.txt' }, action: 'stage', hunks: [{ hunk: 1 }] })
    expect(staged(r, 'f.txt')).toContain('ADDED after 15')
    expect(staged(r, 'f.txt')).toContain('line 2\n')
    expect(staged(r, 'f.txt')).not.toContain('CHANGED 2')
  })

  it('stages a single added line out of a replacement', async () => {
    const r = twoHunks()
    const repo = await open(r)
    const diff = (await repo.diff({ kind: 'unstaged', path: 'f.txt' }))!
    const h0 = diff.hunks[0]!
    const plus = h0.lines.findIndex((l) => l.kind === '+')
    // Select only the '+' of "line 2 -> CHANGED 2": the old line stays, the new one is added.
    await repo.applySelection({ target: { kind: 'unstaged', path: 'f.txt' }, action: 'stage', hunks: [{ hunk: 0, lines: [plus] }] })
    const s = staged(r, 'f.txt').split('\n')
    expect(s.slice(0, 3)).toEqual(['line 1', 'line 2', 'CHANGED 2'])
    expect(s).not.toContain('ADDED after 15')
  })

  it('stages a later hunk correctly when an earlier one changed the line count', async () => {
    const r = initRepo()
    const lines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`)
    r.commit('base', { 'f.txt': lines.join('\n') + '\n' })
    const e = [...lines]
    e.splice(2, 0, 'new A', 'new B', 'new C')
    e.splice(25, 1)
    r.write('f.txt', e.join('\n') + '\n')
    const repo = await open(r)
    const diff = (await repo.diff({ kind: 'unstaged', path: 'f.txt' }))!
    expect(diff.hunks).toHaveLength(2)
    // Both hunks, built and applied in one patch: header arithmetic must line up.
    const patch = buildPatch(diff, [{ hunk: 0 }, { hunk: 1 }], false)!
    expect(patch).toContain('@@ -1,5 +1,8 @@')
    await repo.applySelection({ target: { kind: 'unstaged', path: 'f.txt' }, action: 'stage', hunks: [{ hunk: 0 }, { hunk: 1 }] })
    expect(staged(r, 'f.txt')).toBe(read(r, 'f.txt'))
  })

  it('unstages selected lines', async () => {
    const r = twoHunks()
    r.git('add', 'f.txt')
    const repo = await open(r)
    await repo.snapshot()
    const diff = (await repo.diff({ kind: 'staged', path: 'f.txt' }))!
    const h1 = diff.hunks[1]!
    await repo.applySelection({ target: { kind: 'staged', path: 'f.txt' }, action: 'unstage', hunks: [{ hunk: 1, lines: [h1.lines.findIndex((l) => l.kind === '+')] }] })
    expect(staged(r, 'f.txt')).toContain('CHANGED 2')
    expect(staged(r, 'f.txt')).not.toContain('ADDED after 15')
    // The working tree is untouched.
    expect(read(r, 'f.txt')).toContain('ADDED after 15')
  })

  it('discards lines from the working tree, and undo brings them back', async () => {
    const r = twoHunks()
    const repo = await open(r)
    const before = read(r, 'f.txt')
    await repo.applySelection({ target: { kind: 'unstaged', path: 'f.txt' }, action: 'discard', hunks: [{ hunk: 0 }] })
    expect(read(r, 'f.txt')).not.toContain('CHANGED 2')
    expect(read(r, 'f.txt')).toContain('ADDED after 15')
    expect(await repo.undo()).toBe('Discard lines in f.txt')
    expect(read(r, 'f.txt')).toBe(before)
  })

  it('stages part of an untracked file via intent-to-add', async () => {
    const r = makeFixture('linear')
    r.write('new.txt', 'keep\nskip\n')
    const repo = await open(r)
    await repo.applySelection({ target: { kind: 'untracked', path: 'new.txt' }, action: 'stage', hunks: [{ hunk: 0, lines: [0] }] })
    expect(staged(r, 'new.txt')).toBe('keep\n')
  })

  it('handles files without a trailing newline', async () => {
    const r = initRepo()
    r.commit('base', { 'f.txt': 'a\nb' })
    r.write('f.txt', 'a\nb\nc')
    const repo = await open(r)
    await repo.applySelection({ target: { kind: 'unstaged', path: 'f.txt' }, action: 'stage', hunks: [{ hunk: 0 }] })
    expect(staged(r, 'f.txt')).toBe('a\nb\nc')
  })

  it('stages lines in CRLF files', async () => {
    const r = makeFixture('crlf')
    r.write('win.txt', 'one\r\nTWO\r\nthree\r\nfour\r\n')
    const repo = await open(r)
    const diff = (await repo.diff({ kind: 'unstaged', path: 'win.txt' }))!
    const four = diff.hunks[0]!.lines.findIndex((l) => l.text === 'four\r')
    await repo.applySelection({ target: { kind: 'unstaged', path: 'win.txt' }, action: 'stage', hunks: [{ hunk: 0, lines: [four] }] })
    expect(staged(r, 'win.txt')).toBe('one\r\ntwo\r\nthree\r\nfour\r\n')
  })
})

describe('whole-file operations', () => {
  it('stages, unstages and discards files; discard of untracked files is undoable', async () => {
    const r = makeFixture('linear')
    r.write('file.txt', 'edited\n')
    r.write('extra.txt', 'brand new\n')
    const repo = await open(r)
    await repo.stagePaths(['file.txt', 'extra.txt'])
    expect((await repo.snapshot()).status.map((e) => e.index + e.worktree).sort()).toEqual(['A.', 'M.'])
    await repo.unstagePaths(['file.txt', 'extra.txt'])
    expect((await repo.snapshot()).status.map((e) => e.kind).sort()).toEqual(['changed', 'untracked'])
    await repo.discardPaths(['file.txt', 'extra.txt'])
    expect((await repo.snapshot()).status).toEqual([])
    await repo.undo()
    expect(read(r, 'file.txt')).toBe('edited\n')
    expect(read(r, 'extra.txt')).toBe('brand new\n')
  })

  it('ignores untracked files, anchored and escaped, and undo restores .gitignore', async () => {
    const r = makeFixture('linear')
    r.write('.gitignore', 'node_modules')
    r.write('build/out.js', 'x')
    r.write('weird [1].txt', 'x')
    const repo = await open(r)
    await repo.ignorePaths(['build/out.js', 'weird [1].txt'])
    expect(read(r, '.gitignore')).toBe('node_modules\n/build/out.js\n/weird\\ \\[1\\].txt\n')
    const s = await repo.snapshot()
    expect(s.status.map((e) => e.path)).toEqual(['.gitignore'])
    await repo.undo()
    expect(read(r, '.gitignore')).toBe('node_modules')
  })

  it('unstages in a repository with no commits yet', async () => {
    const r = makeFixture('empty')
    r.write('a.txt', 'a\n')
    const repo = await open(r)
    await repo.stagePaths(['a.txt'])
    await repo.unstagePaths(['a.txt'])
    expect((await repo.snapshot()).status).toEqual([{ path: 'a.txt', index: '?', worktree: '?', kind: 'untracked' }])
  })
})

describe('commits and undo', () => {
  it('undoes a commit, keeping its changes staged', async () => {
    const r = makeFixture('linear')
    const repo = await open(r)
    const before = r.head()
    r.write('file.txt', 'new content\n')
    await repo.stagePaths(['file.txt'])
    await repo.commit('Save work\n\nWith a body')
    expect(await repo.lastCommitMessage()).toBe('Save work\n\nWith a body')
    expect(repo.undoList()[0]!.label).toBe('Commit "Save work"')
    await repo.undo()
    expect(r.head()).toBe(before)
    expect(staged(r, 'file.txt')).toBe('new content\n')
  })

  it('undoes the very first commit back to an unborn branch', async () => {
    const r = makeFixture('empty')
    r.write('a.txt', 'a\n')
    const repo = await open(r)
    await repo.stagePaths(['a.txt'])
    await repo.commit('first')
    await repo.undo()
    expect((await repo.snapshot()).head.hash).toBeUndefined()
    expect(staged(r, 'a.txt')).toBe('a\n')
  })

  it('undoes an amend', async () => {
    const r = makeFixture('linear')
    const repo = await open(r)
    const before = r.head()
    await repo.commit('Reworded', { amend: true })
    expect(r.git('log', '-1', '--format=%s').trim()).toBe('Reworded')
    await repo.undo()
    expect(r.head()).toBe(before)
  })

  it('refuses to undo when HEAD moved outside the app', async () => {
    const r = makeFixture('linear')
    const repo = await open(r)
    await repo.createBranch('x')
    r.commit('made in a terminal')
    await expect(repo.undo()).rejects.toThrow(/HEAD has moved/)
  })
})

describe('branches', () => {
  it('creates, checks out, renames and deletes branches, each undoable', async () => {
    const r = makeFixture('branches')
    const repo = await open(r)
    await repo.createBranch('topic', { at: 'feature', checkout: true })
    expect((await repo.snapshot()).head.branch).toBe('topic')
    await repo.undo()
    expect((await repo.snapshot()).head.branch).toBe('main')
    expect(r.git('branch', '--list', 'topic').trim()).toBe('')

    await repo.renameBranch('wip', 'later')
    expect(r.git('branch', '--list', 'later').trim()).toBe('later')
    await repo.undo()
    expect(r.git('branch', '--list', 'wip').trim()).toBe('wip')

    const wip = r.git('rev-parse', 'wip').trim()
    await repo.deleteBranch('wip', { force: true })
    await repo.undo()
    expect(r.git('rev-parse', 'wip').trim()).toBe(wip)

    await repo.checkout('refs/heads/feature')
    expect((await repo.snapshot()).head.branch).toBe('feature')
    await repo.undo()
    expect((await repo.snapshot()).head.branch).toBe('main')
  })

  it('checks out a remote branch as a local tracking branch', async () => {
    const r = makeFixture('with-remote')
    const repo = await open(r)
    r.git('push', '-q', 'origin', 'HEAD:refs/heads/remote-only')
    r.git('fetch', '-q')
    await repo.checkout('refs/remotes/origin/remote-only')
    const s = await repo.snapshot()
    expect(s.head.branch).toBe('remote-only')
    expect(s.refs.find((x) => x.shortName === 'remote-only')!.upstream).toBe('refs/remotes/origin/remote-only')
  })

  it('merges, and undo resets to before the merge', async () => {
    const r = makeFixture('branches')
    const repo = await open(r)
    const before = r.head()
    await repo.merge('refs/heads/wip', { noFf: true })
    expect(r.git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
    await repo.undo()
    expect(r.head()).toBe(before)
  })

  it('rebases, cherry-picks and reverts with undo', async () => {
    const r = makeFixture('branches')
    const repo = await open(r)
    await repo.checkout('refs/heads/wip')
    const wipBefore = r.head()
    await repo.rebase('refs/heads/main')
    expect(r.git('merge-base', '--is-ancestor', 'main', 'wip') === '').toBe(true)
    await repo.undo()
    expect(r.head()).toBe(wipBefore)
    await repo.undo() // back to main

    const f = r.git('rev-parse', 'wip').trim()
    const mainBefore = r.head()
    await repo.cherryPick(f)
    expect(existsSync(join(r.dir, 'f.txt'))).toBe(true)
    await repo.undo()
    expect(r.head()).toBe(mainBefore)

    await repo.revert(r.git('rev-parse', 'HEAD').trim())
    expect(existsSync(join(r.dir, 'e.txt'))).toBe(false)
    await repo.undo()
    expect(existsSync(join(r.dir, 'e.txt'))).toBe(true)
  })

  it('reverts and cherry-picks merge commits using the first parent', async () => {
    const r = makeFixture('branches')
    const repo = await open(r)
    await repo.revert(r.git('rev-parse', 'HEAD~1').trim())
    expect(existsSync(join(r.dir, 'c.txt'))).toBe(false)
  })

  it('undoes a hard reset including uncommitted changes', async () => {
    const r = makeFixture('linear')
    const repo = await open(r)
    const before = r.head()
    r.write('file.txt', 'uncommitted work\n')
    await repo.reset(r.git('rev-parse', 'HEAD~2').trim(), 'hard')
    expect(read(r, 'file.txt')).toBe('line 3\n'.repeat(3))
    await repo.undo()
    expect(r.head()).toBe(before)
    expect(read(r, 'file.txt')).toBe('uncommitted work\n')
  })

  it('creates and deletes tags with undo, keeping annotated tags intact', async () => {
    const r = makeFixture('tags')
    const repo = await open(r)
    const tagObj = r.git('rev-parse', 'refs/tags/v0.2').trim()
    await repo.deleteTag('v0.2')
    await repo.undo()
    expect(r.git('rev-parse', 'refs/tags/v0.2').trim()).toBe(tagObj)
    await repo.createTag('v1', r.head(), 'One')
    expect(r.git('cat-file', '-t', 'v1').trim()).toBe('tag')
    await repo.undo()
    expect(r.git('tag', '--list', 'v1').trim()).toBe('')
  })
})

describe('stash', () => {
  it('pushes, pops and drops with undo', async () => {
    const r = makeFixture('stash')
    const repo = await open(r)
    expect((await repo.stashList()).length).toBe(2)
    await repo.stashDrop(1)
    expect((await repo.stashList()).map((s) => s.message)).toEqual(['On main: second stash'])
    await repo.undo()
    // `git stash store` always pushes on top, so the restored entry comes back as stash@{0}.
    expect((await repo.stashList()).map((s) => s.message)).toEqual(['On main: first stash', 'On main: second stash'])

    await repo.stashPop(0)
    expect(read(r, 'x.txt')).toBe('changed once\n')
    await repo.undo()
    expect((await repo.stashList()).length).toBe(2)

    r.git('checkout', '--', 'x.txt')
    r.write('x.txt', 'third\n')
    r.write('untracked.txt', 'u\n')
    await repo.stashPush({ message: 'third', includeUntracked: true })
    expect((await repo.snapshot()).status).toEqual([])
    await repo.undo()
    expect(read(r, 'x.txt')).toBe('third\n')
    expect(read(r, 'untracked.txt')).toBe('u\n')
  })

  it('shows a stash as a commit, including untracked files saved with -u', async () => {
    const r = makeFixture('linear')
    r.write('file.txt', 'tracked change\n')
    r.write('new.txt', 'untracked\n')
    const repo = await open(r)
    await repo.stashPush({ includeUntracked: true })
    const [s] = await repo.stashList()
    const d = await repo.commitDetails(s!.hash, { stash: true })
    expect(d.files.map((f) => [f.path, f.change]).sort()).toEqual([['file.txt', 'modified'], ['new.txt', 'added']])
    const diff = await repo.diff({ kind: 'commit', hash: s!.hash, path: 'new.txt' })
    expect(diff!.hunks[0]!.lines).toEqual([{ kind: '+', text: 'untracked', newNo: 1 }])
    // Without the stash flag, a 3-parent commit lists only its first-parent changes.
    expect((await repo.commitDetails(s!.hash)).files.map((f) => f.path)).toEqual(['file.txt'])
  })

  it('does not record an undo entry when there was nothing to stash', async () => {
    const repo = await open(makeFixture('linear'))
    await repo.stashPush()
    expect(repo.undoList()).toEqual([])
  })
})

describe('conflicts', () => {
  it('lists conflicts, shows all three versions, resolves and continues', async () => {
    const r = makeFixture('conflict')
    const repo = await open(r)
    await expect(repo.merge('refs/heads/other')).rejects.toThrow()
    expect((await repo.snapshot()).operation).toBe('merge')
    expect(await repo.conflicts()).toEqual([{ path: 'story.txt', code: 'UU', blocks: 1 }])
    const v = await repo.conflictVersions('story.txt')
    expect(v.base).toBe('one\ntwo\nthree\n')
    expect(v.ours).toContain('Two (ours)')
    expect(v.theirs).toContain('TWO (theirs)')
    expect(v.merged).toContain('<<<<<<<')

    await repo.resolveConflict('story.txt', { content: resolveBlocks(v.merged!, ['both']) })
    expect(read(r, 'story.txt')).toBe('one\nTwo (ours)\nTWO (theirs)\nthree\n')
    await repo.continueOperation()
    const s = await repo.snapshot()
    expect(s.operation).toBeNull()
    expect(r.git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
  })

  it('resolves by taking a side, and aborts', async () => {
    const r = makeFixture('conflict')
    const repo = await open(r)
    await expect(repo.merge('refs/heads/other')).rejects.toThrow()
    await repo.resolveConflict('story.txt', 'theirs')
    expect(read(r, 'story.txt')).toContain('TWO (theirs)')
    await repo.abortOperation()
    expect((await repo.snapshot()).operation).toBeNull()
    expect(read(r, 'story.txt')).toContain('Two (ours)')
  })

  it('continues a rebase after resolving', async () => {
    const r = makeFixture('conflict')
    const repo = await open(r)
    await repo.checkout('refs/heads/other')
    await expect(repo.rebase('refs/heads/main')).rejects.toThrow()
    expect((await repo.snapshot()).operation).toBe('rebase')
    await repo.resolveConflict('story.txt', 'ours')
    await repo.continueOperation()
    expect((await repo.snapshot()).operation).toBeNull()
  })
})

describe('remotes', () => {
  it('pushes with upstream, fetches and pulls', async () => {
    const r = makeFixture('with-remote')
    const repo = await open(r)
    const progress: (string | null)[] = []
    const repoP = await Repo.open(r.dir, { env: r.env() as Record<string, string>, onProgress: (t) => progress.push(t) })
    await repoP.push()
    expect(r.git('rev-parse', 'origin/main').trim()).toBe(r.head())
    expect(progress.at(-1)).toBeNull()

    await repo.createBranch('topic', { checkout: true })
    await repo.push()
    const s = await repo.snapshot()
    expect(s.refs.find((x) => x.shortName === 'topic')!.upstream).toBe('refs/remotes/origin/topic')

    await repo.deleteRemoteBranch('refs/remotes/origin/topic')
    await repo.fetch({ prune: true })
    expect((await repo.snapshot()).refs.some((x) => x.shortName === 'origin/topic')).toBe(false)

    // Someone else pushes to main; we pull it.
    await repo.checkout('refs/heads/main')
    const other = initRepo()
    execFileSync('git', ['clone', '-q', r.git('remote', 'get-url', 'origin').trim(), other.dir + '/c'])
    const c = Object.assign(Object.create(Object.getPrototypeOf(other)), other, { dir: other.dir + '/c' }) as FixtureRepo
    c.git('config', 'user.name', 'B')
    c.git('config', 'user.email', 'b@x')
    c.commit('from elsewhere', { 'elsewhere.txt': 'hi\n' })
    c.git('push', '-q')
    await repo.pull()
    expect(existsSync(join(r.dir, 'elsewhere.txt'))).toBe(true)
  })

  it('reports a helpful error when there is no remote', async () => {
    const repo = await open(makeFixture('linear'))
    await expect(repo.push()).rejects.toThrow(/no remotes/)
  })
})

describe('init and clone', () => {
  it('initializes a new repository, creating the folder', async () => {
    const dir = join(tempDir(), 'brand new')
    const repo = await Repo.init(dir)
    // Git reports the folder resolved: symlinks followed (the macOS temp folder is one), and on
    // Windows short names like RUNNER~1 expanded. realpath.native does both.
    expect(repo.path).toBe(realpathSync.native(dir))
    const s = await repo.snapshot()
    expect(s.head.hash).toBeUndefined()
    expect(await repo.logPage(0, 10)).toMatchObject({ commits: [], done: true })
  })

  it('clones into a subfolder named after the URL, reporting progress', async () => {
    const src = makeFixture('linear')
    const progress: (string | null)[] = []
    const parent = tempDir()
    const repo = await Repo.clone(src.dir + '/', parent, { onProgress: (t) => progress.push(t) })
    expect(repo.path).toBe(join(realpathSync.native(parent), basename(src.dir)))
    expect((await repo.logPage(0, 10)).commits).toHaveLength(5)
    expect(progress.at(-1)).toBeNull()
  })
})

describe('commit-graph maintenance', () => {
  it('writes a commit-graph when missing, and respects core.commitGraph=false', async () => {
    const r = makeFixture('branches')
    const repo = await open(r)
    expect(repo.hasCommitGraph()).toBe(false)
    expect(await repo.maintainCommitGraph()).toBe(true)
    expect(repo.hasCommitGraph()).toBe(true)
    expect(await repo.maintainCommitGraph()).toBe(false)

    const off = makeFixture('linear')
    off.git('config', 'core.commitGraph', 'false')
    const repoOff = await open(off)
    expect(await repoOff.maintainCommitGraph()).toBe(false)
    expect(repoOff.hasCommitGraph()).toBe(false)
  })

  it('finds the shared objects directory from a linked worktree', async () => {
    const r = makeFixture('branches')
    const wt = r.dir + '-wt'
    r.git('worktree', 'add', '-q', wt, 'feature')
    const repo = await Repo.open(wt)
    expect(repo.path).toBe(realpathSync.native(wt))
    expect(realpathSync.native(repo.commonDir)).toBe(realpathSync.native(join(r.dir, '.git')))
    expect((await repo.snapshot()).head.branch).toBe('feature')
  })
})

describe('reading', () => {
  it('searches by message, author, path, content and hash', async () => {
    const r = makeFixture('branches')
    const repo = await open(r)
    const hashOf = (rev: string) => r.git('rev-parse', rev).trim()
    expect(await repo.search('message', 'e')).toContain(hashOf('main'))
    expect((await repo.search('author', 'ada')).length).toBe(7)
    expect(await repo.search('path', 'd.tx')).toEqual([hashOf('feature')])
    expect(await repo.search('content', 'f')).toEqual([hashOf('wip')])
    expect(await repo.search('hash', hashOf('feature').slice(0, 8))).toEqual([hashOf('feature')])
    expect(await repo.search('hash', 'zzzz')).toEqual([])
  })

  it('follows file history across renames, and blames', async () => {
    const r = makeFixture('renames')
    const repo = await open(r)
    expect((await repo.fileHistory('new name.txt')).map((c) => c.subject)).toEqual(['rename', 'add'])
    const blame = await repo.blame('new name.txt')
    expect(blame[0]!.summary).toBe('add')
  })

  it('reads blobs through one cat-file process, including binary and missing objects', async () => {
    const r = makeFixture('linear')
    const repo = await open(r)
    const results = await Promise.all([
      repo.cat.readText('HEAD:file.txt'), repo.cat.readText('HEAD~4:file.txt'), repo.cat.read('HEAD:nope'),
    ])
    expect(results).toEqual(['line 5\n'.repeat(5), 'line 1\n', null])
    r.commit('bin', { 'b.bin': '\x00\x01\x02' })
    expect([...(await repo.cat.read('HEAD:b.bin'))!]).toEqual([0, 1, 2])
    repo.dispose()
  })
})

describe('askpass', () => {
  it('relays a prompt from the script to the handler and returns the answer', async () => {
    const prompts: [string, boolean][] = []
    const server = new AskpassServer(async (msg, secret) => {
      prompts.push([msg, secret])
      return secret ? 's3cret' : null
    })
    const env = await server.start()
    // Must be async: the server lives in this process, so a sync child would block the event
    // loop and the server could never answer (a deadlock).
    const run = (prompt: string) => new Promise<string>((resolve) => {
      // Windows only runs .cmd scripts through a shell (git itself does the same when it calls askpass).
      execFile(env.GIT_ASKPASS!, [process.platform === 'win32' ? JSON.stringify(prompt) : prompt], { env: { ...process.env, ...env }, encoding: 'utf8', shell: process.platform === 'win32' }, (err, stdout, stderr) => {
        resolve(err ? `exit ${(err as { code?: number }).code}${stderr.trim() ? `: ${stderr.trim()}` : ''}` : stdout)
      })
    })
    expect(await run("Password for 'https://x@example.com': ")).toBe('s3cret\n')
    expect(await run("Username for 'https://example.com': ")).toBe('exit 1')
    expect(prompts).toEqual([["Password for 'https://x@example.com': ", true], ["Username for 'https://example.com': ", false]])
    server.stop()
  })

  it('classifies prompts', () => {
    expect(isSecretPrompt("Enter passphrase for key '/home/a/.ssh/id_ed25519': ")).toBe(true)
    expect(isSecretPrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])? ')).toBe(false)
  })
})

describe('straight tips (a branch on top of the trunk or HEAD continues its lane)', () => {
  /** main: A-B. */
  function base() {
    const r = initRepo()
    const A = r.commit('A', { 'a.txt': 'a\n' })
    const B = r.commit('B', { 'b.txt': 'b\n' })
    return { r, A, B }
  }
  const straight = async (r: FixtureRepo) => (await (await open(r)).snapshot()).graph.straight

  it('knows which git versions have %(ahead-behind)', () => {
    expect(supportsAheadBehind('git version 2.41.0')).toBe(true)
    expect(supportsAheadBehind('git version 2.47.1.windows.1')).toBe(true)
    expect(supportsAheadBehind('git version 3.0.0')).toBe(true)
    expect(supportsAheadBehind('git version 2.40.1')).toBe(false)
    expect(supportsAheadBehind('git version 1.9.5')).toBe(false)
    expect(supportsAheadBehind('not git')).toBe(false)
  })

  it('lists a branch on top of main, over the trunk and over HEAD', async () => {
    const { r } = base()
    r.checkout('-b', 'topic')
    r.commit('X'); r.commit('Y')
    const Z = r.commit('Z')
    r.checkout('main')
    expect(await straight(r)).toEqual({ overTrunk: [Z], overHead: [Z] })
    // Checked out, topic is HEAD itself: still over the trunk, and nothing is over HEAD.
    r.checkout('topic')
    expect(await straight(r)).toEqual({ overTrunk: [Z], overHead: [] })
  })

  it('leaves out a branch that merged main: it contains main, but its own line never reaches it', async () => {
    const { r, A } = base()
    r.checkout('-b', 'topic', A)
    r.commit('X', { 'x.txt': 'x\n' })
    r.merge('main')
    expect(r.git('rev-list', '--count', 'topic..main').trim()).toBe('0') // behind = 0: a candidate
    r.checkout('main')
    expect(await straight(r)).toEqual({ overTrunk: [], overHead: [] })
  })

  it('leaves out a branch behind main, and a branch beside it', async () => {
    const { r, A } = base()
    r.git('branch', 'old', A)
    r.checkout('-b', 'side', A)
    r.commit('S', { 's.txt': 's\n' })
    r.checkout('main')
    expect(await straight(r)).toEqual({ overTrunk: [], overHead: [] })
  })

  it('lists every branch on top of main, local and remote', async () => {
    const { r, B } = base()
    const tips: string[] = []
    for (const name of ['one', 'two', 'three']) {
      r.checkout('-b', name, B)
      tips.push(r.commit(name))
    }
    r.git('update-ref', 'refs/remotes/origin/one', tips[0]!)
    // A branch on top of another one is on top of main too.
    r.checkout('-b', 'four', 'one')
    tips.push(r.commit('four'))
    r.checkout('main')
    const s = await straight(r)
    expect(s.overTrunk).toEqual([...tips].sort())
    expect(s.overHead).toEqual([...tips].sort())
  })

  it('takes the newest trunk ref as the trunk tip, and gives up when they have diverged', async () => {
    const { r, B } = base()
    const O = r.commit('O on origin/main')
    r.git('update-ref', 'refs/remotes/origin/main', O)
    r.git('reset', '-q', '--hard', B) // main is one behind origin/main
    r.checkout('-b', 'onOrigin', O)
    const T = r.commit('T')
    r.checkout('-b', 'onMain', B)
    const U = r.commit('U')
    r.checkout('main')
    // onMain sits on main (HEAD) but not on the trunk line, which runs through origin/main.
    expect(await straight(r)).toEqual({ overTrunk: [T], overHead: [O, T, U].sort() })
    // Diverged: main gets a commit origin/main does not have. No trunk tip, so no overTrunk.
    r.commit('D')
    expect((await straight(r)).overTrunk).toEqual([])
  })

  it('works with HEAD detached, and with an unborn HEAD', async () => {
    const { r } = base()
    r.checkout('-b', 'topic')
    const X = r.commit('X')
    const Y = r.commit('Y')
    r.checkout('--detach', X)
    // HEAD is X (no branch there): topic is on top of it and of main.
    expect(await straight(r)).toEqual({ overTrunk: [Y], overHead: [Y] })

    const empty = initRepo()
    expect(await straight(empty)).toEqual({ overTrunk: [], overHead: [] })
  })

  it('is part of the snapshot, and read again when the refs move', async () => {
    const { r } = base()
    r.checkout('-b', 'topic')
    r.commit('X')
    r.checkout('main')
    const repo = await open(r)
    const first = await repo.snapshot()
    expect(first.graph.straight.overTrunk).toHaveLength(1)
    expect((await repo.snapshot()).refsVersion).toBe(first.refsVersion)
    // main moves on: topic is no longer on top of it.
    r.commit('C')
    const next = await repo.snapshot()
    expect(next.graph.straight).toEqual({ overTrunk: [], overHead: [] })
    expect(next.refsVersion).toBeGreaterThan(first.refsVersion)
  })
})
