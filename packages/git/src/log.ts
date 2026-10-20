import type { Commit, CommitOrder, GraphFilter, Person } from '@gitgoose/shared'
import type { ChildProcess } from 'node:child_process'
import type { GitRunner } from './runner'

/**
 * One commit per record. Fields are separated by NUL (%x00) and records end with RS (%x1e).
 * NUL cannot appear in any of these fields, and %s (the subject) never contains a newline,
 * so this is unambiguous no matter what people put in their commit messages.
 *
 * The co-author field asks git for the `Co-authored-by:` trailers only (key matching is
 * case-insensitive), values without the key, unfolded onto one line, several separated by US
 * (%x1f). git already read the whole commit object to produce %s, so this costs no extra walk.
 */
export const LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x1f)%x00%s%x1e'
const RS = '\x1e'
const US = '\x1f'

/**
 * "Grace Hopper <grace@example.com>" as a trailer writes it. A bare address with no name is
 * also valid and used (`Co-authored-by: grace@example.com`), and has to parse to the same
 * address as the bracketed form so the two cannot both show up as separate people.
 */
function parsePerson(value: string): Person | null {
  const v = value.trim()
  if (!v) return null
  const m = /^(.*?)\s*<([^>]*)>$/.exec(v)
  if (m) return { name: m[1]!.trim() || m[2]!, email: m[2]!.trim() }
  return { name: v, email: /^\S+@\S+$/.test(v) ? v : '' }
}

/**
 * Co-authors of one commit, or undefined when it has none (the common case, kept cheap: no
 * array is allocated). The author's own address and repeated addresses are dropped, so the UI
 * can show one avatar per person without checking.
 */
function parseCoAuthors(field: string, authorEmail: string): Person[] | undefined {
  if (!field) return undefined
  const seen = new Set([authorEmail.trim().toLowerCase()])
  const out: Person[] = []
  for (const part of field.split(US)) {
    const p = parsePerson(part)
    if (!p) continue
    const key = p.email.toLowerCase() || `name:${p.name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out.length ? out : undefined
}

export function parseLogRecord(record: string): Commit | null {
  // git puts a newline after each formatted record; it ends up at the start of the next one.
  const r = record.startsWith('\n') ? record.slice(1) : record
  if (!r) return null
  const f = r.split('\x00')
  if (f.length < 8) return null
  const authorEmail = f[3]!
  const coAuthors = parseCoAuthors(f[6]!, authorEmail)
  return {
    hash: f[0]!,
    parents: f[1] ? f[1].split(' ') : [],
    authorName: f[2]!,
    authorEmail,
    authorDate: Number(f[4]),
    commitDate: Number(f[5]),
    subject: f.slice(7).join('\x00'),
    ...(coAuthors ? { coAuthors } : {}),
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

/**
 * git's flag for a commit order. Both never print a parent above one of its children, which is
 * all the lane layout needs. --date-order is newest commit date first, as GitKraken and Tower
 * show it. --topo-order keeps each branch's commits in one block, so dates jump up and down.
 *
 * Both are topological sorts in git (date order only breaks ties by date), so both must be sure
 * no unprinted commit is a child of the next one before printing it. Without generation numbers
 * (the commit-graph file) that means walking all of history first; with them, the first page is
 * as quick as a plain `git log`. Measured in ADR-003.
 */
export function orderFlag(order: CommitOrder): string {
  return order === 'topo' ? '--topo-order' : '--date-order'
}

/** The revisions the graph shows: every branch, remote branch and tag, plus HEAD (detached or not). */
export const GRAPH_REVS = ['--branches', '--remotes', '--tags', 'HEAD']

/**
 * GRAPH_REVS for a repository whose HEAD may be unborn (a new repo, or `checkout --orphan`).
 * Naming an unborn HEAD makes `git log` fail, which would hide every other branch.
 */
export function graphRevs(headHash: string | undefined, filter?: GraphFilter, existing?: Set<string>): string[] {
  const head = headHash ? ['HEAD'] : []
  if (!filter || (!filter.hidden.length && !filter.solo.length)) return [...GRAPH_REVS.filter((r) => r !== 'HEAD'), ...head]
  if (filter.solo.length) {
    // Only refs that still exist: naming a deleted branch would make the whole walk fail.
    const solo = filter.solo.filter((r) => r.endsWith('/*') || !existing || existing.has(r))
    return [...solo.map((r) => (r.endsWith('/*') ? `--glob=${r}` : r)), ...head]
  }
  // --exclude applies to the next --branches / --remotes / --tags only, and takes names relative
  // to that namespace, so each group gets its own list.
  const ex = (prefix: string) => filter.hidden.filter((r) => r.startsWith(prefix)).map((r) => `--exclude=${r.slice(prefix.length)}`)
  return [...ex('refs/heads/'), '--branches', ...ex('refs/remotes/'), '--remotes', ...ex('refs/tags/'), '--tags', ...head]
}

/** Whether graphRevs walks from this ref: the same hide and solo rules, for one full ref name. */
export function graphShowsRef(name: string, filter?: GraphFilter): boolean {
  const matches = (r: string) => r === name || (r.endsWith('/*') && name.startsWith(r.slice(0, -1)))
  if (!filter) return true
  if (filter.solo.length) return filter.solo.some(matches)
  return !filter.hidden.some(matches)
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
    private order: CommitOrder = 'date',
  ) {
    this.stashSet = new Set(stashes)
    this.revs = [...revs, ...stashes]
  }

  /**
   * A stash is a merge commit: parent 1 is where it was made, parent 2 the staged changes, parent
   * 3 (with -u) the untracked files. In the graph it should look like one node beside its base,
   * so it keeps only parent 1, and the helper commits (reachable from nothing else) are dropped.
   * git never prints a parent before its children, so a stash's parents arrive after it.
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
      ['log', orderFlag(this.order), `--format=${LOG_FORMAT}`, ...this.revs, '--'],
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
