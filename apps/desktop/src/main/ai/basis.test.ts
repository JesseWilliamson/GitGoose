import { Repo } from '@gitgoose/git'
import { makeFixture } from '@gitgoose/fixtures'
import { staleReason, type ThreadAnchor } from '@gitgoose/shared'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { basisOf, resolveAll } from './basis'

/**
 * Real git against a real repository: the whole point of a basis is that it notices what git
 * notices, so a mock would only test the mock.
 */

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})

async function open(shape: Parameters<typeof makeFixture>[0] = 'linear') {
  const r = makeFixture(shape)
  const repo = await Repo.open(r.dir, {})
  cleanup.push(() => repo.dispose())
  const log = (...args: string[]) => repo.runner.run(['rev-parse', ...args], { readOnly: true }).then((x) => x.stdout.trim())
  return { r, repo, log }
}

/** The one call the history list makes, for one anchor: was it, is it, and what changed. */
async function reasonAfter(anchor: ThreadAnchor, setup: () => void, shape: Parameters<typeof makeFixture>[0] = 'linear') {
  const { r, repo } = await open(shape)
  const was = await basisOf(repo, anchor)
  setup.call({ r })
  return { was, reason: staleReason(anchor, was ?? undefined, await basisOf(repo, anchor)), r, repo }
}

describe('basisOf', () => {
  it('records nothing for a conversation that owns no view', async () => {
    const { repo } = await open()
    expect(await basisOf(repo, { kind: 'free' })).toBe(null)
    expect(await basisOf(repo, { kind: 'explain', hash: 'HEAD' })).toBe(null)
  })

  it('resolves commits to their full ids, and is null when one is gone', async () => {
    const { repo, log } = await open()
    const head = await log('HEAD')
    expect(await basisOf(repo, { kind: 'review', scope: { kind: 'commits', hashes: [head.slice(0, 7)] } })).toEqual({ commits: [head] })
    expect(await basisOf(repo, { kind: 'review', scope: { kind: 'commits', hashes: ['0'.repeat(40)] } })).toBe(null)
  })

  it('stays the same while nothing moves', async () => {
    const { repo, log } = await open()
    const anchor: ThreadAnchor = { kind: 'review', scope: { kind: 'commits', hashes: [await log('HEAD')] } }
    expect(staleReason(anchor, (await basisOf(repo, anchor))!, await basisOf(repo, anchor))).toBe('')
  })

  it('notices a commit that was amended under a review of it', async () => {
    const { r, repo, log } = await open()
    const anchor: ThreadAnchor = { kind: 'review', scope: { kind: 'commits', hashes: [await log('HEAD')] } }
    const was = (await basisOf(repo, anchor))!
    r.git('commit', '-q', '--amend', '-m', 'Commit 5, reworded')
    // The anchor still names the old hash, which is now unreachable but still in the object store:
    // what the user sees is a review of a commit that is no longer on the branch.
    const now = await basisOf(repo, { kind: 'review', scope: { kind: 'commits', hashes: [await log('HEAD')] } })
    expect(staleReason(anchor, was, now)).toBe('The commits have changed since.')
  })

  it('follows a branch tip and names the branch when it moves', async () => {
    const { r, repo, log } = await open('branches')
    const anchor: ThreadAnchor = { kind: 'review', scope: { kind: 'branch', branch: 'wip' } }
    const was = (await basisOf(repo, anchor))!
    expect(was).toEqual({ commits: [await log('refs/heads/wip')], ref: { name: 'refs/heads/wip', hash: await log('refs/heads/wip') } })
    expect(staleReason(anchor, was, await basisOf(repo, anchor))).toBe('')
    r.checkout('wip')
    r.commit('G', { 'g.txt': 'g\n' })
    expect(staleReason(anchor, was, await basisOf(repo, anchor))).toBe('wip has moved since.')
  })

  it('is null for a branch that has been deleted', async () => {
    const { r, repo } = await open('branches')
    const anchor: ThreadAnchor = { kind: 'review', scope: { kind: 'branch', branch: 'wip' } }
    const was = (await basisOf(repo, anchor))!
    r.git('branch', '-q', '-D', 'wip')
    expect(await basisOf(repo, anchor)).toBe(null)
    expect(staleReason(anchor, was, null)).toBe('wip is gone.')
  })

  it('notices an edit under a conversation about the working tree, tracked or not', async () => {
    const { r, repo } = await open()
    const anchor: ThreadAnchor = { kind: 'walkthrough', scope: { kind: 'working' } }
    writeFileSync(join(r.dir, 'file.txt'), 'changed\n')
    const was = (await basisOf(repo, anchor))!
    expect(staleReason(anchor, was, await basisOf(repo, anchor))).toBe('')
    writeFileSync(join(r.dir, 'file.txt'), 'changed again\n')
    expect(staleReason(anchor, was, await basisOf(repo, anchor))).toBe('The uncommitted changes have changed since.')
    // An untracked file is part of what a walkthrough of the working tree reads, so it counts.
    const after = (await basisOf(repo, anchor))!
    writeFileSync(join(r.dir, 'brand-new.txt'), 'hello\n')
    expect(staleReason(anchor, after, await basisOf(repo, anchor))).toBe('The uncommitted changes have changed since.')
  })

  it('notices what has been staged under a conversation about the index', async () => {
    const { r, repo } = await open()
    const anchor: ThreadAnchor = { kind: 'review', scope: { kind: 'staged' } }
    writeFileSync(join(r.dir, 'file.txt'), 'changed\n')
    r.git('add', 'file.txt')
    const was = (await basisOf(repo, anchor))!
    expect(staleReason(anchor, was, await basisOf(repo, anchor))).toBe('')
    writeFileSync(join(r.dir, 'file.txt'), 'changed more\n')
    // Not staged yet: the index is what was reviewed, and it has not moved.
    expect(staleReason(anchor, was, await basisOf(repo, anchor))).toBe('')
    r.git('add', 'file.txt')
    expect(staleReason(anchor, was, await basisOf(repo, anchor))).toBe('The uncommitted changes have changed since.')
  })

  it('calls a plan rewritten once its commits are gone from the branch', async () => {
    const { r, repo, log } = await open()
    const anchor: ThreadAnchor = { kind: 'recompose', hashes: [await log('HEAD')] }
    const was = (await basisOf(repo, anchor))!
    expect(was.ref).toEqual({ name: 'HEAD', hash: await log('HEAD') })
    r.git('commit', '-q', '--amend', '-m', 'Reworded')
    expect(staleReason({ kind: 'recompose', hashes: [await log('HEAD')] }, was, await basisOf(repo, { kind: 'recompose', hashes: [await log('HEAD')] })))
      .toBe('Those commits have been rewritten since.')
  })

  it('works each distinct anchor out once, however many conversations share it', async () => {
    const { repo } = await open()
    const a: ThreadAnchor = { kind: 'review', scope: { kind: 'staged' } }
    const b: ThreadAnchor = { kind: 'walkthrough', scope: { kind: 'staged' } }
    const map = await resolveAll(repo, [a, { ...a }, b])
    expect(map.size).toBe(2)
    expect(map.get(JSON.stringify(a))).not.toBe(undefined)
  })

  it('does not watch where a branch forked from: a fetch that moves the base is not a stale review', async () => {
    const { r, repo } = await open('branches')
    const anchor: ThreadAnchor = { kind: 'review', scope: { kind: 'branch', branch: 'wip' } }
    const was = (await basisOf(repo, anchor))!
    r.checkout('main')
    r.commit('later on main', { 'later.txt': 'later\n' })
    r.checkout('wip')
    expect(staleReason(anchor, was, await basisOf(repo, anchor))).toBe('')
  })
})
