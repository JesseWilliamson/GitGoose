import type {
  BisectState, BlameLine, ChangeInsights, CodePeek, ImpactResult, ReviewScope, ImageSide, LfsInfo, LfsLock, ChangedFile, CommandRecord, CommitOrder, GraphFilter, Identity, Person, Signature, Commit, CommitSummary, CommitDetails, ConflictFile, ConflictVersions, DiffOptions, DiffTarget, FileDiff, Head, PullMode,
  LogPage, Ref, Remote, RepoOperation, ReflogEntry, RepoSnapshot, ResetMode, Resolution, SearchField, SelectionRequest,
  StashEntry, StatusEntry, StraightTips, Submodule, UndoEntry, Worktree,
} from '@gitgoose/shared'
import { countConflicts } from '@gitgoose/shared'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, rm, stat, writeFile, chmod, mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { enclosingDefinition, findDefinitions, NOT_NAMES, parseGrep, type Definition } from '@gitgoose/codegraph'
import type { GraphStore } from '@gitgoose/codegraph/node'
import type { CodeContext } from '@gitgoose/shared'
import { parseBlame } from './blame'
import { coChanges, oldRanges, parseFilesPerCommit } from './insights'
import { changedSymbols, isTestPath, testsByName } from './impact'
import { globToRegExp, parseCustomChecks, parsePathInstructions, relevantGuidelines } from './reviewrules'
import { CatFile } from './catfile'
import { parseChangedFiles, parseDiff, untrackedDiff } from './diff'
import { graphRevs, graphShowsRef, LOG_FORMAT, LogStream, parseLog } from './log'
import { searchLog } from './search'
import { checkPlan, patchFor, splitUnits, type PlannedCommit, type RecomposeUnit } from './recompose'
import { buildPatch } from './patch'
import { parseRefs, REFS_FORMAT, trunkRefs } from './refs'
import { GitRunner } from './runner'
import { parseReflog, REFLOG_FORMAT } from './reflog'
import { parseStashList, STASH_FORMAT } from './stash'
import { parseWorktrees, realPathOf, samePath } from './worktree'
import { parseStatus } from './status'
import { UndoJournal, type UndoAction } from './undo'

export interface RepoOptions {
  gitPath?: string
  env?: Record<string, string>
  /** Called with progress text from long operations (fetch, push, clone); null when done. */
  onProgress?: (text: string | null) => void
}

const DIFF_ARGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']

function diffArgs(opts: DiffOptions = {}): string[] {
  // At least one context line: zero-context hunks need `git apply --unidiff-zero`, which line
  // staging deliberately does not use (it would also accept hunks that apply in the wrong place).
  const context = Math.max(1, Math.min(opts.context ?? 3, 100))
  return [...DIFF_ARGS, `-U${context}`, ...(opts.ignoreWhitespace ? ['-w'] : [])]
}

let nextRepoId = 1

/**
 * At most this many tips are checked for sitting straight on the trunk or HEAD, each with one
 * bounded rev-list. Real repositories have a handful; past this many the rest draw as before.
 */
const MAX_STRAIGHT_CANDIDATES = 64

/** Whether `git version` output names a git with `%(ahead-behind:...)` in for-each-ref (2.41+). */
export function supportsAheadBehind(version: string): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(version)
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major > 2 || (major === 2 && minor >= 41)
}

/** Whether `git version` output names a git whose `merge-tree --write-tree` takes `--merge-base` (2.40+). */
export function supportsMergeTreeBase(version: string): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(version)
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major > 2 || (major === 2 && minor >= 40)
}

/** The multi-valued config key that holds pinned branch names (shared by every worktree). */
const PIN_KEY = 'gitgoose.pin'

/**
 * One open repository. Reads run concurrently; anything that writes goes through `exclusive`,
 * a one-at-a-time queue, so two clicks can never race for .git/index.lock.
 */
export class Repo {
  readonly id: string
  readonly runner: GitRunner
  readonly cat: CatFile
  readonly journal = new UndoJournal()
  private log: LogStream | null = null
  private refsKey = ''
  private refsVersion = 0
  private last: RepoSnapshot | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private emptyTree: string | null = null

  private constructor(
    readonly path: string,
    readonly gitDir: string,
    /** Shared by all worktrees of a repository; holds objects/ and refs/. */
    readonly commonDir: string,
    private opts: RepoOptions,
  ) {
    this.id = `repo-${nextRepoId++}`
    this.runner = new GitRunner({ cwd: path, gitPath: opts.gitPath, env: opts.env })
    this.cat = new CatFile(this.runner)
  }

  /** Open the repository containing `dir` (any subdirectory works). */
  static async open(dir: string, opts: RepoOptions = {}): Promise<Repo> {
    const probe = new GitRunner({ cwd: dir, gitPath: opts.gitPath, env: opts.env })
    const { stdout } = await probe.run(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { readOnly: true })
    const [top, gitDir, commonDir] = stdout.trim().split('\n')
    if (!top || !gitDir || !commonDir) throw new Error(`${dir} is not inside a git working tree`)
    // --git-common-dir may be relative to the directory we ran in.
    return new Repo(resolve(top), resolve(gitDir), resolve(dir, commonDir), opts)
  }

  static async init(dir: string, opts: RepoOptions = {}): Promise<Repo> {
    await mkdir(dir, { recursive: true })
    await new GitRunner({ cwd: dir, gitPath: opts.gitPath, env: opts.env }).run(['init'])
    return Repo.open(dir, opts)
  }

  static async clone(url: string, parentDir: string, opts: RepoOptions = {}): Promise<Repo> {
    const name = basename(url.replace(/[/\\]+$/, '')).replace(/\.git$/, '') || 'repo'
    const runner = new GitRunner({ cwd: parentDir, gitPath: opts.gitPath, env: opts.env })
    await runner.run(['clone', '--progress', url, name], { onStderr: (t) => opts.onProgress?.(lastLine(t)) })
    opts.onProgress?.(null)
    return Repo.open(join(parentDir, name), opts)
  }

  get name(): string {
    return basename(this.path)
  }

  dispose(): void {
    this.log?.dispose()
    this.cat.dispose()
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private git(args: string[], opts?: Parameters<GitRunner['run']>[1]) {
    return this.runner.run(args, opts)
  }

  private read(args: string[]) {
    return this.runner.run(args, { readOnly: true }).then((r) => r.stdout)
  }

  // ---------------------------------------------------------------- snapshot

  private snapRunning: Promise<RepoSnapshot> | null = null
  private snapQueued: Promise<RepoSnapshot> | null = null

  /**
   * Read status and refs. Calls never overlap: if one is running, the caller gets the *next* run,
   * which starts after it. Overlapping runs could finish out of order, letting an old result
   * overwrite a newer one (and reset the log twice). Several callers waiting at once share one
   * queued run, so a burst of refreshes still costs at most two.
   */
  snapshot(): Promise<RepoSnapshot> {
    if (!this.snapRunning) {
      this.snapRunning = this.readSnapshot().finally(() => {
        this.snapRunning = null
      })
      return this.snapRunning
    }
    this.snapQueued ??= this.snapRunning.catch(() => {}).then(() => {
      this.snapQueued = null
      return this.snapshot()
    })
    return this.snapQueued
  }

  private async readSnapshot(): Promise<RepoSnapshot> {
    // straightTips needs git's version; asked once, alongside the reads below rather than after
    // them, so the first snapshot does not wait for one more process in a row.
    void this.hasAheadBehind()
    const [statusOut, refsOut] = await Promise.all([
      this.read(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']),
      this.read(['for-each-ref', `--format=${REFS_FORMAT}`]),
    ])
    const status = parseStatus(statusOut)
    const refs = parseRefs(refsOut)
    // Only trunk refs the graph walks: one it leaves out would hold lane 0 empty all the way down.
    const trunk = trunkRefs(refsOut, refs).filter((r) => graphShowsRef(r, this.filter))
    const stashes = this.showStashes ? await this.stashHashes() : []
    // Which tips sit straight on top of the trunk or HEAD depends only on the refs, HEAD and the
    // trunk, so it is worked out again only when those change (it walks history) and is part of
    // the key: a change relayouts the graph.
    const shapeKey = `${status.head.hash}|` + refs.map((r) => `${r.name}=${r.hash}`).join(',') + `|${trunk.join(',')}`
    if (shapeKey !== this.straightKey) {
      const trunkTips = refs.filter((r) => trunk.includes(r.name)).map((r) => r.hash)
      // Only a hint for drawing: if it fails, the graph draws as it would without it.
      this.straight = await this.straightTips(trunkTips, status.head.hash).catch(() => ({ overTrunk: [], overHead: [] }))
      this.straightKey = shapeKey
    }
    const straight = this.straight
    const key = `${this.order}|${status.head.branch}|${status.head.hash}|` + refs.map((r) => `${r.name}=${r.hash}`).join(',') + `|${stashes.join(',')}|${trunk.join(',')}` +
      `|${straight.overTrunk.join(',')}|${straight.overHead.join(',')}`
    if (key !== this.refsKey) {
      this.refsKey = key
      this.refsVersion++
      this.log?.dispose()
      this.log = null
    }
    this.last = {
      id: this.id, path: this.path, name: this.name,
      head: status.head, refs, status: status.entries,
      operation: this.operation(), refsVersion: this.refsVersion, filter: this.filter, trunk, order: this.order,
      graph: { straight },
      bisect: existsSync(join(this.gitDir, 'BISECT_START')) ? await this.bisectState() : undefined,
    }
    return this.last
  }

  private straight: StraightTips = { overTrunk: [], overHead: [] }
  private straightKey: string | null = null
  private aheadBehind: Promise<boolean> | null = null

  /**
   * The branch tips whose first-parent chain runs straight down to the trunk tip, or to HEAD, so
   * the graph can draw them continuing that lane instead of opening one to the right (ADR-003, "A
   * branch on top of a reserved line continues it"). The layout streams and cannot know this when
   * a tip arrives; git can, cheaply:
   *
   * 1. One for-each-ref over refs/heads and refs/remotes prints, for every ref, how far ahead of
   *    and behind each base it is (`%(ahead-behind:<base>)`, git 2.41+; one walk for all refs).
   *    A ref that is not behind and is ahead is a candidate: it contains the base.
   * 2. Containing the base is not enough: a branch that merged main contains main, but its own
   *    line (first parents) never reaches it. For each candidate, `rev-list --first-parent` over
   *    at most ahead + 1 commits must meet the base. Candidates are branches not merged yet, so
   *    they are few, and each check is bounded by the branch's own length.
   *
   * `trunkTips` are the hashes of the trunk refs (main, origin/main). When they differ, the base
   * is the one that contains the others (the newest); if they have diverged there is none, and
   * overTrunk is empty. Older git returns empty lists: the graph draws as it did before.
   */
  async straightTips(trunkTips: readonly string[], head: string | undefined): Promise<StraightTips> {
    const none: StraightTips = { overTrunk: [], overHead: [] }
    // The bases go inside a --format atom: take nothing there but a commit hash.
    const isHash = (h: string | undefined): h is string => !!h && /^[0-9a-f]{40,64}$/.test(h)
    const trunks = [...new Set(trunkTips)].filter(isHash)
    if (!isHash(head)) head = undefined
    const bases = [...new Set([...trunks, ...(head ? [head] : [])])]
    if (!bases.length || !(await this.hasAheadBehind())) return none
    const out = await this.read(['for-each-ref', `--format=%(refname)%00%(objectname)${bases.map((b) => `%00%(ahead-behind:${b})`).join('')}`,
      'refs/heads', 'refs/remotes'])
    // For each tip hash, ahead/behind against each base.
    const tips = new Map<string, { ahead: number; behind: number }[]>()
    for (const line of out.split('\n')) {
      const [name, hash, ...ab] = line.split('\x00')
      if (!name || !hash || name.endsWith('/HEAD') || tips.has(hash)) continue
      tips.set(hash, ab.map((s) => {
        const [ahead = NaN, behind = NaN] = s.split(' ').map(Number)
        return { ahead, behind }
      }))
    }
    const over = (tip: string, base: string) => {
      const r = tips.get(tip)?.[bases.indexOf(base)]
      return r && r.behind === 0 && r.ahead > 0 ? r.ahead : 0
    }
    // The trunk tip: the trunk ref that contains all the others.
    const trunk = trunks.find((t) => tips.has(t) && trunks.every((u) => u === t || over(t, u) > 0))

    const checks: { tip: string; trunk: number; head: number }[] = []
    for (const tip of tips.keys()) {
      const c = { tip, trunk: trunk ? over(tip, trunk) : 0, head: head ? over(tip, head) : 0 }
      if (c.trunk || c.head) checks.push(c)
    }
    const result: StraightTips = { overTrunk: [], overHead: [] }
    await Promise.all(checks.slice(0, MAX_STRAIGHT_CANDIDATES).map(async (c) => {
      const chain = (await this.read(['rev-list', '--first-parent', '-n', String(Math.max(c.trunk, c.head) + 1), c.tip, '--'])).split('\n')
      if (c.trunk && chain.slice(0, c.trunk + 1).includes(trunk!)) result.overTrunk.push(c.tip)
      if (c.head && chain.slice(0, c.head + 1).includes(head!)) result.overHead.push(c.tip)
    }))
    // Stable order, so the refs key does not change with the order the checks finish in.
    result.overTrunk.sort()
    result.overHead.sort()
    return result
  }

  /** `%(ahead-behind:...)` arrived in git 2.41. Asked once per repository. */
  private hasAheadBehind(): Promise<boolean> {
    this.aheadBehind ??= this.version().then(supportsAheadBehind)
    return this.aheadBehind
  }

  private gitVersion: Promise<string> | null = null

  /** `git version`, asked once per repository. */
  private version(): Promise<string> {
    this.gitVersion ??= this.read(['version']).catch(() => '')
    return this.gitVersion
  }

  get lastSnapshot(): RepoSnapshot | null {
    return this.last
  }

  operation(): RepoOperation {
    const has = (f: string) => existsSync(join(this.gitDir, f))
    // `git am` keeps its state in rebase-apply too; the "applying" marker tells them apart.
    if (has('rebase-apply/applying')) return 'am'
    if (has('rebase-merge') || has('rebase-apply')) return 'rebase'
    if (has('MERGE_HEAD')) return 'merge'
    if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
    if (has('REVERT_HEAD')) return 'revert'
    return null
  }

  private async head(): Promise<Head> {
    return (this.last ?? (await this.snapshot())).head
  }

  private async currentHead(): Promise<Head> {
    const out = await this.read(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=no'])
    return parseStatus(out).head
  }

  // ---------------------------------------------------------------- maintenance

  hasCommitGraph(): boolean {
    const info = join(this.commonDir, 'objects', 'info')
    return existsSync(join(info, 'commit-graph')) || existsSync(join(info, 'commit-graphs', 'commit-graph-chain'))
  }

  /**
   * Write git's commit-graph file if the repository lacks one (see ADR-004).
   *
   * `git log --date-order` (like --topo-order) must never emit a parent before its children.
   * Without generation numbers it can only prove that by walking the entire history first, so
   * the first page of a 100k-commit log waits ~500 ms for the whole walk. The commit-graph stores
   * generation numbers, letting git stream the order incrementally: the same first page takes ~10 ms. It is the same
   * cache `git gc` and `git maintenance` write; `--split` makes later writes incremental.
   *
   * Returns true if it wrote one. Respects core.commitGraph=false.
   */
  async maintainCommitGraph(opts: { force?: boolean } = {}): Promise<boolean> {
    if (!opts.force && this.hasCommitGraph()) return false
    const setting = await this.runner.run(['config', '--get', 'core.commitGraph'], { okCodes: [1], readOnly: true })
    if (setting.stdout.trim() === 'false') return false
    try {
      await this.runner.run(['commit-graph', 'write', '--reachable', '--split'])
      return true
    } catch {
      // Another git process holds the lock, or the repo is empty. It is only a cache.
      return false
    }
  }

  // ---------------------------------------------------------------- reading

  private filter: GraphFilter = { hidden: [], solo: [] }

  /** Hide or solo refs in the graph. A new filter means a new walk, like new refs do. */
  setGraphFilter(filter: GraphFilter): void {
    const next = { hidden: [...new Set(filter.hidden)].sort(), solo: [...new Set(filter.solo)].sort() }
    if (JSON.stringify(next) === JSON.stringify(this.filter)) return
    this.filter = next
    this.refsKey = ''
  }

  /** The revisions the graph (and search over it) walks. */
  private graphRevs(): string[] {
    const snap = this.last!
    return graphRevs(snap.head.hash, this.filter, new Set(snap.refs.map((r) => r.name)))
  }

  /** Show stashes as nodes in the graph (the showStashes setting). */
  private showStashes = true

  setShowStashes(show: boolean): void {
    if (show === this.showStashes) return
    this.showStashes = show
    // Force a new log (and a new refsVersion, so the renderer starts over too).
    this.refsKey = ''
  }

  /** The order the log lists commits in (the commitOrder setting). */
  private order: CommitOrder = 'date'

  /**
   * Date or topological order. Like a filter change, it means a new walk: the refs key is reset,
   * so the next snapshot bumps refsVersion and the renderer reloads the log once, from the top.
   */
  setCommitOrder(order: CommitOrder): void {
    if (order === this.order) return
    this.order = order
    this.refsKey = ''
  }

  /**
   * Stash commits, newest first, straight from the stash reflog file: no process, cheap enough
   * to read on every snapshot (dropping stash@{2} changes only the reflog, not refs/stash).
   */
  private async stashHashes(): Promise<string[]> {
    try {
      const text = await readFile(join(this.commonDir, 'logs', 'refs', 'stash'), 'utf8')
      return text.split('\n').filter(Boolean).map((l) => l.split(' ')[1]!).filter((h) => /^[0-9a-f]{40,64}$/.test(h)).reverse()
    } catch {
      return []
    }
  }

  async logPage(offset: number, count: number): Promise<LogPage> {
    if (!this.last) await this.snapshot()
    if (!this.log) {
      const stashes = this.showStashes ? await this.stashHashes() : []
      this.log = new LogStream(this.runner, this.graphRevs(), undefined, stashes, this.order)
    }
    const generation = this.refsVersion
    const log = this.log
    const { commits, done } = await log.page(offset, count)
    return { commits, done, generation }
  }

  async commitDetails(hash: string, opts: { stash?: boolean } = {}): Promise<CommitDetails> {
    const fmt = '%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s%x00%cn%x00%ce%x00%b'
    const out = await this.read(['show', '-s', `--format=${fmt}`, hash, '--'])
    const f = out.split('\x00')
    const parents = f[1] ? f[1].split(' ') : []
    const base = parents[0] ?? (await this.emptyTreeHash())
    const [ns, nm] = await Promise.all([
      this.read(['diff-tree', '-r', '-M', '-z', '--name-status', base, hash]),
      this.read(['diff-tree', '-r', '-M', '-z', '--numstat', base, hash]),
    ])
    const files = parseChangedFiles(ns, nm)
    // `git stash -u` stores untracked files in a third parent: a root commit holding only them.
    if (opts.stash && parents[2]) {
      const empty = await this.emptyTreeHash()
      const [uns, unm] = await Promise.all([
        this.read(['diff-tree', '-r', '-z', '--name-status', empty, parents[2]]),
        this.read(['diff-tree', '-r', '-z', '--numstat', empty, parents[2]]),
      ])
      files.push(...parseChangedFiles(uns, unm))
    }
    return {
      hash: f[0]!, parents, authorName: f[2]!, authorEmail: f[3]!,
      authorDate: Number(f[4]), commitDate: Number(f[5]), subject: f[6]!,
      committerName: f[7]!, committerEmail: f[8]!, body: (f[9] ?? '').trim(),
      files, signature: opts.stash ? undefined : await this.signature(hash),
    }
  }

  /**
   * Verify a commit's signature, if it has one. Verifying runs gpg (or ssh-keygen), so it is done
   * only for signed commits, found by the gpgsig header in the raw object; a failure to verify is
   * reported as "cannot check", never as an error that would hide the commit's details.
   */
  private async signature(hash: string): Promise<Signature | undefined> {
    const raw = await this.read(['cat-file', 'commit', hash])
    const headers = raw.slice(0, raw.indexOf('\n\n'))
    if (!/^gpgsig(-sha256)? /m.test(headers)) return undefined
    try {
      const out = (await this.runner.run(['show', '-s', '--format=%G?%x00%GS%x00%GK', hash, '--'], { readOnly: true, okCodes: [1, 128] })).stdout
      const [status = 'E', signer, key] = out.trim().split('\0')
      return { status: (/^[GUXYRB]$/.test(status) ? status : 'E') as Signature['status'], signer: signer || undefined, key: key || undefined }
    } catch {
      return { status: 'E' }
    }
  }

  private async emptyTreeHash(): Promise<string> {
    // Works for SHA-1 and SHA-256 repositories alike, unlike hard-coding 4b825dc...
    this.emptyTree ??= (await this.runner.run(['hash-object', '-t', 'tree', '--stdin'], { input: '', readOnly: true })).stdout.trim()
    return this.emptyTree
  }

  async diff(target: DiffTarget, opts: DiffOptions = {}): Promise<FileDiff | null> {
    const DIFF_ARGS = diffArgs(opts)
    if (target.kind === 'untracked') {
      const content = await readFile(join(this.path, target.path))
      return untrackedDiff(target.path, content)
    }
    let args: string[]
    if (target.kind === 'unstaged') {
      args = ['diff', ...DIFF_ARGS, '--', target.path]
    } else if (target.kind === 'staged') {
      const entry = (this.last ?? (await this.snapshot())).status.find((e) => e.path === target.path)
      const paths = entry?.origPath ? [entry.origPath, target.path] : [target.path]
      args = ['diff', '--cached', '-M', ...DIFF_ARGS, '--', ...paths]
    } else if (target.kind === 'range') {
      const paths = target.oldPath ? [target.oldPath, target.path] : [target.path]
      args = ['diff', '-M', ...DIFF_ARGS, target.from, ...(target.to ? [target.to] : []), '--', ...paths]
    } else {
      const parents = (await this.read(['rev-list', '--parents', '-n', '1', target.hash])).trim().split(' ').slice(1)
      let base = parents[0] ?? (await this.emptyTreeHash())
      let rev = target.hash
      const files = parseChangedFiles(await this.read(['diff-tree', '-r', '-M', '-z', '--name-status', base, target.hash]), '')
      const f = files.find((x) => x.path === target.path)
      if (!f && parents[2]) {
        // An untracked file saved by `git stash -u` (see commitDetails).
        base = await this.emptyTreeHash()
        rev = parents[2]
      }
      const paths = f?.oldPath ? [f.oldPath, target.path] : [target.path]
      args = ['diff', '-M', ...DIFF_ARGS, base, rev, '--', ...paths]
    }
    const out = await this.read(args)
    const parsed = parseDiff(out, target.path)
    return parsed[0] ?? null
  }

  /**
   * Both versions of an image for a diff target, read only when an image diff is shown. A side
   * is null when the file does not exist there (added, deleted); over `cap` bytes, only its size
   * comes back, so a huge asset never crosses IPC.
   */
  async imagePair(target: DiffTarget, cap = 25 * 1024 * 1024): Promise<{ old: ImageSide | null; new: ImageSide | null }> {
    const fromRev = async (spec: string): Promise<ImageSide | null> => {
      const sz = await this.runner.run(['cat-file', '-s', spec], { readOnly: true, okCodes: [128] })
      if (sz.code !== 0) return null
      const size = Number(sz.stdout.trim())
      if (size > cap) return { size }
      const blob = await this.fileAtSpec(spec)
      // An LFS-tracked image is stored as a small pointer: show the real file when it is local.
      const real = size < 400 ? await this.lfsContent(blob) : null
      if (real) return real.length > cap ? { size: real.length } : { size: real.length, data: new Uint8Array(real) }
      return { size, data: new Uint8Array(blob) }
    }
    const fromDisk = async (path: string): Promise<ImageSide | null> => {
      const st = await lstat(join(this.path, path)).catch(() => null)
      if (!st?.isFile()) return null
      return st.size > cap ? { size: st.size } : { size: st.size, data: new Uint8Array(await readFile(join(this.path, path))) }
    }
    const p = target.path
    switch (target.kind) {
      case 'untracked': return { old: null, new: await fromDisk(p) }
      case 'unstaged': return { old: await fromRev(`:${p}`), new: await fromDisk(p) }
      case 'staged': {
        const entry = (this.last ?? (await this.snapshot())).status.find((e) => e.path === p)
        return { old: await fromRev(`HEAD:${entry?.origPath ?? p}`), new: await fromRev(`:${p}`) }
      }
      case 'range': return { old: await fromRev(`${target.from}:${target.oldPath ?? p}`), new: target.to ? await fromRev(`${target.to}:${p}`) : await fromDisk(p) }
      case 'commit': {
        const parents = (await this.read(['rev-list', '--parents', '-n', '1', target.hash])).trim().split(' ').slice(1)
        const files = parents[0] ? parseChangedFiles(await this.read(['diff-tree', '-r', '-M', '-z', '--name-status', parents[0], target.hash]), '') : []
        const f = files.find((x) => x.path === p)
        // A file a stash saved as untracked lives in its third parent (see commitDetails).
        if (!f && parents[2] && !(await fromRev(`${target.hash}:${p}`))) return { old: null, new: await fromRev(`${parents[2]}:${p}`) }
        return { old: parents[0] ? await fromRev(`${parents[0]}:${f?.oldPath ?? p}`) : null, new: await fromRev(`${target.hash}:${p}`) }
      }
    }
  }

  /**
   * Open a diff in the user's external diff tool (`git difftool`), which waits until the tool
   * is closed. It does not take the write lock: it only reads, and a tool can stay open for long.
   */
  async diffTool(target: DiffTarget, tool?: string): Promise<void> {
    const t = tool ? [`--tool=${tool}`] : []
    const base = ['difftool', '--no-prompt', ...t]
    let args: string[]
    switch (target.kind) {
      case 'unstaged': args = [...base, '--', target.path]; break
      case 'staged': args = [...base, '--cached', '--', target.path]; break
      case 'untracked': throw new Error('An untracked file has nothing to compare with yet: stage it to diff it against nothing.')
      case 'range': args = [...base, target.from, ...(target.to ? [target.to] : []), '--', ...(target.oldPath ? [target.oldPath] : []), target.path]; break
      case 'commit': {
        const parent = (await this.read(['rev-list', '--parents', '-n', '1', target.hash])).trim().split(' ')[1]
        args = [...base, parent ?? (await this.emptyTreeHash()), target.hash, '--', target.path]
      }
    }
    await this.runner.run(args, { readOnly: true })
  }

  /**
   * Resolve a conflicted file in the user's merge tool (`git mergetool`). git marks the file
   * resolved when the tool reports success (or the file changed, per mergetool.<tool>.trustExitCode).
   * Outside the write lock, like diffTool: the tool stays open while the user works; the
   * snapshot that follows shows the result.
   */
  async mergeTool(path: string, tool?: string): Promise<void> {
    await this.runner.run(['mergetool', '--no-prompt', ...(tool ? [`--tool=${tool}`] : []), '--', path])
    void this.snapshot()
  }

  private async fileAtSpec(spec: string): Promise<Buffer> {
    return (await this.runner.runBuffer(['cat-file', 'blob', spec], { readOnly: true })).stdout
  }

  /**
   * Files that differ between two revisions, or a revision and the working tree (`to` null:
   * tracked files only, like `git diff <rev>`).
   */
  async compareFiles(from: string, to: string | null): Promise<ChangedFile[]> {
    const revs = [from, ...(to ? [to] : [])]
    const [ns, nm] = await Promise.all([
      this.read(['diff', '-M', '-z', '--name-status', ...revs, '--']),
      this.read(['diff', '-M', '-z', '--numstat', ...revs, '--']),
    ])
    return parseChangedFiles(ns, nm)
  }

  /** The best common ancestor of two revisions (where one forked from the other). */
  async mergeBase(a: string, b: string): Promise<string> {
    return (await this.read(['merge-base', a, b])).trim()
  }

  /** A file's bytes as of a revision (to open or save it). */
  async fileAt(rev: string, path: string): Promise<Buffer> {
    return (await this.runner.runBuffer(['show', `${rev}:${path}`], { readOnly: true })).stdout
  }

  /**
   * Put a file in the working tree back to its content at `rev` (or delete it, when it did not
   * exist there). The current content is saved first, so it can be undone.
   */
  /**
   * Write a file as of `rev` into the working copy (or delete it if `rev` does not have it).
   * With `stash`, `rev` is a stash commit: a file stashed with -u lives in its third parent.
   */
  restoreFile(path: string, rev: string, opts: { stash?: boolean } = {}): Promise<number> {
    return this.exclusive(async () => {
      const saved = await this.saveFiles([path])
      const has = async (r: string) => (await this.runner.run(['cat-file', '-e', `${r}:${path}`], { okCodes: [128, 1], readOnly: true })).code === 0
      let exists = await has(rev)
      if (!exists && opts.stash && (await has(`${rev}^3`))) {
        rev = `${rev}^3`
        exists = true
      }
      if (exists) await this.git(['restore', `--source=${rev}`, '--worktree', '--', path])
      else await rm(join(this.path, path), { force: true })
      return this.record(`Restore ${path} from ${rev.slice(0, 7)}`, [{ kind: 'restore-files', files: saved }], (await this.currentHead()).hash)
    })
  }

  async fileHistory(path: string): Promise<Commit[]> {
    return parseLog(await this.read(['log', '--follow', `--format=${LOG_FORMAT}`, '-n', '1000', '--', path]))
  }

  async blame(path: string, rev?: string): Promise<BlameLine[]> {
    return parseBlame(await this.read(['blame', '--porcelain', ...(rev ? [rev] : []), '--', path]))
  }

  /** The all-fields search in flight: a newer one cancels it (typing fires one per pause). */
  private searching: AbortController | null = null

  /** Every file in the working tree, tracked or not (ignored ones left out), for finding files by name. */
  async listFiles(limit = 200_000): Promise<string[]> {
    const out = await this.read(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    // A file with conflicts is listed once per stage.
    return [...new Set(out.split('\0').filter(Boolean))].slice(0, limit)
  }

  /** search(), plus what the first `limit` hits are (subject, author, date), for showing them as results. */
  async searchCommits(field: SearchField, query: string, limit = 20): Promise<{ total: number; commits: CommitSummary[] }> {
    const hashes = await this.search(field, query)
    if (!hashes.length) return { total: 0, commits: [] }
    const raw = await this.read(['log', '--no-walk=unsorted', '-z', '--format=%H%x00%s%x00%an%x00%ae%x00%at', ...hashes.slice(0, limit), '--'])
    const f = raw.split('\0')
    const commits: CommitSummary[] = []
    for (let i = 0; i + 4 < f.length; i += 5) {
      commits.push({ hash: f[i]!.trim(), subject: f[i + 1]!, authorName: f[i + 2]!, authorEmail: f[i + 3]!, authorDate: Number(f[i + 4]) })
    }
    return { total: hashes.length, commits }
  }

  async search(field: SearchField, query: string): Promise<string[]> {
    const q = query.trim()
    if (!q) return []
    const snap = this.last ?? (await this.snapshot())
    const head = snap.head
    if (field === 'all') {
      this.searching?.abort()
      const abort = (this.searching = new AbortController())
      const refNames = new Map<string, string[]>()
      for (const r of snap.refs) {
        if (r.kind === 'stash') continue
        const list = refNames.get(r.hash)
        if (list) list.push(r.shortName)
        else refNames.set(r.hash, [r.shortName])
      }
      try {
        return await searchLog(this.runner, this.graphRevs(), q, { refNames, signal: abort.signal, order: this.order })
      } finally {
        if (this.searching === abort) this.searching = null
      }
    }
    const base = ['log', '--format=%H', '-n', '2000', ...this.graphRevs()]
    let args: string[]
    switch (field) {
      case 'message': args = [...base, '-i', '-F', `--grep=${q}`, '--']; break
      case 'author': args = [...base, '-i', '-F', `--author=${q}`, '--']; break
      case 'content': args = [...base, `-S${q}`, '--']; break
      case 'path': args = [...base, '--', `:(glob,icase)**/*${q}*`, `:(glob,icase)**/*${q}*/**`]; break
      case 'hash': {
        try {
          const h = await this.read(['rev-parse', '--verify', '--quiet', `${q}^{commit}`])
          return h.trim() ? [h.trim()] : []
        } catch {
          return []
        }
      }
    }
    // Path search is the one place that wants pathspec magic (glob, icase); everything else is literal.
    const env = field === 'path' ? { GIT_LITERAL_PATHSPECS: '0' } : undefined
    return (await this.runner.run(args, { readOnly: true, env })).stdout.split('\n').filter(Boolean)
  }

  async stashList(): Promise<StashEntry[]> {
    return parseStashList(await this.read(['stash', 'list', `--format=${STASH_FORMAT}`]))
  }

  /**
   * A ref's reflog, newest first, with the commits nothing else reaches marked lost. Finding
   * them is one `rev-list <hashes> --not --all`: it walks only what the refs do not already
   * reach, so its cost is the size of what was lost, not the size of the repository.
   */
  async reflog(ref = 'HEAD', limit = 300): Promise<ReflogEntry[]> {
    const out = await this.runner.run(['log', '-g', '--date=unix', `--format=${REFLOG_FORMAT}`, `-n${limit}`, ref, '--'], { readOnly: true, okCodes: [128] })
    if (out.code !== 0) return [] // no reflog yet (a fresh clone of an empty repository)
    const entries = parseReflog(out.stdout)
    const hashes = [...new Set(entries.map((e) => e.hash))]
    if (hashes.length) {
      const lost = new Set((await this.read(['rev-list', ...hashes, '--not', '--all'])).split('\n').filter(Boolean))
      for (const e of entries) if (lost.has(e.hash)) e.lost = true
    }
    return entries
  }

  async lastCommitMessage(): Promise<string> {
    try {
      return (await this.read(['log', '-1', '--format=%B'])).trim()
    } catch {
      return ''
    }
  }

  // ---------------------------------------------------------------- working tree
  //
  // Methods that can be undone return the id of the undo entry they recorded, or null when
  // nothing changed (a merge that was already up to date, say). The UI offers Undo only for an
  // id, and undo(id) refuses unless that entry is still the most recent one.

  private async freshStatus() {
    return parseStatus(await this.read(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']))
  }

  private record(label: string, actions: UndoAction[], expectHead: string | undefined): number {
    return this.journal.record(label, actions, expectHead).id
  }

  stagePaths(paths: string[]): Promise<void> {
    return this.exclusive(async () => {
      await this.git(['add', '-A', '--', ...paths])
    })
  }

  unstagePaths(paths: string[]): Promise<void> {
    return this.exclusive(async () => {
      const status = await this.freshStatus()
      // A staged rename is two index entries: unstaging the new name alone would leave the old
      // name staged as deleted. Unstage both halves.
      const all = new Set(paths)
      for (const e of status.entries) if (e.origPath && all.has(e.path)) all.add(e.origPath)
      const list = [...all]
      if (status.head.hash) await this.git(['reset', '-q', 'HEAD', '--', ...list])
      else await this.git(['rm', '--cached', '-r', '-q', '--', ...list])
    })
  }

  discardPaths(paths: string[]): Promise<number> {
    return this.exclusive(async () => {
      const status = await this.freshStatus()
      const saved = await this.saveFiles(paths)
      const untracked = new Set(status.entries.filter((e) => e.kind === 'untracked').map((e) => e.path))
      const tracked = paths.filter((p) => !untracked.has(p))
      for (const p of paths.filter((p) => untracked.has(p))) await rm(join(this.path, p), { force: true })
      if (tracked.length) await this.git(['checkout', '--', ...tracked])
      return this.record(`Discard changes in ${describePaths(paths)}`, [{ kind: 'restore-files', files: saved }], status.head.hash)
    })
  }

  ignorePaths(paths: string[]): Promise<number> {
    return this.exclusive(async () => {
      const file = join(this.path, '.gitignore')
      const saved = await this.saveFiles(['.gitignore'])
      let current = ''
      try {
        current = await readFile(file, 'utf8')
      } catch {
        // No .gitignore yet.
      }
      // A leading slash anchors the pattern to the repository root, so ignoring `build` here
      // does not also ignore every other folder called build. Escape characters that are
      // special in gitignore patterns so the exact path is matched.
      const lines = paths.map((p) => '/' + p.replace(/([\\*?[\]!# ])/g, '\\$1'))
      const sep = current && !current.endsWith('\n') ? '\n' : ''
      await writeFile(file, current + sep + lines.join('\n') + '\n')
      return this.record(`Ignore ${describePaths(paths)}`, [{ kind: 'restore-files', files: saved }], (await this.currentHead()).hash)
    })
  }

  /**
   * Copy working-tree files into the object database so a discard can be undone.
   * --no-filters stores the bytes exactly as they are on disk: no CRLF conversion and no LFS
   * clean filter, because undo writes them straight back.
   */
  private async saveFiles(paths: string[]): Promise<{ path: string; blob: string | null; mode?: number }[]> {
    const out: { path: string; blob: string | null; mode?: number }[] = []
    for (const p of paths) {
      const abs = join(this.path, p)
      try {
        const st = await lstat(abs)
        if (!st.isFile()) continue
        const { stdout } = await this.git(['hash-object', '-w', '--no-filters', '--', p])
        out.push({ path: p, blob: stdout.trim(), mode: st.mode & 0o777 })
      } catch {
        out.push({ path: p, blob: null })
      }
    }
    return out
  }

  applySelection(req: SelectionRequest): Promise<number | null> {
    return this.exclusive(async () => {
      let target = req.target
      if (target.kind === 'untracked') {
        if (req.action === 'discard') throw new Error('Discard lines of an untracked file by discarding the file')
        // Intent-to-add puts an empty entry in the index, so the file shows up in `git diff`
        // as an addition and its lines can be staged like any other change.
        await this.git(['add', '-N', '--', target.path])
        target = { kind: 'unstaged', path: target.path }
      }
      if (target.kind === 'staged' && req.action !== 'unstage') throw new Error('Staged changes can only be unstaged')
      if (target.kind === 'unstaged' && req.action === 'unstage') throw new Error('Unstaged changes cannot be unstaged')
      // The same context as the diff the user selected from, or hunk indexes would not match.
      const diff = await this.diff(target, { context: req.context })
      if (!diff) return null
      const reverse = req.action !== 'stage'
      const patch = buildPatch(diff, req.hunks, reverse)
      if (!patch) return null
      const args = ['apply', '--whitespace=nowarn', ...(req.action === 'discard' ? [] : ['--cached']), ...(reverse ? ['--reverse'] : []), '-']
      if (req.action === 'discard') {
        const head = await this.currentHead()
        const saved = await this.saveFiles([target.path])
        await this.git(args, { input: patch })
        return this.record(`Discard lines in ${target.path}`, [{ kind: 'restore-files', files: saved }], head.hash)
      }
      await this.git(args, { input: patch })
      return null
    })
  }

  /** `noVerify` skips the pre-commit and commit-msg hooks. */
  commit(message: string, opts: { amend?: boolean; signOff?: boolean; gpgSign?: boolean; noVerify?: boolean } = {}): Promise<number> {
    return this.exclusive(async () => {
      const before = await this.currentHead()
      const flags = [...(opts.amend ? ['--amend'] : []), ...(opts.signOff ? ['--signoff'] : []), ...(opts.gpgSign ? ['-S'] : []), ...(opts.noVerify ? ['--no-verify'] : [])]
      await this.git(['commit', '-F', '-', ...flags], { input: message })
      const after = await this.currentHead()
      const actions: UndoAction[] = before.hash
        ? [{ kind: 'reset', to: before.hash, mode: 'soft' }]
        : [{ kind: 'update-ref', ref: `refs/heads/${after.branch}`, to: null, from: after.hash! }]
      return this.record(opts.amend ? 'Amend commit' : `Commit "${firstLine(message)}"`, actions, after.hash)
    })
  }

  // ---------------------------------------------------------------- branches

  private async refs(): Promise<Ref[]> {
    return parseRefs(await this.read(['for-each-ref', `--format=${REFS_FORMAT}`]))
  }

  private async revParse(rev: string): Promise<string> {
    return (await this.read(['rev-parse', '--verify', '--quiet', rev])).trim()
  }

  /** Undo action that returns HEAD to where it is now. */
  private returnTo(head: Head): UndoAction {
    return head.branch && !head.detached
      ? { kind: 'checkout', target: head.branch, detach: false }
      : { kind: 'checkout', target: head.hash ?? 'HEAD', detach: true }
  }

  /** Check out a ref: a full ref name (refs/heads/x, refs/remotes/o/x, refs/tags/t) or a commit. */
  checkout(ref: string): Promise<number> {
    return this.exclusive(async () => {
      const before = await this.currentHead()
      const actions: UndoAction[] = [this.returnTo(before)]
      if (ref.startsWith('refs/heads/')) {
        await this.git(['checkout', ref.slice(11)])
      } else if (ref.startsWith('refs/remotes/')) {
        // Like GitKraken: checking out origin/feature checks out (or creates) a local `feature` tracking it.
        const remoteShort = ref.slice(13)
        const local = remoteShort.slice(remoteShort.indexOf('/') + 1)
        const refs = await this.refs()
        if (refs.some((r) => r.name === `refs/heads/${local}`)) await this.git(['checkout', local])
        else {
          await this.git(['checkout', '--track', '-b', local, remoteShort])
          actions.push({ kind: 'update-ref', ref: `refs/heads/${local}`, to: null, from: await this.revParse(`refs/heads/${local}`) })
        }
      } else {
        await this.git(['checkout', '--detach', ref.startsWith('refs/tags/') ? ref.slice(10) : ref])
      }
      const after = await this.currentHead()
      return this.record(`Check out ${shortName(ref)}`, actions, after.hash)
    })
  }

  createBranch(name: string, opts: { at?: string; checkout?: boolean } = {}): Promise<number> {
    return this.exclusive(async () => {
      const before = await this.currentHead()
      const at = opts.at ? [opts.at] : []
      if (opts.checkout) await this.git(['checkout', '-b', name, ...at])
      else await this.git(['branch', name, ...at])
      const actions: UndoAction[] = opts.checkout ? [this.returnTo(before)] : []
      actions.push({ kind: 'update-ref', ref: `refs/heads/${name}`, to: null, from: await this.revParse(`refs/heads/${name}`) })
      return this.record(`Create branch ${name}`, actions, (await this.currentHead()).hash)
    })
  }

  renameBranch(from: string, to: string): Promise<number> {
    return this.exclusive(() => this.rename(from, to))
  }

  /** Drag a branch onto a folder in the sidebar: `topic` dropped on `feature` becomes `feature/topic`. */
  renameBranchInto(branch: string, folder: string): Promise<number> {
    const base = branch.slice(branch.lastIndexOf('/') + 1)
    const to = `${folder.replace(/\/+$/, '')}/${base}`
    return this.exclusive(() => this.rename(branch, to, `Move ${branch} into ${folder}`))
  }

  /** `branch -m`, keeping a pin on the branch (git moves its other config, upstream included). */
  private async rename(from: string, to: string, label = `Rename ${from} to ${to}`): Promise<number> {
    await this.git(['branch', '-m', from, to])
    const actions: UndoAction[] = [{ kind: 'rename-branch', from: to, to: from }]
    if ((await this.pins()).includes(from)) {
      await this.git(['config', '--unset-all', '--fixed-value', PIN_KEY, from])
      await this.git(['config', '--add', PIN_KEY, to])
      // Undo runs these first, then renames back.
      actions.unshift({ kind: 'config-value', key: PIN_KEY, value: to, add: false }, { kind: 'config-value', key: PIN_KEY, value: from, add: true })
    }
    return this.record(label, actions, (await this.currentHead()).hash)
  }

  /**
   * When anything was last fetched here (FETCH_HEAD's time, unix seconds), or null when never.
   * A linked worktree writes its own FETCH_HEAD, so the newer of its and the main one counts.
   */
  async lastFetched(): Promise<number | null> {
    const times = await Promise.all([...new Set([this.gitDir, this.commonDir])].map((d) => stat(join(d, 'FETCH_HEAD')).then((s) => s.mtimeMs, () => 0)))
    const newest = Math.max(...times)
    return newest ? Math.floor(newest / 1000) : null
  }

  // ---------------------------------------------------------------- pins

  /** Pinned branch names, in the order they were pinned. Kept in git config, so every worktree sees them. */
  async pins(): Promise<string[]> {
    const r = await this.runner.run(['config', '--get-all', PIN_KEY], { readOnly: true, okCodes: [1] })
    return [...new Set(r.stdout.split('\n').filter(Boolean))]
  }

  /** Pin a branch to the top of the sidebar, or unpin it. Undoable; null when nothing changed. */
  pinBranch(branch: string, pin: boolean): Promise<number | null> {
    return this.exclusive(async () => {
      const pinned = (await this.pins()).includes(branch)
      if (pinned === pin) return null
      if (pin) await this.git(['config', '--add', PIN_KEY, branch])
      else await this.git(['config', '--unset-all', '--fixed-value', PIN_KEY, branch])
      return this.record(pin ? `Pin ${branch}` : `Unpin ${branch}`, [{ kind: 'config-value', key: PIN_KEY, value: branch, add: !pin }], (await this.currentHead()).hash)
    })
  }

  deleteBranch(name: string, opts: { force?: boolean } = {}): Promise<number> {
    return this.exclusive(async () => {
      const ref = (await this.refs()).find((r) => r.name === `refs/heads/${name}`)
      if (!ref) throw new Error(`No branch named ${name}`)
      await this.git(['branch', opts.force ? '-D' : '-d', name])
      const actions: UndoAction[] = [{ kind: 'update-ref', ref: ref.name, to: ref.hash, from: null }]
      if (ref.upstream) actions.push({ kind: 'set-upstream', branch: name, upstream: ref.upstream })
      return this.record(`Delete branch ${name}`, actions, (await this.currentHead()).hash)
    })
  }

  /** Delete several branches at once (branch cleanup); one undo entry brings them all back. */
  deleteBranches(names: string[], opts: { force?: boolean } = {}): Promise<number> {
    return this.exclusive(async () => {
      const refs = await this.refs()
      const actions: UndoAction[] = []
      for (const name of names) {
        const ref = refs.find((r) => r.name === `refs/heads/${name}`)
        if (!ref) throw new Error(`No branch named ${name}`)
        actions.push({ kind: 'update-ref', ref: ref.name, to: ref.hash, from: null })
        if (ref.upstream) actions.push({ kind: 'set-upstream', branch: name, upstream: ref.upstream })
      }
      await this.git(['branch', opts.force ? '-D' : '-d', ...names])
      return this.record(`Delete ${names.length} branches`, actions, (await this.currentHead()).hash)
    })
  }

  /** Local branches whose tip is already in `into` (default HEAD): safe to delete. */
  async mergedBranches(into = 'HEAD'): Promise<string[]> {
    const head = await this.currentHead()
    if (!head.hash) return []
    return (await this.read(['for-each-ref', `--merged=${into}`, '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean)
  }

  /**
   * Move a branch that is not checked out forward to its upstream, when that is a fast-forward
   * (the checked-out branch uses pull instead). One update-ref, with the old value checked.
   */
  fastForward(branch: string): Promise<number> {
    return this.exclusive(async () => {
      const refs = await this.refs()
      const ref = refs.find((r) => r.name === `refs/heads/${branch}`)
      if (!ref?.upstream) throw new Error(`${branch} does not track a remote branch.`)
      if ((await this.currentHead()).branch === branch) throw new Error(`${branch} is checked out: pull it instead.`)
      const target = refs.find((r) => r.name === ref.upstream)
      if (!target) throw new Error(`${shortName(ref.upstream)} no longer exists.`)
      if (!(await this.isAncestor(ref.hash, target.hash))) throw new Error(`${branch} has commits ${shortName(ref.upstream)} does not: it cannot fast-forward.`)
      await this.git(['update-ref', '-m', `gitgoose: fast-forward to ${shortName(ref.upstream)}`, ref.name, target.hash, ref.hash])
      return this.record(`Fast-forward ${branch}`, [{ kind: 'update-ref', ref: ref.name, to: ref.hash, from: target.hash }], (await this.currentHead()).hash)
    })
  }

  /** Make `branch` track `upstream` (a remote branch's full or short name), or nothing. */
  setUpstream(branch: string, upstream: string | null): Promise<number> {
    return this.exclusive(async () => {
      const ref = (await this.refs()).find((r) => r.name === `refs/heads/${branch}`)
      if (!ref) throw new Error(`No branch named ${branch}`)
      if (upstream) await this.git(['branch', `--set-upstream-to=${shortName(upstream)}`, branch])
      else await this.git(['branch', '--unset-upstream', branch], { okCodes: [128] })
      return this.record(upstream ? `Track ${shortName(upstream)}` : `Stop tracking for ${branch}`,
        [{ kind: 'set-upstream', branch, upstream: ref.upstream ?? null }], (await this.currentHead()).hash)
    })
  }

  // ---------------------------------------------------------------- worktrees

  async worktrees(): Promise<Worktree[]> {
    // git prints real paths (no symlinks: /private/tmp on macOS), so compare with ours resolved.
    return parseWorktrees(await this.read(['worktree', 'list', '--porcelain', '-z']), await realpath(this.path).catch(() => this.path))
  }

  /**
   * A second working tree: check out an existing branch there, a new branch (`newBranch`, at
   * `at` or HEAD), or a detached commit. Undo removes it again, which git refuses once it has
   * changes, so undo never deletes work.
   */
  addWorktree(path: string, opts: { branch?: string; newBranch?: string; at?: string }): Promise<number> {
    return this.exclusive(async () => {
      const args = opts.newBranch ? ['-b', opts.newBranch, path, ...(opts.at ? [opts.at] : [])]
        : opts.branch ? [path, opts.branch]
        : ['--detach', path, opts.at ?? 'HEAD']
      await this.git(['worktree', 'add', ...args])
      const actions: UndoAction[] = [{ kind: 'worktree-remove', path }]
      if (opts.newBranch) actions.push({ kind: 'update-ref', ref: `refs/heads/${opts.newBranch}`, to: null, from: await this.revParse(`refs/heads/${opts.newBranch}`) })
      return this.record(`Add worktree ${basename(path)}`, actions, (await this.currentHead()).hash)
    })
  }

  /**
   * Remove a worktree. Without `force` git refuses if it has changes or untracked files, so what
   * goes is only a checkout of committed work: undo checks it out again. With `force` the
   * changes are deleted and there is no undo (the UI asks first).
   */
  removeWorktree(path: string, opts: { force?: boolean } = {}): Promise<number | null> {
    return this.exclusive(async () => {
      const real = await realPathOf(path)
      const w = (await this.worktrees()).find((x) => samePath(x.path, real))
      if (!w) throw new Error(`No worktree at ${path}`)
      if (w.main) throw new Error('The main working tree cannot be removed.')
      if (w.current) throw new Error('This tab shows that worktree: open another one to remove it.')
      await this.git(['worktree', 'remove', ...(opts.force ? ['--force', '--force'] : []), path])
      if (opts.force || !w.head) return null
      return this.record(`Remove worktree ${basename(path)}`, [{ kind: 'worktree-add', path, branch: w.branch, commit: w.head }], (await this.currentHead()).hash)
    })
  }

  lockWorktree(path: string, lock: boolean, reason?: string): Promise<void> {
    return this.exclusive(async () => {
      await this.git(['worktree', lock ? 'lock' : 'unlock', ...(lock && reason ? ['--reason', reason] : []), path])
    })
  }

  /** Forget worktrees whose folders are gone (their branches stay). */
  pruneWorktrees(): Promise<void> {
    return this.exclusive(async () => {
      await this.git(['worktree', 'prune'])
    })
  }

  // ---------------------------------------------------------------- code graph

  /** Definitions per blob id: a file's definitions only change when its content does. */
  private defsCache = new Map<string, Definition[]>()

  /** The repository's code graph (ADR-008), read-only, once the indexer has built it. */
  private graph: GraphStore | null = null

  attachGraph(store: GraphStore | null): void {
    this.graph = store
  }

  /** The key a revision's tree has in the graph: a commit's full hash, or the two special trees. */
  private async treeKey(rev: string | null): Promise<string> {
    if (rev === null) return 'worktree'
    if (rev === '') return 'index'
    return (await this.runner.run(['rev-parse', `${rev}^{commit}`], { readOnly: true })).stdout.trim()
  }

  /** The graph, when it holds this revision's tree. */
  private async graphFor(rev: string | null): Promise<{ store: GraphStore; key: string } | null> {
    if (!this.graph) return null
    const key = await this.treeKey(rev)
    return this.graph.hasTree(key) ? { store: this.graph, key } : null
  }

  /** A file's text at a revision, or in the working tree (rev null). */
  private async textAt(rev: string | null, path: string): Promise<string | null> {
    if (rev === null) return readFile(join(this.path, path), 'utf8').catch(() => null)
    // rev '' reads the index (":path").
    const r = await this.runner.run(['cat-file', 'blob', `${rev}:${path}`], { readOnly: true, okCodes: [128] })
    return r.code === 0 ? r.stdout : null
  }

  /** Definitions in a file, cached by its blob id. */
  async definitionsIn(rev: string | null, path: string): Promise<{ defs: Definition[]; text: string } | null> {
    const text = await this.textAt(rev, path)
    if (text === null) return null
    return { defs: this.definitionsOf(path, text), text }
  }

  /**
   * Definitions of a file's text: parsed by the graph when it has that content, line patterns
   * otherwise. The graph is keyed by blob id, and a blob id is only a hash of the text, so no
   * git call and no tree lookup is needed; any text the graph has seen, at any revision, is found.
   */
  definitionsOf(path: string, text: string): Definition[] {
    const id = blobId(text)
    let defs = this.defsCache.get(id)
    if (!defs) {
      defs = this.graph?.knownBlobs([id]).has(id) ? this.graph.symbolsIn(id) : findDefinitions(path, text)
      if (this.defsCache.size > 5000) this.defsCache.clear()
      this.defsCache.set(id, defs)
    }
    return defs
  }

  /**
   * Code Peek: where `name` is defined and used, as of `rev` (null: the working tree). git grep
   * finds every whole-word occurrence; codegraph decides which of those lines define it.
   */
  async codePeek(name: string, rev: string | null): Promise<CodePeek> {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error('Peek works on identifiers.')
    const g = await this.graphFor(rev)
    if (g) return this.codePeekFromGraph(g.store, g.key, name, rev)
    const MAX_HITS = 400
    const out = await this.runner.run(['grep', '-n', '-z', '--column', '-w', '-I', '-F', '--max-count=30', '-e', name, ...(rev ? [rev] : []), '--'], { readOnly: true, okCodes: [1] })
    const all = parseGrep(out.stdout, rev ?? undefined)
    const hits = all.slice(0, MAX_HITS)
    // Look for definitions only in files whose matching line could define it, most likely first.
    const byFile = new Map<string, number[]>()
    for (const h of hits) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h.line])
    const defs: CodePeek['definitions'] = []
    const defLines = new Set<string>()
    for (const [path] of [...byFile].slice(0, 60)) {
      const f = await this.definitionsIn(rev, path)
      if (!f) continue
      const lines = f.text.split(/\r?\n/)
      for (const d of f.defs) {
        if (d.name !== name) continue
        defLines.add(`${path}:${d.line}`)
        defs.push({ path, line: d.line, endLine: d.endLine, kind: d.kind, signature: d.signature, preview: lines.slice(d.line - 1, Math.min(d.endLine, d.line + 14)) })
      }
    }
    return {
      name,
      definitions: defs,
      references: hits.filter((h) => !defLines.has(`${h.path}:${h.line}`)).map((h) => ({ path: h.path, line: h.line, column: h.column, text: h.text.trim().slice(0, 300) })),
      truncated: all.length > MAX_HITS,
    }
  }

  /** Peek from the parsed graph: definitions and uses are what the parser saw, not word matches. */
  private async codePeekFromGraph(store: GraphStore, key: string, name: string, rev: string | null): Promise<CodePeek> {
    const MAX_REFS = 400
    const texts = new Map<string, string[]>()
    const linesOf = async (path: string) => {
      let lines = texts.get(path)
      if (!lines) {
        lines = (await this.textAt(rev, path))?.split(/\r?\n/) ?? []
        texts.set(path, lines)
      }
      return lines
    }
    const definitions: CodePeek['definitions'] = []
    for (const d of store.definitions(name, key, 60)) {
      const lines = await linesOf(d.path)
      definitions.push({ path: d.path, line: d.line, endLine: d.endLine, kind: d.kind, signature: d.signature, preview: lines.slice(d.line - 1, Math.min(d.endLine, d.line + 14)) })
    }
    const refs = store.references(name, key, MAX_REFS + 1)
    const references: CodePeek['references'] = []
    for (const r of refs.slice(0, MAX_REFS)) {
      const lines = await linesOf(r.path)
      references.push({ path: r.path, line: r.line, column: r.column, text: (lines[r.line - 1] ?? '').trim().slice(0, 300) })
    }
    return { name, definitions, references, truncated: refs.length > MAX_REFS }
  }

  /**
   * Apply a review suggestion: replace lines startLine..endLine of the working file, but only if
   * they are still exactly `original` (what was reviewed). Undoable.
   */
  applySuggestion(path: string, startLine: number, endLine: number, original: string[], replacement: string): Promise<number> {
    return this.exclusive(async () => {
      const abs = join(this.path, path)
      const text = await readFile(abs, 'utf8').catch(() => null)
      if (text === null) throw new Error(`${path} is not in the working tree.`)
      const eol = text.includes('\r\n') ? '\r\n' : '\n'
      const lines = text.split(/\r?\n/)
      const now = lines.slice(startLine - 1, endLine)
      if (now.length !== original.length || now.some((l, i) => l !== original[i])) {
        throw new Error(`Lines ${startLine}-${endLine} of ${path} changed since the review: apply it by hand, or review again.`)
      }
      const saved = await this.saveFiles([path])
      lines.splice(startLine - 1, endLine - startLine + 1, ...replacement.split(/\r?\n/))
      await writeFile(abs, lines.join(eol))
      return this.record(`Apply suggestion to ${path}`, [{ kind: 'restore-files', files: saved }], (await this.currentHead()).hash)
    })
  }

  /** Write a whole working file (an accepted AI fix), only if it still reads `expected`. Undoable. */
  writeFileChecked(path: string, expected: string, content: string, label: string): Promise<number> {
    return this.exclusive(async () => {
      const abs = join(this.path, path)
      const now = await readFile(abs, 'utf8').catch(() => null)
      if (now !== expected) throw new Error(`${path} changed since the fix was proposed: ask again.`)
      const saved = await this.saveFiles([path])
      await writeFile(abs, content)
      return this.record(label, [{ kind: 'restore-files', files: saved }], (await this.currentHead()).hash)
    })
  }

  /** A working file's text (for fix proposals: what the fix is compared with). */
  async workingText(path: string): Promise<string | null> {
    return readFile(join(this.path, path), 'utf8').catch(() => null)
  }

  /**
   * The change a review covers, ready for the model: parsed file diffs, the label to show, the
   * revision line numbers refer to ('index', 'worktree' or a commit), and each file's text after
   * the change. Lock files and minified files are left out; so are files past the size budget
   * (listed in `skipped`).
   */
  /** Pre-push checks from .coderabbit.yaml as of a revision (the one being pushed). */
  async customChecks(rev: string): Promise<{ name: string; instructions: string; mode: 'warn' | 'block' }[]> {
    for (const name of ['.coderabbit.yaml', '.coderabbit.yml']) {
      const text = await this.textAt(rev, name).catch(() => null)
      if (text !== null) return parseCustomChecks(text)
    }
    return []
  }

  /**
   * What pushing a branch would send. With an upstream: the commits it does not have, from where
   * the two meet (commits the upstream has and we lack are not ours to check). Without one: the
   * commits no remote branch has, from the parent of the oldest. Newest first.
   */
  async outgoing(branch?: string): Promise<{ head: string; base: string; label: string; commits: { hash: string; subject: string; body: string }[] }> {
    const name = branch ?? (await this.currentHead()).branch
    if (!name) throw new Error('Check out a branch to push')
    const head = await this.revParse(`refs/heads/${name}`)
    if (!head) throw new Error(`No branch named ${name}`)
    const local = (await this.refs()).find((r) => r.name === `refs/heads/${name}`)
    const upstream = local?.upstream && !local.upstreamGone ? local.upstream : null
    const range = upstream ? [`${upstream}..${head}`] : [head, '--not', '--remotes']
    const raw = await this.read(['log', '-z', '--format=%H%x00%P%x00%s%x00%b', ...range, '--'])
    const fields = raw.split('\0')
    const commits: { hash: string; subject: string; body: string; parents: string[] }[] = []
    for (let i = 0; i + 3 < fields.length; i += 4) {
      commits.push({ hash: fields[i]!.trim(), parents: fields[i + 1]!.split(' ').filter(Boolean), subject: fields[i + 2]!, body: fields[i + 3]!.trim() })
    }
    const base = upstream
      ? (await this.read(['merge-base', upstream, head])).trim()
      : commits.at(-1)?.parents[0] ?? (commits.length ? await this.emptyTreeHash() : head)
    const to = upstream ? shortName(upstream) : 'a new remote branch'
    const label = commits.length ? `${commits.length} commit${commits.length === 1 ? '' : 's'} to ${to}` : ''
    return { head, base, label, commits: commits.map(({ hash, subject, body }) => ({ hash, subject, body })) }
  }

  async reviewInput(scope: ReviewScope, budget = 60_000): Promise<ReviewInput> {
    const NOISE = [':(exclude,glob)**/pnpm-lock.yaml', ':(exclude,glob)**/package-lock.json', ':(exclude,glob)**/yarn.lock', ':(exclude,glob)**/*.lock', ':(exclude,glob)**/*.min.js']
    const diffOf = async (args: string[]) => parseDiff((await this.runner.run(['diff', '-M', '--no-color', '--no-ext-diff', '-U3', ...args, '--', '.', ...NOISE], { readOnly: true, env: { GIT_LITERAL_PATHSPECS: '0' } })).stdout)
    let files: FileDiff[]
    let label: string
    let head: string
    let base: string | undefined
    switch (scope.kind) {
      case 'staged':
        files = await diffOf(['--cached'])
        label = 'Staged changes'
        head = 'index'
        break
      case 'working': {
        files = (await this.currentHead()).hash ? await diffOf(['HEAD']) : []
        const snap = this.last ?? (await this.snapshot())
        for (const e of snap.status.filter((x) => x.kind === 'untracked').slice(0, 50)) {
          const content = await readFile(join(this.path, e.path)).catch(() => null)
          if (content && content.length < 200_000) files.push(untrackedDiff(e.path, content))
        }
        label = 'Uncommitted changes'
        head = 'worktree'
        base = 'HEAD'
        break
      }
      case 'branch': {
        const tip = await this.revParse(`refs/heads/${scope.branch}`)
        if (!tip) throw new Error(`No branch named ${scope.branch}`)
        const from = scope.base ?? (await this.defaultBase(scope.branch))
        if (!from) throw new Error(`Cannot tell what ${scope.branch} branched from: no main, master or remote default branch.`)
        const fork = (await this.read(['merge-base', from, tip])).trim()
        files = await diffOf([fork, tip])
        label = `${scope.branch} since ${shortName(from)}`
        head = tip
        base = fork
        break
      }
      case 'commits': {
        const list = [...scope.hashes].reverse()
        const parents = await Promise.all(list.map(async (h) => (await this.read(['rev-list', '--parents', '-n', '1', h])).trim().split(' ').slice(1)))
        if (!list.every((h, i) => i === 0 || parents[i]![0] === list[i - 1])) throw new Error('Select commits that follow each other to review them together.')
        const newest = list[list.length - 1]!
        base = parents[0]![0] ?? (await this.emptyTreeHash())
        files = await diffOf([base, newest])
        label = list.length === 1 ? `Commit ${newest.slice(0, 7)}` : `${list.length} commits`
        head = newest
        break
      }
      case 'outgoing': {
        const out = await this.outgoing(scope.branch)
        files = out.commits.length ? await diffOf([out.base, out.head]) : []
        label = out.label
        head = out.head
        base = out.base
        break
      }
    }
    const texts = new Map<string, string>()
    const kept: FileDiff[] = []
    const skipped: string[] = []
    let used = 0
    for (const f of files) {
      const size = f.hunks.reduce((n, h) => n + h.lines.reduce((m, l) => m + l.text.length + 8, 0), 0)
      if (used + size > budget && kept.length) {
        skipped.push(f.path)
        continue
      }
      used += size
      kept.push(f)
      if (f.binary || f.change === 'deleted') continue
      const text = head === 'worktree' ? await readFile(join(this.path, f.path), 'utf8').catch(() => null) : await this.textAt(head === 'index' ? '' : head, f.path)
      if (text !== null) texts.set(f.path, text)
    }
    return { files: kept, label, head, base, texts, skipped }
  }

  /**
   * The project's own review guidance for these files, as of `head` ('worktree', 'index' or a
   * commit): guideline files covering them (CLAUDE.md, AGENTS.md, …, nearest directory last) and
   * matching path instructions from .coderabbit.yaml. Bounded to ~24k characters.
   */
  async reviewContext(paths: string[], head: string): Promise<{ guidelines: { path: string; scope: string; text: string }[]; pathInstructions: { path: string; instructions: string }[] }> {
    const rev = head === 'worktree' ? null : head === 'index' ? '' : head
    const listed = rev === null
      ? await this.read(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      : rev === '' ? await this.read(['ls-files', '-z']) : await this.read(['ls-tree', '-r', '-z', '--name-only', rev])
    const all = listed.split('\0').filter(Boolean)
    const guidelines: { path: string; scope: string; text: string }[] = []
    let budget = 24_000
    for (const g of relevantGuidelines(all, paths)) {
      const text = await this.textAt(rev, g.path)
      if (!text?.trim()) continue
      const cut = text.length > 8_000 ? `${text.slice(0, 8_000)}\n[… cut]` : text
      if (cut.length > budget) break
      budget -= cut.length
      guidelines.push({ ...g, text: cut })
    }
    const yaml = all.includes('.coderabbit.yaml') ? await this.textAt(rev, '.coderabbit.yaml') : all.includes('.coderabbit.yml') ? await this.textAt(rev, '.coderabbit.yml') : null
    const pathInstructions = yaml ? parsePathInstructions(yaml).filter((pi) => paths.some((p) => globToRegExp(pi.path).test(p))) : []
    return { guidelines, pathInstructions }
  }

  /**
   * Everything worth knowing about lines start..end of a file at `rev` (null: the working tree):
   * the lines, the definition they are in, definitions of names they use, the commits that
   * changed them (log -L) and who wrote them (blame -L). Bounded at every step.
   */
  async askContext(rev: string | null, path: string, start: number, end: number): Promise<{
    lines: string[]; within?: { name: string; kind: string; line: number; text: string }
    used: { name: string; path: string; line: number; preview: string[] }[]
    history: string[]; blame: { author: string; summary: string; lines: number }[]
  }> {
    const text = await this.textAt(rev, path)
    if (text === null) throw new Error(`${path} is not there${rev ? ` at ${rev.slice(0, 7)}` : ''}.`)
    const all = text.split(/\r?\n/)
    const lines = all.slice(start - 1, end)
    const defs = findDefinitions(path, text)
    const d = enclosingDefinition(defs, start)
    const within = d && d.endLine - d.line < 200 ? { name: d.name, kind: d.kind, line: d.line, text: all.slice(d.line - 1, d.endLine).join('\n') } : undefined
    // Names used in the lines, most frequent first, minus keywords and the function itself.
    const counts = new Map<string, number>()
    for (const m of lines.join('\n').matchAll(/[A-Za-z_$][\w$]{2,}/g)) if (!NOT_NAMES.has(m[0]) && !KEYWORDS.has(m[0]) && m[0] !== d?.name) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1)
    const used: { name: string; path: string; line: number; preview: string[] }[] = []
    for (const [name] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      if (used.length >= 5) break
      const peek = await this.codePeek(name, rev).catch(() => null)
      const def = peek?.definitions[0]
      if (def) used.push({ name, path: def.path, line: def.line, preview: def.preview.slice(0, 10) })
    }
    // log -L needs a commit: the working tree's lines are traced from HEAD.
    const at = rev ?? 'HEAD'
    const history = (await this.runner.run(['log', '-s', '-n', '6', `--format=%h %as %an: %s`, `-L${start},${end}:${path}`, at], { readOnly: true, okCodes: [128] })).stdout
      .split('\n').filter((l) => /^[0-9a-f]{7,} /.test(l))
    const blameOut = await this.runner.run(['blame', '--porcelain', `-L${start},${end}`, at, '--', path], { readOnly: true, okCodes: [128] })
    const byCommit = new Map<string, { author: string; summary: string; lines: number }>()
    for (const b of parseBlame(blameOut.stdout)) {
      const e = byCommit.get(b.hash) ?? { author: b.author, summary: b.summary, lines: 0 }
      e.lines++
      byCommit.set(b.hash, e)
    }
    return { lines, within, used, history, blame: [...byCommit.values()].sort((a, b) => b.lines - a.lines) }
  }

  /**
   * What a change could affect beyond itself: the definitions it touches, every use of them
   * outside the change (git grep at the same revision), tests for them, and files that usually
   * change along. Bounded: 15 symbols, 15 uses each, 80 in all.
   */
  async impact(scope: ReviewScope): Promise<ImpactResult> {
    const input = await this.reviewInput(scope, 400_000)
    const rev = input.head === 'worktree' ? null : input.head === 'index' ? '' : input.head
    const baseRev = input.base ?? 'HEAD'
    const before = new Map<string, string>()
    for (const f of input.files) {
      if (f.change === 'added' || f.binary) continue
      const t = await this.textAt(baseRev, f.oldPath ?? f.path)
      if (t !== null) before.set(f.oldPath ?? f.path, t)
    }
    const symbols = changedSymbols(input.files, (p) => input.texts.get(p) ?? null, (p) => before.get(p) ?? null, (p, t) => this.definitionsOf(p, t)).slice(0, 40)
    // Lines that are part of the change: uses there are not "outside".
    const inChange = addedLineNumbers(input.files)
    const allPaths = await this.listPaths(rev)
    const callers: ImpactResult['callers'] = []
    const names = [...new Set(symbols.map((s) => s.name))].slice(0, 15)
    const g = await this.graphFor(rev)
    const linesOf = this.lineReader(rev, input.texts)
    const defLines = new Set(symbols.map((s) => `${s.path}:${s.line}`))
    for (const name of names) {
      if (callers.length >= 80) break
      for (const u of (await this.usesOf(name, rev, g, { inChange, defLines, linesOf, limit: 15 })).slice(0, 80 - callers.length)) {
        callers.push({ id: `C${callers.length + 1}`, symbol: name, ...u })
      }
    }
    const changedPaths = input.files.map((f) => f.path)
    const tests = [...new Set([
      ...changedPaths.flatMap((p) => testsByName(p, allPaths)),
      ...callers.filter((c) => c.test).map((c) => c.path),
    ])].filter((p) => !changedPaths.includes(p) || isTestPath(p))
    const coChange: ImpactResult['coChange'] = []
    for (const file of changedPaths.slice(0, 10)) {
      const log = await this.read(['log', '-n', '300', '--format=%x01%H', '-z', '--name-only', '--full-diff', ...(input.base && input.head !== 'worktree' && input.head !== 'index' ? [input.head] : []), '--', file]).catch(() => '')
      for (const c of coChanges(file, parseFilesPerCommit(log))) if (!changedPaths.includes(c.path) && !coChange.some((x) => x.path === c.path)) coChange.push(c)
    }
    return { scope, label: input.label, head: input.head, base: input.base, symbols, callers, tests, coChange: coChange.slice(0, 6) }
  }

  // ---------------------------------------------------------------- code context (what the AI is told besides the diff)

  /**
   * What the code graph knows around a change (see CodeContext): the definitions it touches and
   * their uses outside it, the definitions of names its added lines use, and the tests that
   * cover it. Local and deterministic; the model only reads the result. With the graph not ready
   * for this revision, line patterns and git grep answer less precisely (a mention in a comment
   * counts as a use) but a review never waits for an index.
   *
   * Everything is bounded: `limits.symbols` definitions ranked by how many added lines they
   * carry, `limits.callers` sample uses each (non-test first), `limits.used` definitions of
   * used names ranked by how often the added lines use them.
   */
  async codeContext(input: ReviewInput, limits = { symbols: 20, callers: 6, used: 12 }): Promise<CodeContext> {
    const rev = revOf(input.head)
    const g = await this.graphFor(rev)
    const defsOf = (p: string, t: string) => this.definitionsOf(p, t)
    const before = new Map<string, string>()
    for (const f of input.files) {
      if (f.change === 'added' || f.binary) continue
      const t = await this.textAt(input.base ?? 'HEAD', f.oldPath ?? f.path)
      if (t !== null) before.set(f.oldPath ?? f.path, t)
    }
    const all = changedSymbols(input.files, (p) => input.texts.get(p) ?? null, (p) => before.get(p) ?? null, defsOf)
    const inChange = addedLineNumbers(input.files)
    const changedPaths = new Set(input.files.map((f) => f.path))
    const defLines = new Set(all.map((s) => `${s.path}:${s.line}`))
    const linesOf = this.lineReader(rev, input.texts)
    const testPaths = new Set<string>()
    const symbols: CodeContext['symbols'] = []
    for (const s of [...all].sort((a, b) => b.touched - a.touched).slice(0, limits.symbols)) {
      const uses = await this.usesOf(s.name, rev, g, { inChange, defLines, linesOf, limit: 200 })
      const tests = uses.filter((u) => u.test)
      for (const t of tests) testPaths.add(t.path)
      symbols.push({
        name: s.name, kind: s.kind, path: s.path, line: s.line, change: s.change, signature: s.signature, ...(s.oldSignature ? { oldSignature: s.oldSignature } : {}),
        uses: uses.length, testUses: tests.length, callers: [...uses.filter((u) => !u.test), ...tests].slice(0, limits.callers),
      })
    }
    const used = await this.usedDefinitions(input, g, inChange, changedPaths, linesOf, limits.used)
    const allPaths = await this.listPaths(rev)
    for (const p of changedPaths) if (!isTestPath(p)) for (const t of testsByName(p, allPaths)) testPaths.add(t)
    const tests = [...testPaths].sort().map((path) => ({ path, inChange: changedPaths.has(path) }))
    return { source: g ? 'graph' : 'patterns', symbols, used, tests }
  }

  /**
   * Uses of `name` outside the change, as of `rev`: from the graph (calls, type uses, imports:
   * what the parser saw) or, without it, whole-word matches from git grep minus the lines that
   * define the name. Lines in the change and the definitions themselves are left out.
   */
  private async usesOf(
    name: string, rev: string | null, g: { store: GraphStore; key: string } | null,
    opts: { inChange: Map<string, Set<number>>; defLines: Set<string>; linesOf: (path: string) => Promise<string[]>; limit: number },
  ): Promise<{ path: string; line: number; text: string; within?: string; test: boolean }[]> {
    const out: { path: string; line: number; text: string; within?: string; test: boolean }[] = []
    const skip = (path: string, line: number) => opts.inChange.get(path)?.has(line) || opts.defLines.has(`${path}:${line}`)
    if (g) {
      for (const u of g.store.references(name, g.key, opts.limit + 50)) {
        if (out.length >= opts.limit) break
        if (skip(u.path, u.line)) continue
        const text = ((await opts.linesOf(u.path))[u.line - 1] ?? '').trim().slice(0, 240)
        out.push({ path: u.path, line: u.line, text, ...(u.within ? { within: u.within } : {}), test: isTestPath(u.path) })
      }
      return out
    }
    const where = rev === null ? [] : rev === '' ? ['--cached'] : [rev]
    const res = await this.runner.run(['grep', '-n', '-z', '--column', '-w', '-I', '-F', '--max-count=20', '-e', name, ...where, '--'], { readOnly: true, okCodes: [1] })
    for (const h of parseGrep(res.stdout, rev || undefined)) {
      if (out.length >= opts.limit) break
      if (skip(h.path, h.line)) continue
      const defs = (await this.definitionsIn(rev, h.path))?.defs ?? []
      // A line that defines the name (an overload, a re-export) is not a use of it.
      if (defs.some((d) => d.name === name && d.line === h.line)) continue
      const d = enclosingDefinition(defs, h.line)
      out.push({ path: h.path, line: h.line, text: h.text.trim().slice(0, 240), ...(d ? { within: `${d.kind} ${d.name}` } : {}), test: isTestPath(h.path) })
    }
    return out
  }

  /**
   * Definitions, outside the change, of the names the added lines use. With the graph: the
   * references the parser found on those lines (calls, types, constructors), so a word in a
   * comment or a string is not one, and a name with no definition in the repository (a
   * built-in, a library) is dropped for free. Without it: identifiers on the added lines, a
   * few of them, each looked up with git grep.
   */
  private async usedDefinitions(
    input: ReviewInput, g: { store: GraphStore; key: string } | null, inChange: Map<string, Set<number>>, changedPaths: Set<string>,
    linesOf: (path: string) => Promise<string[]>, limit: number,
  ): Promise<CodeContext['used']> {
    const definedHere = new Set<string>()
    for (const [p, t] of input.texts) for (const d of this.definitionsOf(p, t)) definedHere.add(d.name)
    const counts = new Map<string, number>()
    for (const f of input.files) {
      const text = input.texts.get(f.path)
      const added = inChange.get(f.path)
      if (!text || !added?.size) continue
      if (g) {
        const id = blobId(text)
        if (!g.store.knownBlobs([id]).has(id)) continue
        for (const r of g.store.referencesIn(id)) {
          if (r.kind === 'import' || !added.has(r.line) || definedHere.has(r.name)) continue
          counts.set(r.name, (counts.get(r.name) ?? 0) + 1)
        }
      } else {
        const lines = text.split(/\r?\n/)
        for (const n of added) {
          const line = lines[n - 1] ?? ''
          // An import names a thing without using it (the graph skips those too).
          if (/^\s*(import\b|from\s+\S+\s+import\b|#include\b|use\s+[\w:]+;|(const|let|var)\s+\w+\s*=\s*require\()/.test(line)) continue
          for (const m of line.matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
            if (NOT_NAMES.has(m[0]) || KEYWORDS.has(m[0]) || definedHere.has(m[0])) continue
            counts.set(m[0], (counts.get(m[0]) ?? 0) + 1)
          }
        }
      }
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const out: CodeContext['used'] = []
    // Without the graph every lookup is a grep over the repository: a few will do.
    const lookups = g ? ranked.slice(0, limit * 2) : ranked.slice(0, Math.min(limit, 6))
    const rev = revOf(input.head)
    for (const [name, uses] of lookups) {
      if (out.length >= limit) break
      let def: { path: string; line: number; endLine: number; kind: string } | undefined
      if (g) def = g.store.definitions(name, g.key, 5).find((d) => !changedPaths.has(d.path))
      else def = (await this.codePeek(name, rev).catch(() => null))?.definitions.find((d) => !changedPaths.has(d.path))
      if (!def) continue
      const lines = await linesOf(def.path)
      out.push({ name, kind: def.kind, path: def.path, line: def.line, endLine: def.endLine, preview: lines.slice(def.line - 1, Math.min(def.endLine, def.line + 11)), uses })
    }
    return out
  }

  /** A file's lines as of `rev`, read once; the change's own texts need no read. */
  private lineReader(rev: string | null, texts: Map<string, string>): (path: string) => Promise<string[]> {
    const cache = new Map<string, string[]>()
    return async (path) => {
      let lines = cache.get(path)
      if (!lines) {
        lines = (texts.get(path) ?? (await this.textAt(rev, path)) ?? '').split(/\r?\n/)
        cache.set(path, lines)
      }
      return lines
    }
  }

  /** Every path as of `rev` (null: the working tree, untracked included; '': the index). */
  private async listPaths(rev: string | null): Promise<string[]> {
    const listed = rev === null
      ? await this.read(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      : rev === '' ? await this.read(['ls-files', '-z']) : await this.read(['ls-tree', '-r', '-z', '--name-only', rev])
    return listed.split('\0').filter(Boolean)
  }

  /**
   * The messages of the commits a change is made of, newest first: the intent a review reads
   * alongside the diff. Uncommitted and staged changes have none.
   */
  async scopeCommits(input: ReviewInput, max = 20): Promise<{ subject: string; body: string }[]> {
    if (input.head === 'worktree' || input.head === 'index' || !input.base) return []
    const out = await this.runner.run(['log', '-z', `-n${max}`, '--format=%s%x1f%b', `${input.base}..${input.head}`], { readOnly: true, okCodes: [128] })
    return out.stdout.split('\0').filter(Boolean).map((rec) => {
      const [subject = '', body = ''] = rec.split('\x1f')
      return { subject: subject.trim(), body: body.trim() }
    })
  }

  /** Recent commits up to `base` that touched these files: the history a reader of the change needs. */
  async relatedHistory(paths: string[], base = 'HEAD', n = 8): Promise<{ hash: string; subject: string; author: string; date: number }[]> {
    if (!paths.length) return []
    const r = await this.runner.run(['log', `-n${n}`, '--format=%H%x00%s%x00%an%x00%at', base, '--', ...paths.slice(0, 50)], { readOnly: true, okCodes: [128] })
    return r.stdout.split('\n').filter(Boolean).map((l) => {
      const [hash = '', subject = '', author = '', date = '0'] = l.split('\0')
      return { hash, subject, author, date: Number(date) }
    })
  }

  /** What a branch is measured against: its upstream's remote default branch, else main or master. */
  private async defaultBase(branch: string): Promise<string | null> {
    const refs = await this.refs()
    const names = new Set(refs.map((r) => r.name))
    const remoteHead = (await this.runner.run(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { readOnly: true, okCodes: [1, 128] })).stdout.trim()
    for (const c of [remoteHead, 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
      if (c && names.has(c) && c !== `refs/heads/${branch}`) return c
    }
    return null
  }

  /**
   * What history says about the uncommitted change (staged and unstaged, tracked files): files
   * that usually change along with these but are missing, and who wrote the lines being
   * changed. Bounded: 15 files, 300 commits of history each.
   */
  async changeInsights(): Promise<ChangeInsights> {
    const snap = this.last ?? (await this.snapshot())
    if (!snap.head.hash) return { coChange: [], owners: [] }
    const changed = snap.status.filter((e) => e.kind !== 'untracked' && e.kind !== 'unmerged').map((e) => e.path)
    const inChange = new Set(snap.status.map((e) => e.path))
    const files = changed.slice(0, 15)
    const coChange: ChangeInsights['coChange'] = []
    const owners = new Map<string, number>()
    await Promise.all(files.map(async (file) => {
      const log = await this.read(['log', '-n', '300', '--format=%x01%H', '-z', '--name-only', '--full-diff', '--', file])
      for (const c of coChanges(file, parseFilesPerCommit(log))) if (!inChange.has(c.path)) coChange.push(c)
      // Owners: blame the old side of each hunk against HEAD.
      const ranges = oldRanges(await this.read(['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff', '--', file]))
      if (!ranges.length) return
      const blame = await this.runner.run(['blame', '--porcelain', ...ranges.flatMap((r) => ['-L', `${r.start},+${r.count}`]), 'HEAD', '--', file], { readOnly: true, okCodes: [128] })
      for (const b of parseBlame(blame.stdout)) owners.set(b.author, (owners.get(b.author) ?? 0) + 1)
    }))
    // One suggestion per missing file: the strongest reason.
    const best = new Map<string, ChangeInsights['coChange'][number]>()
    for (const c of coChange) {
      const prev = best.get(c.path)
      if (!prev || c.together / c.total > prev.together / prev.total) best.set(c.path, c)
    }
    return {
      coChange: [...best.values()].sort((a, b) => b.together / b.total - a.together / a.total).slice(0, 5),
      owners: [...owners].map(([name, lines]) => ({ name, lines })).sort((a, b) => b.lines - a.lines),
    }
  }

  // ---------------------------------------------------------------- pull requests

  /**
   * Fetch a GitHub pull request's head (refs/pull/N/head: it exists for PRs from forks too) into
   * a local branch and check it out. Undo returns to where you were and deletes the branch.
   */
  checkoutPullRequest(remote: string, num: number, branch = `pr/${num}`): Promise<number> {
    return this.exclusive(async () => {
      const before = await this.currentHead()
      const existed = (await this.refs()).find((r) => r.name === `refs/heads/${branch}`)
      if (existed && before.branch === branch) throw new Error(`${branch} is checked out: switch away to update it from the pull request.`)
      await this.progress(['fetch', '--progress', remote, `+refs/pull/${num}/head:refs/heads/${branch}`])
      await this.git(['checkout', branch])
      const tip = await this.revParse(`refs/heads/${branch}`)
      return this.record(`Check out pull request #${num}`, [
        this.returnTo(before),
        { kind: 'update-ref', ref: `refs/heads/${branch}`, to: existed?.hash ?? null, from: tip },
      ], (await this.currentHead()).hash)
    })
  }

  // ---------------------------------------------------------------- Git LFS

  private lfsVersion: string | null | undefined

  /**
   * LFS state, at no cost for repositories that do not use it: the version check runs once, and
   * the LFS commands only when .gitattributes mentions filter=lfs.
   */
  async lfsInfo(): Promise<LfsInfo> {
    if (this.lfsVersion === undefined) {
      const v = await this.runner.run(['lfs', 'version'], { readOnly: true, okCodes: [1, 128] }).catch(() => null)
      this.lfsVersion = v?.code === 0 ? (/git-lfs\/(\S+)/.exec(v.stdout)?.[1] ?? v.stdout.trim()) : null
    }
    const attrs = await readFile(join(this.path, '.gitattributes'), 'utf8').catch(() => '')
    const info: LfsInfo = { installed: this.lfsVersion !== null, version: this.lfsVersion ?? undefined, used: /filter=lfs/.test(attrs), ready: false, patterns: [], files: [] }
    if (!info.installed || !info.used) return info
    const [track, files, filter] = await Promise.all([
      this.read(['lfs', 'track', '--json']),
      this.read(['lfs', 'ls-files', '--json']),
      this.configGet(null, 'filter.lfs.process'),
    ])
    info.ready = !!filter
    info.patterns = (JSON.parse(track).patterns ?? []).map((p: { pattern: string; source: string; lockable?: boolean }) => ({ pattern: p.pattern, source: p.source, lockable: !!p.lockable }))
    info.files = (JSON.parse(files).files ?? []).map((f: { name: string; size: number; downloaded?: boolean }) => ({ path: f.name, size: f.size, downloaded: f.downloaded !== false }))
    return info
  }

  /** `git lfs install --local`: the filter and hooks, for this repository only. */
  lfsInstall(): Promise<void> {
    return this.exclusive(async () => {
      await this.git(['lfs', 'install', '--local'])
    })
  }

  /** Route files matching `pattern` through LFS (or stop). Only .gitattributes changes: undoable. */
  lfsTrack(pattern: string, track = true): Promise<number> {
    return this.exclusive(async () => {
      const saved = await this.saveFiles(['.gitattributes'])
      await this.git(['lfs', track ? 'track' : 'untrack', '--', pattern])
      return this.record(`${track ? 'Track' : 'Stop tracking'} ${pattern} with LFS`, [{ kind: 'restore-files', files: saved }], (await this.currentHead()).hash)
    })
  }

  /** Download the LFS files the checked-out commit needs (network). */
  lfsPull(): Promise<void> {
    return this.exclusive(async () => {
      await this.progress(['lfs', 'pull'])
    })
  }

  /** Locks on the LFS server (network, so only when asked). */
  async lfsLocks(): Promise<LfsLock[]> {
    const out = await this.read(['lfs', 'locks', '--json'])
    return (JSON.parse(out || '[]') as { id: string; path: string; owner?: { name?: string }; locked_at?: string }[])
      .map((l) => ({ id: String(l.id), path: l.path, owner: l.owner?.name ?? '', lockedAt: l.locked_at ?? '' }))
  }

  /** Lock or unlock a file on the LFS server (network; `force` unlocks someone else's lock). */
  lfsLock(path: string, lock: boolean, force = false): Promise<void> {
    return this.exclusive(async () => {
      await this.git(['lfs', lock ? 'lock' : 'unlock', ...(force ? ['--force'] : []), '--', path])
    })
  }

  /**
   * The real content of an LFS pointer blob, from the local LFS store only (never the network);
   * null when it was not downloaded. Lets image diffs show LFS images.
   */
  private async lfsContent(pointer: Buffer): Promise<Buffer | null> {
    const text = pointer.subarray(0, 300).toString('utf8')
    const oid = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})/.exec(text)?.[1]
    if (!oid) return null
    return readFile(join(this.commonDir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid)).catch(() => null)
  }

  // ---------------------------------------------------------------- command log

  /** The git commands run for this repository, newest first (after `afterId`, when given). */
  commandLog(afterId = 0): CommandRecord[] {
    return this.runner.history.filter((r) => r.id > afterId).reverse().map((r) => ({ ...r }))
  }

  // ---------------------------------------------------------------- bisect

  /**
   * Read a bisect's state from its refs (refs/bisect/bad, good-*, skip-*) and, once there is a
   * good and a bad commit, ask `rev-list --bisect-vars` (the plumbing behind `git bisect`) how
   * many candidates are left. bisect_all=1 means one is left: that is the first bad commit.
   */
  private async bisectState(): Promise<BisectState> {
    const st: BisectState = { good: [], skipped: [] }
    const refs = await this.read(['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/bisect'])
    for (const line of refs.split('\n').filter(Boolean)) {
      const [name, hash] = line.split('\0') as [string, string]
      if (name === 'refs/bisect/bad') st.bad = hash
      else if (name.startsWith('refs/bisect/good-')) st.good.push(hash)
      else if (name.startsWith('refs/bisect/skip-')) st.skipped.push(hash)
    }
    if (st.bad && st.good.length) {
      const vars = new Map<string, string>()
      const out = await this.read(['rev-list', '--bisect-vars', st.bad, '--not', ...st.good])
      for (const m of out.matchAll(/^(\w+)='?([^'\n]*)'?$/gm)) vars.set(m[1]!, m[2]!)
      if (vars.get('bisect_all') === '1') st.found = vars.get('bisect_rev')
      else {
        st.remaining = Number(vars.get('bisect_nr') ?? 0)
        st.steps = Number(vars.get('bisect_steps') ?? 0)
      }
    }
    return st
  }

  /**
   * Mark a commit good, bad or skipped (starting a bisect if none is running). git then checks
   * out the next commit to test. Not recorded for undo: Stop (bisect reset) is the way back.
   */
  bisectMark(rev: string, term: 'good' | 'bad' | 'skip'): Promise<void> {
    return this.exclusive(async () => {
      if (!existsSync(join(this.gitDir, 'BISECT_START'))) await this.git(['bisect', 'start'])
      await this.git(['bisect', term, rev])
    })
  }

  /** End the bisect and go back to the branch (or commit) it started from. */
  bisectReset(): Promise<void> {
    return this.exclusive(async () => {
      await this.git(['bisect', 'reset'])
    })
  }

  // ---------------------------------------------------------------- identity and templates

  private async configGet(scope: 'local' | 'global' | null, key: string): Promise<string | undefined> {
    const r = await this.runner.run(['config', ...(scope ? [`--${scope}`] : []), '--get', key], { readOnly: true, okCodes: [1] })
    return r.code === 0 ? r.stdout.replace(/\n$/, '') : undefined
  }

  async identity(): Promise<Identity> {
    const [ln, le, gn, ge, name, email] = await Promise.all([
      this.configGet('local', 'user.name'), this.configGet('local', 'user.email'),
      this.configGet('global', 'user.name'), this.configGet('global', 'user.email'),
      this.configGet(null, 'user.name'), this.configGet(null, 'user.email'),
    ])
    return { name, email, scope: ln !== undefined || le !== undefined ? 'local' : gn !== undefined || ge !== undefined ? 'global' : null, global: { name: gn, email: ge } }
  }

  /**
   * Set who commits are made as, for this repository or (global) every repository. Null clears
   * this repository's own value, so the global one applies again. Undoable: the old values go back.
   */
  setIdentity(scope: 'local' | 'global', name: string | null, email: string | null): Promise<number> {
    return this.exclusive(async () => {
      const actions: UndoAction[] = []
      for (const [key, value] of [['user.name', name], ['user.email', email]] as const) {
        actions.push({ kind: 'config', scope, key, value: (await this.configGet(scope, key)) ?? null })
        if (value === null) await this.git(['config', `--${scope}`, '--unset', key], { okCodes: [5] })
        else await this.git(['config', `--${scope}`, key, value])
      }
      return this.record(scope === 'global' ? 'Change your global identity' : 'Change this repository\'s identity', actions, (await this.currentHead()).hash)
    })
  }

  /** The commit message template (commit.template), when one is set and readable. */
  async commitTemplate(): Promise<string | null> {
    const path = await this.configGet(null, 'commit.template')
    if (!path) return null
    const abs = path.startsWith('~') ? join(homedir(), path.slice(1)) : resolve(this.path, path)
    return readFile(abs, 'utf8').catch(() => null)
  }

  /** People who recently authored commits here, most active first: co-author suggestions. */
  async recentAuthors(limit = 30): Promise<Person[]> {
    const out = await this.read(['log', '--all', '-n', '2000', '--format=%aN%x00%aE'])
    const counts = new Map<string, { p: Person; n: number }>()
    for (const line of out.split('\n')) {
      const [name, email] = line.split('\0')
      if (!name || !email) continue
      const key = email.toLowerCase()
      const c = counts.get(key)
      if (c) c.n++
      else counts.set(key, { p: { name, email }, n: 1 })
    }
    return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, limit).map((c) => c.p)
  }

  // ---------------------------------------------------------------- submodules

  async submodules(): Promise<Submodule[]> {
    if (!existsSync(join(this.path, '.gitmodules'))) return []
    const cfg = (await this.runner.run(['config', '-f', '.gitmodules', '-z', '--get-regexp', '^submodule\\..*\\.(path|url)$'], { readOnly: true, okCodes: [1] })).stdout
    const byName = new Map<string, Submodule>()
    for (const entry of cfg.split('\0').filter(Boolean)) {
      const nl = entry.indexOf('\n')
      const m = /^submodule\.(.+)\.(path|url)$/.exec(entry.slice(0, nl))
      if (!m) continue
      const sm = byName.get(m[1]!) ?? { name: m[1]!, path: '', url: '', dirty: false }
      sm[m[2] as 'path' | 'url'] = entry.slice(nl + 1)
      byName.set(m[1]!, sm)
    }
    const list = [...byName.values()].filter((s) => s.path)
    if (!list.length) return []
    // Gitlinks (mode 160000) in the index are the commits the superproject records.
    const staged = await this.read(['ls-files', '-s', '-z', '--', ...list.map((s) => s.path)])
    for (const rec of staged.split('\0').filter(Boolean)) {
      const [meta, path] = rec.split('\t')
      const [mode, sha] = meta!.split(' ')
      const sm = list.find((s) => s.path === path)
      if (sm && mode === '160000') sm.recorded = sha
    }
    await Promise.all(list.map(async (sm) => {
      // Only look inside a real checkout: in an empty folder git would find the superproject.
      if (!existsSync(join(this.path, sm.path, '.git'))) return
      const head = await this.runner.run(['-C', sm.path, 'rev-parse', '--verify', '-q', 'HEAD'], { readOnly: true, okCodes: [1, 128] })
      if (head.code === 0) sm.checkedOut = head.stdout.trim()
      const st = await this.runner.run(['-C', sm.path, 'status', '--porcelain', '-z'], { readOnly: true, okCodes: [128] })
      sm.dirty = st.code === 0 && st.stdout.length > 0
    }))
    return list
  }

  /** Clone (if needed) and check out the recorded commit of each submodule, or just `paths`. May fetch. */
  updateSubmodules(paths?: string[]): Promise<void> {
    return this.exclusive(async () => {
      await this.progress(['submodule', 'update', '--init', '--recursive', '--progress', ...(paths?.length ? ['--', ...paths] : [])])
    })
  }

  /** Copy URLs from .gitmodules into the configuration (after someone changed one). */
  syncSubmodules(): Promise<void> {
    return this.exclusive(async () => {
      await this.git(['submodule', 'sync', '--recursive'])
    })
  }

  /** Add a submodule (clones it). Undo deletes it again, unless it was changed since. */
  addSubmodule(url: string, path: string): Promise<number> {
    return this.exclusive(async () => {
      const tree = (await this.git(['write-tree'])).stdout.trim()
      const saved = await this.saveFiles(['.gitmodules'])
      await this.progress(['submodule', 'add', '--progress', '--', url, path])
      const sm = (await this.submodules()).find((s) => s.path === path.replace(/\/+$/, ''))
      if (!sm?.checkedOut) throw new Error(`Could not read the new submodule at ${path}`)
      return this.record(`Add submodule ${sm.path}`, [
        { kind: 'submodule-forget', path: sm.path, name: sm.name, commit: sm.checkedOut },
        { kind: 'read-tree', tree },
        { kind: 'restore-files', files: saved },
      ], (await this.currentHead()).hash)
    })
  }

  /**
   * Remove a submodule: `git rm` drops its checkout and its .gitmodules entry (staged, to commit)
   * and refuses if it has changes. Git keeps its clone in .git/modules, so undo checks it out again.
   */
  removeSubmodule(path: string): Promise<number> {
    return this.exclusive(async () => {
      const tree = (await this.git(['write-tree'])).stdout.trim()
      const saved = await this.saveFiles(['.gitmodules'])
      await this.git(['rm', '-q', '--', path])
      return this.record(`Remove submodule ${path}`, [
        { kind: 'read-tree', tree },
        { kind: 'restore-files', files: saved },
        { kind: 'submodule-restore', path },
      ], (await this.currentHead()).hash)
    })
  }

  // ---------------------------------------------------------------- remotes and tags

  async remotes(): Promise<Remote[]> {
    const out = (await this.runner.run(['config', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], { readOnly: true, okCodes: [1] })).stdout
    const map = new Map<string, Remote>()
    for (const entry of out.split('\0').filter(Boolean)) {
      const nl = entry.indexOf('\n')
      const key = entry.slice(0, nl)
      const value = entry.slice(nl + 1)
      const m = /^remote\.(.+)\.(url|pushurl)$/.exec(key)
      if (!m) continue
      const r = map.get(m[1]!) ?? { name: m[1]!, fetchUrl: '' }
      if (m[2] === 'url') r.fetchUrl = value
      else r.pushUrl = value
      map.set(m[1]!, r)
    }
    return [...map.values()]
  }

  addRemote(name: string, url: string): Promise<number> {
    return this.exclusive(async () => {
      await this.git(['remote', 'add', name, url])
      return this.record(`Add remote ${name}`, [{ kind: 'remote-remove', name }], (await this.currentHead()).hash)
    })
  }

  /** Remove a remote (and its remote-tracking branches; a fetch brings those back after undo). */
  removeRemote(name: string): Promise<number> {
    return this.exclusive(async () => {
      const r = (await this.remotes()).find((x) => x.name === name)
      if (!r) throw new Error(`No remote named ${name}`)
      await this.git(['remote', 'remove', name])
      return this.record(`Remove remote ${name}`, [{ kind: 'remote-add', name, url: r.fetchUrl, pushUrl: r.pushUrl }], (await this.currentHead()).hash)
    })
  }

  renameRemote(from: string, to: string): Promise<number> {
    return this.exclusive(async () => {
      await this.git(['remote', 'rename', from, to])
      return this.record(`Rename remote ${from} to ${to}`, [{ kind: 'remote-rename', from: to, to: from }], (await this.currentHead()).hash)
    })
  }

  /** Change a remote's URL (or its separate push URL; null removes that). */
  setRemoteUrl(name: string, url: string | null, push = false): Promise<number> {
    return this.exclusive(async () => {
      const r = (await this.remotes()).find((x) => x.name === name)
      if (!r) throw new Error(`No remote named ${name}`)
      if (url) await this.git(['remote', 'set-url', ...(push ? ['--push'] : []), name, url])
      else if (push) await this.git(['config', '--unset', `remote.${name}.pushurl`], { okCodes: [5] })
      else throw new Error('A remote needs a URL.')
      return this.record(`Change ${name}'s ${push ? 'push ' : ''}URL`, [{ kind: 'remote-url', name, url: push ? (r.pushUrl ?? null) : r.fetchUrl, push }], (await this.currentHead()).hash)
    })
  }

  /** Push one tag, or all of them (name null), to a remote. */
  pushTags(remote: string, name: string | null): Promise<void> {
    return this.exclusive(async () => {
      await this.progress(['push', '--progress', remote, ...(name ? [`refs/tags/${name}`] : ['--tags'])])
    })
  }

  deleteRemoteTag(remote: string, name: string): Promise<void> {
    return this.exclusive(async () => {
      await this.progress(['push', '--progress', remote, '--delete', `refs/tags/${name}`])
    })
  }

  /** Tag names a remote has (asks the remote: network, only on request). */
  async remoteTags(remote: string): Promise<string[]> {
    const out = await this.read(['ls-remote', '--tags', '--refs', remote])
    return out.split('\n').filter(Boolean).map((l) => l.split('\t')[1]!.replace(/^refs\/tags\//, ''))
  }

  /** Run an operation that moves the current branch; its undo moves it back with reset --keep. */
  private moving(label: string, run: () => Promise<unknown>): Promise<number | null> {
    return this.exclusive(async () => {
      const before = await this.currentHead()
      await run()
      const after = await this.currentHead()
      if (before.hash && after.hash !== before.hash) {
        return this.record(label, [{ kind: 'reset', to: before.hash, mode: 'keep' }], after.hash)
      }
      return null
    })
  }

  /**
   * Merge `ref` into HEAD. squash: stage its changes without a merge commit (commit them
   * yourself; the message is prepared). noCommit: stop before the merge commit, to adjust it.
   */
  merge(ref: string, opts: { noFf?: boolean; ffOnly?: boolean; squash?: boolean; noCommit?: boolean } = {}): Promise<number | null> {
    const flags = opts.squash ? ['--squash'] : opts.noCommit ? ['--no-commit', '--no-ff'] : opts.ffOnly ? ['--ff-only'] : opts.noFf ? ['--no-ff'] : []
    return this.moving(`Merge ${shortName(ref)}`, () => this.git(['merge', '--no-edit', ...flags, shortName(ref)]))
  }

  /** The message git prepared for the next commit (a squash or a stopped merge), or ''. */
  async preparedMessage(): Promise<string> {
    for (const f of ['SQUASH_MSG', 'MERGE_MSG']) {
      try {
        const text = await readFile(join(this.gitDir, f), 'utf8')
        return text.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim()
      } catch {
        // not there
      }
    }
    return ''
  }

  rebase(onto: string): Promise<number | null> {
    return this.moving(`Rebase onto ${shortName(onto)}`, () => this.git(['rebase', shortName(onto)]))
  }

  /**
   * A snapshot of every file in the working tree as a tree object, built in a throwaway index so
   * the real index (which may hold conflicts) is untouched. Fallback backup for `reset --hard`
   * when `git stash create` refuses (it cannot handle an index with unmerged entries).
   */
  private async worktreeTree(): Promise<string> {
    const tmp = join(tmpdir(), `gitgoose-index-${process.pid}-${Date.now()}`)
    try {
      await this.git(['add', '-A'], { env: { GIT_INDEX_FILE: tmp } })
      return (await this.git(['write-tree'], { env: { GIT_INDEX_FILE: tmp } })).stdout.trim()
    } finally {
      await rm(tmp, { force: true })
    }
  }

  reset(hash: string, mode: ResetMode): Promise<number> {
    return this.exclusive(async () => {
      const before = await this.currentHead()
      if (!before.hash) throw new Error('Nothing to reset: the branch has no commits')
      const actions: UndoAction[] = []
      if (mode === 'hard') {
        // `git stash create` builds a stash commit of the current changes without touching the
        // working tree or the stash list. If the reset is hard, that commit is our backup.
        actions.push({ kind: 'reset', to: before.hash, mode: 'keep' })
        let backup = ''
        try {
          backup = (await this.git(['stash', 'create'])).stdout.trim()
          if (backup) actions.push({ kind: 'stash-apply', hash: backup })
        } catch {
          // Unmerged entries (a conflicted merge): save the files as a plain tree instead.
          actions.push({ kind: 'restore-tree', tree: await this.worktreeTree() })
        }
      } else if (mode === 'keep') {
        actions.push({ kind: 'reset', to: before.hash, mode: 'keep' })
      } else {
        // Soft and mixed only move HEAD (and, for mixed, rewrite the index). Undo moves HEAD back
        // softly and then restores the index exactly as it was, so nothing ends up staged that
        // was not staged before.
        actions.push({ kind: 'reset', to: before.hash, mode: 'soft' })
        try {
          actions.push({ kind: 'read-tree', tree: (await this.git(['write-tree'])).stdout.trim() })
        } catch {
          // An index with conflicts has no tree; HEAD still goes back.
        }
      }
      await this.git(['reset', `--${mode}`, hash])
      return this.record(`Reset (${mode}) to ${hash.slice(0, 7)}`, actions, (await this.currentHead()).hash)
    })
  }

  private async isMerge(hash: string): Promise<boolean> {
    const line = (await this.read(['rev-list', '--parents', '-n', '1', hash])).trim()
    return line.split(' ').length > 2
  }

  async cherryPick(hash: string): Promise<number | null> {
    const mainline = (await this.isMerge(hash)) ? ['-m', '1'] : []
    return this.moving(`Cherry-pick ${hash.slice(0, 7)}`, () => this.git(['cherry-pick', ...mainline, hash]))
  }

  /**
   * Cherry-pick several commits onto HEAD in one go, one undo entry for all of them.
   * `hashes` are in graph order (newest first, as the UI shows them); they are applied oldest
   * first. Commits already on the current branch are skipped (picking them would be empty).
   */
  async cherryPickMany(hashes: string[]): Promise<number | null> {
    const head = (await this.currentHead()).hash
    const todo: string[] = []
    for (const h of [...hashes].reverse()) {
      if (head && (await this.isAncestor(h, head))) continue
      todo.push(h)
    }
    if (!todo.length) throw new Error('Those commits are already on the current branch.')
    // -m 1 is accepted for ordinary commits too, so one flag covers a mixed selection.
    const mainline = (await Promise.all(todo.map((h) => this.isMerge(h)))).some(Boolean) ? ['-m', '1'] : []
    return this.moving(`Cherry-pick ${todo.length} ${todo.length === 1 ? 'commit' : 'commits'}`, () => this.git(['cherry-pick', ...mainline, ...todo]))
  }

  /**
   * Cherry-pick commits onto a branch that is not checked out, without checking it out.
   *
   * `git cherry-pick` only works on HEAD: it needs a working tree to apply the change in. But a
   * cherry-pick is just a three-way merge of trees, so it can be done in the object database
   * alone: for commit C, merge C's tree with the branch's tree, taking C's parent as the base
   * (`merge-tree --write-tree --merge-base C^ <branch> C`, git 2.40+). That gives the tree the
   * new commit should have; `commit-tree` makes the commit (with C's author and message) and
   * `update-ref`, given the old value, moves the branch only if nothing moved it meanwhile.
   * Nothing in the working tree or the index changes, so a conflict cannot be left behind
   * half-done: merge-tree reports it and the whole thing is refused instead.
   *
   * `hashes` are in graph order (newest first); they are applied oldest first. One undo entry.
   */
  cherryPickOnto(branch: string, hashes: string[]): Promise<number> {
    return this.exclusive(async () => {
      if (!supportsMergeTreeBase(await this.version())) throw new Error('Cherry-picking onto a branch that is not checked out needs git 2.40 or newer.')
      const ref = `refs/heads/${branch}`
      const old = await this.revParse(ref).catch(() => '')
      if (!old) throw new Error(`No branch named ${branch}`)
      const holder = (await this.worktrees()).find((w) => w.branch === branch)
      if (holder) {
        throw new Error(holder.current ? `${branch} is checked out: cherry-pick onto it the usual way.` : `${branch} is checked out in ${holder.path}: cherry-pick there, or check it out here.`)
      }
      let tip = old
      let picked = 0
      for (const c of [...hashes].reverse()) {
        const parents = (await this.read(['rev-list', '--parents', '-n', '1', c])).trim().split(' ').slice(1)
        if (!parents.length) throw new Error(`${c.slice(0, 7)} is a root commit: there is no change to pick.`)
        const merged = await this.runner.run(['merge-tree', '--write-tree', '--name-only', '-z', `--merge-base=${parents[0]}`, tip, c], { okCodes: [1] })
        const fields = merged.stdout.split('\0')
        if (merged.code === 1) {
          const files = fields.slice(1, fields.indexOf('', 1)).filter(Boolean)
          throw new Error(`${c.slice(0, 7)} conflicts with ${branch}${files.length ? ` in ${describePaths(files)}` : ''}. Check out ${branch} and cherry-pick it there to resolve the conflict.`)
        }
        const tree = fields[0]!.trim()
        // Already there (an empty pick): nothing to commit.
        if (tree === (await this.revParse(`${tip}^{tree}`))) continue
        const raw = await this.read(['cat-file', 'commit', c])
        const author = /^author (.*) <(.*)> (\d+ [+-]\d{4})$/m.exec(raw)
        const message = raw.slice(raw.indexOf('\n\n') + 2)
        const env: Record<string, string> = author ? { GIT_AUTHOR_NAME: author[1]!, GIT_AUTHOR_EMAIL: author[2]!, GIT_AUTHOR_DATE: author[3]! } : {}
        tip = (await this.git(['commit-tree', tree, '-p', tip, '-F', '-'], { input: message, env })).stdout.trim()
        picked++
      }
      if (!picked) throw new Error(`Those changes are already on ${branch}.`)
      await this.git(['update-ref', '-m', `gitgoose: cherry-pick ${picked} onto ${branch}`, ref, tip, old])
      return this.record(`Cherry-pick ${picked === 1 ? hashes[0]!.slice(0, 7) : `${picked} commits`} onto ${branch}`,
        [{ kind: 'update-ref', ref, to: old, from: tip }], (await this.currentHead()).hash)
    })
  }

  /**
   * Bring the change one commit (or stash) made to some files into the working tree: the
   * path-limited diff of `rev` against its first parent, applied with `git apply`. A stash's
   * change is its working tree against its base, plus the untracked files in its third parent.
   *
   * A plain apply first: it touches only the working tree, and copes with files that have edits
   * of their own as long as the lines around the change still match. When it does not apply,
   * `--3way` merges it instead (and may leave conflict markers to resolve); --3way works through
   * the index, so their index entries are saved too. Undo puts files and index entries back.
   */
  applyFileFrom(rev: string, paths: string[], opts: { stash?: boolean } = {}): Promise<number> {
    return this.exclusive(async () => {
      if (!paths.length) throw new Error('No files to apply')
      const diff = (a: string, b: string) => this.read(['diff', '--binary', ...DIFF_ARGS, a, b, '--', ...paths])
      let patch: string
      if (opts.stash) {
        const third = await this.runner.run(['rev-parse', '--verify', '-q', `${rev}^3`], { readOnly: true, okCodes: [1] })
        patch = (await diff(`${rev}^1`, rev)) + (third.code === 0 ? await diff(await this.emptyTreeHash(), third.stdout.trim()) : '')
      } else {
        const parents = (await this.read(['rev-list', '--parents', '-n', '1', rev])).trim().split(' ').slice(1)
        patch = await diff(parents[0] ?? (await this.emptyTreeHash()), rev)
      }
      if (!patch.trim()) throw new Error(`${describePaths(paths)} did not change in ${rev.slice(0, 7)}.`)
      const head = await this.currentHead()
      const saved = await this.saveFiles(paths)
      const actions: UndoAction[] = [{ kind: 'restore-files', files: saved }]
      const plain = await this.runner.run(['apply', '--whitespace=nowarn', '-'], { input: patch, okCodes: [1] })
      if (plain.code !== 0) {
        const entries = (await this.read(['ls-files', '-s', '-z', '--', ...paths])).split('\0').filter(Boolean).map((l) => {
          const [meta, path] = l.split('\t') as [string, string]
          const [mode, blob] = meta.split(' ') as [string, string]
          return { path, mode, blob }
        })
        actions.push({ kind: 'index-entries', paths, entries })
        const merged = await this.runner.run(['apply', '--3way', '--whitespace=nowarn', '-'], { input: patch, okCodes: [1] })
        // Exit 1 with conflict markers written is a merge to finish; anything else did not apply.
        const unmerged = (await this.freshStatus()).entries.some((e) => e.kind === 'unmerged' && paths.includes(e.path))
        if (merged.code !== 0 && !unmerged) throw new Error((merged.stderr || plain.stderr).trim() || `The change does not apply to ${describePaths(paths)}.`)
      }
      return this.record(`Apply ${describePaths(paths)} from ${opts.stash ? 'a stash' : rev.slice(0, 7)}`, actions, head.hash)
    })
  }

  // ---------------------------------------------------------------- editing history

  /**
   * The commits on the current branch that can be dropped or moved: from HEAD along first
   * parents, newest first, stopping before the first merge and before the root commit (moving
   * those needs --rebase-merges or --root, more than these simple edits should do).
   */
  async editableCommits(limit = 1000): Promise<string[]> {
    const head = await this.currentHead()
    if (!head.branch || !head.hash) return []
    const out: string[] = []
    const lines = (await this.read(['rev-list', '--first-parent', '--parents', '-n', String(limit + 1), 'HEAD'])).trim().split('\n')
    for (const line of lines) {
      const [h, ...parents] = line.split(' ')
      if (parents.length !== 1) break
      out.push(h!)
    }
    return out
  }

  /** Drop commits from the current branch (the ones after them are replayed). */
  dropCommits(hashes: string[]): Promise<number | null> {
    return this.reorder(`Drop ${hashes.length === 1 ? `${hashes[0]!.slice(0, 7)}` : `${hashes.length} commits`}`, async (chain) => {
      const drop = new Set(hashes)
      if (!hashes.every((h) => chain.includes(h))) throw new Error('Only commits on the current branch, after its last merge, can be dropped.')
      return chain.filter((h) => !drop.has(h))
    })
  }

  /**
   * Move commits (kept in their relative order) to just above (newer than) or below (older than)
   * `target`, on the current branch.
   */
  moveCommits(hashes: string[], target: string, where: 'above' | 'below'): Promise<number | null> {
    return this.reorder(`Move ${hashes.length === 1 ? hashes[0]!.slice(0, 7) : `${hashes.length} commits`}`, async (chain) => {
      if (![...hashes, target].every((h) => chain.includes(h))) {
        throw new Error('Only commits on the current branch, after its last merge, can be moved.')
      }
      if (hashes.includes(target)) return chain
      const moving = chain.filter((h) => hashes.includes(h))
      const rest = chain.filter((h) => !hashes.includes(h))
      const at = rest.indexOf(target) + (where === 'above' ? 1 : 0)
      return [...rest.slice(0, at), ...moving, ...rest.slice(at)]
    })
  }

  /**
   * Rewrite the editable part of the branch to `plan(chain)` (oldest first) with an interactive
   * rebase whose todo list we write ourselves. Only the part from the first changed position is
   * replayed. --autostash keeps uncommitted work out of the way; a conflict stops the rebase like
   * any other (the conflict wizard takes over, and Abort puts everything back).
   */
  private reorder(label: string, plan: (chainOldestFirst: string[]) => Promise<(string | TodoItem)[]>, opts: { before?: string; undoMode?: 'keep' | 'soft' } = {}): Promise<number | null> {
    return this.exclusive(async () => {
      if (this.operation()) throw new Error(`Finish the ${this.operation()} in progress first.`)
      const chain = (await this.editableCommits()).reverse()
      const next = (await plan(chain)).map((t): TodoItem => (typeof t === 'string' ? { hash: t } : t))
      // Replay from the first position that changes (a different commit, or an action on it).
      let i = 0
      while (i < chain.length && next[i] && chain[i] === next[i]!.hash && !next[i]!.action && next[i]!.message === undefined) i++
      if (i === chain.length && next.length === chain.length) return null
      // A squash or fixup folds into the commit before it, which must be replayed too.
      while (i > 0 && (next[i]?.action === 'squash' || next[i]?.action === 'fixup')) i--
      const base = (await this.read(['rev-parse', `${chain[i]}^`])).trim()
      const files: string[] = []
      const lines: string[] = []
      for (const t of next.slice(i)) {
        lines.push(`${t.action ?? 'pick'} ${t.hash}`)
        if (t.message !== undefined) {
          // Reword: amend the commit just picked with the new message, from a file (any text is safe).
          const msgFile = join(this.gitDir, `gitgoose-msg-${process.pid}-${files.length}`)
          await writeFile(msgFile, t.message.trim() + '\n')
          files.push(msgFile)
          lines.push(`exec git commit --amend --allow-empty --no-verify -F ${shellQuote(msgFile)}`)
        }
      }
      const file = join(this.gitDir, `gitgoose-todo-${process.pid}`)
      files.push(file)
      await writeFile(file, (lines.join('\n') || 'noop') + '\n')
      const before = opts.before ?? (await this.currentHead()).hash!
      try {
        // git runs the sequence editor through a shell with the todo path appended. GIT_EDITOR
        // stays `true`, so a squash keeps git's combined message as it is.
        // rebase.updateRefs=false, not --no-update-refs: the flag needs git 2.38+, config is ignored before.
        await this.git(['-c', 'rebase.updateRefs=false', 'rebase', '-i', '--autostash', base], {
          env: { GIT_SEQUENCE_EDITOR: `cp ${shellQuote(file)}` },
        })
      } finally {
        await Promise.all(files.map((f) => rm(f, { force: true })))
      }
      const after = (await this.currentHead()).hash
      return after === before ? null : this.record(label, [{ kind: 'reset', to: before, mode: opts.undoMode ?? 'keep' }], after)
    })
  }

  /** Change the message of a commit on the current branch (HEAD included). */
  rewordCommit(hash: string, message: string): Promise<number | null> {
    if (!message.trim()) return Promise.reject(new Error('The message is empty.'))
    return this.reorder(`Reword ${hash.slice(0, 7)}`, async (chain) => {
      if (!chain.includes(hash)) throw new Error('Only commits on the current branch, after its last merge, can be reworded.')
      return chain.map((h) => (h === hash ? { hash: h, message } : h))
    })
  }

  /**
   * Fold a commit into the one before it. 'squash' keeps both messages (one after the other),
   * 'fixup' keeps only the earlier commit's message.
   */
  squashCommit(hash: string, mode: 'squash' | 'fixup'): Promise<number | null> {
    return this.reorder(`${mode === 'squash' ? 'Squash' : 'Fixup'} ${hash.slice(0, 7)}`, async (chain) => {
      const at = chain.indexOf(hash)
      if (at < 0) throw new Error('Only commits on the current branch, after its last merge, can be squashed.')
      if (at === 0) throw new Error('The commit below it is not on this part of the branch (a merge or the first commit).')
      return chain.map((h) => (h === hash ? { hash: h, action: mode } : h))
    })
  }

  /**
   * Squash `hashes` onto `target` (Tower's drag-onto): move them just above it, then fold each
   * into it, keeping all messages.
   */
  squashOnto(hashes: string[], target: string, opts: { fixup?: boolean } = {}): Promise<number | null> {
    const action = opts.fixup ? 'fixup' as const : 'squash' as const
    return this.reorder(`${opts.fixup ? 'Fixup' : 'Squash'} ${hashes.length === 1 ? hashes[0]!.slice(0, 7) : `${hashes.length} commits`} into ${target.slice(0, 7)}`, async (chain) => {
      if (![...hashes, target].every((h) => chain.includes(h)) || hashes.includes(target)) {
        throw new Error('Only commits on the current branch, after its last merge, can be squashed.')
      }
      const moving = chain.filter((h) => hashes.includes(h))
      const rest = chain.filter((h) => !hashes.includes(h))
      const at = rest.indexOf(target) + 1
      return [...rest.slice(0, at), ...moving.map((h) => ({ hash: h, action })), ...rest.slice(at)]
    })
  }

  /**
   * Put the staged changes into an older commit: commit them as a fixup, then fold that into the
   * target. Undo puts the branch back and leaves the changes staged again (reset --soft).
   */
  async fixupInto(target: string): Promise<number | null> {
    const before = (await this.currentHead()).hash!
    const chain = await this.editableCommits()
    if (!chain.includes(target)) throw new Error('Only commits on the current branch, after its last merge, can take a fixup.')
    await this.exclusive(() => this.git(['commit', '--no-verify', '-m', `fixup! ${target}`]))
    const fixup = (await this.currentHead()).hash!
    return this.reorder(`Fixup into ${target.slice(0, 7)}`, async (c) => {
      const rest = c.filter((h) => h !== fixup)
      const at = rest.indexOf(target) + 1
      return [...rest.slice(0, at), { hash: fixup, action: 'fixup' as const }, ...rest.slice(at)]
    }, { before, undoMode: 'soft' })
  }

  // ---------------------------------------------------------------- recompose

  /**
   * Check that `hashes` (graph order) can be recomposed and describe them: a chain of
   * non-merge commits on the current branch, with only non-merge commits after it up to HEAD.
   */
  async recomposeInfo(hashes: string[]): Promise<{
    branch: string
    base: string | null
    list: string[]
    after: string[]
    units: RecomposeUnit[]
    messages: { hash: string; subject: string; body: string; author: string }[]
    onRemote: string[]
  }> {
    const head = await this.currentHead()
    if (!head.branch || !head.hash) throw new Error('Check out a branch first: recompose rewrites the current branch.')
    const list = [...new Set(hashes)].reverse()
    if (!list.length) throw new Error('Select the commits to recompose.')
    const parents = await Promise.all(list.map(async (h) => (await this.read(['rev-list', '--parents', '-n', '1', h])).trim().split(' ').slice(1)))
    if (parents.some((p) => p.length > 1)) throw new Error('Merge commits cannot be recomposed. Select a run of ordinary commits.')
    if (!list.every((h, i) => i === 0 || parents[i]![0] === list[i - 1])) {
      throw new Error('Select commits that follow each other (a range, with Shift-click).')
    }
    const newest = list[list.length - 1]!
    if (!(await this.isAncestor(newest, head.hash))) throw new Error(`These commits are not on ${head.branch}.`)
    const afterMerges = (await this.read(['rev-list', '--min-parents=2', `${newest}..${head.hash}`])).trim()
    if (afterMerges) throw new Error(`${head.branch} has merge commits after these; recompose only works on a straight line of commits.`)
    const after = (await this.read(['rev-list', '--reverse', `${newest}..${head.hash}`])).trim().split('\n').filter(Boolean)
    const base = parents[0]![0] ?? null
    const diff = await this.read(['diff', '--no-color', '--no-ext-diff', '--no-renames', '--binary', base ?? (await this.emptyTreeHash()), newest])
    const units = splitUnits(diff)
    if (!units.length) throw new Error('These commits change nothing, so there is nothing to recompose.')
    const messages = await Promise.all(list.map(async (h) => {
      const [subject = '', author = '', body = ''] = (await this.read(['log', '-1', '--format=%s%x00%an <%ae>%x00%b', h])).split('\0')
      return { hash: h, subject, body: body.trim(), author }
    }))
    const onRemote = (await this.read(['branch', '-r', '--format=%(refname:short)', '--contains', list[0]!])).trim().split('\n').filter(Boolean)
    return { branch: head.branch, base, list, after, units, messages, onRemote }
  }

  /**
   * Replace the commits with `plan` (oldest first, every unit exactly once). The new commits are
   * built in a throwaway index, so the working tree and the real index are never touched; the
   * last one must have the newest original's tree, so the commits after the range keep their
   * trees exactly and only get new parents. Then one update-ref moves the branch.
   */
  recompose(hashes: string[], plan: PlannedCommit[]): Promise<number> {
    return this.exclusive(async () => {
      const info = await this.recomposeInfo(hashes)
      const problems = checkPlan(info.units, plan)
      if (problems.length) throw new Error(problems.join(' '))
      const oldHead = (await this.currentHead()).hash!
      const index = join(this.gitDir, `gitgoose-recompose-${process.pid}.index`)
      const env = { GIT_INDEX_FILE: index }
      // One author keeps the commits theirs; several make you the author, crediting them all.
      const authors = [...new Set(info.messages.map((m) => m.author))]
      const authorEnv = authors.length === 1 ? splitAuthor(authors[0]!) : {}
      const trailer = authors.length > 1 ? `\n\n${authors.map((a) => `Co-authored-by: ${a}`).join('\n')}` : ''
      try {
        if (info.base) await this.git(['read-tree', info.base], { env })
        else await this.git(['read-tree', '--empty'], { env })
        const byId = new Map(info.units.map((u) => [u.id, u]))
        let parent = info.base
        for (const [i, c] of plan.entries()) {
          const patch = patchFor(c.units.map((id) => byId.get(id)!))
          try {
            await this.runner.run(['apply', '--cached', '--whitespace=nowarn', '-'], { env, input: patch })
          } catch (e) {
            throw new Error(`Could not build commit ${i + 1} ("${c.message.split('\n')[0]}"): its changes do not apply in this order. Try moving it later.\n${(e as Error).message}`)
          }
          const tree = (await this.runner.run(['write-tree'], { env })).stdout.trim()
          parent = (await this.runner.run(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], {
            env: { ...env, ...authorEnv }, input: c.message.trim() + trailer + '\n',
          })).stdout.trim()
        }
        const want = (await this.read(['rev-parse', `${info.list[info.list.length - 1]}^{tree}`])).trim()
        const got = (await this.read(['rev-parse', `${parent}^{tree}`])).trim()
        if (got !== want) throw new Error('The new commits do not add up to the original result, so nothing was changed.')
        // The commits after the range: same tree, message and author; new parent.
        for (const h of info.after) {
          const [an = '', ae = '', ad = '', msg = ''] = (await this.read(['log', '-1', '--format=%an%x00%ae%x00%ad%x00%B', '--date=raw', h])).split('\0')
          parent = (await this.runner.run(['commit-tree', `${h}^{tree}`, '-p', parent!], {
            env: { GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad }, input: msg,
          })).stdout.trim()
        }
        const ref = `refs/heads/${info.branch}`
        await this.git(['update-ref', '-m', 'gitgoose: recompose', ref, parent!, oldHead])
        return this.record(`Recompose ${info.list.length} commits`, [{ kind: 'update-ref', ref, to: oldHead, from: parent! }], parent!)
      } finally {
        await rm(index, { force: true })
      }
    })
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    const res = await this.runner.run(['merge-base', '--is-ancestor', a, b], { okCodes: [1], readOnly: true })
    return res.code === 0
  }

  /**
   * Several commits as text to paste or `git apply`/`git am`: a diff or a mailbox of patches.
   * `hashes` are in graph order (newest first). When they form a chain (each one's first parent
   * is the one before), it is one diff from the oldest's parent to the newest, or a numbered
   * patch series; otherwise each commit's own diff or patch, oldest first.
   */
  async commitsText(hashes: string[], format: 'diff' | 'patch'): Promise<string> {
    const list = [...hashes].reverse()
    if (!list.length) return ''
    const parents = await Promise.all(list.map(async (h) => (await this.read(['rev-list', '--parents', '-n', '1', h])).trim().split(' ').slice(1)))
    const chain = list.every((h, i) => i === 0 || parents[i]![0] === list[i - 1])
    const diffOf = async (from: string | undefined, to: string) =>
      this.read(['diff', '--no-color', '--no-ext-diff', '-M', '--binary', from ?? (await this.emptyTreeHash()), to])
    if (format === 'diff') {
      if (chain) return diffOf(parents[0]![0], list[list.length - 1]!)
      return (await Promise.all(list.map((h, i) => diffOf(parents[i]![0], h)))).join('')
    }
    const fp = ['format-patch', '--stdout', '--no-color', '--binary']
    if (chain) {
      const newest = list[list.length - 1]!
      return this.read(parents[0]!.length ? [...fp, `${list[0]}^..${newest}`] : [...fp, '--root', newest])
    }
    return (await Promise.all(list.map((h) => this.read([...fp, '-1', h])))).join('')
  }

  /** Save commits as numbered .patch files in `dir`, oldest first (`format-patch`). Returns their paths. */
  async savePatches(hashes: string[], dir: string): Promise<string[]> {
    const out: string[] = []
    const list = [...hashes].reverse()
    for (const [i, h] of list.entries()) {
      const r = await this.read(['format-patch', '--no-color', '--binary', '-o', dir, `--start-number=${i + 1}`, '-1', h])
      out.push(...r.split('\n').filter(Boolean))
    }
    return out
  }

  /**
   * Apply a patch. Mailbox patches (format-patch output, "From <sha> …") become commits with
   * `am --3way`, keeping author and message; undo moves the branch back. A plain diff is applied
   * to the working tree and index with `apply --3way`; undo puts both back. A 3-way apply can
   * stop on conflicts: `am` then waits for continue / abort, a plain apply leaves conflicted
   * files, and the undo entry is recorded either way so nothing is lost.
   */
  applyPatch(text: string): Promise<number | null> {
    if (/^From [0-9a-f]{40} /m.test(text)) {
      return this.moving(`Apply ${(text.match(/^From [0-9a-f]{40} /gm) ?? []).length} patches`, () => this.git(['am', '--3way'], { input: text }))
    }
    return this.exclusive(async () => {
      if (this.operation()) throw new Error(`Finish the ${this.operation()} in progress first.`)
      const numstat = await this.runner.run(['apply', '--numstat', '-z'], { input: text, readOnly: true })
      const paths = parseNumstatPaths(numstat.stdout)
      if (!paths.length) throw new Error('This is not a patch git can read.')
      const tree = (await this.git(['write-tree'])).stdout.trim()
      const saved = await this.saveFiles(paths)
      const head = (await this.currentHead()).hash
      const record = () => this.record(`Apply patch to ${describePaths(paths)}`, [{ kind: 'read-tree', tree }, { kind: 'restore-files', files: saved }], head)
      try {
        await this.git(['apply', '--3way', '--whitespace=nowarn'], { input: text })
      } catch (e) {
        // Conflicts: the files are changed (with markers); keep the way back.
        if ((await this.read(['ls-files', '-u'])).trim()) await record()
        throw e
      }
      return record()
    })
  }

  async revert(hash: string): Promise<number | null> {
    const mainline = (await this.isMerge(hash)) ? ['-m', '1'] : []
    return this.moving(`Revert ${hash.slice(0, 7)}`, () => this.git(['revert', '--no-edit', ...mainline, hash]))
  }

  /** `sign` makes a signed tag (-s, with your signing key); signed tags are annotated, so it needs a message. */
  createTag(name: string, hash: string, message?: string, opts: { sign?: boolean } = {}): Promise<number> {
    return this.exclusive(async () => {
      const kind = opts.sign ? ['-s', '-m', message || name] : message ? ['-a', '-m', message] : []
      await this.git(['tag', ...kind, name, hash])
      const obj = await this.revParse(`refs/tags/${name}`)
      return this.record(`Create tag ${name}`, [{ kind: 'update-ref', ref: `refs/tags/${name}`, to: null, from: obj }], (await this.currentHead()).hash)
    })
  }

  deleteTag(name: string): Promise<number> {
    return this.exclusive(async () => {
      // rev-parse without ^{} gives the tag object itself for annotated tags, so undo restores it intact.
      const obj = await this.revParse(`refs/tags/${name}`)
      await this.git(['tag', '-d', name])
      return this.record(`Delete tag ${name}`, [{ kind: 'update-ref', ref: `refs/tags/${name}`, to: obj, from: null }], (await this.currentHead()).hash)
    })
  }

  // ---------------------------------------------------------------- remotes

  private progress(args: string[]): Promise<unknown> {
    return this.git(args, { onStderr: (t) => this.opts.onProgress?.(lastLine(t)) })
      .finally(() => this.opts.onProgress?.(null))
  }

  fetch(opts: { remote?: string; prune?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      await this.progress(['fetch', '--progress', ...(opts.prune ? ['--prune'] : []), ...(opts.remote ? [opts.remote] : ['--all'])])
      // New commits arrived: extend the commit-graph in the background (incremental with --split).
      void this.maintainCommitGraph({ force: true })
    })
  }

  /** Pull HEAD's upstream, or (`remote` and `branch`) a given remote branch into HEAD. */
  pull(opts: { mode?: PullMode; remote?: string; branch?: string } = {}): Promise<number | null> {
    const mode = { merge: '--no-rebase', rebase: '--rebase', 'ff-only': '--ff-only' }[opts.mode ?? 'merge']
    const from = opts.remote && opts.branch ? [opts.remote, opts.branch] : []
    return this.moving(from.length ? `Pull ${from.join('/')}` : 'Pull', async () => {
      await this.progress(['pull', '--progress', '--no-edit', mode, ...from])
      void this.maintainCommitGraph({ force: true })
    })
  }

  push(opts: { force?: boolean; branch?: string; remote?: string; remoteBranch?: string } = {}): Promise<void> {
    return this.exclusive(async () => {
      const head = await this.currentHead()
      const branch = opts.branch ?? head.branch
      if (!branch) throw new Error('Check out a branch to push')
      const local = (await this.refs()).find((r) => r.name === `refs/heads/${branch}`)
      const force = opts.force ? ['--force-with-lease'] : []
      if (opts.remoteBranch) {
        // Push to a branch with another name on the remote, and track it.
        await this.progress(['push', '--progress', ...force, '-u', opts.remote ?? (await this.defaultRemote()), `${branch}:${opts.remoteBranch}`])
      } else if (local?.upstream && !local.upstreamGone && !opts.remote) {
        await this.progress(['push', '--progress', ...force, ...(opts.branch ? [remoteOf(local.upstream), branch] : [])])
      } else {
        const remote = opts.remote ?? (await this.defaultRemote())
        await this.progress(['push', '--progress', ...force, '-u', remote, branch])
      }
    })
  }

  private async defaultRemote(): Promise<string> {
    const remotes = (await this.read(['remote'])).split('\n').filter(Boolean)
    if (!remotes.length) throw new Error('This repository has no remotes')
    return remotes.includes('origin') ? 'origin' : remotes[0]!
  }

  deleteRemoteBranch(remoteRef: string): Promise<void> {
    return this.exclusive(async () => {
      const short = shortName(remoteRef)
      const slash = short.indexOf('/')
      await this.progress(['push', '--progress', short.slice(0, slash), '--delete', short.slice(slash + 1)])
    })
  }

  // ---------------------------------------------------------------- stash

  private async topStash(): Promise<string | null> {
    try {
      return (await this.revParse('refs/stash')) || null
    } catch {
      return null
    }
  }

  /**
   * Stash changes: everything (`includeUntracked` adds new files), only some `paths`, only what is
   * staged (`staged`), or everything while leaving the staged changes in place (`keepIndex`, to
   * test exactly what is about to be committed). Undo pops it back with --index. After a
   * --staged stash of a partly staged file that pop can refuse; the stash is kept when it does.
   */
  stashPush(opts: { message?: string; includeUntracked?: boolean; paths?: string[]; staged?: boolean; keepIndex?: boolean } = {}): Promise<number | null> {
    return this.exclusive(async () => {
      const before = await this.topStash()
      await this.git([
        'stash', 'push',
        ...(opts.includeUntracked && !opts.staged ? ['-u'] : []),
        ...(opts.staged ? ['--staged'] : []),
        ...(opts.keepIndex ? ['--keep-index'] : []),
        ...(opts.message ? ['-m', opts.message] : []),
        ...(opts.paths?.length ? ['--', ...opts.paths] : []),
      ])
      const after = await this.topStash()
      if (!after || after === before) return null
      const what = opts.paths?.length ? describePaths(opts.paths) : opts.staged ? 'staged changes' : 'changes'
      return this.record(`Stash ${what}`, [{ kind: 'stash-pop', hash: after }], (await this.currentHead()).hash)
    })
  }

  /**
   * Tower's snapshot: save the working tree as a stash entry and leave it exactly as it is (no
   * file is rewritten, so editors and watchers see nothing). `stash create` makes the commit for
   * tracked changes; untracked files get the third parent `stash -u` would give them, built in a
   * temporary index, so Apply brings them back too.
   */
  snapshotWorkTree(message?: string): Promise<number | null> {
    return this.exclusive(async () => {
      const head = await this.currentHead()
      if (!head.hash) throw new Error('Make a first commit before taking a snapshot.')
      const untracked = (await this.read(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
      let w = (await this.git(['stash', 'create'])).stdout.trim()
      if (!w && !untracked.length) return null
      const label = message?.trim() || `Snapshot ${new Date().toLocaleString()}`
      const msg = `On ${head.branch ?? '(no branch)'}: ${label}`
      if (!w) {
        // Only untracked files: stash create made nothing, so build the index commit too.
        const index = (await this.git(['commit-tree', `${head.hash}^{tree}`, '-p', head.hash, '-m', `index on ${head.branch ?? 'HEAD'}`])).stdout.trim()
        w = (await this.git(['commit-tree', `${head.hash}^{tree}`, '-p', head.hash, '-p', index, '-m', msg])).stdout.trim()
      }
      const parents = (await this.read(['rev-list', '--parents', '-n', '1', w])).trim().split(' ').slice(1)
      let u: string | null = null
      if (untracked.length) {
        const tmp = join(tmpdir(), `gitgoose-snap-${process.pid}-${Date.now()}`)
        const env = { GIT_INDEX_FILE: tmp }
        try {
          await this.git(['read-tree', '--empty'], { env })
          await this.git(['update-index', '--add', '-z', '--stdin'], { env, input: untracked.join('\0') + '\0' })
          const tree = (await this.git(['write-tree'], { env })).stdout.trim()
          u = (await this.git(['commit-tree', tree, '-m', `untracked files on ${head.branch ?? 'HEAD'}`])).stdout.trim()
        } finally {
          await rm(tmp, { force: true })
        }
      }
      const final = (await this.git(['commit-tree', `${w}^{tree}`, ...parents.flatMap((p) => ['-p', p]), ...(u ? ['-p', u] : []), '-m', msg])).stdout.trim()
      await this.git(['stash', 'store', '-m', msg, final])
      return this.record(`Snapshot "${label}"`, [{ kind: 'stash-drop', hash: final }], head.hash)
    })
  }

  /**
   * `git stash branch`: a new branch where the stash was made, checked out, with the stash
   * applied and dropped. The way out when a stash no longer applies to where you are now. Undo
   * puts the stash entry back and returns to where you were; the applied changes are dropped
   * (they are in the restored stash), unless you edited the files since, when undo refuses.
   */
  stashBranch(index: number, name: string): Promise<number> {
    return this.exclusive(async () => {
      const entry = (await this.stashList()).find((s) => s.index === index)
      if (!entry) throw new Error(`No stash@{${index}}`)
      const before = await this.currentHead()
      // What applying it will leave in the working tree: the stash's tree, plus its untracked files.
      const tree = await this.revParse(`${entry.hash}^{tree}`)
      const third = await this.runner.run(['rev-parse', '--verify', '-q', `${entry.hash}^3`], { readOnly: true, okCodes: [1] })
      const untracked = third.code === 0
        ? (await this.read(['ls-tree', '-r', '-z', third.stdout.trim()])).split('\0').filter(Boolean).map((l) => {
            const tab = l.indexOf('\t')
            return { path: l.slice(tab + 1), blob: l.slice(0, tab).split(' ')[2]! }
          })
        : []
      await this.git(['stash', 'branch', name, entry.ref])
      const tip = await this.revParse(`refs/heads/${name}`)
      return this.record(`Stash to branch ${name}`, [
        { kind: 'drop-applied', tree, untracked },
        { kind: 'stash-store', hash: entry.hash, message: entry.message },
        this.returnTo(before),
        { kind: 'update-ref', ref: `refs/heads/${name}`, to: null, from: tip },
      ], (await this.currentHead()).hash)
    })
  }

  stashApply(index: number): Promise<void> {
    return this.exclusive(async () => {
      await this.git(['stash', 'apply', `stash@{${index}}`])
    })
  }

  stashPop(index: number): Promise<number | null> {
    return this.exclusive(async () => {
      const entry = (await this.stashList()).find((s) => s.index === index)
      await this.git(['stash', 'pop', `stash@{${index}}`])
      if (!entry) return null
      return this.record('Pop stash (restores the stash entry; changes stay)', [{ kind: 'stash-store', hash: entry.hash, message: entry.message }], (await this.currentHead()).hash)
    })
  }

  stashDrop(index: number): Promise<number | null> {
    return this.exclusive(async () => {
      const entry = (await this.stashList()).find((s) => s.index === index)
      await this.git(['stash', 'drop', `stash@{${index}}`])
      if (!entry) return null
      return this.record(`Drop stash "${entry.message}"`, [{ kind: 'stash-store', hash: entry.hash, message: entry.message }], (await this.currentHead()).hash)
    })
  }

  // ---------------------------------------------------------------- conflicts

  async conflicts(): Promise<ConflictFile[]> {
    const status = await this.freshStatus()
    const out: ConflictFile[] = []
    for (const e of status.entries.filter((s: StatusEntry) => s.kind === 'unmerged')) {
      let blocks = 0
      try {
        blocks = countConflicts(await readFile(join(this.path, e.path), 'utf8'))
      } catch {
        // Deleted on one side: no file in the working tree.
      }
      out.push({ path: e.path, code: e.index + e.worktree, blocks })
    }
    return out
  }

  async conflictVersions(path: string): Promise<ConflictVersions> {
    // Stage 1 is the common ancestor, 2 is ours (HEAD), 3 is theirs (the commit being merged in).
    const [base, ours, theirs] = await Promise.all([1, 2, 3].map((n) => this.cat.readText(`:${n}:${path}`)))
    let merged: string | null = null
    try {
      merged = await readFile(join(this.path, path), 'utf8')
    } catch {
      merged = null
    }
    return { base: base ?? null, ours: ours ?? null, theirs: theirs ?? null, merged }
  }

  resolveConflict(path: string, resolution: Resolution): Promise<void> {
    return this.exclusive(async () => {
      if (typeof resolution === 'object') {
        await writeFile(join(this.path, path), resolution.content)
        await this.git(['add', '--', path])
        return
      }
      const stage = resolution === 'ours' ? 2 : 3
      const exists = (await this.cat.read(`:${stage}:${path}`)) !== null
      if (!exists) {
        // That side deleted the file: resolving to it means deleting.
        await this.git(['rm', '-q', '--', path])
      } else {
        await this.git(['checkout', `--${resolution}`, '--', path])
        await this.git(['add', '--', path])
      }
    })
  }

  continueOperation(): Promise<void> {
    return this.exclusive(async () => {
      const op = this.operation()
      if (op === 'merge') await this.git(['commit', '--no-edit'])
      else if (op === 'rebase') await this.git(['rebase', '--continue'])
      else if (op === 'cherry-pick') await this.git(['cherry-pick', '--continue'])
      else if (op === 'revert') await this.git(['revert', '--continue'])
      else if (op === 'am') await this.git(['am', '--continue'])
    })
  }

  abortOperation(): Promise<void> {
    return this.exclusive(async () => {
      const op = this.operation()
      if (op === 'merge') await this.git(['merge', '--abort'])
      else if (op === 'rebase') await this.git(['rebase', '--abort'])
      else if (op === 'cherry-pick') await this.git(['cherry-pick', '--abort'])
      else if (op === 'revert') await this.git(['revert', '--abort'])
      else if (op === 'am') await this.git(['am', '--abort'])
    })
  }

  // ---------------------------------------------------------------- undo

  undoList(): UndoEntry[] {
    return this.journal.list()
  }

  /**
   * Undo the most recent operation and return its label (null when there is nothing to undo).
   * With `entryId` (from a toast's Undo button), refuse unless that entry is still the most recent:
   * otherwise an old toast would undo some newer, unrelated operation.
   */
  undo(entryId?: number): Promise<string | null> {
    return this.exclusive(async () => {
      const entry = this.journal.peek()
      if (!entry) return null
      if (entryId !== undefined && entry.id !== entryId) {
        throw new Error(`Something else happened since, so this cannot be undone from here. Use Undo in the toolbar to step back one operation at a time (next: "${entry.label}").`)
      }
      const head = await this.currentHead()
      if (head.hash !== entry.expectHead) {
        throw new Error(`Cannot undo "${entry.label}": HEAD has moved since (another tool changed the repository)`)
      }
      const redo = await this.inverse(entry.actions)
      for (const action of entry.actions) await this.perform(action)
      this.journal.pop()
      const after = (await this.currentHead()).hash
      if (redo) this.journal.pushRedo({ ...entry, actions: redo, expectHead: after }, entry)
      return entry.label
    })
  }

  /** Redo the operation undone last (when nothing has happened since). Returns its label. */
  redo(): Promise<string | null> {
    return this.exclusive(async () => {
      const r = this.journal.peekRedo()
      if (!r) return null
      const head = await this.currentHead()
      if (head.hash !== r.redo.expectHead) {
        this.journal.clearRedo()
        throw new Error(`Cannot redo "${r.redo.label}": the repository changed since it was undone.`)
      }
      for (const action of r.redo.actions) await this.perform(action)
      this.journal.popRedo()
      // Back on the undo stack, expecting the HEAD we are at now.
      this.journal.restore({ ...r.original, expectHead: (await this.currentHead()).hash })
      return r.redo.label
    })
  }

  redoList(): UndoEntry[] {
    return this.journal.redoList()
  }

  /**
   * The actions that would redo `actions` after they are performed, or null when some step
   * cannot be reversed from data alone (a discard, a stash pop: those stay undo-only).
   */
  private async inverse(actions: UndoAction[]): Promise<UndoAction[] | null> {
    const out: UndoAction[] = []
    const head = await this.currentHead()
    for (const a of actions) {
      switch (a.kind) {
        case 'reset':
          if (!head.hash) return null
          out.push({ kind: 'reset', to: head.hash, mode: a.mode })
          break
        case 'update-ref':
          out.push({ kind: 'update-ref', ref: a.ref, to: a.from, from: a.to })
          break
        case 'checkout':
          out.push({ kind: 'checkout', target: head.branch ?? head.hash!, detach: !head.branch })
          break
        case 'rename-branch':
          out.push({ kind: 'rename-branch', from: a.to, to: a.from })
          break
        case 'config-value':
          out.push({ ...a, add: !a.add })
          break
        default:
          return null
      }
    }
    return out.reverse()
  }

  private async perform(a: UndoAction): Promise<void> {
    switch (a.kind) {
      case 'reset':
        await this.git(['reset', `--${a.mode}`, a.to])
        break
      case 'update-ref':
        // The old value makes git refuse if the ref has moved since: undo never clobbers
        // commits someone added to a branch in the meantime.
        if (a.to === null) await this.git(['update-ref', '-d', a.ref, ...(a.from ? [a.from] : [])])
        else await this.git(['update-ref', a.ref, a.to, a.from ?? ''])
        break
      case 'read-tree':
        await this.git(['read-tree', a.tree])
        break
      case 'checkout':
        await this.git(a.detach ? ['checkout', '--detach', a.target] : ['checkout', a.target])
        break
      case 'rename-branch':
        await this.git(['branch', '-m', a.from, a.to])
        break
      case 'set-upstream':
        if (a.upstream) await this.git(['branch', `--set-upstream-to=${shortName(a.upstream)}`, a.branch], { okCodes: [128] })
        else await this.git(['branch', '--unset-upstream', a.branch], { okCodes: [128] })
        break
      case 'remote-add':
        await this.git(['remote', 'add', a.name, a.url])
        if (a.pushUrl) await this.git(['remote', 'set-url', '--push', a.name, a.pushUrl])
        break
      case 'remote-remove':
        await this.git(['remote', 'remove', a.name])
        break
      case 'remote-rename':
        await this.git(['remote', 'rename', a.from, a.to])
        break
      case 'remote-url':
        if (a.url) await this.git(['remote', 'set-url', ...(a.push ? ['--push'] : []), a.name, a.url])
        else await this.git(['config', '--unset', `remote.${a.name}.pushurl`], { okCodes: [5] })
        break
      case 'stash-pop': {
        // Find the entry by its commit: other stash operations may have moved it from stash@{0}.
        const entry = (await this.stashList()).find((s) => s.hash === a.hash)
        if (!entry) throw new Error('The stash this would restore no longer exists')
        await this.git(['stash', 'pop', '--index', entry.ref])
        break
      }
      case 'stash-drop': {
        const entry = (await this.stashList()).find((s) => s.hash === a.hash)
        if (entry) await this.git(['stash', 'drop', entry.ref])
        break
      }
      case 'stash-store':
        await this.git(['stash', 'store', '-m', a.message, a.hash])
        break
      case 'stash-apply':
        await this.git(['stash', 'apply', a.hash])
        break
      case 'restore-tree': {
        // Check the tree out into the working tree through a throwaway index.
        const tmp = join(tmpdir(), `gitgoose-index-${process.pid}-${Date.now()}`)
        try {
          await this.git(['read-tree', a.tree], { env: { GIT_INDEX_FILE: tmp } })
          await this.git(['checkout-index', '-a', '-f'], { env: { GIT_INDEX_FILE: tmp } })
        } finally {
          await rm(tmp, { force: true })
        }
        break
      }
      case 'config-value':
        if (a.add) await this.git(['config', '--add', a.key, a.value])
        else await this.git(['config', '--unset-all', '--fixed-value', a.key, a.value], { okCodes: [5] })
        break
      case 'index-entries':
        // --force-remove drops every stage (a conflict left by --3way), then the saved entries go back.
        await this.git(['update-index', '--force-remove', '--', ...a.paths])
        for (const e of a.entries) await this.git(['update-index', '--add', '--cacheinfo', `${e.mode},${e.blob},${e.path}`])
        break
      case 'config':
        if (a.value === null) await this.git(['config', `--${a.scope}`, '--unset', a.key], { okCodes: [5] })
        else await this.git(['config', `--${a.scope}`, a.key, a.value])
        break
      case 'submodule-forget': {
        const inside = (args: string[]) => this.runner.run(['-C', a.path, ...args], { readOnly: true, okCodes: [128] })
        const head = await inside(['rev-parse', 'HEAD'])
        if (head.code === 0 && (head.stdout.trim() !== a.commit || (await inside(['status', '--porcelain'])).stdout.trim())) {
          throw new Error(`${a.path} has new commits or changes since it was added: undo would delete them.`)
        }
        await this.git(['submodule', 'deinit', '-f', '--', a.path], { okCodes: [1, 128] })
        await rm(join(this.path, a.path), { recursive: true, force: true })
        await rm(join(this.gitDir, 'modules', a.name), { recursive: true, force: true })
        await this.git(['config', '--remove-section', `submodule.${a.name}`], { okCodes: [128] })
        break
      }
      case 'submodule-restore':
        await this.git(['submodule', 'update', '--init', '--', a.path])
        break
      case 'worktree-remove':
        await this.git(['worktree', 'remove', a.path])
        break
      case 'worktree-add':
        await this.git(['worktree', 'add', ...(a.branch ? [a.path, a.branch] : ['--detach', a.path, a.commit])])
        break
      case 'drop-applied': {
        // `stash create` snapshots the tracked working tree without touching anything.
        const w = (await this.git(['stash', 'create'])).stdout.trim()
        const tree = await this.revParse(`${w || 'HEAD'}^{tree}`)
        const changed = 'The working tree changed since, so undo cannot tell your edits from the stash: commit or stash them first.'
        if (tree !== a.tree) throw new Error(changed)
        for (const f of a.untracked) {
          if ((await this.read(['hash-object', '--', f.path])).trim() !== f.blob) throw new Error(changed)
        }
        await this.git(['reset', '--hard', '-q'])
        for (const f of a.untracked) await rm(join(this.path, f.path), { force: true })
        break
      }
      case 'restore-files':
        for (const f of a.files) {
          const abs = join(this.path, f.path)
          if (f.blob === null) {
            await rm(abs, { force: true })
            continue
          }
          const content = await this.cat.read(f.blob)
          if (!content) throw new Error(`Saved copy of ${f.path} is gone`)
          await mkdir(dirname(abs), { recursive: true })
          await writeFile(abs, content)
          if (f.mode !== undefined && process.platform !== 'win32') await chmod(abs, f.mode)
        }
        break
    }
  }
}

function shortName(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes|tags)\//, '')
}

function remoteOf(upstream: string): string {
  return shortName(upstream).split('/')[0]!
}

function firstLine(s: string): string {
  const l = s.trim().split('\n')[0] ?? ''
  return l.length > 50 ? l.slice(0, 47) + '...' : l
}

function lastLine(t: string): string {
  const parts = t.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** Paths from `git apply --numstat -z`: "add\tdel\tpath\0", or "add\tdel\t\0old\0new\0" for a rename. */
export function parseNumstatPaths(out: string): string[] {
  const parts = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!
    if (!rec) continue
    const m = /^[\d-]+\t[\d-]+\t(.*)$/s.exec(rec)
    if (!m) continue
    if (m[1]) paths.push(m[1])
    else {
      paths.push(parts[i + 1]!, parts[i + 2]!)
      i += 2
    }
  }
  return [...new Set(paths.filter(Boolean))]
}

/** Common words in code that are not worth looking up as definitions. */
/** The input a review, walkthrough or impact works on: what reviewInput returns. */
export interface ReviewInput {
  files: FileDiff[]
  label: string
  /** The revision line numbers refer to: 'worktree', 'index', or a commit. */
  head: string
  base?: string
  /** Each file's text after the change. */
  texts: Map<string, string>
  /** Files in the change but not sent (over the size budget). */
  skipped: string[]
}

/** The revision a review head names for textAt / graphFor: null the working tree, '' the index. */
function revOf(head: string): string | null {
  return head === 'worktree' ? null : head === 'index' ? '' : head
}

/** git's id for a blob with this text: SHA-1 of "blob <size>\0" and the bytes. (A SHA-256 repository just misses the lookup.) */
export function blobId(text: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')
}

/** New-side line numbers that are added lines, per file: a use there is part of the change, not outside it. */
function addedLineNumbers(files: FileDiff[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  for (const f of files) {
    const set = new Set<number>()
    for (const h of f.hunks) for (const l of h.lines) if (l.newNo !== undefined && l.kind === '+') set.add(l.newNo)
    out.set(f.path, set)
  }
  return out
}

const KEYWORDS = new Set(['const', 'let', 'var', 'true', 'false', 'null', 'undefined', 'void', 'number', 'string', 'boolean', 'any', 'unknown', 'never',
  'async', 'export', 'import', 'from', 'default', 'class', 'interface', 'type', 'extends', 'implements', 'public', 'private', 'protected', 'static',
  'self', 'None', 'True', 'False', 'def', 'pass', 'lambda', 'yield', 'func', 'struct', 'impl', 'pub', 'mut', 'let', 'nil', 'end', 'then', 'elif',
  'console', 'log', 'length', 'push', 'map', 'filter', 'Math', 'Object', 'Array', 'String', 'Number', 'Promise', 'Error', 'JSON', 'throw', 'break', 'continue', 'case', 'in', 'of', 'and', 'not'])

function describePaths(paths: string[]): string {
  return paths.length === 1 ? paths[0]! : `${paths.length} files`
}

/** "Ada Lovelace <ada@example.com>" -> author environment for commit-tree. */
function splitAuthor(a: string): Record<string, string> {
  const m = /^(.*) <(.*)>$/.exec(a)
  return m ? { GIT_AUTHOR_NAME: m[1]!, GIT_AUTHOR_EMAIL: m[2]! } : {}
}

/** Quote for a POSIX shell (git runs editors through one, also on Windows). */
function shellQuote(s: string): string {
  return `'${s.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`
}

/** One line of an interactive rebase we write ourselves. */
interface TodoItem {
  hash: string
  action?: 'pick' | 'squash' | 'fixup'
  /** Reword: the commit's new message. */
  message?: string
}
