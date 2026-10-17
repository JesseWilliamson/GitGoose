import type { ChangeKind } from '@gitsquid/shared'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Folder, List, ListTree, Search } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import { matchesFilter, treeRows } from '../lib/fileTree'
import { splitPath } from '../lib/format'
import { saveSettings, useSetting } from '../lib/store'

const BADGE: Record<string, { letter: string; cls: string; title: string }> = {
  added: { letter: 'A', cls: 'text-add', title: 'Added' },
  untracked: { letter: 'U', cls: 'text-add', title: 'Untracked' },
  modified: { letter: 'M', cls: 'text-warn', title: 'Modified' },
  deleted: { letter: 'D', cls: 'text-del', title: 'Deleted' },
  renamed: { letter: 'R', cls: 'text-accent', title: 'Renamed' },
  copied: { letter: 'C', cls: 'text-accent', title: 'Copied' },
  typechange: { letter: 'T', cls: 'text-warn', title: 'Type changed' },
  unmerged: { letter: '!', cls: 'text-del', title: 'Conflicted' },
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

export function FileRow({ path, oldPath, kind, selected, onClick, actions, stats, testId, menu, depth, tree }: {
  /** Tree view: indent by depth and show only the file name (the folders are rows above). */
  depth?: number
  tree?: boolean
  path: string
  oldPath?: string
  kind: ChangeKind | 'untracked'
  selected?: boolean
  onClick?: () => void
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
      data-testid={testId}
      data-path={path}
      title={oldPath ? `${oldPath} → ${path}` : path}
      style={tree ? { paddingLeft: 12 + (depth ?? 0) * 14 + 16 } : undefined}
      className={clsx('group flex h-6 cursor-default items-center gap-2 px-3 text-[13px]', selected ? 'bg-select' : 'hover:bg-hover')}
    >
      <span className={clsx('w-3 shrink-0 text-center font-mono text-[11px] font-bold', b.cls)} title={b.title}>{b.letter}</span>
      <span className="min-w-0 flex-1 truncate">
        <span>{name}</span>
        {dir && !tree && <span className="ml-1.5 text-xs text-faint">{dir}</span>}
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

/**
 * A list of changed files, flat or as a folder tree (Settings → Appearance, or the toggle in
 * FileListTools), narrowed by a filter. Folder rows can carry actions for all files under them
 * (stage a folder, say).
 */
export function FileListView<T>({ items, pathOf, filter, renderFile, folderActions, testId }: {
  items: T[]
  pathOf: (item: T) => string
  filter: string
  renderFile: (item: T, layout: { depth: number; tree: boolean }) => ReactNode
  folderActions?: (paths: string[]) => ReactNode
  testId?: string
}) {
  const tree = useSetting('fileTree')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const shown = filter.trim() ? items.filter((i) => matchesFilter(pathOf(i), filter)) : items
  if (!tree) return <>{shown.map((i) => renderFile(i, { depth: 0, tree: false }))}</>
  const byPath = new Map(shown.map((i) => [pathOf(i), i]))
  const toggle = (path: string) => setCollapsed((c) => {
    const next = new Set(c)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  return (
    <>
      {treeRows([...byPath.keys()], collapsed).map((r) => r.kind === 'file' ? (
        <div key={r.path}>{renderFile(byPath.get(r.path)!, { depth: r.depth, tree: true })}</div>
      ) : (
        <div key={`dir:${r.path}`} onClick={() => toggle(r.path)} data-testid={testId ? `${testId}-folder` : undefined} data-path={r.path}
          style={{ paddingLeft: 12 + r.depth * 14 }}
          className="group flex h-6 cursor-default items-center gap-1.5 pr-3 text-[13px] hover:bg-hover">
          {collapsed.has(r.path) ? <ChevronRight size={12} className="text-faint" /> : <ChevronDown size={12} className="text-faint" />}
          <Folder size={13} className="shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate">{r.name}</span>
          <span className="text-[11px] text-faint">{r.files.length}</span>
          {folderActions && <span className="hidden shrink-0 items-center gap-1 group-hover:flex" onClick={(e) => e.stopPropagation()}>{folderActions(r.files)}</span>}
        </div>
      ))}
    </>
  )
}

/** The filter box and the list / tree toggle over a file list. */
export function FileListTools({ filter, onFilter }: { filter: string; onFilter: (f: string) => void }) {
  const tree = useSetting('fileTree')
  return (
    <div className="flex items-center gap-1 border-b border-line px-2 py-1">
      <Search size={12} className="ml-1 shrink-0 text-faint" />
      <input value={filter} onChange={(e) => onFilter(e.target.value)} placeholder="Filter files" data-testid="file-filter"
        onKeyDown={(e) => { if (e.key === 'Escape') onFilter('') }}
        className="h-6 min-w-0 flex-1 bg-transparent px-1 text-[12px] outline-none" />
      <button onClick={() => void saveSettings({ fileTree: !tree })} title={tree ? 'Show as a list' : 'Show as a tree'} aria-label={tree ? 'Show as a list' : 'Show as a tree'}
        data-testid="file-tree-toggle" className="rounded p-1 text-faint hover:bg-hover hover:text-fg">
        {tree ? <List size={13} /> : <ListTree size={13} />}
      </button>
    </div>
  )
}
