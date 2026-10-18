import { execFileSync, spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { CONFLICT_BRANCH, CONFLICT_BRANCHES, makeDevRepo } from './devrepo'

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

describe('development repository', () => {
  it('has the promised shape', () => {
    const t = Date.now()
    const { dir, authors } = makeDevRepo({ commits: 1500 })
    // Git and the file system are much slower on Windows CI runners (21 s there for this one).
    expect(Date.now() - t).toBeLessThan(process.platform === 'win32' ? 60_000 : 20_000)
    expect(Number(git(dir, 'rev-list', '--all', '--count'))).toBeGreaterThan(1450)
    expect(Number(git(dir, 'rev-list', '--all', '--merges', '--count'))).toBeGreaterThan(50)
    expect(git(dir, 'tag').trim().split('\n').length).toBeGreaterThanOrEqual(30)
    const branches = git(dir, 'branch', '--format=%(refname:short)').trim().split('\n')
    expect(branches.length).toBeGreaterThanOrEqual(15)
    expect(branches).toEqual(expect.arrayContaining(['main', 'develop', 'release/1.x', 'gh-pages', ...Object.values(CONFLICT_BRANCHES)]))
    // Like a real project, every branch, remote branch and tag grows from one root commit. (Not
    // --all: the untracked-files commit of a `stash -u` has no parent, so refs/stash adds a root.)
    expect(git(dir, 'rev-list', '--max-parents=0', '--branches', '--remotes', '--tags').trim().split('\n')).toHaveLength(1)
    const seenAuthors = new Set(git(dir, 'log', '--all', '--format=%ae').trim().split('\n'))
    for (const a of authors) expect(seenAuthors).toContain(a.email)
    expect(Number(git(dir, 'log', '--all', '-M', '--diff-filter=R', '--format=%h').trim().split('\n').length)).toBeGreaterThan(10)
    expect(git(dir, 'stash', 'list').trim().split('\n')).toHaveLength(4)
    expect(git(dir, 'remote').trim().split('\n').sort()).toEqual(['origin', 'upstream'])
    expect(git(dir, 'status', '-sb').split('\n')[0]).toContain('[ahead 2, behind 3]')
    const status = git(dir, 'status', '--porcelain').trimEnd().split('\n') // not trim(): the first line starts with a space
    expect(status.filter((l) => l.startsWith(' M'))).toHaveLength(4) // 3 files and .gitignore
    expect(status.filter((l) => /^[MADR]/.test(l))).toHaveLength(0) // nothing staged, so merges are not refused
    expect(status.filter((l) => l.startsWith(' D'))).toHaveLength(1)
    expect(status.filter((l) => l.startsWith('??'))).toHaveLength(3)
    expect(spawnSync('git', ['fsck', '--no-progress', '--no-dangling'], { cwd: dir }).status).toBe(0)
    // Odd paths and the binary asset are there.
    const files = git(dir, '-c', 'core.quotepath=false', 'ls-files').split('\n')
    expect(files).toEqual(expect.arrayContaining(['docs/Design Notes.md', 'docs/résumé-ünïcode.md', 'assets/hero.bin', 'scripts/windows-setup.bat']))
    expect(git(dir, 'show', 'HEAD:scripts/windows-setup.bat')).toContain('\r\n')
  }, 60_000)

  it('has a conflict branch for each kind of conflict, each conflicting with develop as the repo stands', () => {
    const { dir } = makeDevRepo({ commits: 300, icons: 100 })
    const before = git(dir, 'status', '--porcelain')
    // Unmerged entries as `git status` shows them: UU both modified, UD deleted by them, AA both added.
    const expected: Record<string, string[]> = {
      [CONFLICT_BRANCHES.renameVsEdit]: ['UU src/config.ts', 'UU src/utils/formatting.ts'],
      [CONFLICT_BRANCHES.deleteVsEdit]: ['UD src/api/client.ts'],
      [CONFLICT_BRANCHES.bothAdded]: ['AA src/utils/retry.ts'],
      [CONFLICT_BRANCHES.binary]: ['UU assets/brand.woff2'],
    }
    // Merged straight into the dirty working tree: git stops on the conflicts, not on local changes.
    for (const [branch, conflicts] of Object.entries(expected)) {
      expect(spawnSync('git', ['merge', branch], { cwd: dir }).status).not.toBe(0)
      const unmerged = git(dir, 'status', '--porcelain').split('\n').filter((l) => /^(UU|UD|DU|AA) /.test(l)).sort()
      expect(unmerged, branch).toEqual(conflicts)
      git(dir, 'merge', '--abort')
      expect(git(dir, 'status', '--porcelain')).toBe(before)
    }
    expect(CONFLICT_BRANCH).toBe(CONFLICT_BRANCHES.renameVsEdit)
  }, 60_000)

  it('has ignored files, an unstaged .gitignore edit that changes what is untracked, and a bulk stash', () => {
    const { dir, bulkStashFiles } = makeDevRepo({ commits: 300, icons: 400 })
    const untracked = () => git(dir, 'status', '--porcelain').split('\n').filter((l) => l.startsWith('??')).sort()
    const ignored = git(dir, 'status', '--porcelain', '--ignored').split('\n').filter((l) => l.startsWith('!!'))
    expect(ignored).toEqual(expect.arrayContaining(['!! node_modules/', '!! dist/', '!! .env', '!! .idea/']))
    expect(untracked()).toEqual(['?? notes/', '?? npm-debug.log', '?? scratch.ts'])
    // Discarding the .gitignore edit: npm-debug.log is ignored again, .idea/ no longer is.
    git(dir, 'checkout', '--', '.gitignore')
    expect(untracked()).toEqual(['?? .idea/', '?? notes/', '?? scratch.ts'])

    // stash@{0} touches every icon and adds a quarter more.
    expect(git(dir, 'stash', 'list').split('\n')[0]).toContain('icons: stroke-width 2')
    expect(bulkStashFiles).toBe(500)
    git(dir, 'stash', 'apply', '-q', 'stash@{0}')
    const status = git(dir, 'status', '--porcelain', '-uall').split('\n')
    expect(status.filter((l) => l.startsWith(' M assets/icons/'))).toHaveLength(400)
    expect(status.filter((l) => l.startsWith('?? assets/icons/'))).toHaveLength(100)
  }, 60_000)

  it('is deterministic: the same seed gives the same hashes', () => {
    const a = makeDevRepo({ commits: 300, icons: 200 })
    const b = makeDevRepo({ commits: 300, icons: 200 })
    const refs = (d: string) => git(d, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/stash')
    expect(refs(a.dir)).toBe(refs(b.dir))
    const other = makeDevRepo({ commits: 300, icons: 200, seed: 7 })
    expect(refs(other.dir)).not.toBe(refs(a.dir))
  }, 60_000)
})
