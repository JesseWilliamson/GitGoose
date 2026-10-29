import clsx from 'clsx'
import { Archive, ArrowDown, ArrowUp, ChevronDown, ChevronRight, GitBranch, RefreshCw, Redo2, Search, Settings, Undo2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { fetchAll, newBranch, pull, push, redo, stash, undo } from '../lib/actions'
import { runCommand, useSetting, useStore, type RepoView } from '../lib/store'
import { hasConflicts, readSelection, SCENE_TITLES, SCENES, setScene } from '../lib/scenes'
import { modName, shortcutOf } from '../lib/keys'
import { Input } from '@/components/ui/input'
import { DM, Kbd, Spinner, ToolbarButton } from './ui'
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
              count={head?.behind} />
            <DropdownMenu.Trigger className="-ml-1 h-row-lg rounded-md px-0.5 text-hint hover:bg-accent hover:text-foreground" aria-label="Pull options"><ChevronDown size={12} /></DropdownMenu.Trigger>
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
              count={head?.ahead} />
            <DropdownMenu.Trigger className="-ml-1 h-row-lg rounded-md px-0.5 text-hint hover:bg-accent hover:text-foreground" aria-label="Push options"><ChevronDown size={12} /></DropdownMenu.Trigger>
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

      <SceneTabs view={view} />

      <div className="flex min-w-0 items-center justify-end gap-0.5">
      {/* A real input (shadcn's) with a search icon and the shortcut, 20 rem wide. It is read-only: clicking it,
          or pressing Enter on it, opens the search (a dialog with its own field), so it never holds text.
          The shortcut is spelled out per platform (not the cmd glyph everywhere). */}
      <div className="no-drag relative mx-2 w-36 min-w-0 shrink xl:w-56">
        <Search size={16} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-hint" />
        <Input readOnly value="" placeholder="Search…" aria-label="Search" title={`Search everything (${shortcutOf('search', keys)}); commands only: ${shortcutOf('palette', keys)}`} aria-keyshortcuts={shortcutOf('search', keys)} data-testid="omni-open"
          onClick={() => runCommand('search')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runCommand('search') } }}
          className="h-row-lg cursor-pointer bg-background pr-16 pl-8 text-xs shadow-none placeholder:text-hint md:text-xs dark:bg-background" />
        <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2"><Kbd>{shortcutOf('search', keys)}</Kbd></span>
      </div>

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
      <ToolbarButton icon={<Undo2 size={16} />} label="Undo" onClick={() => void undo(view.id)} disabled={!last || !!view.busy}
        title={last ? `Undo: ${last.label} (${modName()}+Z)` : 'Nothing to undo'} className="min-w-0 px-2">
        <span className="shrink-0 font-medium">Undo</span>
        {/* The operation in words where there is room; below 1280 px it is in the tooltip. */}
        {last && <span className="hidden min-w-0 truncate text-hint xl:inline" data-testid="undo-label">{last.label}</span>}
      </ToolbarButton>
      <ToolbarButton icon={<Redo2 size={16} />} label="Redo" onClick={() => void redo(view.id)} disabled={!next || !!view.busy}
        title={next ? `Redo: ${next.label} (${shortcutOf('redo')})` : 'Nothing to redo'} />
    </div>
  )
}

/**
 * The scenes (ADR-012), in the middle of the title bar: Browse, Read, Changes with its count, and
 * Resolve only while an operation is stopped on conflicts. Keys 1–4; each scene keeps its place.
 */
function SceneTabs({ view }: { view: RepoView }) {
  const conflicts = hasConflicts(view)
  const scenes = SCENES.filter((s) => s !== 'resolve' || conflicts || view.scene === 'resolve')
  const count = view.snapshot.status.length
  return (
    <div className="no-drag flex items-center gap-0.5 rounded-md bg-background p-0.5" role="tablist" data-testid="scene-tabs">
      {scenes.map((s) => {
        const on = view.scene === s
        return (
          <button key={s} role="tab" aria-selected={on} data-testid={`scene-tab-${s}`} title={`${SCENE_TITLES[s]} (${SCENES.indexOf(s) + 1})`}
            onClick={() => (s === 'read' && !on ? readSelection(view.id) : setScene(view.id, s))}
            className={clsx('flex h-6 items-center gap-1.5 rounded px-2.5 text-xs', on ? 'bg-card font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              s === 'resolve' && 'text-warn')}>
            {SCENE_TITLES[s]}
            {s === 'changes' && count > 0 && <span className="rounded bg-popover px-1 text-2xs tabular-nums text-muted-foreground">{count}</span>}
          </button>
        )
      })}
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
