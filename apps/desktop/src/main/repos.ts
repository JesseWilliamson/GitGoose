import { Repo } from '@gitgoose/git'
import { FIRST_LOG_PAGE, type CommitOrder, type GraphFilter, type RepoSnapshot } from '@gitgoose/shared'
import type { AsyncSubscription } from '@parcel/watcher'
import { relative, sep } from 'node:path'

interface Open {
  repo: Repo
  subscriptions: AsyncSubscription[]
  /** Setting up the watchers, which starts after the first snapshot has gone back (see `add`). */
  watching: Promise<void>
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
 * The native watcher module, loaded when the first repository opens rather than with the app:
 * loading it is ~25 ms the window would otherwise wait for.
 */
let watcherModule: Promise<typeof import('@parcel/watcher')> | null = null
const loadWatcher = () => (watcherModule ??= import('@parcel/watcher').then((m) => m.default))

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
  /** Opens in progress, by the path asked for: a second request for the same path joins the first. */
  private opening = new Map<string, Promise<RepoSnapshot>>()
  /** Repositories opened by `preopen` whose first snapshot no window has asked for yet. */
  private unclaimed = new Set<string>()

  constructor(
    private options: () => { gitPath: string; env: Record<string, string>; showStashes?: boolean; commitOrder?: CommitOrder; graphFilters?: Record<string, GraphFilter> },
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
    repo.setCommitOrder(this.options().commitOrder ?? 'date')
    const filter = this.options().graphFilters?.[repo.path]
    if (filter) repo.setGraphFilter(filter)
    const entry: Open = { repo, subscriptions: [], watching: Promise.resolve(), timer: null, lastJson: '', held: 0, fired: false }
    this.open.set(repo.id, entry)
    const snapshot = await repo.snapshot()
    entry.lastJson = JSON.stringify(snapshot)
    // Subscribing walks the whole working tree (inotify needs one watch per directory), so it
    // runs after the snapshot has gone back and the graph does not wait for it. What changes in
    // between is caught by the window-focus refresh, as it would be without a watcher.
    entry.watching = this.watch(entry)
    // After the first screen is up, make sure later log walks are fast (ADR-004).
    setTimeout(() => void repo.maintainCommitGraph(), 1500)
    this.hooks.opened?.(repo)
    return snapshot
  }

  private async watch(entry: Open): Promise<void> {
    const { repo } = entry
    const onEvents = (err: Error | null) => {
      if (!err) this.schedule(repo.id)
    }
    const ignore = IGNORE.map((p) => p.split('/').join(sep))
    try {
      const watcher = await loadWatcher()
      entry.subscriptions.push(await watcher.subscribe(repo.path, onEvents, { ignore }))
      // Linked worktrees keep their git dir outside the working tree; watch it too.
      const rel = relative(repo.path, repo.gitDir)
      if (rel.startsWith('..')) {
        entry.subscriptions.push(await watcher.subscribe(repo.gitDir, onEvents, { ignore: ['objects', 'lfs'] }))
      }
    } catch {
      // No watcher (e.g. a network drive): the window-focus refresh still keeps us current.
    }
  }

  async openPath(path: string): Promise<RepoSnapshot> {
    const existing = this.findByPath(path)
    if (existing) {
      // Opened ahead of the window (see preopen): the snapshot read then is still current, since
      // every refresh since replaced it, so the window need not wait for git to read it again.
      if (this.unclaimed.delete(existing.id) && existing.lastSnapshot) return existing.lastSnapshot
      return existing.snapshot()
    }
    const running = this.opening.get(path)
    if (running) {
      const snapshot = await running
      this.unclaimed.delete(snapshot.id)
      return snapshot
    }
    return this.track(path, this.openNew(path))
  }

  /**
   * Start opening a repository the window is about to ask for (the tabs restored at startup),
   * and read the first page of its log, while the window is still loading. That is a few hundred
   * milliseconds of git work the window would otherwise wait for after it has loaded. Failures
   * are left for the window's own request to report.
   */
  preopen(path: string): void {
    if (this.findByPath(path) || this.opening.has(path)) return
    const opening = this.track(path, this.openNew(path).then((snapshot) => {
      // Marked before `opening` resolves, so a window that joined this open unmarks it after.
      this.unclaimed.add(snapshot.id)
      void this.open.get(snapshot.id)?.repo.logPage(0, FIRST_LOG_PAGE).catch(() => {})
      return snapshot
    }))
    opening.catch(() => {})
  }

  private track(path: string, opening: Promise<RepoSnapshot>): Promise<RepoSnapshot> {
    const tracked = opening.finally(() => this.opening.delete(path))
    this.opening.set(path, tracked)
    return tracked
  }

  private async openNew(path: string): Promise<RepoSnapshot> {
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
    this.unclaimed.delete(id)
    this.hooks.closed?.(id)
    if (o.timer) clearTimeout(o.timer)
    // A subscription still being set up lands in `subscriptions` first, then goes with the rest.
    await o.watching
    await Promise.all(o.subscriptions.map((s) => s.unsubscribe()))
    o.repo.dispose()
    return o.repo.path
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((id) => this.close(id)))
  }
}
