import type {
  BlameLine, ChangedFile, Commit, CommitDetails, ConflictFile, ConflictVersions, DiffOptions, DiffTarget, FileDiff, Head, PullMode,
  LogPage, Ref, Remote, RepoOperation, ReflogEntry, RepoSnapshot, ResetMode, Resolution, SearchField, SelectionRequest,
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
import { searchLog } from './search'
import { checkPlan, patchFor, splitUnits, type PlannedCommit, type RecomposeUnit } from './recompose'
import { buildPatch } from './patch'
import { parseRefs, REFS_FORMAT } from './refs'
import { GitRunner } from './runner'
import { parseReflog, REFLOG_FORMAT } from './reflog'
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
    const stashes = this.showStashes ? await this.stashHashes() : []
    const key = `${status.head.branch}|${status.head.hash}|` + refs.map((r) => `${r.name}=${r.hash}`).join(',') + `|${stashes.join(',')}`
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

  /** Show stashes as nodes in the graph (the showStashes setting). */
  private showStashes = true

  setShowStashes(show: boolean): void {
    if (show === this.showStashes) return
    this.showStashes = show
    // Force a new log (and a new refsVersion, so the renderer starts over too).
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
      this.log = new LogStream(this.runner, graphRevs(this.last!.head.hash), undefined, stashes)
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
        return await searchLog(this.runner, graphRevs(head.hash), q, { refNames, signal: abort.signal })
      } finally {
        if (this.searching === abort) this.searching = null
      }
    }
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
      await this.git(['update-ref', '-m', `gitsquid: fast-forward to ${shortName(ref.upstream)}`, ref.name, target.hash, ref.hash])
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
          const msgFile = join(this.gitDir, `gitsquid-msg-${process.pid}-${files.length}`)
          await writeFile(msgFile, t.message.trim() + '\n')
          files.push(msgFile)
          lines.push(`exec git commit --amend --allow-empty --no-verify -F ${shellQuote(msgFile)}`)
        }
      }
      const file = join(this.gitDir, `gitsquid-todo-${process.pid}`)
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
  squashOnto(hashes: string[], target: string): Promise<number | null> {
    return this.reorder(`Squash ${hashes.length === 1 ? hashes[0]!.slice(0, 7) : `${hashes.length} commits`} into ${target.slice(0, 7)}`, async (chain) => {
      if (![...hashes, target].every((h) => chain.includes(h)) || hashes.includes(target)) {
        throw new Error('Only commits on the current branch, after its last merge, can be squashed.')
      }
      const moving = chain.filter((h) => hashes.includes(h))
      const rest = chain.filter((h) => !hashes.includes(h))
      const at = rest.indexOf(target) + 1
      return [...rest.slice(0, at), ...moving.map((h) => ({ hash: h, action: 'squash' as const })), ...rest.slice(at)]
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
      const index = join(this.gitDir, `gitsquid-recompose-${process.pid}.index`)
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
        await this.git(['update-ref', '-m', 'gitsquid: recompose', ref, parent!, oldHead])
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
