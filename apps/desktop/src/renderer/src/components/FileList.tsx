import type { ChangeKind } from '@gitsquid/shared'
import clsx from 'clsx'
import { ContextMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { splitPath } from '../lib/format'

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

export function FileRow({ path, oldPath, kind, selected, onClick, actions, stats, testId, menu }: {
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
      className={clsx('group flex h-6 cursor-default items-center gap-2 px-3 text-[13px]', selected ? 'bg-select' : 'hover:bg-hover')}
    >
      <span className={clsx('w-3 shrink-0 text-center font-mono text-[11px] font-bold', b.cls)} title={b.title}>{b.letter}</span>
      <span className="min-w-0 flex-1 truncate">
        <span>{name}</span>
        {dir && <span className="ml-1.5 text-xs text-faint">{dir}</span>}
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
