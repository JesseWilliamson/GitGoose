import type {
  BlameLine, Commit, CommitDetails, ConflictFile, ConflictVersions, DiffOptions, DiffTarget, FileDiff, Head, PullMode,
  LogPage, Ref, RepoOperation, RepoSnapshot, ResetMode, Resolution, SearchField, SelectionRequest,
  StashEntry, StatusEntry, UndoEntry,
} from '@gitsquid/shared'
import { countConflicts } from '@gitsquid/shared'
import { existsSync } from 'node:fs'
import { lstat, readFile, rm, writeFile, chmod, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseBlame } from './blame'
import { CatFile } from './catfile'
import { parseChangedFiles, parseDiff, untrackedDiff } from './diff'
import { graphRevs, LOG_FORMAT, LogStream, parseLog } from './log'
import { buildPatch } from './patch'
import { parseRefs, REFS_FORMAT } from './refs'
import { GitRunner } from './runner'
import { parseStashList, STASH_FORMAT } from './stash'
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
    const [statusOut, refsOut] = await Promise.all([
      this.read(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']),
      this.read(['for-each-ref', `--format=${REFS_FORMAT}`]),
    ])
    const status = parseStatus(statusOut)
    const refs = parseRefs(refsOut)
    const key = `${status.head.branch}|${status.head.hash}|` + refs.map((r) => `${r.name}=${r.hash}`).join(',')
    if (key !== this.refsKey) {
      this.refsKey = key
      this.refsVersion++
      this.log?.dispose()
      this.log = null
    }
    this.last = {
      id: this.id, path: this.path, name: this.name,
      head: status.head, refs, status: status.entries,
      operation: this.operation(), refsVersion: this.refsVersion,
    }
    return this.last
  }

  get lastSnapshot(): RepoSnapshot | null {
    return this.last
  }

  operation(): RepoOperation {
    const has = (f: string) => existsSync(join(this.gitDir, f))
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
   * `git log --topo-order` must emit children before parents. Without generation numbers it
   * can only prove that by walking the entire history first, so the first page of a 100k-commit
   * log waits ~500 ms for the whole walk. The commit-graph stores generation numbers, letting git
   * stream topological order incrementally: the same first page takes ~10 ms. It is the same
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

  async logPage(offset: number, count: number): Promise<LogPage> {
    if (!this.last) await this.snapshot()
    if (!this.log) this.log = new LogStream(this.runner, graphRevs(this.last!.head.hash))
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
      files,
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

  async fileHistory(path: string): Promise<Commit[]> {
    return parseLog(await this.read(['log', '--follow', `--format=${LOG_FORMAT}`, '-n', '1000', '--', path]))
  }

  async blame(path: string, rev?: string): Promise<BlameLine[]> {
    return parseBlame(await this.read(['blame', '--porcelain', ...(rev ? [rev] : []), '--', path]))
  }

  async search(field: SearchField, query: string): Promise<string[]> {
    const q = query.trim()
    if (!q) return []
    const head = (this.last ?? (await this.snapshot())).head
    const base = ['log', '--format=%H', '-n', '2000', ...graphRevs(head.hash)]
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

  commit(message: string, opts: { amend?: boolean; signOff?: boolean; gpgSign?: boolean } = {}): Promise<number> {
    return this.exclusive(async () => {
      const before = await this.currentHead()
      const flags = [...(opts.amend ? ['--amend'] : []), ...(opts.signOff ? ['--signoff'] : []), ...(opts.gpgSign ? ['-S'] : [])]
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
    return this.exclusive(async () => {
      await this.git(['branch', '-m', from, to])
      return this.record(`Rename ${from} to ${to}`, [{ kind: 'rename-branch', from: to, to: from }], (await this.currentHead()).hash)
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

  merge(ref: string, opts: { noFf?: boolean; ffOnly?: boolean } = {}): Promise<number | null> {
    const flags = opts.ffOnly ? ['--ff-only'] : opts.noFf ? ['--no-ff'] : []
    return this.moving(`Merge ${shortName(ref)}`, () => this.git(['merge', '--no-edit', ...flags, shortName(ref)]))
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
    const tmp = join(tmpdir(), `gitsquid-index-${process.pid}-${Date.now()}`)
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

  async revert(hash: string): Promise<number | null> {
    const mainline = (await this.isMerge(hash)) ? ['-m', '1'] : []
    return this.moving(`Revert ${hash.slice(0, 7)}`, () => this.git(['revert', '--no-edit', ...mainline, hash]))
  }

  createTag(name: string, hash: string, message?: string): Promise<number> {
    return this.exclusive(async () => {
      await this.git(['tag', ...(message ? ['-a', '-m', message] : []), name, hash])
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

  pull(opts: { mode?: PullMode } = {}): Promise<number | null> {
    const mode = { merge: '--no-rebase', rebase: '--rebase', 'ff-only': '--ff-only' }[opts.mode ?? 'merge']
    return this.moving('Pull', async () => {
      await this.progress(['pull', '--progress', '--no-edit', mode])
      void this.maintainCommitGraph({ force: true })
    })
  }

  push(opts: { force?: boolean; branch?: string; remote?: string } = {}): Promise<void> {
    return this.exclusive(async () => {
      const head = await this.currentHead()
      const branch = opts.branch ?? head.branch
      if (!branch) throw new Error('Check out a branch to push')
      const local = (await this.refs()).find((r) => r.name === `refs/heads/${branch}`)
      const force = opts.force ? ['--force-with-lease'] : []
      if (local?.upstream && !local.upstreamGone && !opts.remote) {
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

  stashPush(opts: { message?: string; includeUntracked?: boolean } = {}): Promise<number | null> {
    return this.exclusive(async () => {
      const before = await this.topStash()
      await this.git(['stash', 'push', ...(opts.includeUntracked ? ['-u'] : []), ...(opts.message ? ['-m', opts.message] : [])])
      const after = await this.topStash()
      if (!after || after === before) return null
      return this.record('Stash changes', [{ kind: 'stash-pop', hash: after }], (await this.currentHead()).hash)
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
    })
  }

  abortOperation(): Promise<void> {
    return this.exclusive(async () => {
      const op = this.operation()
      if (op === 'merge') await this.git(['merge', '--abort'])
      else if (op === 'rebase') await this.git(['rebase', '--abort'])
      else if (op === 'cherry-pick') await this.git(['cherry-pick', '--abort'])
      else if (op === 'revert') await this.git(['revert', '--abort'])
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
      for (const action of entry.actions) await this.perform(action)
      this.journal.pop()
      return entry.label
    })
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
        await this.git(['branch', `--set-upstream-to=${shortName(a.upstream)}`, a.branch], { okCodes: [128] })
        break
      case 'stash-pop': {
        // Find the entry by its commit: other stash operations may have moved it from stash@{0}.
        const entry = (await this.stashList()).find((s) => s.hash === a.hash)
        if (!entry) throw new Error('The stash this would restore no longer exists')
        await this.git(['stash', 'pop', '--index', entry.ref])
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
        const tmp = join(tmpdir(), `gitsquid-index-${process.pid}-${Date.now()}`)
        try {
          await this.git(['read-tree', a.tree], { env: { GIT_INDEX_FILE: tmp } })
          await this.git(['checkout-index', '-a', '-f'], { env: { GIT_INDEX_FILE: tmp } })
        } finally {
          await rm(tmp, { force: true })
        }
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

function describePaths(paths: string[]): string {
  return paths.length === 1 ? paths[0]! : `${paths.length} files`
}
