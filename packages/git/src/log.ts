import type { Commit } from '@gitsquid/shared'
import type { ChildProcess } from 'node:child_process'
import type { GitRunner } from './runner'

/**
 * One commit per record. Fields are separated by NUL (%x00) and records end with RS (%x1e).
 * NUL cannot appear in any of these fields, and %s (the subject) never contains a newline,
 * so this is unambiguous no matter what people put in their commit messages.
 */
export const LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s%x1e'
const RS = '\x1e'

export function parseLogRecord(record: string): Commit | null {
  // git puts a newline after each formatted record; it ends up at the start of the next one.
  const r = record.startsWith('\n') ? record.slice(1) : record
  if (!r) return null
  const f = r.split('\x00')
  if (f.length < 7) return null
  return {
    hash: f[0]!,
    parents: f[1] ? f[1].split(' ') : [],
    authorName: f[2]!,
    authorEmail: f[3]!,
    authorDate: Number(f[4]),
    commitDate: Number(f[5]),
    subject: f.slice(6).join('\x00'),
  }
}

export function parseLog(output: string): Commit[] {
  const commits: Commit[] = []
  for (const rec of output.split(RS)) {
    const c = parseLogRecord(rec)
    if (c) commits.push(c)
  }
  return commits
}

/** Incremental parser: feed it chunks of stdout, get back the commits completed so far. */
export class LogParser {
  private pending = ''

  push(chunk: string): Commit[] {
    this.pending += chunk
    const parts = this.pending.split(RS)
    this.pending = parts.pop()!
    const out: Commit[] = []
    for (const p of parts) {
      const c = parseLogRecord(p)
      if (c) out.push(c)
    }
    return out
  }
}

/** The revisions the graph shows: every branch, remote branch and tag, plus HEAD (detached or not). */
export const GRAPH_REVS = ['--branches', '--remotes', '--tags', 'HEAD']

/**
 * GRAPH_REVS for a repository whose HEAD may be unborn (a new repo, or `checkout --orphan`).
 * Naming an unborn HEAD makes `git log` fail, which would hide every other branch.
 */
export function graphRevs(headHash: string | undefined): string[] {
  return headHash ? GRAPH_REVS : GRAPH_REVS.filter((r) => r !== 'HEAD')
}

/**
 * One `git log` walk over the whole history, read only as far as the UI has asked for.
 *
 * Paging with `--skip=N` would make git re-walk N commits for every page, so page 50 costs 50x
 * page 1. Instead we keep a single process open and use stream backpressure: when we have
 * buffered enough commits beyond what was requested, we pause stdout. The OS pipe fills up,
 * git blocks on write, and costs nothing until we resume.
 */
export class LogStream {
  readonly commits: Commit[] = []
  done = false
  error: Error | null = null
  private child: ChildProcess | null = null
  private parser = new LogParser()
  private waiters: { need: number; resolve: () => void }[] = []
  private want = 0
  private stashSet: Set<string>
  /** Index and untracked-files commits of stashes: never shown. */
  private hidden = new Set<string>()

  constructor(
    private runner: GitRunner,
    private revs: string[] = GRAPH_REVS,
    /** How far beyond the last request to read before pausing. */
    private readAhead = 2000,
    /** Stash commits to show in the graph, each attached to the commit it was made on. */
    stashes: string[] = [],
  ) {
    this.stashSet = new Set(stashes)
    this.revs = [...revs, ...stashes]
  }

  /**
   * A stash is a merge commit: parent 1 is where it was made, parent 2 the staged changes, parent
   * 3 (with -u) the untracked files. In the graph it should look like one node beside its base,
   * so it keeps only parent 1, and the helper commits (reachable from nothing else) are dropped.
   * --topo-order puts a stash before its parents, so they are known by the time they arrive.
   */
  private accept(c: Commit): boolean {
    if (this.hidden.has(c.hash)) return false
    if (this.stashSet.has(c.hash)) {
      for (const p of c.parents.slice(1)) this.hidden.add(p)
      c.parents = c.parents.slice(0, 1)
      c.stash = true
    }
    return true
  }

  private start(): void {
    const child = this.runner.spawn(
      ['log', '--topo-order', `--format=${LOG_FORMAT}`, ...this.revs, '--'],
      { readOnly: true },
    )
    this.child = child
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      for (const c of this.parser.push(chunk)) if (this.accept(c)) this.commits.push(c)
      this.settle()
      if (this.commits.length >= this.want + this.readAhead) child.stdout!.pause()
    })
    let stderr = ''
    child.stderr!.on('data', (b: Buffer) => (stderr += b.toString('utf8')))
    child.on('close', (code, signal) => {
      this.done = true
      // A kill from dispose() is not an error. Anything else that fails is reported, not hidden.
      if (code !== 0 && !signal && !this.disposed) this.error = new Error(stderr.trim() || `git log exited with ${code}`)
      this.settle()
    })
    child.on('error', (e) => {
      this.done = true
      this.error = e
      this.settle()
    })
  }

  private settle(): void {
    this.waiters = this.waiters.filter((w) => {
      if (this.done || this.commits.length >= w.need) {
        w.resolve()
        return false
      }
      return true
    })
  }

  /** Resolve once at least `count` commits are buffered (or the log ended). */
  async ensure(count: number): Promise<void> {
    if (!this.child) this.start()
    this.want = Math.max(this.want, count)
    if (this.child?.stdout?.isPaused() && this.commits.length < this.want + this.readAhead) {
      this.child.stdout.resume()
    }
    if (this.done || this.commits.length >= count) return
    await new Promise<void>((resolve) => this.waiters.push({ need: count, resolve }))
    if (this.error) throw this.error
  }

  async page(offset: number, count: number): Promise<{ commits: Commit[]; done: boolean }> {
    await this.ensure(offset + count)
    const commits = this.commits.slice(offset, offset + count)
    return { commits, done: this.done && offset + count >= this.commits.length }
  }

  private disposed = false

  dispose(): void {
    this.disposed = true
    this.child?.kill()
    this.child = null
    this.done = true
    this.settle()
  }
}
