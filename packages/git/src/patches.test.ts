import { initRepo, tempDir } from '@gitsquid/fixtures'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseNumstatPaths, Repo } from './repo'

function setup() {
  const r = initRepo()
  const root = r.commit('root', { 'a.txt': '1\n2\n3\n' })
  return { r, root }
}

describe('patches', () => {
  it('reads paths from numstat, renames included', () => {
    expect(parseNumstatPaths('1\t0\ta.txt\x002\t1\tdir/b.txt\x00')).toEqual(['a.txt', 'dir/b.txt'])
    expect(parseNumstatPaths('0\t0\t\x00old.txt\x00new.txt\x00-\t-\timg.png\x00')).toEqual(['old.txt', 'new.txt', 'img.png'])
  })

  it('saves commits as numbered patch files and applies them elsewhere as commits; undo', async () => {
    const { r, root } = setup()
    const one = r.commit('one', { 'b.txt': 'b\n' })
    const two = r.commit('two', { 'a.txt': '1\n2\n3\n4\n' })
    const repo = await Repo.open(r.dir, {})
    const dir = tempDir('gitsquid-patches-')
    const paths = await repo.savePatches([two, one], dir)
    expect(paths.map((p) => p.split('/').pop())).toEqual(['0001-one.patch', '0002-two.patch'])

    r.git('reset', '-q', '--hard', root)
    const text = paths.map((p) => readFileSync(p, 'utf8')).join('')
    const id = await repo.applyPatch(text)
    expect(r.git('log', '--format=%s %an', '-3').trim().split('\n')).toEqual(['two Ada Lovelace', 'one Ada Lovelace', 'root Ada Lovelace'])
    await repo.undo(id!)
    expect(r.head()).toBe(root)
    repo.dispose()
  })

  it('applies a plain diff to the working tree and index; undo puts both back', async () => {
    const { r } = setup()
    r.write('a.txt', '1\n2\nthree\n')
    const diff = r.git('diff')
    r.git('checkout', '--', 'a.txt')
    r.write('other.txt', 'mine\n')
    const repo = await Repo.open(r.dir, {})
    const id = await repo.applyPatch(diff)
    expect(r.git('status', '--porcelain').trimEnd()).toBe('M  a.txt\n?? other.txt')
    await repo.undo(id!)
    expect(r.git('status', '--porcelain').trimEnd()).toBe('?? other.txt')
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('1\n2\n3\n')
    await expect(repo.applyPatch('not a patch\n')).rejects.toThrow()
    repo.dispose()
  })

  it('stops a conflicting mailbox patch as an "am" in progress, which can be aborted', async () => {
    const { r, root } = setup()
    const change = r.commit('change three', { 'a.txt': '1\n2\nTHREE\n' })
    const repo = await Repo.open(r.dir, {})
    const text = readFileSync((await repo.savePatches([change], tempDir('gitsquid-patches-')))[0]!, 'utf8')
    r.git('reset', '-q', '--hard', root)
    r.commit('other change', { 'a.txt': '1\n2\ntres\n' })
    await expect(repo.applyPatch(text)).rejects.toThrow()
    expect(repo.operation()).toBe('am')
    expect(r.git('status', '--porcelain').trimEnd()).toBe('UU a.txt')
    await repo.abortOperation()
    expect(repo.operation()).toBeNull()
    expect(r.git('log', '-1', '--format=%s').trim()).toBe('other change')
    repo.dispose()
  })
})
