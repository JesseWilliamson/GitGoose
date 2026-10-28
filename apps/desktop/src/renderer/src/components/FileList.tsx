import type { ChangeKind } from '@gitgoose/shared'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Folder, List, ListTree, Search } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { startDrag, type DragSource } from '../lib/dnd'
import { matchesFilter, treeRows } from '../lib/fileTree'
import { splitPath } from '../lib/format'
import { saveSettings, useSetting } from '../lib/store'

const BADGE: Record<string, { letter: string; cls: string; title: string }> = {
  added: { letter: 'A', cls: 'text-add', title: 'Added' },
  untracked: { letter: 'U', cls: 'text-add', title: 'Untracked' },
  modified: { letter: 'M', cls: 'text-warn', title: 'Modified' },
  deleted: { letter: 'D', cls: 'text-destructive', title: 'Deleted' },
  renamed: { letter: 'R', cls: 'text-primary', title: 'Renamed' },
  copied: { letter: 'C', cls: 'text-primary', title: 'Copied' },
  typechange: { letter: 'T', cls: 'text-warn', title: 'Type changed' },
  unmerged: { letter: '!', cls: 'text-destructive', title: 'Conflicted' },
}

/** Porcelain status letter (M, A, D, R...) to a change kind. */
export function statusKind(code: string): ChangeKind | 'untracked' {
  switch (code) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'typechange'
    case 'U': return 'unmerged'
    case '?': return 'untracked'
    default: return 'modified'
  }
}

export function FileRow({ path, oldPath, kind, selected, onClick, actions, stats, testId, menu, depth, tree, drag }: {
  /** Dragging the row drags this (a file's change to apply elsewhere, or working-copy files to stash). */
  drag?: DragSource
  /** Tree view: indent by depth and show only the file name (the folders are rows above). */
  depth?: number
  tree?: boolean
  path: string
  oldPath?: string
  kind: ChangeKind | 'untracked'
  selected?: boolean
  /** Gets the click, so a list can read Shift and Ctrl/Cmd for selecting several files. */
  onClick?: (e: React.MouseEvent) => void
  actions?: ReactNode
  stats?: ReactNode
  testId?: string
  /** Right-click menu content (CM.Content). */
  menu?: ReactNode
}) {
  const b = BADGE[kind] ?? BADGE.modified!
  const { dir, name } = splitPath(path)
  const row = (
    <div
      onClick={onClick}
      // Shift-click would otherwise also select the text between the two rows.
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      data-testid={testId}
      data-selected={selected || undefined}
      data-path={path}
      draggable={!!drag}
      onDragStart={drag ? (e) => startDrag(e.dataTransfer, drag) : undefined}
      title={oldPath ? `${oldPath} → ${path}` : path}
      style={tree ? { paddingLeft: 12 + (depth ?? 0) * 14 + 16 } : undefined}
      className={clsx('group flex h-row cursor-default items-center gap-2 px-3 text-sm', selected ? 'bg-select' : 'hover:bg-accent')}
    >
      <span className={clsx('w-3 shrink-0 text-center font-mono text-2xs font-bold', b.cls)} title={b.title}>{b.letter}</span>
      <span className="min-w-0 flex-1 truncate">
        <span>{name}</span>
        {dir && !tree && <span className="ml-1.5 text-xs text-hint">{dir}</span>}
      </span>
      {stats}
      {actions && <span className="hidden shrink-0 items-center gap-1 group-hover:flex">{actions}</span>}
    </div>
  )
  if (!menu) return row
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      {menu}
    </ContextMenu.Root>
  )
}

export interface FileLayout {
  depth: number
  tree: boolean
  order: string[]
}

/**
 * A list of changed files, flat or as a folder tree (Settings → Appearance, or the toggle in
 * FileListTools), narrowed by a filter. Folder rows can carry actions for all files under them
 * (stage a folder, say).
 */
export function FileListView<T>({ items, pathOf, filter, renderFile, folderActions, testId }: {
  items: T[]
  pathOf: (item: T) => string
  filter: string
  /** `order` is every file row as shown, top to bottom: what a Shift-click range runs along. */
  renderFile: (item: T, layout: FileLayout) => ReactNode
  folderActions?: (paths: string[]) => ReactNode
  testId?: string
}) {
  const tree = useSetting('fileTree')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const shown = filter.trim() ? items.filter((i) => matchesFilter(pathOf(i), filter)) : items
  if (!tree) {
    const order = shown.map(pathOf)
    return <Rows count={shown.length} render={(k) => renderFile(shown[k]!, { depth: 0, tree: false, order })} />
  }
  const byPath = new Map(shown.map((i) => [pathOf(i), i]))
  const toggle = (path: string) => setCollapsed((c) => {
    const next = new Set(c)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  const rows = treeRows([...byPath.keys()], collapsed)
  const order = rows.filter((r) => r.kind === 'file').map((r) => r.path)
  return (
    <Rows count={rows.length} render={(k) => {
      const r = rows[k]!
      return r.kind === 'file' ? (
        <div key={r.path}>{renderFile(byPath.get(r.path)!, { depth: r.depth, tree: true, order })}</div>
      ) : (
        <div key={`dir:${r.path}`} onClick={() => toggle(r.path)} data-testid={testId ? `${testId}-folder` : undefined} data-path={r.path}
          style={{ paddingLeft: 12 + r.depth * 14 }}
          className="group flex h-row cursor-default items-center gap-1.5 pr-3 text-sm hover:bg-accent">
          {collapsed.has(r.path) ? <ChevronRight size={12} className="text-hint" /> : <ChevronDown size={12} className="text-hint" />}
          <Folder size={13} className="shrink-0 text-hint" />
          <span className="min-w-0 flex-1 truncate">{r.name}</span>
          <span className="text-2xs text-hint">{r.files.length}</span>
          {folderActions && <span className="hidden shrink-0 items-center gap-1 group-hover:flex" onClick={(e) => e.stopPropagation()}>{folderActions(r.files)}</span>}
        </div>
      )
    }} />
  )
}

/** Lists up to this long render every row; longer ones only the rows in view. */
const VIRTUAL_FROM = 200
const ROW_PX = 24 // h-row

/**
 * Rows of a file list. A short list renders them all. A long one (a 3,000-file stash) renders only
 * what is in view: the list does not scroll by itself, it sits in a pane that scrolls (Details),
 * so the virtualizer follows that ancestor and offsets by where the list starts inside it.
 */
function Rows({ count, render }: { count: number; render: (i: number) => ReactNode }) {
  if (count < VIRTUAL_FROM) return <>{Array.from({ length: count }, (_, i) => render(i))}</>
  return <VirtualRows count={count} render={render} />
}

function VirtualRows({ count, render }: { count: number; render: (i: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let p = el.parentElement
    while (p && !/(auto|scroll)/.test(getComputedStyle(p).overflowY)) p = p.parentElement
    setScroller(p)
    if (!p) return
    const measure = () => setMargin(el.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(p)
    return () => ro.disconnect()
  }, [])
  const virt = useVirtualizer({ count, getScrollElement: () => scroller, estimateSize: () => ROW_PX, overscan: 20, scrollMargin: margin })
  return (
    <div ref={ref} style={{ height: virt.getTotalSize(), position: 'relative' }} data-testid="file-list-virtual">
      {virt.getVirtualItems().map((vi) => (
        <div key={vi.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_PX, transform: `translateY(${vi.start - margin}px)` }}>
          {render(vi.index)}
        </div>
      ))}
    </div>
  )
}

/** The filter box and the list / tree toggle over a file list. */
export function FileListTools({ filter, onFilter }: { filter: string; onFilter: (f: string) => void }) {
  const tree = useSetting('fileTree')
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1">
      <Search size={12} className="ml-1 shrink-0 text-hint" />
      <input value={filter} onChange={(e) => onFilter(e.target.value)} placeholder="Filter files" data-testid="file-filter"
        onKeyDown={(e) => { if (e.key === 'Escape') onFilter('') }}
        className="h-6 min-w-0 flex-1 bg-transparent px-1 text-xs outline-none" />
      <button onClick={() => void saveSettings({ fileTree: !tree })} title={tree ? 'Show as a list' : 'Show as a tree'} aria-label={tree ? 'Show as a list' : 'Show as a tree'}
        data-testid="file-tree-toggle" className="rounded p-1 text-hint hover:bg-accent hover:text-foreground">
        {tree ? <List size={13} /> : <ListTree size={13} />}
      </button>
    </div>
  )
}
