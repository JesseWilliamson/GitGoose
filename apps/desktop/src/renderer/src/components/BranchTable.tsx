import type { Ref } from '@gitgoose/shared'
import clsx from 'clsx'
import { Pin, X } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useMemo, useState } from 'react'
import { checkout, deleteBranches, isStale, reviewBranch, STALE_DAYS } from '../lib/actions'
import { relativeTime } from '../lib/format'
import { ensureLoaded, selectCommit, updateRepo, useStore, type RepoView } from '../lib/store'
import { GraphMenu } from './menus'
import { Button } from './ui'

/**
 * Branch housekeeping beside the graph (B in Browse, ADR-012): every local branch with what it is
 * (merged, stale, ahead of or behind its upstream, when it last moved), filters for the ones to
 * clean up, and a bulk delete that Undo brings back. It sits beside the graph rather than on a
 * screen of its own, so a row clicked here shows its commit in the graph, and a branch can still
 * be dragged onto a commit there.
 */

type Filter = 'all' | 'merged' | 'stale' | 'ahead'

interface Row {
  ref: Ref
  name: string
  merged: boolean
  stale: boolean
  pinned: boolean
  /** Checked out, here or in another worktree: git will not delete it. */
  busy: boolean
}

export function BranchTable({ view }: { view: RepoView }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const rows = useMemo<Row[]>(() => {
    const checkedOut = new Set(view.worktrees.map((w) => w.branch).filter(Boolean))
    return view.snapshot.refs
      .filter((r) => r.kind === 'local')
      .map((r) => ({
        ref: r, name: r.shortName, merged: view.merged.includes(r.shortName), stale: isStale(r), pinned: view.pins.includes(r.shortName),
        busy: r.shortName === view.snapshot.head.branch || checkedOut.has(r.shortName),
      }))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.ref.date ?? 0) - (a.ref.date ?? 0))
  }, [view.snapshot.refs, view.snapshot.head.branch, view.merged, view.pins, view.worktrees])
  const shown = rows.filter((r) => filter === 'all' || (filter === 'merged' && r.merged && !r.busy) || (filter === 'stale' && r.stale && !r.busy) || (filter === 'ahead' && (r.ref.ahead ?? 0) > 0))
  const count = (f: Filter) => rows.filter((r) => (f === 'merged' ? r.merged && !r.busy : f === 'stale' ? r.stale && !r.busy : (r.ref.ahead ?? 0) > 0)).length
  const toggle = (name: string) => setPicked((p) => {
    const next = new Set(p)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    return next
  })
  const chosen = rows.filter((r) => picked.has(r.name) && !r.busy)
  const unmerged = chosen.filter((r) => !r.merged).length
  const remove = () => {
    void deleteBranches(view.id, chosen.map((r) => r.name), unmerged > 0)
    setPicked(new Set())
  }
  const show = (r: Row) => {
    selectCommit(view.id, r.ref.hash)
    void ensureLoaded(view.id, r.ref.hash)
  }

  return (
    <div className="flex h-full min-h-0 w-[560px] shrink-0 flex-col border-l border-border bg-card" data-testid="branch-table">
      <div className="flex h-strip shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="font-medium">Branches {rows.length}</span>
        <div className="flex gap-0.5" role="tablist">
          {(['all', 'merged', 'stale', 'ahead'] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} data-testid={`branch-filter-${f}`} onClick={() => setFilter(f)}
              className={clsx('rounded px-2 py-0.5 capitalize', filter === f ? 'bg-select font-medium' : 'text-muted-foreground hover:bg-accent')}>
              {f === 'ahead' ? 'Unpushed' : f}{f !== 'all' ? ` ${count(f)}` : ''}
            </button>
          ))}
        </div>
        <button className="ml-auto rounded p-1 text-hint hover:bg-accent hover:text-foreground" title="Close (B)" onClick={() => updateRepo(view.id, { branchTable: false })}><X size={14} /></button>
      </div>
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-border px-3 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
        <span className="w-4" />
        <span className="min-w-0 flex-1">Name</span>
        <span className="w-24">State</span>
        <span className="w-16 text-right">↑ ↓</span>
        <span className="w-20 text-right">Moved</span>
        <span className="w-14" />
      </div>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="branch-rows">
            {shown.map((r) => (
              <div key={r.name} data-testid="branch-row" data-branch={r.name} onClick={() => show(r)} onDoubleClick={() => void checkout(view.id, r.ref.name)}
                onContextMenu={() => useStore.setState({ menu: { kind: 'ref', ref: r.ref, hash: r.ref.hash } })}
                className="group flex h-7 cursor-default items-center gap-2 px-3 text-sm hover:bg-accent">
                <input type="checkbox" className="w-4" aria-label={`Pick ${r.name}`} checked={picked.has(r.name)} disabled={r.busy}
                  onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.name)} />
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  {r.pinned && <Pin size={11} className="shrink-0 text-hint" />}
                  <span className={clsx('truncate', r.busy && 'font-semibold')} title={r.ref.upstream ? `${r.name} → ${r.ref.upstream.replace('refs/remotes/', '')}` : r.name}>{r.name}</span>
                </span>
                <span className="flex w-24 gap-1 text-2xs">
                  {r.busy && <span className="text-primary">checked out</span>}
                  {!r.busy && r.merged && <span className="text-add">merged</span>}
                  {!r.busy && r.stale && <span className="text-warn" title={`No commits for ${STALE_DAYS} days`}>stale</span>}
                  {!r.ref.upstream && !r.busy && !r.merged && !r.stale && <span className="text-hint">local only</span>}
                </span>
                <span className="w-16 text-right font-mono text-2xs text-muted-foreground">
                  {r.ref.upstream ? `${r.ref.ahead ?? 0} ${r.ref.behind ?? 0}` : ''}
                </span>
                <span className="w-20 text-right text-2xs text-hint">{r.ref.date !== undefined ? relativeTime(r.ref.date) : ''}</span>
                <span className="flex w-14 justify-end">
                  <button className="hidden rounded px-1.5 text-2xs font-medium text-primary group-hover:block hover:bg-select" data-testid="branch-review"
                    onClick={(e) => { e.stopPropagation(); void reviewBranch(view.id, r.ref) }}>Review</button>
                </span>
              </div>
            ))}
            {shown.length === 0 && <div className="px-3 py-4 text-sm text-hint">Nothing here.</div>}
          </div>
        </ContextMenu.Trigger>
        <GraphMenu repoId={view.id} />
      </ContextMenu.Root>
      <div className="flex h-11 shrink-0 items-center gap-2 border-t border-border px-3 text-xs" data-testid="branch-bulk">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {chosen.length ? `${chosen.length} picked${unmerged ? `, ${unmerged} not merged: their commits stay reachable through Undo` : ': all merged, nothing is lost'}`
            : 'Pick branches to delete; Undo brings them back.'}
        </span>
        <Button size="sm" variant={unmerged ? 'danger' : 'primary'} disabled={!chosen.length} onClick={remove} data-testid="branch-delete">
          Delete {chosen.length || ''}
        </Button>
      </div>
    </div>
  )
}
