import { makeFixture } from '@gitsquid/fixtures'
import { describe, expect, it } from 'vitest'
import { parseBlame } from './blame'
import { parseChangedFiles, parseDiff, untrackedDiff } from './diff'
import { LOG_FORMAT, LogParser, parseLog } from './log'
import { parseRefs, REFS_FORMAT } from './refs'
import { parseStashList, STASH_FORMAT } from './stash'
import { parseStatus } from './status'

describe('log', () => {
  it('parses NUL/RS separated records', () => {
    // Captured from: git log --format=LOG_FORMAT (two commits, the second a root).
    const raw = 'aaa\x00bbb ccc\x00Ada\x00ada@x\x001700000060\x001700000061\x00Merge it\x1e\n' +
      'bbb\x00\x00Bob\x00bob@x\x001700000000\x001700000000\x00subject with \x1e? no\x1e\n'
    const commits = parseLog(raw)
    expect(commits[0]).toEqual({
      hash: 'aaa', parents: ['bbb', 'ccc'], authorName: 'Ada', authorEmail: 'ada@x',
      authorDate: 1700000060, commitDate: 1700000061, subject: 'Merge it',
    })
    expect(commits[1]!.parents).toEqual([])
  })

  it('parses incrementally across arbitrary chunk boundaries', () => {
    const r = makeFixture('branches')
    const raw = r.git('log', '--topo-order', `--format=${LOG_FORMAT}`, '--branches')
    const whole = parseLog(raw)
    const p = new LogParser()
    const chunked = []
    for (let i = 0; i < raw.length; i += 7) chunked.push(...p.push(raw.slice(i, i + 7)))
    expect(chunked).toEqual(whole)
    // F is older than M and E, so topo order (newest first, children before parents) puts it after C.
    expect(whole.map((c) => c.subject)).toEqual(['E', 'M', 'D', 'C', 'F', 'B', 'A'])
  })
})

describe('refs', () => {
  it('peels annotated tags to their commit', () => {
    const r = makeFixture('tags')
    const refs = parseRefs(r.git('for-each-ref', `--format=${REFS_FORMAT}`))
    const head = r.head()
    expect(refs.find((x) => x.shortName === 'v0.2')).toMatchObject({ kind: 'tag', hash: head })
    expect(refs.find((x) => x.shortName === 'main')).toMatchObject({ kind: 'local', hash: head })
  })

  it('reads upstream tracking and skips origin/HEAD', () => {
    const r = makeFixture('with-remote')
    const refs = parseRefs(r.git('for-each-ref', `--format=${REFS_FORMAT}`))
    expect(refs.find((x) => x.shortName === 'main')).toMatchObject({ upstream: 'refs/remotes/origin/main', ahead: 1, behind: 0 })
    expect(refs.some((x) => x.shortName === 'origin/HEAD')).toBe(false)
    expect(refs.some((x) => x.shortName === 'origin/main')).toBe(true)
  })
})

describe('status', () => {
  it('parses changed, staged, renamed and untracked files, including spaces in paths', () => {
    const r = makeFixture('renames')
    r.write('new name.txt', 'edited\n')
    r.write('dir with space/untracked file.txt', 'x\n')
    r.write('staged.txt', 's\n')
    r.git('add', 'staged.txt')
    r.git('mv', 'new name.txt', 'renamed again.txt')
    const s = parseStatus(r.git('status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'))
    expect(s.head.branch).toBe('main')
    expect(s.head.hash).toBe(r.head())
    expect(s.entries).toEqual(expect.arrayContaining([
      { path: 'renamed again.txt', origPath: 'new name.txt', index: 'R', worktree: 'M', kind: 'renamed' },
      { path: 'staged.txt', index: 'A', worktree: '.', kind: 'changed' },
      { path: 'dir with space/untracked file.txt', index: '?', worktree: '?', kind: 'untracked' },
    ]))
  })

  it('reports an unborn branch and unmerged files', () => {
    const empty = makeFixture('empty')
    const s0 = parseStatus(empty.git('status', '--porcelain=v2', '-z', '--branch'))
    expect(s0.head).toEqual({ branch: 'main', hash: undefined, detached: false })

    const r = makeFixture('conflict')
    expect(r.tryGit('merge', 'other')).not.toBe(0)
    const s = parseStatus(r.git('status', '--porcelain=v2', '-z', '--branch'))
    expect(s.entries).toContainEqual({ path: 'story.txt', index: 'U', worktree: 'U', kind: 'unmerged' })
  })

  it('reports detached HEAD', () => {
    const r = makeFixture('linear')
    r.checkout('--detach', 'HEAD~1')
    const s = parseStatus(r.git('status', '--porcelain=v2', '-z', '--branch'))
    expect(s.head.detached).toBe(true)
    expect(s.head.branch).toBeUndefined()
  })
})

describe('diff', () => {
  it('parses hunks with line numbers', () => {
    const r = makeFixture('linear')
    r.write('file.txt', 'one\ntwo\nthree\nfour\nfive\n')
    r.commit('distinct lines')
    r.write('file.txt', 'one\nINSERTED\ntwo\nthree\nfour\n')
    const [d] = parseDiff(r.git('diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'), 'file.txt')
    expect(d!.hunks).toHaveLength(1)
    const h = d!.hunks[0]!
    expect(h.lines.filter((l) => l.kind === '+')).toEqual([{ kind: '+', text: 'INSERTED', newNo: 2 }])
    expect(h.lines.filter((l) => l.kind === '-')).toEqual([{ kind: '-', text: 'five', oldNo: 5 }])
    expect(d!.header[0]).toBe('diff --git a/file.txt b/file.txt')
  })

  it('marks a missing newline at end of file', () => {
    const r = makeFixture('linear')
    r.write('file.txt', 'no newline')
    const [d] = parseDiff(r.git('diff', '--no-color'), 'file.txt')
    const last = d!.hunks[0]!.lines.at(-1)!
    expect(last).toMatchObject({ kind: '+', text: 'no newline', noNewline: true })
  })

  it('detects renames and binary files', () => {
    const r = makeFixture('renames')
    const [d] = parseDiff(r.git('diff', '-M', '--no-color', 'HEAD~1', 'HEAD'))
    expect(d).toMatchObject({ change: 'renamed', oldPath: 'old name.txt', path: 'new name.txt' })
    r.write('bin.dat', 'a\x00b')
    r.git('add', 'bin.dat')
    const [b] = parseDiff(r.git('diff', '--cached', '--no-color'), 'bin.dat')
    expect(b).toMatchObject({ binary: true, change: 'added', hunks: [] })
  })

  it('keeps CR characters in CRLF files', () => {
    const r = makeFixture('crlf')
    r.write('win.txt', 'one\r\nTWO\r\nthree\r\n')
    const [d] = parseDiff(r.git('diff', '--no-color'), 'win.txt')
    expect(d!.hunks[0]!.lines.find((l) => l.kind === '+')!.text).toBe('TWO\r')
  })

  it('synthesizes a diff for untracked files', () => {
    const d = untrackedDiff('n.txt', Buffer.from('a\nb'))
    expect(d.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 })
    expect(d.hunks[0]!.lines[1]).toMatchObject({ text: 'b', noNewline: true })
    expect(untrackedDiff('x', Buffer.from([0, 1, 2])).binary).toBe(true)
  })

  it('combines name-status and numstat', () => {
    const r = makeFixture('renames')
    const ns = r.git('diff-tree', '-r', '-M', '-z', '--name-status', 'HEAD~1', 'HEAD')
    const nm = r.git('diff-tree', '-r', '-M', '-z', '--numstat', 'HEAD~1', 'HEAD')
    expect(parseChangedFiles(ns, nm)).toEqual([
      { path: 'new name.txt', oldPath: 'old name.txt', change: 'renamed', additions: 0, deletions: 0, binary: false },
    ])
    const base = r.git('rev-parse', 'HEAD~1').trim()
    r.write('new name.txt', 'x\n')
    r.commit('edit')
    const files = parseChangedFiles(
      r.git('diff-tree', '-r', '-z', '--name-status', base, 'HEAD'),
      r.git('diff-tree', '-r', '-z', '--numstat', base, 'HEAD'))
    expect(files.find((f) => f.path === 'new name.txt')).toMatchObject({ change: 'added', additions: 1 })
  })
})

describe('blame and stash', () => {
  it('parses porcelain blame, reusing metadata for repeated commits', () => {
    const r = makeFixture('linear')
    const lines = parseBlame(r.git('blame', '--porcelain', '--', 'file.txt'))
    expect(lines).toHaveLength(5)
    expect(lines.every((l) => l.hash === r.head() && l.summary === 'Commit 5' && l.author === 'Ada Lovelace')).toBe(true)
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5])
  })

  it('lists stashes newest first', () => {
    const r = makeFixture('stash')
    const s = parseStashList(r.git('stash', 'list', `--format=${STASH_FORMAT}`))
    expect(s.map((x) => [x.index, x.ref, x.message])).toEqual([
      [0, 'stash@{0}', 'On main: second stash'],
      [1, 'stash@{1}', 'On main: first stash'],
    ])
  })
})
