import clsx from 'clsx'
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, GitBranch, SquareTerminal, RefreshCw, Search, Settings, Undo2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { fetchAll, newBranch, pop, pull, push, stash, undo } from '../lib/actions'
import { runCommand, useStore, type RepoView } from '../lib/store'
import { modName, shortcutOf } from '../lib/keys'
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
      <ToolbarButton icon={<Search size={17} />} label="Search" onClick={() => runCommand('search')} title={`Search commits (${shortcutOf('search', useStore.getState().settings?.keybindings)})`} />
      {/* Not the ⌘ glyph: that is a macOS key, and this button is the same on every platform. */}
      <ToolbarButton icon={<SquareTerminal size={17} />} label="Palette" onClick={() => useStore.setState({ palette: true })} title={`Command palette (${shortcutOf('palette', useStore.getState().settings?.keybindings)})`} />
      <ToolbarButton icon={<Settings size={17} />} label="Settings" onClick={() => useStore.setState({ page: 'settings' })} />
    </div>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="absolute -top-0.5 right-0.5 rounded-full bg-accent px-1 text-[9px] leading-[14px] font-bold text-accent-fg">{children}</span>
}
