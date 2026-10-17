import { Repo } from '@gitsquid/git'
import type { RepoSnapshot } from '@gitsquid/shared'
import watcher from '@parcel/watcher'
import { relative, sep } from 'node:path'

interface Open {
  repo: Repo
  subscriptions: watcher.AsyncSubscription[]
  timer: NodeJS.Timeout | null
  lastJson: string
}

/** Paths whose changes never affect what we show. Objects change on every commit but refs and the index cover it. */
const IGNORE = ['.git/objects', '.git/lfs', 'node_modules', '.git/fsmonitor--daemon']

/**
 * Open repositories and their file watchers.
 *
 * A change anywhere in the working tree or .git schedules one refresh 100 ms later; more
 * changes inside that window fold into the same refresh (debouncing). A checkout that touches
 * 10,000 files costs one `git status`, not 10,000. A snapshot is only sent to the renderer when
 * it differs from the last one, so our own index.lock churn does not cause re-renders.
 */
export class RepoManager {
  private open = new Map<string, Open>()

  constructor(
    private options: () => { gitPath: string; env: Record<string, string> },
    private emit: (snapshot: RepoSnapshot) => void,
    private onProgress: (repoId: string, text: string | null) => void,
    private onWorktree: (repoId: string) => void,
  ) {}

  get(id: string): Repo {
    const o = this.open.get(id)
    if (!o) throw new Error(`Repository ${id} is not open`)
    return o.repo
  }

  all(): Repo[] {
    return [...this.open.values()].map((o) => o.repo)
  }

  findByPath(path: string): Repo | undefined {
    for (const o of this.open.values()) if (o.repo.path === path) return o.repo
    return undefined
  }

  async add(repo: Repo): Promise<RepoSnapshot> {
    const entry: Open = { repo, subscriptions: [], timer: null, lastJson: '' }
    this.open.set(repo.id, entry)
    const snapshot = await repo.snapshot()
    entry.lastJson = JSON.stringify(snapshot)
    const onEvents = (err: Error | null) => {
      if (!err) this.schedule(repo.id)
    }
    const ignore = IGNORE.map((p) => p.split('/').join(sep))
    try {
      entry.subscriptions.push(await watcher.subscribe(repo.path, onEvents, { ignore }))
      // Linked worktrees keep their git dir outside the working tree; watch it too.
      const rel = relative(repo.path, repo.gitDir)
      if (rel.startsWith('..')) {
        entry.subscriptions.push(await watcher.subscribe(repo.gitDir, onEvents, { ignore: ['objects', 'lfs'] }))
      }
    } catch {
      // No watcher (e.g. a network drive): the window-focus refresh still keeps us current.
    }
    // After the first screen is up, make sure later log walks are fast (ADR-004).
    setTimeout(() => void repo.maintainCommitGraph(), 1500)
    return snapshot
  }

  async openPath(path: string): Promise<RepoSnapshot> {
    const existing = this.findByPath(path)
    if (existing) return existing.snapshot()
    const { gitPath, env } = this.options()
    const repo = await Repo.open(path, { gitPath, env, onProgress: (t) => this.onProgress(repo.id, t) })
    if (this.findByPath(repo.path)) {
      // Opened from a subdirectory of a repo that is already open.
      const known = this.findByPath(repo.path)!
      repo.dispose()
      return known.snapshot()
    }
    return this.add(repo)
  }

  schedule(id: string, delay = 100): void {
    const o = this.open.get(id)
    if (!o) return
    if (o.timer) clearTimeout(o.timer)
    o.timer = setTimeout(() => {
      o.timer = null
      void this.refresh(id).then(() => this.onWorktree(id))
    }, delay)
  }

  async refresh(id: string): Promise<RepoSnapshot | null> {
    const o = this.open.get(id)
    if (!o) return null
    try {
      const snapshot = await o.repo.snapshot()
      const json = JSON.stringify(snapshot)
      if (json !== o.lastJson) {
        o.lastJson = json
        this.emit(snapshot)
      }
      return snapshot
    } catch {
      return null
    }
  }

  refreshAll(): void {
    for (const id of this.open.keys()) void this.refresh(id)
  }

  async close(id: string): Promise<string | null> {
    const o = this.open.get(id)
    if (!o) return null
    this.open.delete(id)
    if (o.timer) clearTimeout(o.timer)
    await Promise.all(o.subscriptions.map((s) => s.unsubscribe()))
    o.repo.dispose()
    return o.repo.path
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((id) => this.close(id)))
  }
}
