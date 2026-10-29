import { api } from './api'
import { NavHistory, type NavLocation } from './nav'
import { ensureLoaded, getLog, onLogSwap, selectedHashes, useStore, type RepoView, type Selection } from './store'

/**
 * Back and forward wired to the store. Every change of the active tab, or of its selection,
 * centre view or line, is recorded as a location (lib/nav.ts decides what counts as a new step);
 * going back or forward puts a recorded location back.
 *
 * Three ways in: the keyboard and the View menu (the `back` / `forward` commands, see App.tsx),
 * the mouse's side buttons (seen here in the page), and, on Windows and Linux, the same buttons
 * reported again by the window as an app command (main/index.ts), as is a trackpad swipe on macOS.
 */

const history = new NavHistory()
/** Set while back/forward changes the store, so the change is not recorded as a new step. */
let navigating = false

const live = (repoId: string) => !!useStore.getState().repos[repoId]

function locationOf(v: RepoView): NavLocation {
  return { repoId: v.id, selected: v.selected, center: v.center, file: v.file, line: v.line }
}

let installed = false
/** Start recording (once; App calls it on mount). */
export function installNavigation(): void {
  if (installed) return
  installed = true
  const s = useStore.getState()
  const v = s.active ? s.repos[s.active] : undefined
  if (v) history.record(locationOf(v), performance.now())
  useStore.subscribe((s, prev) => {
    if (navigating || !s.active) return
    const v = s.repos[s.active]
    if (!v) return
    const was = prev.repos[s.active]
    if (s.active === prev.active && was && was.selected === v.selected && was.center === v.center && was.file === v.file && was.line === v.line) return
    history.record(locationOf(v), performance.now())
  })
  // A rebase or reorder gives commits new hashes: entries follow them exactly as the view on
  // screen does (selection, file diff, line), so going back finds the commit the user moved, not
  // its stale copy, and never pairs the new commit with the old one's diff.
  onLogSwap((id, follow) => history.map((loc) => (loc.repoId === id ? follow(loc) : loc)))
}

/** The graph is on screen and the selection names commits it has not loaded (yet, or any more). */
function unloaded(v: RepoView, loc: NavLocation): string[] {
  if (loc.center.kind !== 'graph') return []
  const log = getLog(v.id)
  // A stash is not in the graph when stashes are hidden, and never will be: nothing to load.
  return selectedHashes(loc.selected).filter((h) => !log.index.has(h) && !v.stashes.some((s) => s.hash === h))
}

/**
 * The line view's anchor when the graph has not loaded it: the graph shows the line through the
 * cursor (or HEAD) instead until it is in, which is the wrong line.
 */
function unloadedLine(v: RepoView, loc: NavLocation): string[] {
  if (loc.center.kind !== 'graph' || !loc.line) return []
  return getLog(v.id).index.has(loc.line.hash) ? [] : [loc.line.hash]
}

function headOf(v: RepoView): Selection {
  return v.snapshot.head.hash ? { kind: 'commit', hash: v.snapshot.head.hash } : { kind: 'wip' }
}

/** Change the store without recording the change as a step. */
function quietly(change: () => void): void {
  navigating = true
  try {
    change()
  } finally {
    navigating = false
  }
}

/** Go back (-1) or forward (1). */
function go(step: -1 | 1): void {
  const s = useStore.getState()
  // A modal has the user's attention; the page behind it stays put.
  if (s.dialog || s.omni) return
  // The settings page is not a step in history: back closes it, like Esc.
  if (s.page) {
    if (step < 0) useStore.setState({ page: null })
    return
  }
  const loc = step < 0 ? history.back(live) : history.forward(live)
  if (!loc) return
  const v = s.repos[loc.repoId]
  if (!v) return
  // A selected commit the graph has not loaded may just not be paged in yet (a refresh reloads
  // only the first page): load up to it so the graph can show it and scroll to it. It may also
  // never be in the graph (a lost commit picked in the reflog) and still be perfectly readable:
  // then it stays selected, as recorded. Only a commit the repository no longer has (pruned)
  // gives way to HEAD; one a rewrite replaced was already moved by the follower (onLogSwap).
  const missing = unloaded(v, loc)
  const done = getLog(v.id).done
  // One store change for tab and view, so the screen never shows the new tab with the old view.
  quietly(() => useStore.setState((s) => ({ active: loc.repoId, repos: { ...s.repos, [loc.repoId]: { ...v, selected: loc.selected, center: loc.center, file: loc.file, line: loc.line } } })))
  const toLoad = done ? [] : [...missing, ...unloadedLine(v, loc)]
  if (missing.length || toLoad.length) void settle(loc.repoId, loc.selected, toLoad)
}

/** Load the restored commits into the graph; any still not there must at least be readable. */
async function settle(id: string, selected: Selection, toLoad: string[]): Promise<void> {
  for (const h of toLoad) await ensureLoaded(id, h)
  // The user moved on meanwhile: leave it.
  const current = () => {
    const v = useStore.getState().repos[id]
    return v && v.selected === selected ? v : null
  }
  const v = current()
  if (!v) return
  const offGraph = unloaded(v, { repoId: id, selected, center: v.center, file: v.file, line: v.line })
  const readable = await Promise.all(offGraph.map((h) => api.commitDetails(id, h).then(() => true, () => false)))
  const now = current()
  if (!now || readable.every(Boolean)) return
  quietly(() => useStore.setState((s) => ({ repos: { ...s.repos, [id]: { ...now, selected: headOf(now) } } })))
}

/**
 * One click of a side button can arrive twice on Windows and Linux: as a mouse event in the page
 * and as the window's app command. Whichever comes first navigates; the other one, from the other
 * source within a moment, is the same click and is dropped. Repeats from one source (a held key,
 * quick clicks) all count. Commands are the keyboard, the View menu and the window's reports.
 */
const SAME_CLICK_MS = 150
let lastNav = { source: '', at: -Infinity }

export function navigate(source: 'mouse' | 'command', step: -1 | 1): void {
  const now = performance.now()
  if (source !== lastNav.source && now - lastNav.at < SAME_CLICK_MS) return
  lastNav = { source, at: now }
  go(step)
}

export const goBack = () => navigate('command', -1)
export const goForward = () => navigate('command', 1)

/**
 * The mouse's back (button 3) and forward (4) buttons. Caught at the window before anything else,
 * and default-prevented on press and click too, so nothing else reacts to them.
 */
export function installMouseNavigation(): () => void {
  const onMouse = (e: MouseEvent) => {
    if (e.button !== 3 && e.button !== 4) return
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'mouseup') navigate('mouse', e.button === 3 ? -1 : 1)
  }
  const types = ['mousedown', 'mouseup', 'auxclick'] as const
  for (const t of types) window.addEventListener(t, onMouse, true)
  return () => {
    for (const t of types) window.removeEventListener(t, onMouse, true)
  }
}
