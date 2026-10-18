import { initRepo } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

/**
 *   main:  A - B
 *   topic:  \- X - Y - Z     (from A)
 */
function setup() {
  const r = initRepo()
  const A = r.commit('A', { 'a.txt': 'a\n' })
  const B = r.commit('B', { 'b.txt': 'b\n' })
  r.git('checkout', '-q', '-b', 'topic', A)
  const X = r.commit('X', { 'x.txt': 'x\n' })
  const Y = r.commit('Y', { 'x.txt': 'x\ny\n' })
  const Z = r.commit('Z', { 'z.txt': 'z\n' })
  r.checkout('main')
  return { r, A, B, X, Y, Z }
}

const subjects = (r: ReturnType<typeof setup>['r'], range: string) => r.git('log', '--format=%s', range).trim().split('\n')

describe('several commits at once', () => {
  it('cherry-picks oldest first, skips commits already on the branch, and undoes in one step', async () => {
    const { r, B, X, Z } = setup()
    const repo = await Repo.open(r.dir, {})
    const before = r.head()
    // Graph order (newest first), with B already on main.
    const id = await repo.cherryPickMany([Z, X, B])
    expect(subjects(r, `${before}..HEAD`)).toEqual(['Z', 'X'])
    await repo.undo(id!)
    expect(r.head()).toBe(before)
    await expect(repo.cherryPickMany([B])).rejects.toThrow('already on the current branch')
    repo.dispose()
  })

  it('copies a chain as one diff, and scattered commits as one diff each', async () => {
    const { r, A, X, Y, Z } = setup()
    const repo = await Repo.open(r.dir, {})
    const chain = await repo.commitsText([Y, X], 'diff')
    expect(chain).toBe(r.git('diff', '--binary', A, Y))
    // The chain's diff applies to A and gives Y's tree.
    r.git('checkout', '-q', '-b', 'apply-diff', A)
    r.write('chain.patch', chain)
    r.git('apply', '--index', 'chain.patch')
    expect(r.git('write-tree').trim()).toBe(r.git('rev-parse', `${Y}^{tree}`).trim())
    r.git('reset', '-q', '--hard')
    r.git('clean', '-fdq')

    const scattered = await repo.commitsText([Z, X], 'diff')
    expect(scattered).toContain('x.txt')
    expect(scattered).toContain('z.txt')
    expect(scattered.indexOf('x.txt')).toBeLessThan(scattered.indexOf('z.txt'))
    repo.dispose()
  })

  it('copies patches that git am applies, numbered when they form a series', async () => {
    const { r, A, X, Y, Z } = setup()
    const repo = await Repo.open(r.dir, {})
    const series = await repo.commitsText([Z, Y, X], 'patch')
    expect(series).toContain('[PATCH 1/3] X')
    expect(series).toContain('[PATCH 3/3] Z')
    r.git('checkout', '-q', '-b', 'apply-patch', A)
    r.write('../series.mbox', series)
    r.git('am', '-q', '../series.mbox')
    expect(subjects(r, `${A}..HEAD`)).toEqual(['Z', 'Y', 'X'])
    expect(r.git('rev-parse', 'HEAD^{tree}').trim()).toBe(r.git('rev-parse', `${Z}^{tree}`).trim())
    // From the root: format-patch needs --root, which the chain case adds.
    expect(await repo.commitsText([X, A], 'patch')).toContain('[PATCH 1/2] A')
    repo.dispose()
  })
})
