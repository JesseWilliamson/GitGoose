import { Repo } from '@gitgoose/git'
import type { GraphFilter, RepoSnapshot } from '@gitgoose/shared'
import watcher from '@parcel/watcher'
import { relative, sep } from 'node:path'

interface Open {
  repo: Repo
  subscriptions: watcher.AsyncSubscription[]
  timer: NodeJS.Timeout | null
  lastJson: string
  /** Writes of ours in flight (see `during`); watcher refreshes wait while this is above zero. */
  held: number
  /** The watcher fired while held: one refresh is owed when the write is done. */
  fired: boolean
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
 *
 * Our own writes run inside `during`, which holds the watcher back until they finish: a rebase
 * moves HEAD once per commit and stashes and unstashes around it, and the renderer must see
 * only the state it ends in, not every step on the way (each would reset the graph).
 */
export class RepoManager {
  private open = new Map<string, Open>()

  constructor(
    private options: () => { gitPath: string; env: Record<string, string>; showStashes?: boolean; graphFilters?: Record<string, GraphFilter> },
    private emit: (snapshot: RepoSnapshot) => void,
    private onProgress: (repoId: string, text: string | null) => void,
    private onWorktree: (repoId: string) => void,
    /** Who else keeps per-repository state (the code graph): told when one opens or closes. */
    private hooks: { opened?: (repo: Repo) => void; closed?: (repoId: string) => void } = {},
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
    repo.setShowStashes(this.options().showStashes ?? true)
    const filter = this.options().graphFilters?.[repo.path]
    if (filter) repo.setGraphFilter(filter)
    const entry: Open = { repo, subscriptions: [], timer: null, lastJson: '', held: 0, fired: false }
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
    this.hooks.opened?.(repo)
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
    if (o.held) {
      o.fired = true
      return
    }
    if (o.timer) clearTimeout(o.timer)
    o.timer = setTimeout(() => {
      o.timer = null
      void this.refresh(id).then(() => this.onWorktree(id))
    }, delay)
  }

  /**
   * Run one of our own writes. Watcher events during it are folded into a single refresh after
   * it, whether it succeeded or failed (a rebase that stops on conflicts must still show so).
   */
  async during<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const o = this.open.get(id)
    if (!o) return fn()
    if (o.timer) {
      // A refresh already scheduled would otherwise run mid-write; it happens afterwards instead.
      clearTimeout(o.timer)
      o.timer = null
      o.fired = true
    }
    o.held++
    try {
      return await fn()
    } finally {
      o.held--
      if (o.held === 0) {
        const fired = o.fired
        o.fired = false
        await this.refresh(id)
        if (fired) this.onWorktree(id)
      }
    }
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
    this.hooks.closed?.(id)
    if (o.timer) clearTimeout(o.timer)
    await Promise.all(o.subscriptions.map((s) => s.unsubscribe()))
    o.repo.dispose()
    return o.repo.path
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((id) => this.close(id)))
  }
}
