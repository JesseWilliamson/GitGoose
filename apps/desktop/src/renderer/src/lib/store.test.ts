import { makeFixture } from '@gitgoose/fixtures'
import { Repo } from '@gitgoose/git'
import { defaultSettings, type GitGooseEvent, type LogPage } from '@gitgoose/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { RepoManager } from '../../../main/repos'

/**
 * The window's store driven through the main process's real RepoManager over real git: the IPC
 * bridge is replaced by direct calls, nothing else is. The store reads `window.gitgoose` when it
 * loads, so the bridge and the few browser globals boot() touches are set up first.
 */
async function windowWith(manager: RepoManager, openRepos: string[], hold: Promise<void>, asked: () => void) {
  const listeners: ((e: GitGooseEvent) => void)[] = []
  const api: Record<string, unknown> = {
    onEvent: (l: (e: GitGooseEvent) => void) => void listeners.push(l),
    getSettings: async () => ({ ...defaultSettings(), openRepos }),
    setSettings: async () => ({ ...defaultSettings(), openRepos }),
    openRepo: (path: string) => manager.openPath(path),
    // Held back, like a first page that takes a while to arrive, until the test lets it through.
    logPage: async (id: string, offset: number, count: number): Promise<LogPage> => {
      asked()
      await hold
      return manager.get(id).logPage(offset, count)
    },
  }
  // Everything else (sidebar lists, GitHub status, ...) fails, which the store tolerates.
  const bridge = new Proxy(api, { get: (t, k: string) => t[k] ?? (async () => { throw new Error(`${k} not in this test`) }) })
  Object.assign(globalThis, {
    window: { gitgoose: bridge },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    document: { documentElement: { dataset: {}, style: { setProperty: () => {} } } },
  })
  const store = await import('./store')
  return { store, push: (e: GitGooseEvent) => listeners.forEach((l) => l(e)) }
}

describe('restoring tabs at startup', () => {
  let manager: RepoManager | null = null
  afterEach(async () => {
    await manager?.closeAll()
    manager = null
  })

  it('shows a change made while the tab was on its way, not the older answer to openRepo', async () => {
    const r = makeFixture('linear')
    const env = r.env() as Record<string, string>
    const probe = await Repo.open(r.dir, { env })
    const path = probe.path
    probe.dispose()
    let push: (e: GitGooseEvent) => void = () => {}
    manager = new RepoManager(() => ({ gitPath: 'git', env }), (snapshot) => push({ type: 'snapshot', snapshot }), () => {}, () => {})
    manager.preopen(path)

    let release!: () => void
    const hold = new Promise<void>((done) => (release = done))
    let asked!: () => void
    const pageAsked = new Promise<void>((done) => (asked = done))
    const w = await windowWith(manager, [path], hold, asked)
    push = w.push
    const booting = w.store.boot()

    // openRepo has answered and the first page is on its way: a file changes, the main process
    // notices and pushes the new snapshot before the tab exists.
    await pageAsked
    r.write('new.txt', 'made while the tab was loading\n')
    const id = manager.all()[0]!.id
    await manager.refresh(id)

    release()
    await booting
    const view = w.store.useStore.getState().repos[id]!
    expect(view.snapshot.status.map((e) => e.path)).toContain('new.txt')
  })
})
