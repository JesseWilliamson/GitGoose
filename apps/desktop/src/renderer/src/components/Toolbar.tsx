import clsx from 'clsx'
import { Archive, ArrowDown, ArrowUp, ChevronDown, ChevronRight, GitBranch, RefreshCw, Redo2, Search, Settings, Undo2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { fetchAll, newBranch, pull, push, redo, stash, undo } from '../lib/actions'
import { runCommand, useSetting, useStore, type RepoView } from '../lib/store'
import { modName, shortcutOf } from '../lib/keys'
import { DM, Spinner, ToolbarButton } from './ui'
import { whyNotFetchAll, whyNotForcePush, whyNotPull, whyNotPush } from '../lib/menuRules'

/**
 * One slim row. Three columns: where you are and what you can do on the left, search in the
 * middle, what just happened on the right. The sides are fixed-width icons so nothing shifts as
 * state changes; the only variable-width item, the undo chip, lives on the right where it grows
 * into the free space instead of pushing the buttons around.
 */
export function Toolbar({ view }: { view: RepoView }) {
  const id = view.id
  const snap = view.snapshot
  const head = snap.head.branch ? snap.refs.find((r) => r.name === `refs/heads/${snap.head.branch}`) : undefined
  const keys = useStore.getState().settings?.keybindings
  const pullMode = useSetting('pullMode')
  const pullWhy = whyNotPull(snap, head)
  return (
    <div className="drag grid h-toolbar shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-border bg-card px-2" data-testid="toolbar">
      <div className="flex min-w-0 items-center gap-0.5">
        <Location view={view} />
        <Divider />
        <DropdownMenu.Root>
          <div className="no-drag flex items-stretch">
            <ToolbarButton icon={<ArrowDown size={16} />} label="Pull" title={`Pull (${pullMode === 'ff-only' ? 'fast-forward only' : pullMode})`} onClick={() => void pull(id)} disabled={!!view.busy}
              badge={(head?.behind ?? 0) > 0 ? <Badge>{head!.behind}</Badge> : null} />
            <DropdownMenu.Trigger className="-ml-1 rounded-md px-0.5 text-hint hover:bg-accent hover:text-foreground" aria-label="Pull options"><ChevronDown size={11} /></DropdownMenu.Trigger>
          </div>
          <DM.Content>
            <DM.Item reason={pullWhy} onSelect={() => void pull(id, 'merge')}>Pull (merge)</DM.Item>
            <DM.Item reason={pullWhy} onSelect={() => void pull(id, 'rebase')}>Pull (rebase)</DM.Item>
            <DM.Item reason={pullWhy} onSelect={() => void pull(id, 'ff-only')}>Pull (fast-forward only)</DM.Item>
            <DM.Item reason={whyNotFetchAll(view)} onSelect={() => void fetchAll(id)}>Fetch all</DM.Item>
          </DM.Content>
        </DropdownMenu.Root>
        <DropdownMenu.Root>
          <div className="no-drag flex items-stretch">
            <ToolbarButton icon={<ArrowUp size={16} />} label="Push" onClick={() => push(id)} disabled={!!view.busy || !snap.head.branch}
              badge={(head?.ahead ?? 0) > 0 ? <Badge>{head!.ahead}</Badge> : null} />
            <DropdownMenu.Trigger className="-ml-1 rounded-md px-0.5 text-hint hover:bg-accent hover:text-foreground" aria-label="Push options"><ChevronDown size={11} /></DropdownMenu.Trigger>
          </div>
          <DM.Content>
            <DM.Item reason={whyNotPush(head)} onSelect={() => push(id)}>Push</DM.Item>
            <DM.Item reason={whyNotForcePush(head)} onSelect={() => push(id, true)}>Force push (with lease)…</DM.Item>
          </DM.Content>
        </DropdownMenu.Root>
        <ToolbarButton icon={<RefreshCw size={16} className={clsx(view.busy === 'Fetch' && 'animate-spin')} />} label="Fetch" title="Fetch all remotes" onClick={() => void fetchAll(id)} disabled={!!view.busy} />
        <Divider />
        <ToolbarButton icon={<GitBranch size={16} />} label="Branch" title="New branch…" onClick={() => newBranch(id)} disabled={!snap.head.hash} />
        <ToolbarButton icon={<Archive size={16} />} label="Stash" title="Stash changes" onClick={() => stash(id)} disabled={!!view.busy} />
      </div>

      {/* Like VS Code's command centre: a box that looks like a search field, with its shortcut.
          The shortcut is spelled out per platform (not the ⌘ glyph everywhere). */}
      <button onClick={() => runCommand('search')} data-testid="omni-open"
        title={`Search everything (${shortcutOf('search', keys)}); commands only: ${shortcutOf('palette', keys)}`}
        className="no-drag mx-3 flex h-7 w-[26rem] min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-xs text-hint hover:border-primary/60 hover:text-muted-foreground">
        <Search size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Search…</span>
        <kbd className="shrink-0 rounded border border-border px-1 text-2xs">{shortcutOf('search', keys)}</kbd>
      </button>

      <div className="flex min-w-0 items-center justify-end gap-0.5">
        {(view.busy || view.progress) && (
          <div className="no-drag flex min-w-0 max-w-64 items-center gap-2 truncate px-2 text-xs text-muted-foreground" data-testid="busy">
            <Spinner /> <span className="truncate">{view.progress ?? view.busy}</span>
          </div>
        )}
        <UndoChip view={view} />
        <Divider />
        <ToolbarButton icon={<Settings size={16} />} label="Settings" onClick={() => useStore.setState({ page: 'settings' })} />
      </div>
    </div>
  )
}

/**
 * The last undoable operation, in words, with the button to undo it: "Undo  Reset (hard) to
 * 1a2b3c4". Undo is the thing this app has that most git clients do not, so it is shown rather
 * than hidden behind an icon. The accessible name stays exactly "Undo" (the operation is in the
 * tooltip) so the button is found by that name whatever it currently names.
 */
function UndoChip({ view }: { view: RepoView }) {
  const last = view.undo[0]
  const next = view.redo[0]
  return (
    <div className="no-drag flex min-w-0 items-center" data-testid="undo-chip">
      <button onClick={() => void undo(view.id)} disabled={!last || !!view.busy} aria-label="Undo"
        title={last ? `Undo: ${last.label} (${modName()}+Z)` : 'Nothing to undo'}
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:pointer-events-none">
        <Undo2 size={15} className="shrink-0" />
        <span className="shrink-0 font-medium">Undo</span>
        {last && <span className="min-w-0 truncate text-hint" data-testid="undo-label">{last.label}</span>}
      </button>
      <ToolbarButton icon={<Redo2 size={15} />} label="Redo" onClick={() => void redo(view.id)} disabled={!next || !!view.busy}
        title={next ? `Redo: ${next.label} (${shortcutOf('redo')})` : 'Nothing to redo'} className="size-7" />
    </div>
  )
}

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-border" />
}

/**
 * Where you are: the repository, then what HEAD is on. That is the branch name, or the short
 * commit hash when HEAD is detached (a checked-out tag or commit, mid-rebase).
 */
function Location({ view }: { view: RepoView }) {
  const { name, path, head } = view.snapshot
  const value = head.branch ?? (head.hash ? head.hash.slice(0, 7) : 'no commits')
  return (
    <div className="flex min-w-0 shrink items-center gap-1 px-1 text-sm" data-testid="location">
      <span className="max-w-40 truncate text-muted-foreground" title={path} data-testid="location-repo">{name}</span>
      <ChevronRight size={14} className="shrink-0 text-hint" />
      <span className={clsx('max-w-48 truncate font-semibold text-foreground', !head.branch && !!head.hash && 'font-mono')} title={head.hash} data-testid="location-head">{value}</span>
    </div>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="absolute -top-0.5 right-0 rounded-full bg-primary px-1 text-2xs leading-[14px] font-bold text-primary-foreground">{children}</span>
}
