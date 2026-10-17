import type { SearchField } from '@gitsquid/shared'
import clsx from 'clsx'
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, ChevronUp, GitBranch, SquareTerminal, RefreshCw, Search, Settings, Undo2, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { fetchAll, newBranch, pop, pull, push, stash, undo } from '../lib/actions'
import { api } from '../lib/api'
import { ensureLoaded, onCommand, reportError, updateRepo, useStore, type RepoView } from '../lib/store'
import { modName } from '../lib/keys'
import { DM, Spinner, ToolbarButton } from './ui'

export function Toolbar({ view }: { view: RepoView }) {
  const id = view.id
  const snap = view.snapshot
  const head = snap.head.branch ? snap.refs.find((r) => r.name === `refs/heads/${snap.head.branch}`) : undefined
  const lastUndo = view.undo[0]
  return (
    <div className="drag flex h-14 shrink-0 items-center gap-1 border-b border-line bg-panel px-2" data-testid="toolbar">
      <ToolbarButton icon={<Undo2 size={17} />} label="Undo" disabled={!lastUndo || !!view.busy}
        title={lastUndo ? `Undo: ${lastUndo.label} (${modName()}+Z)` : 'Nothing to undo'} onClick={() => void undo(id)} />
      <span className="mx-1 h-8 w-px bg-line" />
      <DropdownMenu.Root>
        <div className="no-drag flex items-stretch">
          <ToolbarButton icon={<ArrowDown size={17} />} label="Pull" onClick={() => void pull(id)} disabled={!!view.busy}
            badge={(head?.behind ?? 0) > 0 ? <Badge>{head!.behind}</Badge> : null} />
          <DropdownMenu.Trigger className="rounded-md px-0.5 text-muted hover:bg-hover hover:text-fg"><ChevronDown size={12} /></DropdownMenu.Trigger>
        </div>
        <DM.Content>
          <DM.Item onSelect={() => void pull(id, 'merge')}>Pull (merge)</DM.Item>
          <DM.Item onSelect={() => void pull(id, 'rebase')}>Pull (rebase)</DM.Item>
          <DM.Item onSelect={() => void pull(id, 'ff-only')}>Pull (fast-forward only)</DM.Item>
          <DM.Item onSelect={() => void fetchAll(id)}>Fetch all</DM.Item>
        </DM.Content>
      </DropdownMenu.Root>
      <DropdownMenu.Root>
        <div className="no-drag flex items-stretch">
          <ToolbarButton icon={<ArrowUp size={17} />} label="Push" onClick={() => push(id)} disabled={!!view.busy || !snap.head.branch}
            badge={(head?.ahead ?? 0) > 0 ? <Badge>{head!.ahead}</Badge> : null} />
          <DropdownMenu.Trigger className="rounded-md px-0.5 text-muted hover:bg-hover hover:text-fg"><ChevronDown size={12} /></DropdownMenu.Trigger>
        </div>
        <DM.Content>
          <DM.Item onSelect={() => push(id)}>Push</DM.Item>
          <DM.Item onSelect={() => push(id, true)}>Force push (with lease)…</DM.Item>
        </DM.Content>
      </DropdownMenu.Root>
      <ToolbarButton icon={<RefreshCw size={17} className={clsx(view.busy === 'Fetch' && 'animate-spin')} />} label="Fetch" onClick={() => void fetchAll(id)} disabled={!!view.busy} />
      <span className="mx-1 h-8 w-px bg-line" />
      <ToolbarButton icon={<GitBranch size={17} />} label="Branch" onClick={() => newBranch(id)} disabled={!snap.head.hash} />
      <ToolbarButton icon={<Archive size={17} />} label="Stash" onClick={() => stash(id)} disabled={!!view.busy} />
      <ToolbarButton icon={<ArchiveRestore size={17} />} label="Pop" onClick={() => pop(id)} disabled={!view.stashes.length || !!view.busy} />
      <div className="flex-1" />
      {(view.busy || view.progress) && (
        <div className="no-drag flex max-w-72 items-center gap-2 truncate px-2 text-xs text-muted" data-testid="busy">
          <Spinner /> <span className="truncate">{view.progress ?? view.busy}</span>
        </div>
      )}
      <SearchBox view={view} />
      {/* Not the ⌘ glyph: that is a macOS key, and this button is the same on every platform. */}
      <ToolbarButton icon={<SquareTerminal size={17} />} label="Palette" onClick={() => useStore.setState({ palette: true })} title={`Command palette (${modName()}+K)`} />
      <ToolbarButton icon={<Settings size={17} />} label="Settings" onClick={() => useStore.setState({ page: 'settings' })} />
    </div>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="absolute -top-0.5 right-0.5 rounded-full bg-accent px-1 text-[9px] leading-[14px] font-bold text-accent-fg">{children}</span>
}

const FIELDS: { value: SearchField; label: string }[] = [
  { value: 'message', label: 'Message' },
  { value: 'author', label: 'Author' },
  { value: 'path', label: 'File path' },
  { value: 'content', label: 'Code (added/removed)' },
  { value: 'hash', label: 'SHA' },
]

function SearchBox({ view }: { view: RepoView }) {
  const [query, setQuery] = useState(view.search?.query ?? '')
  const [field, setField] = useState<SearchField>(view.search?.field ?? 'message')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const s = view.search

  useEffect(() => onCommand((name) => {
    if (name === 'search') input.current?.focus()
  }), [])

  const go = async (hash: string) => {
    updateRepo(view.id, { selected: { kind: 'commit', hash }, center: { kind: 'graph' } })
    await ensureLoaded(view.id, hash)
  }

  const submit = async () => {
    if (!query.trim()) {
      updateRepo(view.id, { search: null })
      return
    }
    setBusy(true)
    try {
      const hits = await api.search(view.id, field, query)
      updateRepo(view.id, { search: { field, query, hits, index: 0 } })
      if (hits[0]) await go(hits[0])
    } catch (e) {
      reportError('Search failed', e)
    } finally {
      setBusy(false)
    }
  }

  const step = (d: number) => {
    if (!s || !s.hits.length) return
    const index = (s.index + d + s.hits.length) % s.hits.length
    updateRepo(view.id, { search: { ...s, index } })
    void go(s.hits[index]!)
  }

  const clear = () => {
    setQuery('')
    updateRepo(view.id, { search: null })
  }

  return (
    <div className="no-drag mx-2 flex h-8 items-center rounded-md border border-line bg-bg text-xs focus-within:border-accent">
      <select value={field} onChange={(e) => setField(e.target.value as SearchField)} title="Search in"
        className="h-full rounded-l-md border-r border-line bg-transparent px-1 text-muted outline-none">
        {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>
      <Search size={13} className="ml-2 shrink-0 text-faint" />
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (s && s.query === query && s.field === field) step(e.shiftKey ? -1 : 1)
            else void submit()
          } else if (e.key === 'Escape') {
            clear()
            input.current?.blur()
          }
        }}
        placeholder="Find commits"
        data-testid="search-input"
        className="h-full w-44 bg-transparent px-2 outline-none"
      />
      {busy && <Spinner className="mr-2 text-faint" />}
      {s && !busy && (
        <>
          <span className="px-1 whitespace-nowrap text-faint" data-testid="search-count">{s.hits.length ? `${s.index + 1} of ${s.hits.length}` : 'No matches'}</span>
          <button onClick={() => step(-1)} className="px-0.5 text-muted hover:text-fg" title="Previous (Shift+Enter)"><ChevronUp size={13} /></button>
          <button onClick={() => step(1)} className="px-0.5 text-muted hover:text-fg" title="Next (Enter)"><ChevronDown size={13} /></button>
          <button onClick={clear} className="px-1 text-muted hover:text-fg" title="Clear (Esc)"><X size={13} /></button>
        </>
      )}
    </div>
  )
}
