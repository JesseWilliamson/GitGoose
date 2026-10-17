import type { Ref } from '@gitsquid/shared'
import clsx from 'clsx'
import { Archive, ChevronDown, ChevronRight, Cloud, GitBranch, Tag } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useMemo, useState, type ReactNode } from 'react'
import { checkout, pop, stashApply, stashDrop } from '../lib/actions'
import { relativeTime } from '../lib/format'
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
    const m = new Map<string, Ref[]>()
    for (const r of snap.refs) {
      if (r.kind !== 'remote' || !match(r)) continue
      const remote = r.shortName.split('/')[0]!
      m.set(remote, [...(m.get(remote) ?? []), r])
    }
    return m
  }, [snap.refs, f])

  const jump = async (hash: string) => {
    updateRepo(view.id, { selected: { kind: 'commit', hash }, center: { kind: 'graph' } })
    await ensureLoaded(view.id, hash)
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
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
            <Section title="Local" count={locals.length} icon={<GitBranch size={13} />}>
              {locals.map((r) => (
                <RefItem key={r.name} r={r} label={r.shortName} view={view} onJump={jump} head={r.shortName === snap.head.branch}>
                  {(r.ahead ?? 0) > 0 && <span className="text-[10px] text-add">↑{r.ahead}</span>}
                  {(r.behind ?? 0) > 0 && <span className="text-[10px] text-warn">↓{r.behind}</span>}
                  {r.upstreamGone && <span className="text-[10px] text-faint" title="Upstream deleted">gone</span>}
                </RefItem>
              ))}
            </Section>
            {[...remotes.entries()].map(([remote, refs]) => (
              <Section key={remote} title={remote} count={refs.length} icon={<Cloud size={13} />} defaultOpen={false}>
                {refs.map((r) => (
                  <RefItem key={r.name} r={r} label={r.shortName.slice(remote.length + 1)} view={view} onJump={jump} />
                ))}
              </Section>
            ))}
            {remotes.size === 0 && !f && <Section title="Remotes" count={0} icon={<Cloud size={13} />}><Empty>No remotes</Empty></Section>}
            <Section title="Tags" count={tags.length} icon={<Tag size={13} />} defaultOpen={false}>
              {tags.map((r) => <RefItem key={r.name} r={r} label={r.shortName} view={view} onJump={jump} />)}
            </Section>
            <Section title="Stashes" count={view.stashes.length} icon={<Archive size={13} />}>
              {view.stashes.map((s) => (
                <StashItem key={s.ref} repoId={view.id} index={s.index} message={s.message} date={s.date} />
              ))}
              {view.stashes.length === 0 && <Empty>No stashes</Empty>}
            </Section>
          </div>
        </ContextMenu.Trigger>
        <GraphMenu repoId={view.id} />
      </ContextMenu.Root>
    </aside>
  )
}

function Section({ title, count, icon, children, defaultOpen = true }: {
  title: string; count: number; icon: ReactNode; children: ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mt-1">
      <button onClick={() => setOpen(!open)} className="flex h-7 w-full items-center gap-1.5 px-2 text-[12px] font-semibold text-muted hover:text-fg">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {icon}
        <span className="flex-1 truncate text-left">{title}</span>
        <span className="text-[11px] font-normal text-faint">{count}</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-8 py-1 text-xs text-faint">{children}</div>
}

function RefItem({ r, label, view, onJump, head, children }: {
  r: Ref; label: string; view: RepoView; onJump: (hash: string) => void; head?: boolean; children?: ReactNode
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
      className={clsx('flex h-6 cursor-default items-center gap-1.5 pr-3 pl-8 text-[13px]', selected ? 'bg-select' : 'hover:bg-hover', head && 'font-semibold')}
    >
      {head && <span className="-ml-4 w-3 text-[10px] text-accent">✓</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
    </div>
  )
}

function StashItem({ repoId, index, message, date }: { repoId: string; index: number; message: string; date: number }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          onContextMenu={(e) => e.stopPropagation()}
          onDoubleClick={() => pop(repoId, index)}
          title={`${message}\n${relativeTime(date)}\nDouble-click to pop`}
          className="flex h-6 items-center gap-1.5 pr-3 pl-8 text-[13px] hover:bg-hover"
        >
          <span className="min-w-0 flex-1 truncate">{message.replace(/^On [^:]+: /, '')}</span>
          <span className="text-[10px] text-faint">{relativeTime(date)}</span>
        </div>
      </ContextMenu.Trigger>
      <CM.Content>
        <CM.Item onSelect={() => pop(repoId, index)}>Pop (apply and delete)</CM.Item>
        <CM.Item onSelect={() => void stashApply(repoId, index)}>Apply</CM.Item>
        <CM.Separator />
        <CM.Item danger onSelect={() => void stashDrop(repoId, index)}>Drop</CM.Item>
      </CM.Content>
    </ContextMenu.Root>
  )
}
