import clsx from 'clsx'
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, GitBranch, RefreshCw, Redo2, Search, Settings, Undo2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { fetchAll, newBranch, pop, pull, push, redo, stash, undo } from '../lib/actions'
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
      <ToolbarButton icon={<Redo2 size={17} />} label="Redo" disabled={!view.redo[0] || !!view.busy}
        title={view.redo[0] ? `Redo: ${view.redo[0].label} (${shortcutOf('redo')})` : 'Nothing to redo'} onClick={() => void redo(id)} />
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
      {/* Like the Next.js docs: a box that looks like a search field, with its shortcut. The
          shortcut is spelled out per platform (not the ⌘ glyph everywhere). */}
      <button onClick={() => runCommand('search')} data-testid="omni-open"
        title={`Search everything (${shortcutOf('search', useStore.getState().settings?.keybindings)}); commands only: ${shortcutOf('palette', useStore.getState().settings?.keybindings)}`}
        className="no-drag mx-2 flex h-8 w-56 shrink items-center gap-2 rounded-lg border border-line bg-bg px-2.5 text-[13px] text-faint hover:border-accent/60 hover:text-muted">
        <Search size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Search…</span>
        <kbd className="shrink-0 rounded border border-line px-1 text-[10px]">{shortcutOf('search', useStore.getState().settings?.keybindings)}</kbd>
      </button>
      <ToolbarButton icon={<Settings size={17} />} label="Settings" onClick={() => useStore.setState({ page: 'settings' })} />
    </div>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="absolute -top-0.5 right-0.5 rounded-full bg-accent px-1 text-[9px] leading-[14px] font-bold text-accent-fg">{children}</span>
}
