import type { Ref } from '@gitsquid/shared'
import clsx from 'clsx'
import { Archive, ChevronDown, ChevronRight, Cloud, GitBranch, History, Plus, Tag } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useMemo, useState, type ReactNode } from 'react'
import { addRemote, checkout, isStale, pop, remoteNames, stashApply, stashDrop, stashToBranch } from '../lib/actions'
import { relativeTime, stashLabel } from '../lib/format'
import { ensureLoaded, updateRepo, useStore, type RepoView } from '../lib/store'
import { REF_MIME } from './Graph'
import { GraphMenu } from './menus'
import { CM } from './ui'

export function Sidebar({ view }: { view: RepoView }) {
  const [filter, setFilter] = useState('')
  const snap = view.snapshot
  const f = filter.trim().toLowerCase()
  const match = (r: Ref) => !f || r.shortName.toLowerCase().includes(f)

  const locals = snap.refs.filter((r) => r.kind === 'local' && match(r))
  const tags = snap.refs.filter((r) => r.kind === 'tag' && match(r)).reverse()
  const remotes = useMemo(() => {
    const m = new Map<string, Ref[]>(remoteNames(view).map((n) => [n, []]))
    for (const r of snap.refs) {
      if (r.kind !== 'remote' || !match(r)) continue
      const remote = r.shortName.split('/')[0]!
      m.get(remote)?.push(r)
    }
    return m
  }, [snap.refs, view.remotes, f])
  const merged = new Set(view.merged)
  /** After "Check which tags are on <remote>": the tags it does not have. */
  const onRemote = view.remoteTags ? new Set(view.remoteTags.names) : null
  const menuFor = (section: 'local' | 'remotes' | 'tags') => () => useStore.setState({ menu: { kind: 'section', section } })

  const jump = async (hash: string) => {
    updateRepo(view.id, { selected: { kind: 'commit', hash }, center: { kind: 'graph' } })
    await ensureLoaded(view.id, hash)
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-panel">
      <div className="p-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter branches and tags"
          className="h-7 w-full rounded-md border border-line bg-bg px-2 text-xs outline-none focus:border-accent"
        />
      </div>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className="min-h-0 flex-1 overflow-y-auto pb-4" data-testid="sidebar">
            <Section title="Local" count={locals.length} icon={<GitBranch size={13} />} onContextMenu={menuFor('local')}>
              {locals.map((r) => {
                const head = r.shortName === snap.head.branch
                return (
                  <RefItem key={r.name} r={r} label={r.shortName} view={view} onJump={jump} head={head}>
                    {(r.ahead ?? 0) > 0 && <span className="text-[10px] text-add">↑{r.ahead}</span>}
                    {(r.behind ?? 0) > 0 && <span className="text-[10px] text-warn">↓{r.behind}</span>}
                    {r.upstreamGone && <span className="text-[10px] text-faint" title="Upstream deleted">gone</span>}
                    {!head && merged.has(r.shortName) && <Badge title={`Already in ${snap.head.branch ?? 'HEAD'}: safe to delete`}>merged</Badge>}
                    {!head && isStale(r) && <Badge title="No commits for 90 days">stale</Badge>}
                  </RefItem>
                )
              })}
            </Section>
            <Section title="Remotes" count={remotes.size} icon={<Cloud size={13} />} onContextMenu={menuFor('remotes')}
              action={<button title="Add remote" aria-label="Add remote" onClick={() => addRemote(view.id)} className="rounded p-0.5 text-faint hover:bg-hover hover:text-fg"><Plus size={13} /></button>}>
              {[...remotes.entries()].filter(([, refs]) => !f || refs.length).map(([remote, refs]) => (
                <Section key={remote} title={remote} count={refs.length} icon={null} defaultOpen={false} depth={1}
                  testId="remote-section" onContextMenu={() => useStore.setState({ menu: { kind: 'remote', remote } })}>
                  {refs.map((r) => (
                    <RefItem key={r.name} r={r} label={r.shortName.slice(remote.length + 1)} view={view} onJump={jump} depth={1} />
                  ))}
                  {refs.length === 0 && <Empty depth={1}>Not fetched yet</Empty>}
                </Section>
              ))}
              {remotes.size === 0 && <Empty>No remotes</Empty>}
            </Section>
            <Section title="Tags" count={tags.length} icon={<Tag size={13} />} defaultOpen={false} onContextMenu={menuFor('tags')}>
              {tags.map((r) => (
                <RefItem key={r.name} r={r} label={r.shortName} view={view} onJump={jump}>
                  {onRemote && !onRemote.has(r.shortName) && <Badge title={`Not on ${view.remoteTags!.remote}`}>local only</Badge>}
                </RefItem>
              ))}
            </Section>
            <Section title="Stashes" count={view.stashes.length} icon={<Archive size={13} />}>
              {view.stashes.map((s) => (
                <StashItem key={s.ref} repoId={view.id} index={s.index} message={s.message} date={s.date}
                  selected={view.selected.kind === 'commit' && view.selected.hash === s.hash}
                  onSelect={() => updateRepo(view.id, { selected: { kind: 'commit', hash: s.hash }, center: { kind: 'graph' } })} />
              ))}
              {view.stashes.length === 0 && <Empty>No stashes</Empty>}
            </Section>
            <button onClick={() => updateRepo(view.id, { center: { kind: 'reflog' } })} data-testid="open-reflog"
              title="Every place HEAD has been: recover deleted branches and lost commits"
              className={clsx('mt-1 flex h-7 w-full items-center gap-1.5 pr-2 pl-[27px] text-[12px] font-semibold hover:text-fg', view.center.kind === 'reflog' ? 'text-fg' : 'text-muted')}>
              <History size={13} /> Reflog
            </button>
          </div>
        </ContextMenu.Trigger>
        <GraphMenu repoId={view.id} />
      </ContextMenu.Root>
    </aside>
  )
}

function Section({ title, count, icon, children, defaultOpen = true, depth = 0, action, onContextMenu, testId }: {
  title: string; count: number; icon: ReactNode; children: ReactNode; defaultOpen?: boolean; depth?: number
  /** A small button at the end of the header (Add remote). */
  action?: ReactNode
  /** Right-click on the header: records the menu target (the sidebar's menu renders it). */
  onContextMenu?: () => void
  testId?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={depth ? '' : 'mt-1'} data-testid={testId} data-name={title}>
      <div className="flex h-7 items-center pr-2" onContextMenu={onContextMenu}>
        <button onClick={() => setOpen(!open)} style={{ paddingLeft: 8 + depth * 16 }}
          className={clsx('flex h-full min-w-0 flex-1 items-center gap-1.5 text-[12px] hover:text-fg', depth ? 'font-medium text-muted' : 'font-semibold text-muted')}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {icon}
          <span className="flex-1 truncate text-left">{title}</span>
          <span className="text-[11px] font-normal text-faint">{count}</span>
        </button>
        {action && <span className="ml-1">{action}</span>}
      </div>
      {open && <div>{children}</div>}
    </div>
  )
}

function Badge({ title, children }: { title: string; children: ReactNode }) {
  return <span title={title} className="rounded bg-hover px-1 text-[10px] text-faint">{children}</span>
}

function Empty({ children, depth = 0 }: { children: ReactNode; depth?: number }) {
  return <div className="py-1 text-xs text-faint" style={{ paddingLeft: 32 + depth * 16 }}>{children}</div>
}

function RefItem({ r, label, view, onJump, head, depth = 0, children }: {
  r: Ref; label: string; view: RepoView; onJump: (hash: string) => void; head?: boolean; depth?: number; children?: ReactNode
}) {
  const selected = view.selected.kind === 'commit' && view.selected.hash === r.hash
  return (
    <div
      draggable={r.kind !== 'tag'}
      onDragStart={(e) => {
        e.dataTransfer.setData(REF_MIME, JSON.stringify(r))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => void onJump(r.hash)}
      onDoubleClick={() => !head && void checkout(view.id, r.name)}
      onContextMenu={() => useStore.setState({ menu: { kind: 'ref', ref: r, hash: r.hash } })}
      data-testid="sidebar-ref"
      data-ref={r.name}
      title={`${r.name}\nDouble-click to check out`}
      style={{ paddingLeft: 32 + depth * 16 }}
      className={clsx('flex h-6 cursor-default items-center gap-1.5 pr-3 text-[13px]', selected ? 'bg-select' : 'hover:bg-hover', head && 'font-semibold')}
    >
      {head && <span className="-ml-4 w-3 text-[10px] text-accent">✓</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
    </div>
  )
}

function StashItem({ repoId, index, message, date, selected, onSelect }: {
  repoId: string; index: number; message: string; date: number; selected: boolean; onSelect: () => void
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          onContextMenu={(e) => e.stopPropagation()}
          onClick={onSelect}
          onDoubleClick={() => pop(repoId, index)}
          data-testid="stash-item"
          title={`${message}\n${relativeTime(date)}\nClick to see its changes, double-click to pop`}
          className={clsx('flex h-6 items-center gap-1.5 pr-3 pl-8 text-[13px]', selected ? 'bg-select' : 'hover:bg-hover')}
        >
          <span className="min-w-0 flex-1 truncate">{stashLabel(message)}</span>
          <span className="text-[10px] text-faint">{relativeTime(date)}</span>
        </div>
      </ContextMenu.Trigger>
      <CM.Content>
        <CM.Item onSelect={() => pop(repoId, index)}>Pop (apply and delete)</CM.Item>
        <CM.Item onSelect={() => void stashApply(repoId, index)}>Apply</CM.Item>
        <CM.Item onSelect={() => stashToBranch(repoId, index)}>Create a branch from this stash…</CM.Item>
        <CM.Separator />
        <CM.Item danger onSelect={() => void stashDrop(repoId, index)}>Drop</CM.Item>
      </CM.Content>
    </ContextMenu.Root>
  )
}
