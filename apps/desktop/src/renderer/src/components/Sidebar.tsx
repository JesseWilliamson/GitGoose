import type { GraphFilter, Ref } from '@gitgoose/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import {
  Archive, Boxes, ChevronDown, ChevronRight, Cloud, Eye, EyeOff, Focus, Folder, FolderTree, GitBranch, GitPullRequest, HardDrive, History,
  Laptop, ListTree, Pin, Plus, RefreshCw, Settings2, Tag,
} from 'lucide-react'
import { ContextMenu, DropdownMenu } from 'radix-ui'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  addRemote, addSubmodule, addWorktree, checkout, checkoutPull, deleteBranch, deleteRemoteBranch, deleteTag, hasGitHubRemote, hideInGraph, isStale, lfsPull,
  lfsSetUp, loadPulls, newBranch, newTag, pop, remoteNames, restoreGraphFilter, revealInHistory, showAllInGraph, showBranchHistory, showHistory, showInGraph,
  showWorkingCopy, stashDrop,
} from '../lib/actions'
import { relativeTime, stashLabel } from '../lib/format'
import { refShown } from '../lib/graphFilter'
import { shortcutOf } from '../lib/keys'
import { startDrag, type DropTarget } from '../lib/dnd'
import { foldersOf } from '../lib/refTree'
import {
  defaultOpen, focusable, folderKey, openKeyOf, parentIndex, refKey, rowHeight, sidebarRows, type RefSection, type SidebarRow, type WorkspaceItem,
} from '../lib/sidebarRows'
import { onCommand, openRepo, saveSettings, updateRepo, updateSidebarPrefs, useSetting, useSidebarPrefs, useStore, type RepoView } from '../lib/store'
import { GraphMenu } from './menus'
import { DM } from './ui'

const isMac = window.gitgoose?.platform === 'darwin'
const TAG_LIMITS: Record<string, number> = { '50': 50, '100': 100, '250': 250, all: Infinity }

/**
 * Tower's sidebar: Workspace, Pinned, Branches (a folder tree), Remotes, Tags, Submodules,
 * Worktrees and Git LFS, with the filter box and the + and gear menus at the bottom.
 *
 * Everything in it is one flat list of rows (lib/sidebarRows.ts), virtualized: a repository
 * with thousands of branches and tags renders the rows on screen and no more. Which sections,
 * folders and remotes are open is kept per repository (settings → sidebar), so it survives a
 * restart; the keyboard moves a cursor through the rows (↑↓, ←→ to fold, Enter checks out,
 * Space shows the history, Delete deletes with Undo, Mod+0 goes to HEAD's branch).
 */
export function Sidebar({ view }: { view: RepoView }) {
  const [filter, setFilter] = useState('')
  const snap = view.snapshot
  const prefs = useSidebarPrefs(snap.path)
  const folders = useSetting('sidebarFolders')
  const tagLimit = TAG_LIMITS[useSetting('sidebarTags')] ?? Infinity
  const github = hasGitHubRemote(view)
  const remotes = remoteNames(view)
  const remotesKey = remotes.join('\0')
  const worktreeCount = view.worktrees.length
  const isOpen = (key: string) => prefs.open?.[key] ?? defaultOpen(key, worktreeCount)
  const rows = useMemo(() => sidebarRows({
    refs: snap.refs, headBranch: snap.head.branch, pins: view.pins, remotes, stashes: view.stashes, hasGitHub: github,
    pulls: view.pulls, pullsLoading: view.pullsLoading, worktrees: view.worktrees, submodules: view.submodules, lfs: view.lfs,
    folders, tagLimit, filter, showReflog: prefs.reflog !== false, isOpen,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isOpen reads prefs.open; remotes by value
  }), [snap.refs, snap.head.branch, view.pins, remotesKey, view.stashes, github, view.pulls, view.pullsLoading, view.worktrees, view.submodules, view.lfs, folders, tagLimit, filter, prefs])

  /** What badges and marks need, worked out once per change instead of once per row. */
  const look = useMemo<RowContext>(() => ({
    repoId: view.id,
    headBranch: snap.head.branch,
    filter: snap.filter,
    merged: prefs.merged === false ? new Set() : new Set(view.merged),
    stale: prefs.stale !== false,
    prs: new Map(view.pulls?.state === 'ok' ? view.pulls.pulls.filter((p) => !p.fromFork).map((p) => [p.branch, p]) : []),
    elsewhere: new Map(view.worktrees.filter((w) => !w.current && w.branch).map((w) => [w.branch!, w.path])),
    onRemote: view.remoteTags ? { remote: view.remoteTags.remote, names: new Set(view.remoteTags.names) } : null,
    lastFetched: view.lastFetched,
  }), [view.id, snap.head.branch, snap.filter, prefs.merged, prefs.stale, view.merged, view.pulls, view.worktrees, view.remoteTags, view.lastFetched])

  const [cursor, setCursor] = useState<string | null>(null)
  useEffect(() => setCursor(null), [view.id])
  const scrollRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Row heights are fixed per kind, so the estimate is exact and nothing is measured.
    estimateSize: (i) => rowHeight(rows[i]!),
    overscan: 12,
  })

  const toggle = (key: string) => {
    const next = !isOpen(key)
    if (next && key === 'ws:pulls' && !view.pulls && !view.pullsLoading) void loadPulls(view.id)
    updateSidebarPrefs(snap.path, (p) => ({ ...p, open: { ...p.open, [key]: next } }))
  }
  const openAll = (keys: string[]) => updateSidebarPrefs(snap.path, (p) => ({ ...p, open: { ...p.open, ...Object.fromEntries(keys.map((k) => [k, true])) } }))

  // A click on a branch shows its history (solos it); a double-click checks it out. The first
  // click of a double-click has already soloed it by then, so the double-click puts the filter
  // back first: checking out is all it means.
  const lastClick = useRef<{ ref: string; before: GraphFilter } | null>(null)
  const clickRef = (e: { detail: number; metaKey: boolean; ctrlKey: boolean }, r: Ref, key: string) => {
    setCursor(key)
    if (e.detail > 1) return
    if (r.kind === 'tag' || prefs.click === 'reveal') {
      lastClick.current = null
      void revealInHistory(view.id, r.hash)
      return
    }
    lastClick.current = { ref: r.name, before: snap.filter }
    showBranchHistory(view.id, r.name, isMac ? e.metaKey : e.ctrlKey)
    void revealInHistory(view.id, r.hash)
  }
  const doubleClickRef = (r: Ref) => {
    const last = lastClick.current
    lastClick.current = null
    if (last?.ref === r.name) restoreGraphFilter(view.id, last.before)
    if (r.kind !== 'local' || r.shortName !== snap.head.branch) void checkout(view.id, r.name)
  }

  const workspace = (item: WorkspaceItem) => {
    if (item === 'working-copy') showWorkingCopy(view.id)
    else if (item === 'history') showHistory(view.id)
    else if (item === 'reflog') updateRepo(view.id, { center: { kind: 'reflog' } })
    else toggle(`ws:${item}`)
  }

  /** Put the cursor on HEAD's branch, opening the folders around it, and scroll there. */
  const goToHead = () => {
    const b = snap.head.branch
    if (!b) return
    const r = snap.refs.find((x) => x.name === `refs/heads/${b}`)
    if (!r) return
    setFilter('')
    openAll(['section:branches', ...foldersOf(b).map((p) => folderKey('branches', p))])
    setCursor(refKey('branches', r))
    void revealInHistory(view.id, r.hash)
  }
  // Scroll to the cursor whenever it moves (keyboard, Mod+0), once its row exists.
  const cursorIndex = cursor ? rows.findIndex((r) => r.key === cursor) : -1
  useEffect(() => {
    if (cursorIndex >= 0) virt.scrollToIndex(cursorIndex, { align: 'auto' })
  }, [cursorIndex, virt])

  // Workspace shortcuts that need the sidebar itself (the others are plain actions, see App).
  useEffect(() => onCommand((name) => {
    if (name === 'ws-stashes' || name === 'ws-pulls') {
      const key = `ws:${name.slice(3)}`
      if (!isOpen('section:workspace')) toggle('section:workspace')
      if (!isOpen(key)) toggle(key)
      setCursor(key)
    } else if (name === 'select-head-branch') goToHead()
  }))

  const activate = (row: SidebarRow, how: 'enter' | 'space' | 'click') => {
    const k = openKeyOf(row)
    if (row.kind === 'ref') {
      if (how === 'enter') doubleClickRef(row.ref)
      else clickRef({ detail: 1, metaKey: false, ctrlKey: false }, row.ref, row.key)
    } else if (row.kind === 'workspace') workspace(row.item)
    else if (k) toggle(k)
    else if (row.kind === 'stash') updateRepo(view.id, { selected: { kind: 'commit', hash: row.stash.hash }, center: { kind: 'graph' } })
    else if (row.kind === 'worktree' && how === 'enter' && !row.worktree.current) void openRepo(row.worktree.path)
    else if (row.kind === 'more-tags') void saveSettings({ sidebarTags: 'all' })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const mod = isMac ? e.metaKey : e.ctrlKey
    // Mod+0 is Actual Size everywhere else; in the sidebar it goes to HEAD's branch (as in Tower).
    if (mod && e.key === '0') {
      e.preventDefault()
      e.stopPropagation()
      goToHead()
      return
    }
    if (mod || e.altKey) return
    const at = cursorIndex
    const row = at >= 0 ? rows[at] : undefined
    const move = (from: number, step: 1 | -1) => {
      for (let i = from + step; i >= 0 && i < rows.length; i += step) {
        if (focusable(rows[i]!)) return setCursor(rows[i]!.key)
      }
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); return move(at, 1)
      case 'ArrowUp': e.preventDefault(); return move(at < 0 ? rows.length : at, -1)
      case 'ArrowLeft': {
        e.preventDefault()
        if (!row) return
        const k = openKeyOf(row)
        if (k && isOpen(k) && !(filter && row.kind !== 'header')) return toggle(k)
        const p = parentIndex(rows, at)
        if (p >= 0) setCursor(rows[p]!.key)
        return
      }
      case 'ArrowRight': {
        e.preventDefault()
        if (!row) return
        const k = openKeyOf(row)
        if (k && !isOpen(k)) return toggle(k)
        if (k) move(at, 1)
        return
      }
      case 'Enter': e.preventDefault(); if (row) activate(row, 'enter'); return
      case ' ': e.preventDefault(); if (row) activate(row, 'space'); return
      case 'Escape':
        // Back to every branch (Tower: leave the branch's history).
        if (snap.filter.solo.length) { e.preventDefault(); showHistory(view.id) }
        return
      case 'Delete':
      case 'Backspace': {
        if (!row) return
        e.preventDefault()
        // Each of these is undoable (deleting on a remote asks first).
        if (row.kind === 'ref' && row.ref.kind === 'local' && row.ref.shortName !== snap.head.branch) void deleteBranch(view.id, row.ref.shortName)
        else if (row.kind === 'ref' && row.ref.kind === 'tag') void deleteTag(view.id, row.ref.shortName)
        else if (row.kind === 'ref' && row.ref.kind === 'remote') deleteRemoteBranch(view.id, row.ref.name)
        else if (row.kind === 'stash') void stashDrop(view.id, row.stash.index)
        return
      }
    }
  }

  const branches = snap.refs.filter((r) => r.kind === 'local' || r.kind === 'remote')
  const shown = branches.filter((r) => refShown(r, snap.filter, snap.head.branch)).length
  const soloed = snap.filter.solo.map((r) => r.replace(/^refs\/(heads|remotes|tags)\//, ''))

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-card">
      <div className="flex h-6 shrink-0 items-center gap-1.5 px-3 pt-1.5 text-xs text-muted-foreground" data-testid="sidebar-viewing">
        <Eye size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {soloed.length ? `Viewing the history of ${soloed.join(', ')}` : `Viewing ${shown.toLocaleString()}/${branches.length.toLocaleString()}`}
        </span>
        {shown < branches.length && <button onClick={() => showAllInGraph(view.id)} className="shrink-0 font-medium text-primary hover:underline">Show all</button>}
      </div>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pt-1 pb-2 outline-none" data-testid="sidebar" tabIndex={0} onKeyDown={onKeyDown}>
            <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {virt.getVirtualItems().map((item) => {
                const row = rows[item.index]!
                return (
                  <SidebarRowView key={row.key} row={row} top={item.start} cursor={row.key === cursor} view={view} look={look}
                    onToggle={toggle} onWorkspace={workspace} onClickRef={clickRef} onDoubleClickRef={doubleClickRef} onCursor={setCursor} />
                )
              })}
            </div>
          </div>
        </ContextMenu.Trigger>
        <GraphMenu repoId={view.id} />
      </ContextMenu.Root>
      <div className="shrink-0 border-t border-border p-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.preventDefault(); setFilter('') } }}
          placeholder="Filter branches and tags"
          data-testid="sidebar-filter"
          className="h-input w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
        />
        <div className="mt-1.5 flex items-center gap-1">
          <AddMenu view={view} />
          <span className="flex-1" />
          <GearMenu path={snap.path} />
        </div>
      </div>
    </aside>
  )
}

interface RowContext {
  repoId: string
  headBranch: string | undefined
  filter: GraphFilter
  merged: Set<string>
  stale: boolean
  prs: Map<string, { number: number; title: string }>
  elsewhere: Map<string, string>
  onRemote: { remote: string; names: Set<string> } | null
  lastFetched: number | null
}

const ICONS: Record<string, ReactNode> = {
  workspace: <Laptop size={13} />, pinned: <Pin size={13} />, branches: <GitBranch size={13} />, remotes: <Cloud size={13} />, tags: <Tag size={13} />,
  submodules: <Boxes size={13} />, worktrees: <FolderTree size={13} />, lfs: <HardDrive size={13} />,
}
const WORKSPACE: Record<WorkspaceItem, { label: string; icon: ReactNode; command: string; title: string }> = {
  'working-copy': { label: 'Working Copy', icon: <Laptop size={13} />, command: 'ws-working-copy', title: 'Your uncommitted changes' },
  history: { label: 'History', icon: <ListTree size={13} />, command: 'ws-history', title: 'Every branch in the graph' },
  stashes: { label: 'Stashes', icon: <Archive size={13} />, command: 'ws-stashes', title: 'Changes put aside' },
  pulls: { label: 'Pull Requests', icon: <GitPullRequest size={13} />, command: 'ws-pulls', title: 'Open pull requests on GitHub (asks GitHub when opened)' },
  reflog: { label: 'Reflog', icon: <History size={13} />, command: 'ws-reflog', title: 'Every place HEAD has been: recover deleted branches and lost commits' },
}
const sectionMenu = { branches: 'local', remotes: 'remotes', tags: 'tags', worktrees: 'worktrees', submodules: 'submodules', lfs: 'lfs' } as const

/**
 * Where a row's text starts: 16px per level. Rows that fold (folders, remotes) hang their chevron
 * to the left of that, so a folder's name and its branches' names line up.
 */
const pad = (depth: number) => 16 + depth * 16
/** A row's `data-drop-target`: what DragBadge passes to dropPlan when something is dragged over it. */
const drop = (t: DropTarget) => JSON.stringify(t)
const SECTION_TARGETS = new Set(['branches', 'tags', 'pinned', 'worktrees'])
const WORKSPACE_TARGETS = new Set(['working-copy', 'stashes', 'pulls'])
const FOLD = 14

/**
 * One row. Memoized: scrolling re-renders the list each frame, but a row's props (its offset is a
 * number) stay equal, so React skips it.
 */
const SidebarRowView = memo(function SidebarRowView({ row, top, cursor, view, look, onToggle, onWorkspace, onClickRef, onDoubleClickRef, onCursor }: {
  row: SidebarRow; top: number; cursor: boolean; view: RepoView; look: RowContext
  onToggle: (key: string) => void
  onWorkspace: (item: WorkspaceItem) => void
  onClickRef: (e: { detail: number; metaKey: boolean; ctrlKey: boolean }, r: Ref, key: string) => void
  onDoubleClickRef: (r: Ref) => void
  onCursor: (key: string) => void
}) {
  const style: React.CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, height: rowHeight(row), transform: `translateY(${top}px)` }
  const base = clsx('flex cursor-default items-center gap-1.5 pr-3 text-sm', cursor ? 'bg-select' : 'hover:bg-accent')
  /** Rows without a menu of their own: no menu opens (the list's menu would say "Nothing here"). */
  const noMenu = (e: React.MouseEvent) => e.preventDefault()
  const id = look.repoId
  switch (row.kind) {
    case 'header': {
      const menu = (sectionMenu as Record<string, (typeof sectionMenu)[keyof typeof sectionMenu]>)[row.section]
      return (
        <div style={style} data-testid="sidebar-section" data-section={row.section} data-name={row.title}
          data-drop-target={SECTION_TARGETS.has(row.section) ? drop({ kind: 'section', section: row.section as 'branches' }) : undefined}
          className={clsx('flex items-center pr-2', cursor && 'bg-select')}
          onContextMenu={menu ? () => useStore.setState({ menu: { kind: 'section', section: menu } }) : noMenu}>
          <button onClick={() => { onCursor(row.key); onToggle(row.key) }} style={{ paddingLeft: 8 }}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground">
            {row.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {ICONS[row.section]}
            <span className="flex-1 truncate text-left">{row.title}</span>
            {row.section !== 'workspace' && <span className="text-2xs font-normal text-muted-foreground/70">{row.count}</span>}
          </button>
          {row.section === 'remotes' && <SmallButton label="Add remote" onClick={() => addRemote(id)}><Plus size={13} /></SmallButton>}
          {row.section === 'worktrees' && <SmallButton label="Add worktree" onClick={() => addWorktree(id)}><Plus size={13} /></SmallButton>}
        </div>
      )
    }
    case 'workspace': {
      const w = WORKSPACE[row.item]
      const key = shortcutOf(w.command, useStore.getState().settings?.keybindings)
      const active = row.item === 'working-copy' ? view.selected.kind === 'wip' && view.center.kind === 'graph'
        : row.item === 'history' ? view.center.kind === 'graph' && !view.snapshot.filter.solo.length && view.selected.kind !== 'wip'
        : row.item === 'reflog' ? view.center.kind === 'reflog' : false
      const prefs = useStore.getState().settings?.sidebar[view.snapshot.path]
      const changes = row.item === 'working-copy' ? view.snapshot.status.length : 0
      const body = (
        <div style={{ ...style, paddingLeft: pad(1) }} data-testid="workspace-item" data-item={row.item} title={`${w.title}${key ? ` (${key})` : ''}`}
          data-drop-target={WORKSPACE_TARGETS.has(row.item) ? drop({ kind: 'workspace', item: row.item as 'stashes' }) : undefined}
          onClick={() => { onCursor(row.key); onWorkspace(row.item) }} onContextMenu={noMenu}
          className={clsx(base, active ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
          {row.open !== undefined ? (row.open ? <ChevronDown size={12} className="-ml-3.5 shrink-0" /> : <ChevronRight size={12} className="-ml-3.5 shrink-0" />) : null}
          <span className="shrink-0">{w.icon}</span>
          <span className="min-w-0 flex-1 truncate">{w.label}</span>
          {row.item === 'working-copy' && changes > 0 && <span className="text-2xs text-muted-foreground/70">{changes}</span>}
          {row.item === 'stashes' && prefs?.stashCount !== false && <span className="text-2xs text-muted-foreground/70" data-testid="stash-count">{row.count}</span>}
          {row.item === 'pulls' && (
            <SmallButton label="Refresh pull requests" title="Refresh pull requests (asks GitHub)" onClick={(e) => { e.stopPropagation(); void loadPulls(id) }}>
              <RefreshCw size={11} className={view.pullsLoading ? 'animate-spin' : ''} />
            </SmallButton>
          )}
        </div>
      )
      // The Reflog item keeps the testid tests and docs know it by.
      return row.item === 'reflog' ? <div data-testid="open-reflog" style={{ display: 'contents' }}>{body}</div> : body
    }
    case 'folder':
      return (
        <div style={{ ...style, paddingLeft: pad(row.depth) - FOLD }} data-testid="sidebar-folder" data-path={row.path} data-section={sectionName(row.section)}
          // Only Branches' folders take a branch (rename it into the folder).
          data-drop-target={row.section === 'branches' ? drop({ kind: 'folder', folder: row.path }) : undefined}
          onClick={() => { onCursor(row.key); onToggle(row.key) }} onContextMenu={noMenu} className={clsx(base, 'text-muted-foreground')}>
          {row.open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
          <Folder size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          <span className="text-2xs text-muted-foreground/70">{row.count}</span>
        </div>
      )
    case 'remote': {
      const hidden = look.filter.hidden.includes(`refs/remotes/${row.remote}/*`)
      return (
        <div style={{ ...style, paddingLeft: pad(1) - FOLD }} data-testid="remote-section" data-name={row.remote} className={clsx(base, 'text-muted-foreground')}
          data-drop-target={drop({ kind: 'remote', remote: row.remote })}
          onContextMenu={() => useStore.setState({ menu: { kind: 'remote', remote: row.remote } })}>
          <button onClick={() => { onCursor(row.key); onToggle(row.key) }} className="flex h-full min-w-0 flex-1 items-center gap-1.5 font-medium hover:text-foreground">
            {row.open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
            <Cloud size={12} className="shrink-0" />
            <span className={clsx('min-w-0 flex-1 truncate text-left', hidden && 'text-muted-foreground/70 line-through')}>{row.remote}</span>
            <span className="text-2xs font-normal text-muted-foreground/70">{row.count}</span>
          </button>
        </div>
      )
    }
    case 'ref':
      return <RefRow row={row} style={style} cursor={cursor} look={look} onClick={onClickRef} onDoubleClick={onDoubleClickRef} />
    case 'stash': {
      const s = row.stash
      const selected = view.selected.kind === 'commit' && view.selected.hash === s.hash
      return (
        <div style={{ ...style, paddingLeft: pad(2) }} data-testid="stash-item" draggable
          onDragStart={(e) => startDrag(e.dataTransfer, { kind: 'stash', index: s.index, hash: s.hash, ref: s.ref })}
          onClick={() => { onCursor(row.key); updateRepo(id, { selected: { kind: 'commit', hash: s.hash }, center: { kind: 'graph' } }) }}
          onDoubleClick={() => pop(id, s.index)}
          onContextMenu={() => useStore.setState({ menu: { kind: 'stash', stash: s } })}
          title={`${s.message}\n${relativeTime(s.date)}\nClick to see its changes, double-click to pop`}
          className={clsx(base, (selected || cursor) && 'bg-select')}>
          <span className="min-w-0 flex-1 truncate">{stashLabel(s.message)}</span>
          <span className="text-2xs text-muted-foreground/70">{relativeTime(s.date)}</span>
        </div>
      )
    }
    case 'pull': {
      const p = row.pull
      return (
        <div style={{ ...style, paddingLeft: pad(2) }} data-testid="pull-item" data-number={p.number}
          onClick={() => onCursor(row.key)}
          onDoubleClick={() => void checkoutPull(id, p.number)}
          onContextMenu={() => useStore.setState({ menu: { kind: 'pull', number: p.number } })}
          title={`#${p.number} ${p.title}\n${p.author} wants to merge ${p.branch} into ${p.base}\nDouble-click to check it out`}
          className={base}>
          <span className="shrink-0 text-2xs text-muted-foreground/70">#{p.number}</span>
          <span className="min-w-0 flex-1 truncate">{p.title}</span>
          {p.draft && <Badge>draft</Badge>}
          {p.fromFork && <Badge title="From a fork">fork</Badge>}
        </div>
      )
    }
    case 'worktree': {
      const w = row.worktree
      const folder = w.path.split(/[\\/]/).filter(Boolean).pop()
      return (
        <div style={{ ...style, paddingLeft: pad(1) }} data-testid="worktree-item" data-path={w.path}
          onClick={() => {
            onCursor(row.key)
            const r = view.snapshot.refs.find((x) => x.kind === 'local' && x.shortName === w.branch)
            if (r) void revealInHistory(id, r.hash)
          }}
          onDoubleClick={() => !w.current && void openRepo(w.path)}
          onContextMenu={() => useStore.setState({ menu: { kind: 'worktree', path: w.path } })}
          title={`${w.path}${w.current ? '\nThis tab' : '\nDouble-click to open it in a tab'}`}
          className={clsx(base, w.current && 'font-semibold')}>
          {w.current && <span className="-ml-4 w-3 text-2xs text-primary">✓</span>}
          <span className="min-w-0 flex-1 truncate">{w.branch ?? `detached at ${w.head?.slice(0, 7) ?? '?'}`}</span>
          <span className="max-w-24 truncate text-2xs text-muted-foreground/70">{folder}</span>
          {w.locked !== undefined && <Badge title={w.locked || undefined}>locked</Badge>}
          {w.prunable && <Badge title={w.prunable}>missing</Badge>}
        </div>
      )
    }
    case 'submodule': {
      const m = row.submodule
      return (
        <div style={{ ...style, paddingLeft: pad(1) }} data-testid="submodule-item" data-path={m.path}
          onClick={() => onCursor(row.key)}
          onDoubleClick={() => m.checkedOut && void openRepo(`${view.snapshot.path}/${m.path}`)}
          onContextMenu={() => useStore.setState({ menu: { kind: 'submodule', path: m.path } })}
          title={`${m.path}\n${m.url}${m.checkedOut ? '\nDouble-click to open it in a tab' : ''}`}
          className={base}>
          <span className="min-w-0 flex-1 truncate">{m.path}</span>
          {!m.checkedOut && <Badge title="Not cloned yet: Update to check it out">not cloned</Badge>}
          {m.checkedOut && m.recorded && m.checkedOut !== m.recorded && <Badge title={`At ${m.checkedOut.slice(0, 7)}; this repository records ${m.recorded.slice(0, 7)}`}>moved</Badge>}
          {m.dirty && <Badge title="Has uncommitted changes inside">changes</Badge>}
        </div>
      )
    }
    case 'lfs-setup':
      return (
        <div style={{ ...style, paddingLeft: pad(1) }} className="flex items-center gap-2 pr-3 text-xs text-warn" data-testid="lfs-setup" onContextMenu={noMenu}>
          <span className="min-w-0 flex-1 truncate">Not set up here: LFS files stay pointers.</span>
          <button className="font-medium text-primary hover:underline" onClick={() => void lfsSetUp(id)}>Set up</button>
        </div>
      )
    case 'lfs-pattern':
      return (
        <div style={{ ...style, paddingLeft: pad(1) }} data-testid="lfs-pattern" onClick={() => onCursor(row.key)}
          onContextMenu={() => useStore.setState({ menu: { kind: 'lfs-pattern', pattern: row.pattern.pattern } })}
          title={`From ${row.pattern.source}`} className={clsx(base, 'font-mono text-xs')}>
          <span className="min-w-0 flex-1 truncate">{row.pattern.pattern}</span>
          {row.pattern.lockable && <Badge title="Lockable: checked out read-only until you lock it">lockable</Badge>}
        </div>
      )
    case 'lfs-missing':
      return (
        <div style={{ ...style, paddingLeft: pad(1) }} className="flex items-center gap-2 pr-3 text-xs text-muted-foreground" onContextMenu={noMenu}>
          <span className="min-w-0 flex-1">{row.count} not downloaded</span>
          <button className="font-medium text-primary hover:underline" onClick={() => void lfsPull(id)}>Pull</button>
        </div>
      )
    case 'more-tags':
      return (
        <div style={{ ...style, paddingLeft: pad(1) }} className="flex items-center text-xs text-muted-foreground/70" data-testid="more-tags" onContextMenu={noMenu}>
          {row.hidden.toLocaleString()} older {row.hidden === 1 ? 'tag' : 'tags'} ·&nbsp;
          <button className="font-medium text-primary hover:underline" onClick={() => void saveSettings({ sidebarTags: 'all' })}>Show all</button>
        </div>
      )
    case 'empty':
      return (
        <div style={{ ...style, paddingLeft: pad(row.depth) }} className="flex items-center text-xs text-muted-foreground/70" data-testid="sidebar-empty" data-for={row.for} onContextMenu={noMenu}>
          {row.text}
        </div>
      )
  }
})

function sectionName(s: RefSection): string {
  return typeof s === 'string' ? s : 'remotes'
}

function RefRow({ row, style, cursor, look, onClick, onDoubleClick }: {
  row: Extract<SidebarRow, { kind: 'ref' }>; style: React.CSSProperties; cursor: boolean; look: RowContext
  onClick: (e: React.MouseEvent, r: Ref, key: string) => void
  onDoubleClick: (r: Ref) => void
}) {
  const r = row.ref
  const head = r.kind === 'local' && r.shortName === look.headBranch
  const filter = look.filter
  const remote = r.kind === 'remote' ? `refs/remotes/${r.shortName.split('/')[0]}/*` : null
  const hidden = filter.hidden.includes(r.name) || (!!remote && filter.hidden.includes(remote))
  const soloed = filter.solo.includes(r.name)
  /** Out of the graph: hidden, or not among the soloed refs. HEAD's branch always shows. */
  const out = !head && r.kind !== 'tag' && !refShown(r, filter, look.headBranch)
  const pr = r.kind === 'local' ? look.prs.get(r.shortName) : undefined
  const fetched = look.lastFetched ? `, last fetched ${relativeTime(look.lastFetched)}` : ''
  const tracking = r.upstream ? `Tracks ${r.upstream.replace(/^refs\/remotes\//, '')}${fetched}` : ''
  // Tower's badge order: ↑n ↓n, gone, merged, stale, worktree, #PR, local only.
  const badges: ReactNode[] = []
  if ((r.ahead ?? 0) > 0) badges.push(<span key="ahead" className="text-2xs text-add" title={`${r.ahead} to push. ${tracking}`}>↑{r.ahead}</span>)
  if ((r.behind ?? 0) > 0) badges.push(<span key="behind" className="text-2xs text-warn" title={`${r.behind} to pull. ${tracking}`}>↓{r.behind}</span>)
  if (r.upstreamGone) badges.push(<span key="gone" className="text-2xs text-muted-foreground/70" title="Upstream deleted on the remote">gone</span>)
  if (r.kind === 'local' && !head) {
    if (look.merged.has(r.shortName)) badges.push(<Badge key="merged" title={`Already in ${look.headBranch ?? 'HEAD'}: safe to delete`}>merged</Badge>)
    if (look.stale && isStale(r)) badges.push(<Badge key="stale" title="No commits for 90 days">stale</Badge>)
  }
  if (r.kind === 'local' && look.elsewhere.has(r.shortName)) badges.push(<Badge key="wt" title={`Checked out in ${look.elsewhere.get(r.shortName)}`}>worktree</Badge>)
  if (pr) badges.push(<Badge key="pr" title={`Pull request #${pr.number}: ${pr.title}`}>#{pr.number}</Badge>)
  if (r.kind === 'tag' && look.onRemote && !look.onRemote.names.has(r.shortName)) badges.push(<Badge key="local" title={`Not on ${look.onRemote.remote}`}>local only</Badge>)
  return (
    <div
      style={{ ...style, paddingLeft: pad(row.depth) }}
      onClick={(e) => onClick(e, r, row.key)}
      onDoubleClick={() => onDoubleClick(r)}
      onMouseDown={(e) => e.detail > 1 && e.preventDefault()}
      onContextMenu={() => useStore.setState({ menu: { kind: 'ref', ref: r, hash: r.hash } })}
      draggable
      onDragStart={(e) => startDrag(e.dataTransfer, { kind: 'ref', ref: r })}
      data-drop-target={drop({ kind: 'ref', ref: r })}
      data-testid="sidebar-ref"
      data-ref={r.name}
      data-section={sectionName(row.section)}
      data-upstream={r.upstream ?? ''}
      title={`${r.name}${tracking ? `\n${tracking}` : ''}\n${r.kind === 'tag' ? 'Click to show it in the graph' : 'Click to show its history, double-click to check out'}`}
      className={clsx('group flex cursor-default items-center gap-1.5 pr-3 text-sm', cursor ? 'bg-select' : 'hover:bg-accent', head && 'font-semibold')}
    >
      {head && <span className="-ml-4 w-3 text-2xs text-primary">✓</span>}
      <span className={clsx('min-w-[4.5rem] flex-1 truncate', out && 'text-muted-foreground/70 line-through decoration-muted-foreground/50')} data-testid="ref-label">{row.label}</span>
      {/* Badges give way before the branch name does: the name is what you are looking for. They
          wrap onto a second line that is cut off, so a badge that does not fit disappears whole
          instead of showing as "sta". */}
      {badges.length > 0 && <span className="flex h-4 min-w-0 shrink flex-wrap items-center justify-end gap-x-1 overflow-hidden">{badges}</span>}
      {soloed && <span title="Showing its history: the graph shows only the branches you picked"><Focus size={12} className="text-primary" /></span>}
      {!head && r.kind !== 'tag' && (
        <button
          onClick={(e) => { e.stopPropagation(); if (filter.hidden.includes(r.name)) showInGraph(look.repoId, r.name); else hideInGraph(look.repoId, r.name) }}
          onDoubleClick={(e) => e.stopPropagation()}
          title={hidden ? 'Show in the graph' : 'Hide in the graph'} aria-label={hidden ? 'Show in the graph' : 'Hide in the graph'} data-testid="toggle-hidden"
          className={clsx('rounded p-0.5 text-muted-foreground/70 hover:text-foreground', hidden ? '' : 'opacity-0 group-hover:opacity-100')}>
          {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
      )}
    </div>
  )
}

function SmallButton({ label, title, onClick, children }: { label: string; title?: string; onClick: (e: React.MouseEvent) => void; children: ReactNode }) {
  return (
    <button title={title ?? label} aria-label={label} onClick={onClick} onDoubleClick={(e) => e.stopPropagation()} className="ml-1 rounded p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground">
      {children}
    </button>
  )
}

function Badge({ title, children }: { title?: string; children: ReactNode }) {
  return <span title={title} className="rounded bg-accent px-1 text-2xs text-muted-foreground/70">{children}</span>
}

/** The + below the sidebar: everything new that the sidebar lists. */
function AddMenu({ view }: { view: RepoView }) {
  const id = view.id
  const head = view.snapshot.head.hash
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button aria-label="New…" title="Create a branch, tag, remote, submodule or worktree" data-testid="sidebar-add" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <Plus size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DM.Content>
        <DM.Item onSelect={() => newBranch(id)}>Create branch…</DM.Item>
        <DM.Item disabled={!head} onSelect={() => head && newTag(id, head)}>Create tag…</DM.Item>
        <DM.Separator />
        <DM.Item onSelect={() => addRemote(id)}>Add remote…</DM.Item>
        <DM.Item onSelect={() => addSubmodule(id)}>Add submodule…</DM.Item>
        <DM.Item onSelect={() => addWorktree(id)}>Add worktree…</DM.Item>
      </DM.Content>
    </DropdownMenu.Root>
  )
}

/** The gear below the sidebar: how it shows things. Folders is for every repository, the rest for this one. */
function GearMenu({ path }: { path: string }) {
  const prefs = useSidebarPrefs(path)
  const folders = useSetting('sidebarFolders')
  const set = (patch: Partial<typeof prefs>) => updateSidebarPrefs(path, (p) => ({ ...p, ...patch }))
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button aria-label="Sidebar options" title="Sidebar options" data-testid="sidebar-gear" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <Settings2 size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DM.Content align="end">
        <DM.Check checked={folders} onChange={(v) => void saveSettings({ sidebarFolders: v })} testId="gear-folders">Group refs in folders (all repositories)</DM.Check>
        <DM.Separator />
        <DM.Label>This repository</DM.Label>
        <DM.Check checked={prefs.merged !== false} onChange={(v) => set({ merged: v })} testId="gear-merged">Show merged badge</DM.Check>
        <DM.Check checked={prefs.stale !== false} onChange={(v) => set({ stale: v })} testId="gear-stale">Show stale badge</DM.Check>
        <DM.Check checked={prefs.reflog !== false} onChange={(v) => set({ reflog: v })} testId="gear-reflog">Show reflog</DM.Check>
        <DM.Check checked={prefs.stashCount !== false} onChange={(v) => set({ stashCount: v })} testId="gear-stash-count">Show stash count</DM.Check>
        <DM.Separator />
        <DM.Label>Click a branch</DM.Label>
        <DM.Check checked={prefs.click !== 'reveal'} onChange={(v) => set({ click: v ? 'history' : 'reveal' })} testId="gear-click-history">Show its history</DM.Check>
        <DM.Check checked={prefs.click === 'reveal'} onChange={(v) => set({ click: v ? 'reveal' : 'history' })} testId="gear-click-reveal">Reveal its commit</DM.Check>
      </DM.Content>
    </DropdownMenu.Root>
  )
}
