import { GraphStore } from '@gitgoose/codegraph/node'
import type { Repo } from '@gitgoose/git'
import type { CodeGraphStatus, RepoSnapshot } from '@gitgoose/shared'
import { utilityProcess, type UtilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { IndexerReply, IndexerRequest } from './indexer'

interface Tracked {
  repo: Repo
  dbFile: string
  status: CodeGraphStatus
  /** Which trees are known to be indexed (the keys the store uses). */
  trees: Set<string>
  /** Syncs in flight, by request id. */
  inFlight: Map<number, { what: string; resolve: (key?: string) => void; reject: (e: Error) => void }>
  /** The last requested sync of each tree, so a second caller waits on the same one. */
  latest: Map<string, Promise<string | undefined>>
  reader: GraphStore | null
  timer: NodeJS.Timeout | null
}

export interface CodeGraphOptions {
  /** Where databases live (one per repository). */
  dir: string
  /** The built utility-process entry (out/main/indexer.js). */
  modulePath: string
  /** Grammar files copied into resources (packaged), or null to resolve them from node_modules (development). */
  grammarDir: string | null
  gitOpts: () => { gitPath: string; env: Record<string, string> }
  enabled: () => boolean
  emit: (repoId: string, status: CodeGraphStatus) => void
}

/**
 * Keeps each open repository's code graph current (ADR-008).
 *
 * Owns the indexer utility process and talks to it with request ids. On open, and whenever
 * HEAD, the index or the working tree change, it asks for the three trees Peek and Impact
 * query (HEAD, index, worktree). A commit shown in a diff is indexed on demand through
 * `ensure`, which is cheap: only blobs the store has not seen are parsed.
 */
export class CodeGraphService {
  private child: UtilityProcess | null = null
  private tracked = new Map<string, Tracked>()
  private nextId = 1
  /** Unexpected exits in a row; after a few, stop restarting (something is wrong with the build). */
  private crashes = 0

  constructor(private opts: CodeGraphOptions) {}

  status(repoId: string): CodeGraphStatus {
    return this.tracked.get(repoId)?.status ?? { state: this.opts.enabled() ? 'indexing' : 'off', done: 0, total: 0 }
  }

  /** Start tracking a repository: open its database in the indexer and index it. */
  open(repo: Repo): void {
    if (!this.opts.enabled()) {
      this.opts.emit(repo.id, { state: 'off', done: 0, total: 0 })
      return
    }
    mkdirSync(this.opts.dir, { recursive: true })
    const dbFile = join(this.opts.dir, `${createHash('sha1').update(repo.commonDir).digest('hex').slice(0, 16)}.sqlite`)
    const t: Tracked = { repo, dbFile, status: { state: 'indexing', done: 0, total: 0 }, trees: new Set(), inFlight: new Map(), latest: new Map(), reader: null, timer: null }
    this.tracked.set(repo.id, t)
    this.send({ type: 'open', repoId: repo.id, path: repo.path, dbFile, grammarDir: this.opts.grammarDir, ...this.opts.gitOpts() })
    this.scheduleAll(repo.id, 0)
  }

  close(repoId: string): void {
    const t = this.tracked.get(repoId)
    if (!t) return
    this.tracked.delete(repoId)
    if (t.timer) clearTimeout(t.timer)
    t.repo.attachGraph(null)
    t.reader?.close()
    for (const p of t.inFlight.values()) p.reject(new Error('Repository closed'))
    this.send({ type: 'close', repoId })
    if (this.tracked.size === 0) this.stopChild()
  }

  /** Refs or status changed: HEAD, the index and the working tree may all differ now. */
  onSnapshot(repoId: string, _snap: RepoSnapshot): void {
    this.scheduleAll(repoId, 300)
  }

  /** Files changed on disk: the working tree differs. */
  onWorktree(repoId: string): void {
    const t = this.tracked.get(repoId)
    if (!t) return
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => {
      t.timer = null
      void this.sync(repoId, 'worktree').catch(() => {})
    }, 300)
  }

  /** Drop the database and index again from scratch. */
  async reindex(repoId: string): Promise<void> {
    const t = this.tracked.get(repoId)
    if (!t) return
    const repo = t.repo
    this.close(repoId)
    rmSync(t.dbFile, { force: true })
    rmSync(`${t.dbFile}-wal`, { force: true })
    rmSync(`${t.dbFile}-shm`, { force: true })
    this.open(repo)
  }

  /**
   * Wait until the tree a query needs is indexed: the working tree (rev null), the index
   * (rev ''), or a commit. Resolves at once when it already is; rejects when the graph is off.
   */
  async ensure(repoId: string, rev: string | null): Promise<void> {
    const t = this.tracked.get(repoId)
    if (!t) throw new Error('The code graph is off for this repository.')
    if (rev === null) await this.sync(repoId, 'worktree')
    else if (rev === '') await this.sync(repoId, 'index')
    else await this.sync(repoId, 'rev', rev)
  }

  dispose(): void {
    for (const id of [...this.tracked.keys()]) this.close(id)
    this.stopChild()
  }

  // ---------------------------------------------------------------- internals

  private scheduleAll(repoId: string, delay: number): void {
    const t = this.tracked.get(repoId)
    if (!t) return
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => {
      t.timer = null
      void Promise.all([this.sync(repoId, 'rev', 'HEAD'), this.sync(repoId, 'index'), this.sync(repoId, 'worktree')]).catch(() => {})
    }, delay)
  }

  /** One sync of a tree; concurrent callers for the same tree share it. */
  private sync(repoId: string, what: 'rev' | 'index' | 'worktree', rev?: string): Promise<string | undefined> {
    const t = this.tracked.get(repoId)
    if (!t) return Promise.reject(new Error('The code graph is off for this repository.'))
    const name = what === 'rev' ? `rev:${rev}` : what
    const running = t.latest.get(name)
    if (running) return running
    const id = this.nextId++
    const p = new Promise<string | undefined>((resolve, reject) => {
      t.inFlight.set(id, { what: name, resolve, reject })
      this.send({ type: 'sync', id, repoId, what, rev })
      this.update(t, { state: 'indexing' })
    }).finally(() => {
      if (t.latest.get(name) === p) t.latest.delete(name)
    })
    t.latest.set(name, p)
    return p
  }

  private update(t: Tracked, patch: Partial<CodeGraphStatus>): void {
    t.status = { ...t.status, ...patch }
    this.opts.emit(t.repo.id, t.status)
  }

  private onReply(m: IndexerReply): void {
    if (m.type === 'opened') return
    for (const t of this.tracked.values()) {
      const req = t.inFlight.get(m.id)
      if (!req) continue
      if (m.type === 'progress') {
        this.update(t, { state: 'indexing', done: m.done, total: m.total })
        return
      }
      t.inFlight.delete(m.id)
      if (m.type === 'error') {
        req.reject(new Error(m.message))
        if (t.inFlight.size === 0) this.update(t, { state: 'error', message: m.message })
        return
      }
      if (m.key) t.trees.add(m.key)
      t.trees.add(req.what)
      // The first result means the database exists: main can read it from now on.
      if (!t.reader && existsSync(t.dbFile)) {
        t.reader = new GraphStore(t.dbFile, true)
        t.repo.attachGraph(t.reader)
      }
      req.resolve(m.key)
      if (t.inFlight.size === 0) this.update(t, { state: 'ready', done: 0, total: 0, message: undefined })
      return
    }
  }

  private send(req: IndexerRequest): void {
    this.ensureChild().postMessage(req)
  }

  private ensureChild(): UtilityProcess {
    if (this.child) return this.child
    const child = utilityProcess.fork(this.opts.modulePath, [], { serviceName: 'GitGoose code indexer' })
    child.on('message', (m: IndexerReply) => this.onReply(m))
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      this.crashes++
      // Every request in flight is lost; say so, and the next request starts a new process.
      for (const t of this.tracked.values()) {
        for (const p of t.inFlight.values()) p.reject(new Error(`The code indexer stopped (exit code ${code}).`))
        t.inFlight.clear()
        t.latest.clear()
        if (t.status.state === 'indexing') this.update(t, { state: 'error', message: `The code indexer stopped (exit code ${code}).` })
      }
      if (this.crashes >= 3) {
        for (const t of this.tracked.values()) this.update(t, { state: 'error', message: 'The code indexer keeps stopping; it is off until GitGoose restarts.' })
        this.tracked.clear()
        return
      }
      // Repositories still open must be reopened in the new process before their next sync.
      for (const t of this.tracked.values()) this.send({ type: 'open', repoId: t.repo.id, path: t.repo.path, dbFile: t.dbFile, grammarDir: this.opts.grammarDir, ...this.opts.gitOpts() })
    })
    this.child = child
    return child
  }

  private stopChild(): void {
    const c = this.child
    this.child = null
    this.crashes = 0
    c?.kill()
  }
}
