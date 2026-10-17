import { GraphLayout, type Row } from '@gitsquid/graph'
import { SETTINGS, type Commit, type DiffTarget, type GitHubStatus, type GitSquidEvent, type Ref, type RepoSnapshot, type SearchField, type SettingKey, type Settings, type StashEntry, type UndoEntry } from '@gitsquid/shared'
import { create } from 'zustand'
import { api, toUiError, type UiError } from './api'

export type Selection = { kind: 'wip' } | { kind: 'commit'; hash: string }

export type FileMode = 'diff' | 'history' | 'blame'

export type CenterView =
  | { kind: 'graph' }
  | { kind: 'file'; target: DiffTarget; mode: FileMode }
  | { kind: 'conflicts' }

export interface SearchState {
  field: SearchField
  query: string
  hits: string[]
  /** Position in hits of the current match. */
  index: number
}

export interface RepoView {
  id: string
  snapshot: RepoSnapshot
  /** Bumped when the log data (outside React state) changes; components subscribe to it. */
  logVersion: number
  selected: Selection
  center: CenterView
  search: SearchState | null
  stashes: StashEntry[]
  undo: UndoEntry[]
  progress: string | null
  busy: string | null
  /** Bumped whenever files change on disk; open diffs reload on it. */
  worktreeTick: number
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
      extra?: { label: string; placeholder?: string }
      onSubmit: (value: string, extra: string) => void | Promise<void>
    }
  | { kind: 'confirm'; title: string; message: string; confirm: string; danger?: boolean; onConfirm: () => void | Promise<void> }
  /** A question with several answers; the last choice is usually Cancel (a choice with no run). */
  | { kind: 'choice'; title: string; message: string; detail?: string; choices: Choice[] }
  | { kind: 'clone' }
  | { kind: 'shortcuts' }

export interface DropRequest {
  x: number
  y: number
  source: Ref
  /** Where it was dropped: a ref pill, or just a commit row. */
  target: { ref?: Ref; hash: string }
}

export type MenuTarget = { kind: 'commit'; hash: string } | { kind: 'ref'; ref: Ref; hash: string } | null

interface State {
  settings: Settings | null
  tabs: string[]
  active: string | null
  repos: Record<string, RepoView>
  prompt: { promptId: number; message: string; secret: boolean } | null
  dialog: Dialog | null
  toasts: Toast[]
  attentions: Attention[]
  palette: boolean
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
  palette: false,
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

export function getLog(id: string): LogData {
  let l = logs.get(id)
  if (!l) {
    l = emptyLog(undefined, -1)
    logs.set(id, l)
  }
  return l
}

function emptyLog(head: string | undefined, generation: number): LogData {
  return {
    commits: [], rows: [], index: new Map(), layout: new GraphLayout({ head }),
    generation, done: false, loading: null, maxWidth: 1,
  }
}

function resetLog(id: string, snap: RepoSnapshot): void {
  logs.set(id, emptyLog(snap.head.hash, snap.refsVersion))
  updateRepo(id, (v) => ({ logVersion: v.logVersion + 1 }))
}

/** First page small so the first screen paints fast; later pages large to cut round trips. */
const FIRST_PAGE = 300
const PAGE = 3000

export function loadMore(id: string): Promise<void> {
  const log = getLog(id)
  if (log.loading) return log.loading
  if (log.done) return Promise.resolve()
  const offset = log.commits.length
  const count = offset === 0 ? FIRST_PAGE : PAGE
  log.loading = api.logPage(id, offset, count).then(
    async (page) => {
      log.loading = null
      if (logs.get(id) !== log) return // reset while we were waiting
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
      if (offset === 0) performance.mark('gitsquid:first-page')
      updateRepo(id, (v) => ({ logVersion: v.logVersion + 1 }))
    },
    (e) => {
      log.loading = null
      log.done = true
      reportError('Could not read history', e)
    },
  )
  return log.loading
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
    search: null, stashes: [], undo: [], progress: null, busy: null, worktreeTick: 0,
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
  void loadMore(snap.id)
  void refreshAux(snap.id)
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
    // A merge/rebase just stopped on conflicts: show the conflict wizard.
    center: hasConflicts && !hadConflicts ? { kind: 'conflicts' } : !snap.operation && v.center.kind === 'conflicts' ? { kind: 'graph' } : v.center,
  }))
  if (snap.refsVersion !== getLog(snap.id).generation) {
    resetLog(snap.id, snap)
    void loadMore(snap.id)
  }
  void refreshAux(snap.id)
}

export async function refreshAux(id: string): Promise<void> {
  try {
    const [stashes, undo] = await Promise.all([api.stashList(id), api.undoList(id)])
    updateRepo(id, { stashes, undo })
  } catch {
    // The tab was closed meanwhile.
  }
}

function onEvent(e: GitSquidEvent): void {
  switch (e.type) {
    case 'snapshot':
      onSnapshot(e.snapshot)
      break
    case 'worktree':
      updateRepo(e.repoId, (v) => ({ worktreeTick: v.worktreeTick + 1 }))
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
  set((s) => ({ attentions: [{ ...a, id, time: Date.now() }, ...s.attentions].slice(0, 5) }))
  return id
}

export function dismissAttention(id: number): void {
  set((s) => ({ attentions: s.attentions.filter((a) => a.id !== id) }))
}

/** Ask a question with several answers in a modal. */
export function choose(title: string, message: string, choices: Choice[], detail?: string): void {
  set({ dialog: { kind: 'choice', title, message, detail, choices } })
}
