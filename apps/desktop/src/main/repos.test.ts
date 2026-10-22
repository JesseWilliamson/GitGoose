import { Repo } from '@gitgoose/git'
import { makeFixture } from '@gitgoose/fixtures'
import type { RepoSnapshot } from '@gitgoose/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepoManager } from './repos'

/** Longer than the watcher's 100 ms debounce: time for a refresh it schedules to have run. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
// A snapshot that is expected is waited for (vi.waitFor): a fixed wait failed on a slow Windows
// runner. A snapshot that must NOT come is asserted after a fixed wait, as there is no event to wait for.

describe('RepoManager', () => {
  let manager: RepoManager | null = null
  afterEach(async () => {
    await manager?.closeAll()
    manager = null
  })

  async function setup() {
    const r = makeFixture('linear')
    const emitted: RepoSnapshot[] = []
    const worktree: string[] = []
    manager = new RepoManager(() => ({ gitPath: 'git', env: r.env() as Record<string, string> }), (s) => emitted.push(s), () => {}, (id) => worktree.push(id))
    const repo = await Repo.open(r.dir, { env: r.env() as Record<string, string> })
    await manager.add(repo)
    return { r, repo, emitted, worktree, m: manager }
  }

  it('pushes one snapshot per change the watcher reports', async () => {
    const { r, repo, emitted, m } = await setup()
    r.commit('one')
    m.schedule(repo.id, 0)
    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: 5000 })
    expect(emitted[0]!.head.hash).toBe(r.git('rev-parse', 'HEAD').trim())
  })

  it('holds the watcher during a write and pushes only the final state after it', async () => {
    const { r, repo, emitted, worktree, m } = await setup()
    const first = r.git('rev-parse', 'HEAD').trim()
    await m.during(repo.id, async () => {
      // Two steps the watcher would normally report one by one, like the picks of a rebase.
      r.commit('step 1')
      m.schedule(repo.id, 0)
      await wait(300)
      expect(emitted).toHaveLength(0)
      r.commit('step 2')
      m.schedule(repo.id, 0)
      await wait(300)
      expect(emitted).toHaveLength(0)
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.head.hash).toBe(r.git('rev-parse', 'HEAD').trim())
    expect(emitted[0]!.head.hash).not.toBe(first)
    // Open diffs still hear that files changed, once.
    expect(worktree).toEqual([repo.id])
    // Afterwards the watcher is back to normal.
    r.commit('later')
    m.schedule(repo.id, 0)
    await vi.waitFor(() => expect(emitted).toHaveLength(2), { timeout: 5000 })
  })

  it('still refreshes after a write that throws, and lets the error through', async () => {
    const { r, repo, emitted, m } = await setup()
    await expect(m.during(repo.id, async () => {
      r.commit('partial')
      throw new Error('stopped on conflicts')
    })).rejects.toThrow('stopped on conflicts')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.head.hash).toBe(r.git('rev-parse', 'HEAD').trim())
  })
})
