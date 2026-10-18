import { GraphLayout, type Row } from '@gitgoose/graph'
import { SETTINGS, type PullRequestList, type CodeGraphStatus, type Commit, type DiffTarget, type GitHubStatus, type GitGooseEvent, type AskThread, type LfsInfo, type PushCheckResult, type Ref, type Remote, type RepoSnapshot, type Submodule, type Worktree, type SettingKey, type Settings, type StashEntry, type UndoEntry } from '@gitgoose/shared'
import { create } from 'zustand'
import { api, toUiError, type UiError } from './api'
import { onAiEvent } from './ai'
import { opName } from './format'
import { followRewrite } from './rewrite'
import type { ReviewState } from './review'
import type { WalkthroughState } from './walkthrough'
import type { ImpactState } from './impact'

export type Selection =
  | { kind: 'wip' }
  | { kind: 'commit'; hash: string }
  /**
   * Several commits (Shift- or Ctrl/Cmd-click). `hashes` are in graph order; `anchor` is where a
   * Shift-click range starts, `cursor` the commit the keyboard moves from.
   */
  | { kind: 'commits'; hashes: string[]; anchor: string; cursor: string }
  /** Comparing two revisions, or a revision and the working tree (`to` null). */
  | { kind: 'compare'; from: string; to: string | null; fromLabel: string; toLabel: string }

export type FileMode = 'diff' | 'history' | 'blame'

export type CenterView =
  | { kind: 'graph' }
  | { kind: 'file'; target: DiffTarget; mode: FileMode }
  | { kind: 'conflicts' }
  | { kind: 'reflog' }
  | { kind: 'commands' }
  | { kind: 'review' }
  | { kind: 'walkthrough' }
  | { kind: 'impact' }

export interface RepoView {
  id: string
  snapshot: RepoSnapshot
  /** Bumped when the log data (outside React state) changes; components subscribe to it. */
  logVersion: number
  selected: Selection
  center: CenterView
  /** Commits that drop / move / drag can edit: the current branch back to its last merge, newest first. */
  editable: string[]
  /** Undone operations that can be redone, newest first. */
  redo: UndoEntry[]
  stashes: StashEntry[]
  undo: UndoEntry[]
  /** Configured remotes (a remote with no branches fetched yet still shows). */
  remotes: Remote[]
  worktrees: Worktree[]
  submodules: Submodule[]
  lfs: LfsInfo | null
  /** Pull requests, loaded only when the user opens the list (it is a network call). */
  pulls: PullRequestList | null
  pullsLoading: boolean
  /** The last AI review in this repository (see lib/review.ts). */
  review: ReviewState | null
  walkthrough: WalkthroughState | null
  impact: ImpactState | null
  /** The question thread open under the diff, if any. */
  ask: AskThread | null
  /** Saved threads (newest first), loaded with the repository. */
  askThreads: AskThread[]
  /** Local branches already in HEAD: safe to delete. */
  merged: string[]
  /** Tag names on a remote, after the user asked to check (the only way it is read: network). */
  remoteTags: { remote: string; names: string[] } | null
  progress: string | null
  busy: string | null
  /** Bumped whenever files change on disk; open diffs reload on it. */
  worktreeTick: number
  /** The code graph (ADR-008): Peek and Impact wait while it indexes. */
  codegraph: CodeGraphStatus
}

/** Toasts are for outcomes that need nothing from the user: successes and notes. */
export interface Toast {
  id: number
  kind: 'info' | 'success'
  title: string
  detail?: string
  action?: { label: string; run: () => void }
}

export interface Choice {
  label: string
  variant?: 'primary' | 'danger' | 'default'
  run?: () => void | Promise<void>
}

/**
 * A failure the user must notice: shown in the attention bar under the tab bar until dismissed.
 * Failures that are really a question ("delete anyway?") use a choice dialog instead.
 */
export interface Attention {
  id: number
  /** Attentions with the same key replace each other (one "conflicts" row per repository). */
  key?: string
  title: string
  detail?: string
  actions?: Choice[]
  time: number
}

export type Dialog =
  | {
      kind: 'input'
      title: string
      label: string
      placeholder?: string
      initial?: string
      confirm: string
      /** A second, optional field (e.g. a tag message). */
      extra?: { label: string; placeholder?: string; initial?: string }
      onSubmit: (value: string, extra: string) => void | Promise<void>
    }
  | { kind: 'confirm'; title: string; message: string; confirm: string; danger?: boolean; onConfirm: () => void | Promise<void> }
  /** A question with several answers; the last choice is usually Cancel (a choice with no run). */
  | { kind: 'choice'; title: string; message: string; detail?: string; choices: Choice[]; onDismiss?: () => void }
  | { kind: 'clone' }
  | { kind: 'shortcuts' }
  /** Several lines of text (a commit message). */
  | { kind: 'text'; title: string; initial: string; confirm: string; onSubmit: (text: string) => void }
  /** Who commits are made as, for this repository or globally. `onSaved` refreshes whoever asked. */
  | { kind: 'identity'; repoId: string; onSaved?: () => void }
  /** Pick one of many (filterable): co-authors, remote branches. */
  | { kind: 'pick'; title: string; placeholder?: string; items: { label: string; detail?: string; value: string }[]; onPick: (value: string) => void }
  /** Open a pull request for a branch. */
  | { kind: 'create-pr'; repoId: string; branch: string }
  /** The review learnings of a repository, to read and remove. */
  | { kind: 'learnings'; repoId: string }
  /** Results of pre-push checks that need the user (a failure, or a blocking check not judged). */
  | { kind: 'push-checks'; repoId: string; label: string; results: PushCheckResult[]; outcome: 'warn' | 'block'; onPush: () => void }
  /** Editing this repository's own pre-push checks. */
  | { kind: 'push-rules'; repoId: string }
  /** Git LFS locks on the server (fetched when the dialog opens). */
  | { kind: 'lfs-locks'; repoId: string }
  /** Branch cleanup: pick merged or stale branches to delete. */
  | { kind: 'cleanup'; repoId: string }

export interface DropRequest {
  x: number
  y: number
  source: Ref
  /** Where it was dropped: a ref pill, or just a commit row. */
  target: { ref?: Ref; hash: string }
}

export type MenuTarget =
  | { kind: 'commit'; hash: string }
  | { kind: 'commits'; hashes: string[] }
  | { kind: 'stash'; stash: StashEntry }
  | { kind: 'ref'; ref: Ref; hash: string }
  | { kind: 'remote'; remote: string }
  | { kind: 'worktree'; path: string }
  | { kind: 'submodule'; path: string }
  | { kind: 'lfs-pattern'; pattern: string }
  | { kind: 'pull'; number: number }
  /** A sidebar section header with its own actions. */
  | { kind: 'section'; section: 'local' | 'remotes' | 'tags' | 'worktrees' | 'submodules' | 'lfs' }
  | null

interface State {
  settings: Settings | null
  tabs: string[]
  active: string | null
  repos: Record<string, RepoView>
  prompt: { promptId: number; message: string; secret: boolean } | null
  dialog: Dialog | null
  toasts: Toast[]
  attentions: Attention[]
  /** The omni search, open with this text in the box ("> " for commands only), or closed. */
  omni: { query: string } | null
  /** What the settings page's search box starts with (the omni search opens settings this way). */
  settingsQuery: string
  drop: DropRequest | null
  menu: MenuTarget
  /** Progress text for a clone in flight. */
  cloneProgress: string | null
  /** A full-window page shown instead of the repository (or welcome) view. */
  page: 'settings' | null
  /** GitHub sign-in state; loaded when first needed (the Accounts panel), then kept by events. */
  github: GitHubStatus | null
}

export const useStore = create<State>(() => ({
  settings: null,
  tabs: [],
  active: null,
  repos: {},
  prompt: null,
  dialog: null,
  toasts: [],
  attentions: [],
  omni: null,
  settingsQuery: '',
  drop: null,
  menu: null,
  cloneProgress: null,
  page: null,
  github: null,
}))

const set = useStore.setState
const get = useStore.getState

export function updateRepo(id: string, patch: Partial<RepoView> | ((v: RepoView) => Partial<RepoView>)): void {
  set((s) => {
    const v = s.repos[id]
    if (!v) return s
    const p = typeof patch === 'function' ? patch(v) : patch
    return { repos: { ...s.repos, [id]: { ...v, ...p } } }
  })
}

export function activeRepo(): RepoView | null {
  const s = get()
  return s.active ? (s.repos[s.active] ?? null) : null
}

/** One setting, falling back to its default before settings have loaded. */
export function useSetting<K extends SettingKey>(key: K): Settings[K] {
  return useStore((s) => (s.settings ? s.settings[key] : (SETTINGS[key].default as Settings[K])))
}

export function setting<K extends SettingKey>(key: K): Settings[K] {
  const s = get().settings
  return s ? s[key] : (SETTINGS[key].default as Settings[K])
}

export function useActiveRepo(): RepoView | null {
  return useStore((s) => (s.active ? (s.repos[s.active] ?? null) : null))
}

// ------------------------------------------------------------------ log data

/**
 * The commit log lives outside React state, in plain arrays we append to.
 *
 * With 100k commits, copying the array into a new state object for every page would cost more
 * than loading the page. Instead we mutate these arrays and bump `logVersion` in the store; the
 * virtualized graph re-reads rows by index for the 40 or so rows on screen.
 */
export interface LogData {
  commits: Commit[]
  rows: Row[]
  index: Map<string, number>
  layout: GraphLayout
  generation: number
  done: boolean
  loading: Promise<void> | null
  /** Widest row seen so far, in lanes. */
  maxWidth: number
}

const logs = new Map<string, LogData>()
/**
 * A log being rebuilt because the refs changed, until its first page is in. The old one stays on
 * screen meanwhile (see resetLog), so `getLog` keeps returning it.
 */
const pending = new Map<string, LogData>()

export function getLog(id: string): LogData {
  let l = logs.get(id)
  if (!l) {
    l = emptyLog(undefined, -1)
    logs.set(id, l)
  }
  return l
}

function emptyLog(snap: RepoSnapshot | undefined, generation: number): LogData {
  // The trunk (main, origin/main) keeps the leftmost lane, so a checkout does not move it.
  const trunk = snap ? snap.refs.filter((r) => snap.trunk.includes(r.name)).map((r) => r.hash) : []
  return {
    commits: [], rows: [], index: new Map(), layout: new GraphLayout({ head: snap?.head.hash, trunk }),
    generation, done: false, loading: null, maxWidth: 1,
  }
}

/** The generation the log on its way (or on screen) was walked from. */
function logGeneration(id: string): number {
  return (pending.get(id) ?? logs.get(id))?.generation ?? -1
}

/**
 * The refs changed: walk the history again from this snapshot.
 *
 * When rows are on screen they stay there until the new walk's first page is in, and the two
 * are swapped in one render (see swapIn). Emptying the list first would collapse it to a
 * "Loading…" row for a frame or two and drop the scroll position, which reads as a flicker on
 * every commit, checkout or reorder. The first page is as big as what was loaded before (up to
 * one regular page), so the swap does not shorten the list under the scrollbar.
 */
function resetLog(id: string, snap: RepoSnapshot): void {
  const next = emptyLog(snap, snap.refsVersion)
  const live = logs.get(id)
  if (!live || live.commits.length === 0) {
    pending.delete(id)
    logs.set(id, next)
    updateRepo(id, (v) => ({ logVersion: v.logVersion + 1 }))
    void loadInto(id, next)
    return
  }
  pending.set(id, next)
  void loadInto(id, next, Math.max(FIRST_PAGE, Math.min(live.commits.length, PAGE)))
}

/**
 * The new log's first page is in: it replaces the one on screen. A selection that pointed at
 * commits the rewrite replaced (a rebase gives every replayed commit a new hash) follows them to
 * their new hashes, so the detail panel shows the commit the user just moved, not a stale copy.
 * A selected commit that is gone (dropped, or folded into another) gives way to HEAD.
 */
function swapIn(id: string, log: LogData): void {
  const old = logs.get(id)
  pending.delete(id)
  logs.set(id, log)
  const v = get().repos[id]
  if (!old || !v) return
  const sel = v.selected
  const hashes = selectedHashes(sel)
  if (!hashes.length || hashes.every((h) => log.index.has(h))) return
  const next = followRewrite(hashes, old, log)
  const head = v.snapshot.head.hash
  let selected: Selection = next[0] ? { kind: 'commit', hash: next[0] } : head ? { kind: 'commit', hash: head } : { kind: 'wip' }
  if (sel.kind === 'commits' && next.length > 1) {
    const [anchor] = followRewrite([sel.anchor], old, log)
    const [cursor] = followRewrite([sel.cursor], old, log)
    selected = { kind: 'commits', hashes: next, anchor: anchor ?? next[0]!, cursor: cursor ?? next[next.length - 1]! }
  }
  updateRepo(id, { selected })
}

/** First page small so the first screen paints fast; later pages large to cut round trips. */
const FIRST_PAGE = 300
const PAGE = 3000

export function loadMore(id: string): Promise<void> {
  // The log on screen is being replaced: its pages would now come from the new walk, in the new
  // order, so it must not grow. Callers wait for the swap instead; the new log pages as usual.
  const next = pending.get(id)
  if (next) return next.loading ?? Promise.resolve()
  return loadInto(id, getLog(id))
}

function loadInto(id: string, log: LogData, firstPage = FIRST_PAGE): Promise<void> {
  if (log.loading) return log.loading
  if (log.done) return Promise.resolve()
  const offset = log.commits.length
  const count = offset === 0 ? firstPage : PAGE
  const current = () => logs.get(id) === log || pending.get(id) === log
  log.loading = api.logPage(id, offset, count)
    .then(
      async (page) => {
        if (!current()) return // reset while we were waiting
        if (page.generation !== log.generation) {
          // Refs moved since our snapshot: fetch a fresh one, which resets and reloads.
          onSnapshot(await api.snapshot(id))
          return
        }
        const rows = log.layout.push(page.commits)
        for (let i = 0; i < page.commits.length; i++) {
          const c = page.commits[i]!
          log.index.set(c.hash, log.commits.length)
          log.commits.push(c)
          log.rows.push(rows[i]!)
          if (rows[i]!.width > log.maxWidth) log.maxWidth = rows[i]!.width
        }
        log.done = page.done
        if (pending.get(id) === log) swapIn(id, log)
        else if (offset === 0) performance.mark('gitgoose:first-page')
        updateRepo(id, (v) => ({ logVersion: v.logVersion + 1 }))
      },
      (e) => {
        log.done = true
        if (pending.get(id) === log) swapIn(id, log)
        reportError('Could not read history', e)
      },
    )
    // Cleared last (not before the swap): `loadMore` on a pending log hands out this promise, and
    // a caller looping on it (ensureLoaded) must not see a pending log with nothing in flight.
    .finally(() => {
      log.loading = null
    })
  return log.loading
}

/** The commits a selection covers, in graph order. */
export function selectedHashes(sel: Selection): string[] {
  return sel.kind === 'commit' ? [sel.hash] : sel.kind === 'commits' ? sel.hashes : []
}

/**
 * When the selected commits (newest first) form a chain, each one's parent being the next one
 * down, their combined change is one diff: from the oldest one's parent to the newest. That
 * parent, or undefined when they do not follow each other (or the chain starts at a root commit).
 */
export function chainBase(id: string, hashes: string[]): string | undefined {
  const log = getLog(id)
  const commits = hashes.map((h) => log.commits[log.index.get(h) ?? -1])
  if (commits.some((c) => !c)) return undefined
  const ok = commits.every((c, i) => i === commits.length - 1 || c!.parents[0] === commits[i + 1]!.hash)
  return ok ? commits[commits.length - 1]!.parents[0] : undefined
}

/** The commit the keyboard moves from (the last one clicked). */
export function selectionCursor(sel: Selection): string | null {
  return sel.kind === 'commit' ? sel.hash : sel.kind === 'commits' ? sel.cursor : null
}

/**
 * Click on a commit row: plain selects one; Shift selects the range from the anchor (graph
 * order, like a file list); Ctrl/Cmd adds or removes one. A selection of one is a plain one.
 */
export function selectCommit(id: string, hash: string, mods: { range?: boolean; toggle?: boolean } = {}): void {
  const v = get().repos[id]
  if (!v) return
  const log = getLog(id)
  const sel = v.selected
  const one = (h: string): Selection => ({ kind: 'commit', hash: h })
  const many = (hashes: string[], anchor: string, cursor: string): Selection =>
    hashes.length === 1 ? one(hashes[0]!) : { kind: 'commits', hashes, anchor, cursor }
  let next: Selection = one(hash)
  if (mods.range) {
    const anchor = sel.kind === 'commits' ? sel.anchor : sel.kind === 'commit' ? sel.hash : null
    const a = anchor ? log.index.get(anchor) : undefined
    const b = log.index.get(hash)
    if (anchor && a !== undefined && b !== undefined) {
      // Only the anchor's line of history: a range across a merge would otherwise sweep in the
      // other branch's commits, which is never what a run of commits is meant to be. A line keeps
      // its lane (the layout only moves a line at a fork), so the lane is the branch.
      const lane = log.rows[a]?.lane
      const lo = Math.min(a, b)
      const hashes: string[] = []
      for (let i = lo; i <= Math.max(a, b); i++) if (log.rows[i]?.lane === lane) hashes.push(log.commits[i]!.hash)
      next = many(hashes, anchor, hash)
    }
  } else if (mods.toggle) {
    const set = new Set(selectedHashes(sel))
    if (set.has(hash)) set.delete(hash)
    else set.add(hash)
    const hashes = [...set].sort((x, y) => (log.index.get(x) ?? Infinity) - (log.index.get(y) ?? Infinity))
    if (hashes.length) next = many(hashes, sel.kind === 'commits' ? sel.anchor : hash, hash)
  }
  updateRepo(id, { selected: next })
}

/** Load pages until `hash` is in the log (for jumping to a search hit or a parent commit). */
export async function ensureLoaded(id: string, hash: string): Promise<number | undefined> {
  for (;;) {
    const log = getLog(id)
    const i = log.index.get(hash)
    if (i !== undefined || log.done) return i
    await loadMore(id)
  }
}

// ------------------------------------------------------------------ repos and events

function newView(snap: RepoSnapshot): RepoView {
  return {
    id: snap.id, snapshot: snap, logVersion: 0,
    selected: snap.status.length ? { kind: 'wip' } : snap.head.hash ? { kind: 'commit', hash: snap.head.hash } : { kind: 'wip' },
    center: snap.operation && snap.status.some((e) => e.kind === 'unmerged') ? { kind: 'conflicts' } : { kind: 'graph' },
    editable: [], redo: [], stashes: [], undo: [], remotes: [], merged: [], worktrees: [], submodules: [], lfs: null, pulls: null, pullsLoading: false, review: null, walkthrough: null, impact: null, ask: null, askThreads: [], remoteTags: null, progress: null, busy: null, worktreeTick: 0,
    codegraph: { state: 'indexing', done: 0, total: 0 },
  }
}

export function addRepo(snap: RepoSnapshot): void {
  const s = get()
  if (s.repos[snap.id]) {
    set({ active: snap.id })
    return
  }
  set({ repos: { ...s.repos, [snap.id]: newView(snap) }, tabs: [...s.tabs, snap.id], active: snap.id })
  resetLog(snap.id, snap)
  void refreshAux(snap.id)
  void api.askThreads(snap.id).then((askThreads) => updateRepo(snap.id, { askThreads }), () => {})
  void api.codeGraphStatus(snap.id).then((codegraph) => updateRepo(snap.id, { codegraph }), () => {})
  if (setting('fetchOnOpen')) void import('./actions').then((a) => a.fetchAll(snap.id, { quiet: true }))
}

/**
 * Settings → Git → fetch every N minutes. One timer checks every minute; each open repo is fetched
 * when its last fetch is older than the interval. Quiet on success; failures go to the attention
 * bar like any other.
 */
const lastFetch = new Map<string, number>()
setInterval(() => {
  const minutes = setting('autoFetchMinutes')
  if (!minutes) return
  for (const id of get().tabs) {
    const last = lastFetch.get(id) ?? 0
    if (Date.now() - last < minutes * 60_000 || get().repos[id]?.busy) continue
    lastFetch.set(id, Date.now())
    void import('./actions').then((a) => a.fetchAll(id, { quiet: true }))
  }
}, 60_000)

export async function openRepo(path: string): Promise<void> {
  try {
    addRepo(await api.openRepo(path))
    set({ settings: await api.getSettings() })
  } catch (e) {
    reportError(`Could not open ${path}`, e)
  }
}

export async function closeTab(id: string): Promise<void> {
  const s = get()
  const tabs = s.tabs.filter((t) => t !== id)
  const repos = { ...s.repos }
  delete repos[id]
  const i = s.tabs.indexOf(id)
  const active = s.active === id ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : s.active
  set({ tabs, repos, active })
  logs.delete(id)
  pending.delete(id)
  await api.closeRepo(id)
  set({ settings: await api.getSettings() })
}

export function onSnapshot(snap: RepoSnapshot): void {
  const view = get().repos[snap.id]
  if (!view) return
  const hadConflicts = view.snapshot.status.some((e) => e.kind === 'unmerged')
  const hasConflicts = snap.status.some((e) => e.kind === 'unmerged')
  updateRepo(snap.id, (v) => ({
    snapshot: snap,
    // Something just stopped on conflicts: show the conflict wizard. Leave it once the operation
    // is over and nothing is unmerged (a stash pop has no operation, only unmerged files).
    center: hasConflicts && !hadConflicts ? { kind: 'conflicts' } : !snap.operation && !hasConflicts && v.center.kind === 'conflicts' ? { kind: 'graph' } : v.center,
  }))
  if (hasConflicts && !hadConflicts) alertConflicts(snap.id, snap)
  else if (!hasConflicts) dismissAttentionKey(`conflicts-${snap.id}`)
  if (snap.refsVersion !== logGeneration(snap.id)) resetLog(snap.id, snap)
  void refreshAux(snap.id)
}

export async function refreshAux(id: string): Promise<void> {
  try {
    const [stashes, undo, editable, redo, remotes, merged, worktrees, submodules, lfs] = await Promise.all([
      api.stashList(id), api.undoList(id), api.editableCommits(id), api.redoList(id), api.remotes(id), api.mergedBranches(id), api.worktrees(id), api.submodules(id),
      api.lfsInfo(id).catch(() => null),
    ])
    updateRepo(id, { stashes, undo, editable, redo, remotes, merged, worktrees, submodules, lfs })
  } catch {
    // The tab was closed meanwhile.
  }
}

function onEvent(e: GitGooseEvent): void {
  switch (e.type) {
    case 'snapshot':
      onSnapshot(e.snapshot)
      break
    case 'worktree':
      updateRepo(e.repoId, (v) => ({ worktreeTick: v.worktreeTick + 1 }))
      break
    case 'codegraph':
      updateRepo(e.repoId, { codegraph: e.status })
      break
    case 'prompt':
      set({ prompt: { promptId: e.promptId, message: e.message, secret: e.secret } })
      break
    case 'progress':
      if (e.repoId === 'clone') set({ cloneProgress: e.text })
      else updateRepo(e.repoId, { progress: e.text })
      break
    case 'command':
      commandListeners.forEach((l) => l(e.name))
      break
    case 'settings':
      set({ settings: e.settings })
      applyTheme(e.settings)
      break
    case 'github':
      set({ github: e.status })
      break
    case 'ai-text':
    case 'ai-permission':
    case 'ai-permission-closed':
      onAiEvent(e)
      break
  }
}

export async function loadGitHub(): Promise<void> {
  try {
    set({ github: await api.githubStatus() })
  } catch (e) {
    reportError('Could not read the GitHub sign-in', e)
  }
}

const commandListeners = new Set<(name: string) => void>()
/** Run a command as if chosen from the menu: every listener hears it (App, the search box, …). */
export function runCommand(name: string): void {
  commandListeners.forEach((l) => l(name))
}

export function onCommand(l: (name: string) => void): () => void {
  commandListeners.add(l)
  return () => commandListeners.delete(l)
}

// ------------------------------------------------------------------ theme and boot

export function applyTheme(settings: Settings): void {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  // UI scale is applied by the main process as the window zoom; only code panes read these.
  root.style.setProperty('--gs-code-size', `${settings.codeFontSize}px`)
  root.style.setProperty('--gs-code-font', settings.codeFontFamily.trim() || 'var(--font-mono)')
  root.style.setProperty('--gs-tab-size', String(settings.tabSize))
}

/** Row height for code panes (diff, blame), derived from the code font size so rows never overlap. */
export function codeLineHeight(fontSize: number): number {
  return Math.round(fontSize * 1.6)
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const settings = await api.setSettings(patch)
  set({ settings })
  applyTheme(settings)
}

let booted = false
export async function boot(): Promise<void> {
  if (booted) return
  booted = true
  api.onEvent(onEvent)
  const settings = await api.getSettings()
  set({ settings })
  applyTheme(settings)
  // Local only (no network): whether a GitHub sign-in is stored, for avatar URLs.
  void loadGitHub()
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const s = get().settings
    if (s) applyTheme(s)
  })
  for (const path of settings.openRepos) {
    try {
      addRepo(await api.openRepo(path))
    } catch {
      // The folder was moved or deleted; drop it from the session.
      const s = await api.getSettings()
      await api.setSettings({ openRepos: s.openRepos.filter((p) => p !== path) })
    }
  }
}

// ------------------------------------------------------------------ toasts

let nextToast = 1

export function toast(t: Omit<Toast, 'id'>, ms = 5000): number {
  const id = nextToast++
  set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }))
  if (ms > 0) setTimeout(() => dismissToast(id), ms)
  return id
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

let nextAttention = 1

/** Report a failure in the attention bar, with git's stderr under "Details". Stays until dismissed. */
export function reportError(title: string, e: unknown, actions?: Choice[]): number {
  const err: UiError = toUiError(e)
  const detail = [err.message, err.stderr && err.stderr.trim() !== err.message ? err.stderr.trim() : ''].filter(Boolean).join('\n\n')
  return attention({ title, detail, actions })
}

export function attention(a: Omit<Attention, 'id' | 'time'>): number {
  const id = nextAttention++
  // Newest first; keep the last few so a burst of failures cannot fill the screen.
  set((s) => ({ attentions: [{ ...a, id, time: Date.now() }, ...s.attentions.filter((x) => !a.key || x.key !== a.key)].slice(0, 5) }))
  return id
}

export function dismissAttentionKey(key: string): void {
  set((s) => (s.attentions.some((a) => a.key === key) ? { attentions: s.attentions.filter((a) => a.key !== key) } : s))
}

/**
 * Conflicts appeared (a merge, rebase, cherry-pick, revert, pull or stash pop stopped): say so in
 * the attention bar, where it cannot be missed, with the two ways forward. It goes away by
 * itself once nothing is unmerged.
 */
export function alertConflicts(id: string, snap: RepoSnapshot): void {
  const files = snap.status.filter((e) => e.kind === 'unmerged').length
  const op = snap.operation && opName(snap.operation)
  const what = op ? `The ${op} stopped` : 'Applying the changes stopped'
  attention({
    key: `conflicts-${id}`,
    title: `${what}: ${files} ${files === 1 ? 'file has' : 'files have'} conflicts`,
    detail: op
      ? `Resolve them in the conflict view, then continue the ${op}. Abort puts everything back as it was before the ${op}.`
      : 'Resolve them in the conflict view and mark each file resolved.',
    actions: [
      { label: 'Resolve conflicts', variant: 'primary', run: () => updateRepo(id, { center: { kind: 'conflicts' } }) },
      ...(op ? [{ label: `Abort ${op}`, run: () => void api.abortOperation(id).catch((e) => reportError(`Abort ${op} failed`, e)) }] : []),
    ],
  })
}

export function dismissAttention(id: number): void {
  set((s) => ({ attentions: s.attentions.filter((a) => a.id !== id) }))
}

/** Ask a question with several answers in a modal. */
export function choose(title: string, message: string, choices: Choice[], detail?: string, onDismiss?: () => void): void {
  set({ dialog: { kind: 'choice', title, message, detail, choices, onDismiss } })
}
