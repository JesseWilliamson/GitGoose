import { initRepo } from '@gitsquid/fixtures'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

describe('external diff and merge tools', () => {
  it('opens a diff in the configured tool with both versions', async () => {
    const r = initRepo()
    const base = r.commit('root', { 'a.txt': 'one\n' })
    const head = r.commit('two', { 'a.txt': 'two\n' })
    const out = join(r.dir, '..', `tool-${Date.now()}.txt`)
    // A "tool" that records what it was given: the two files git hands every diff tool.
    r.git('config', 'difftool.record.cmd', `cat "$LOCAL" "$REMOTE" > '${out}'`)
    const repo = await Repo.open(r.dir, {})
    await repo.diffTool({ kind: 'commit', hash: head, path: 'a.txt' }, 'record')
    expect(readFileSync(out, 'utf8')).toBe('one\ntwo\n')
    r.write('a.txt', 'three\n')
    await repo.diffTool({ kind: 'unstaged', path: 'a.txt' }, 'record')
    expect(readFileSync(out, 'utf8')).toBe('two\nthree\n')
    await repo.diffTool({ kind: 'range', from: base, to: null, path: 'a.txt' }, 'record')
    expect(readFileSync(out, 'utf8')).toBe('one\nthree\n')
    repo.dispose()
  })

  it('resolves a conflict in the merge tool, and git marks it resolved', async () => {
    const r = initRepo()
    r.commit('root', { 'f.txt': '1\n' })
    r.git('checkout', '-q', '-b', 'theirs')
    r.commit('theirs', { 'f.txt': 'theirs\n' })
    r.checkout('main')
    r.commit('ours', { 'f.txt': 'ours\n' })
    expect(r.tryGit('merge', 'theirs')).not.toBe(0)
    r.git('config', 'mergetool.taketheirs.cmd', 'cp "$REMOTE" "$MERGED"')
    r.git('config', 'mergetool.taketheirs.trustExitCode', 'true')
    r.git('config', 'mergetool.keepBackup', 'false')
    const repo = await Repo.open(r.dir, {})
    await repo.mergeTool('f.txt', 'taketheirs')
    expect(readFileSync(join(r.dir, 'f.txt'), 'utf8')).toBe('theirs\n')
    expect(r.git('status', '--porcelain').trim()).toBe('M  f.txt')
    repo.dispose()
  })
})
