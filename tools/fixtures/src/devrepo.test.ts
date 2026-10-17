import { execFileSync, spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { CONFLICT_BRANCH, makeDevRepo } from './devrepo'
import { tempDir } from './index'

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

describe('development repository', () => {
  it('has the promised shape', () => {
    const t = Date.now()
    const { dir, authors } = makeDevRepo({ commits: 1500 })
    expect(Date.now() - t).toBeLessThan(20_000)
    expect(Number(git(dir, 'rev-list', '--all', '--count'))).toBeGreaterThan(1450)
    expect(Number(git(dir, 'rev-list', '--all', '--merges', '--count'))).toBeGreaterThan(50)
    expect(git(dir, 'tag').trim().split('\n').length).toBeGreaterThanOrEqual(30)
    const branches = git(dir, 'branch', '--format=%(refname:short)').trim().split('\n')
    expect(branches.length).toBeGreaterThanOrEqual(15)
    expect(branches).toEqual(expect.arrayContaining(['main', 'develop', 'release/1.x', 'gh-pages', CONFLICT_BRANCH]))
    // gh-pages shares no history with main.
    expect(spawnSync('git', ['merge-base', 'main', 'gh-pages'], { cwd: dir }).status).toBe(1)
    const seenAuthors = new Set(git(dir, 'log', '--all', '--format=%ae').trim().split('\n'))
    for (const a of authors) expect(seenAuthors).toContain(a.email)
    expect(Number(git(dir, 'log', '--all', '-M', '--diff-filter=R', '--format=%h').trim().split('\n').length)).toBeGreaterThan(10)
    expect(git(dir, 'stash', 'list').trim().split('\n')).toHaveLength(3)
    expect(git(dir, 'remote').trim().split('\n').sort()).toEqual(['origin', 'upstream'])
    expect(git(dir, 'status', '-sb').split('\n')[0]).toContain('[ahead 2, behind 3]')
    const status = git(dir, 'status', '--porcelain').trimEnd().split('\n') // not trim(): the first line starts with a space
    expect(status.filter((l) => l.startsWith(' M'))).toHaveLength(3)
    expect(status.filter((l) => l.startsWith('M '))).toHaveLength(1)
    expect(status.filter((l) => l.startsWith(' D'))).toHaveLength(1)
    expect(status.filter((l) => l.startsWith('??'))).toHaveLength(2)
    expect(spawnSync('git', ['fsck', '--no-progress', '--no-dangling'], { cwd: dir }).status).toBe(0)
    // Odd paths and the binary asset are there.
    const files = git(dir, '-c', 'core.quotepath=false', 'ls-files').split('\n')
    expect(files).toEqual(expect.arrayContaining(['docs/Design Notes.md', 'docs/résumé-ünïcode.md', 'assets/hero.bin', 'scripts/windows-setup.bat']))
    expect(git(dir, 'show', 'HEAD:scripts/windows-setup.bat')).toContain('\r\n')
  }, 60_000)

  it('has a conflict branch that really conflicts with develop, including a renamed file', () => {
    const { dir } = makeDevRepo({ commits: 300 })
    const clone = tempDir('gitsquid-dev-clone-')
    execFileSync('git', ['clone', '-q', '-b', 'develop', dir, clone + '/c'])
    const c = clone + '/c'
    git(c, 'config', 'user.name', 'T')
    git(c, 'config', 'user.email', 't@x')
    git(c, 'fetch', '-q', dir, `${CONFLICT_BRANCH}:${CONFLICT_BRANCH}`)
    const merge = spawnSync('git', ['merge', CONFLICT_BRANCH], { cwd: c, encoding: 'utf8' })
    expect(merge.status).not.toBe(0)
    const conflicted = git(c, 'diff', '--name-only', '--diff-filter=U').trim().split('\n').sort()
    expect(conflicted).toEqual(['src/config.ts', 'src/utils/formatting.ts'])
  }, 60_000)

  it('is deterministic: the same seed gives the same hashes', () => {
    const a = makeDevRepo({ commits: 300 })
    const b = makeDevRepo({ commits: 300 })
    const refs = (d: string) => git(d, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/stash')
    expect(refs(a.dir)).toBe(refs(b.dir))
    const other = makeDevRepo({ commits: 300, seed: 7 })
    expect(refs(other.dir)).not.toBe(refs(a.dir))
  }, 60_000)
})
