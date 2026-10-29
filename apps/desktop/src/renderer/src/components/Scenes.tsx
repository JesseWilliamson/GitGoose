import clsx from 'clsx'
import { Bot, Check, GitCommitVertical, ListTree, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { revertLinesFromCommit } from '../lib/actions'
import { readBlocks, saveAnchor, setFace, setLens, setScene, setViewed, toggleFolded, workingBlocks, type Face } from '../lib/scenes'
import { getLog, selectCommit, updateRepo, useStore, type RepoView } from '../lib/store'
import { viewedKey } from '../lib/stream'
import { useStreamBlocks, type BlockSpec } from '../lib/useStream'
import { splitPath } from '../lib/format'
import { AiChatPanel } from './AiChatPanel'
import { ConflictWizard } from './ConflictWizard'
import { WorkingCopyPanel } from './DetailPanel'
import { DiffStream, type StreamHandle } from './DiffStream'
import { BlamePane, HistoryPane } from './DiffView'
import { Graph } from './Graph'

/**
 * The reading scenes (ADR-012): a left column of context, 320 px, and the reader taking the rest
 * of the window. The column changes face (what is around the commit, or the AI conversation);
 * it never changes width, so the diff never moves. `\` folds it to a rail for an even wider reader.
 */

const isTyping = () => {
  const el = document.activeElement
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement | null)?.isContentEditable === true
}

/** Keys of the reading scenes, while nothing else has the keyboard (a text field, a dialog, the search). */
function useReaderKeys(view: RepoView, handle: React.RefObject<StreamHandle | null>, opts: { onJ?: (step: 1 | -1) => void; onEsc?: () => boolean; onLens?: (mode: 'blame' | 'history', path: string) => void }) {
  const latest = useRef({ view, opts })
  latest.current = { view, opts }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping()) return
      const s = useStore.getState()
      if (s.dialog || s.omni || s.page || s.active !== latest.current.view.id) return
      const h = handle.current
      const { view: v, opts: o } = latest.current
      if (!h) {
        // No stream on screen (a lens has the reader): only Esc applies.
        if (e.key === 'Escape') {
          e.preventDefault()
          if (!o.onEsc?.()) setScene(v.id, 'browse')
        }
        return
      }
      const key = e.key
      const step = (d: 1 | -1) => {
        e.preventDefault()
        return d
      }
      if (key === 'n') h.file(step(1))
      else if (key === 'p') h.file(step(-1))
      else if (key === 'j' || key === 'J') {
        step(1)
        if (!h.block(1)) o.onJ?.(1)
      } else if (key === 'k' || key === 'K') {
        step(-1)
        if (!h.block(-1)) o.onJ?.(-1)
      } else if (key === ' ') {
        e.preventDefault()
        // At the end of the stream Space goes on to the next commit, as J does.
        if (!h.page(e.shiftKey ? -1 : 1) && !e.shiftKey) o.onJ?.(1)
      } else if ((key === 'y' || key === 'h') && o.onLens) {
        const cur = h.current()
        if (cur?.file) {
          e.preventDefault()
          o.onLens(key === 'y' ? 'blame' : 'history', cur.file.path)
        }
      } else if (key === 'v') {
        e.preventDefault()
        h.toggleViewed()
      } else if (key === '\\') {
        e.preventDefault()
        toggleFolded(v.id)
      } else if (key === 'R' && e.shiftKey) {
        const sel = h.selection()
        if (sel && sel.target.kind === 'commit') {
          e.preventDefault()
          h.clearSelection()
          void revertLinesFromCommit(v.id, sel.target, sel.diff, sel.hunks)
        }
      } else if (key === 'Escape') {
        if (h.selection()) {
          e.preventDefault()
          h.clearSelection()
        } else if (!o.onEsc?.()) {
          e.preventDefault()
          setScene(v.id, 'browse')
        } else e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handle])
}

/** A stream of blocks with its place remembered per set of blocks, and jumps from file lists. */
function SceneStream({ view, specs, handle, endCard, onCurrent }: {
  view: RepoView; specs: BlockSpec[]; handle: React.RefObject<StreamHandle | null>; endCard?: React.ReactNode
  onCurrent?: (c: { block: number; path: string | null }) => void
}) {
  const { blocks, loadBlock, loadFiles } = useStreamBlocks(view, specs)
  const streamKey = specs.map((s) => s.key).join('|')
  const onAnchor = useCallback((a: { key: string; offset: number }) => saveAnchor(view.id, streamKey, a), [view.id, streamKey])
  const onViewed = useCallback((k: string, v: boolean) => setViewed(view.id, k, v), [view.id])
  // A file clicked in a list (the left column, Details): scroll to it once it is loaded.
  const jump = view.jump
  useEffect(() => {
    if (!jump) return
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i]!.files?.some((f) => f.path === jump.path)) {
        handle.current?.showFile(i, jump.path)
        updateRepo(view.id, { jump: null })
        return
      }
    }
  }, [jump, blocks, handle, view.id])
  return (
    <DiffStream key={streamKey} ref={handle} view={view} blocks={blocks} loadBlock={loadBlock} loadFiles={loadFiles}
      viewed={view.viewed} onViewed={onViewed} initialAnchor={view.read.anchors[streamKey] ?? null} onAnchor={onAnchor} endCard={endCard} onCurrent={onCurrent} />
  )
}

/** The left column: its face tabs, the face, and the fold. */
function LeftColumn({ view, faces, face, onFace, children }: {
  view: RepoView; faces: { id: string; label: string; icon: React.ReactNode }[]; face: string; onFace: (f: string) => void; children: React.ReactNode
}) {
  if (view.folded) {
    return (
      <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2" data-testid="left-rail">
        <button className="rounded p-1.5 text-hint hover:bg-accent hover:text-foreground" title="Show the column (\)" onClick={() => toggleFolded(view.id)}><PanelLeftOpen size={16} /></button>
        {faces.map((f) => (
          <button key={f.id} className={clsx('rounded p-1.5 hover:bg-accent', f.id === face ? 'text-foreground' : 'text-hint')} title={f.label}
            onClick={() => { onFace(f.id); toggleFolded(view.id) }}>{f.icon}</button>
        ))}
      </div>
    )
  }
  return (
    <div className="flex w-80 shrink-0 flex-col border-r border-border bg-card" data-testid="left-column" data-face={face}>
      <div className="flex h-strip shrink-0 items-stretch border-b border-border">
        {faces.map((f) => (
          <button key={f.id} onClick={() => onFace(f.id)} data-testid={`face-${f.id}`} aria-pressed={f.id === face}
            className={clsx('flex items-center gap-1.5 border-b-2 px-3 text-xs', f.id === face ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {f.icon}{f.label}
          </button>
        ))}
        <button className="ml-auto px-2 text-hint hover:text-foreground" title="Fold the column (\)" onClick={() => toggleFolded(view.id)}><PanelLeftClose size={14} /></button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}

/** The files of the block the reader is in, with their viewed marks: click to scroll there. */
function FilesNow({ view, handle, current }: { view: RepoView; handle: React.RefObject<StreamHandle | null>; current: { block: number; path: string | null } | null }) {
  const [, force] = useState(0)
  // The handle's blocks are read on render; the reader tells us when its current file changes.
  useEffect(() => force((n) => n + 1), [current])
  const h = handle.current
  const block = h?.blockFiles() ?? null
  if (!block?.length) return null
  const viewedCount = block.filter((f) => view.viewed.has(viewedKey(f))).length
  return (
    <div className="flex max-h-[45%] min-h-0 shrink-0 flex-col border-t border-border" data-testid="files-now">
      <div className="flex h-7 shrink-0 items-center justify-between px-3 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
        <span>Files {block.length}</span><span className="font-normal normal-case">{viewedCount} of {block.length} viewed</span>
      </div>
      <div className="min-h-0 overflow-y-auto pb-1">
        {block.map((f) => {
          const { dir, name } = splitPath(f.path)
          const isNow = f.path === current?.path
          return (
            <button key={f.path} data-testid="files-now-row" data-path={f.path} onClick={() => current && h?.showFile(current.block, f.path)}
              className={clsx('flex h-6 w-full items-center gap-2 px-3 text-left text-xs', isNow ? 'bg-select' : 'hover:bg-accent')}>
              <span className="w-3 shrink-0 text-add">{view.viewed.has(viewedKey(f)) ? <Check size={12} /> : null}</span>
              <span className="min-w-0 flex-1 truncate">{name}<span className="ml-1.5 text-hint">{dir}</span></span>
              <span className="shrink-0 font-mono text-2xs"><span className="text-add">+{f.additions}</span> <span className="text-destructive">−{f.deletions}</span></span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Read: the selection (or a branch under review) in the reader, the narrow graph and its files beside it. */
export function ReadScene({ view }: { view: RepoView }) {
  const handle = useRef<StreamHandle>(null)
  const specs = useMemo(() => readBlocks(view), [view.read.range, view.selected, view.snapshot.status, view.logVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const [current, setCurrent] = useState<{ block: number; path: string | null } | null>(null)
  const face = view.read.face
  // J / K past either end of the stream: the next commit in the graph (when reading the selection).
  const onJ = (step: 1 | -1) => {
    if (view.read.range || view.selected.kind !== 'commit') return
    const log = getLog(view.id)
    const i = log.index.get(view.selected.hash)
    const next = i === undefined ? undefined : log.commits[i + step]
    if (next) selectCommit(view.id, next.hash)
  }
  const onEsc = () => {
    if (view.read.lens) {
      setLens(view.id, null)
      return true
    }
    if (face !== 'around') {
      setFace(view.id, 'around')
      return true
    }
    if (view.read.range) {
      updateRepo(view.id, { read: { ...view.read, range: null } })
      return false
    }
    return false
  }
  const onLens = (mode: 'blame' | 'history', path: string) => {
    const cur = handle.current?.current()
    const block = cur ? specs[cur.block] : undefined
    setLens(view.id, { mode, path, rev: block?.target.kind === 'commit' ? block.target.hash : undefined })
  }
  useReaderKeys(view, handle, { onJ, onEsc, onLens })
  const label = view.read.range ? `Reviewing ${view.read.range.label}: ${view.read.range.hashes.length} commits, oldest first` : null
  return (
    <div className="flex min-h-0 flex-1" data-testid="scene-read">
      <LeftColumn view={view} face={face} onFace={(f) => setFace(view.id, f as Face)}
        faces={[{ id: 'around', label: 'Around', icon: <ListTree size={13} /> }, { id: 'ai', label: 'AI', icon: <Bot size={13} /> }]}>
        {face === 'ai' ? <AiChatPanel view={view} /> : (
          <>
            {label && <div className="shrink-0 border-b border-border bg-primary/10 px-3 py-1.5 text-xs" data-testid="review-range">{label}</div>}
            <div className="flex min-h-0 flex-1 flex-col"><Graph view={view} narrow /></div>
            <FilesNow view={view} handle={handle} current={current} />
          </>
        )}
      </LeftColumn>
      <div className="flex min-w-0 flex-1 flex-col">
        {view.read.lens ? <Lens view={view} lens={view.read.lens} />
          : <SceneStream view={view} specs={specs} handle={handle} endCard={<EndCard view={view} />} onCurrent={setCurrent} />}
      </div>
    </div>
  )
}

/**
 * A file's blame or history in place of the stream. Picking a commit there reads it: the lens
 * closes and the stream shows that commit, with the file it came from.
 */
function Lens({ view, lens }: { view: RepoView; lens: NonNullable<RepoView['read']['lens']> }) {
  // A commit picked in the blame or the history changes the selection: read it.
  const picked = useRef(view.selected)
  useEffect(() => {
    if (view.selected !== picked.current) {
      setLens(view.id, null)
      updateRepo(view.id, { jump: { path: lens.path, nonce: Date.now() } })
    }
  }, [view.selected, view.id, lens.path])
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid={`lens-${lens.mode}`}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-sm">
        <button className="rounded px-1.5 text-xs text-muted-foreground hover:bg-accent" onClick={() => setLens(view.id, null)}>‹ Diff <kbd className="ml-1 text-2xs">Esc</kbd></button>
        <span className="font-semibold">{lens.mode === 'blame' ? 'Blame' : 'History'}</span>
        <span className="min-w-0 truncate text-muted-foreground">{lens.path}{lens.rev ? ` at ${lens.rev.slice(0, 7)}` : ''}</span>
        <span className="ml-auto text-2xs text-hint">{lens.mode === 'blame' ? 'Click a commit to read the change that wrote those lines' : 'Click a commit to read it'}</span>
      </div>
      {lens.mode === 'blame' ? <BlamePane view={view} path={lens.path} rev={lens.rev} /> : <HistoryPane view={view} path={lens.path} />}
    </div>
  )
}

function EndCard({ view }: { view: RepoView }) {
  return (
    <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
      <span>End of the {view.read.range ? 'review' : 'commit'}</span>
      <span className="text-hint"><kbd>J</kbd> next commit · <kbd>Esc</kbd> back to Browse</span>
    </div>
  )
}

/** Changes: the working copy's lists and the commit box on the left, every changed file in the reader. */
export function ChangesScene({ view }: { view: RepoView }) {
  const handle = useRef<StreamHandle>(null)
  const specs = useMemo(() => workingBlocks(view), [view.snapshot.status]) // eslint-disable-line react-hooks/exhaustive-deps
  const face = view.read.face
  useReaderKeys(view, handle, { onEsc: () => {
    if (face !== 'around') {
      setFace(view.id, 'around')
      return true
    }
    return false
  } })
  return (
    <div className="flex min-h-0 flex-1" data-testid="scene-changes">
      <LeftColumn view={view} face={face} onFace={(f) => setFace(view.id, f as Face)}
        faces={[{ id: 'around', label: 'Changes', icon: <GitCommitVertical size={13} /> }, { id: 'ai', label: 'AI', icon: <Bot size={13} /> }]}>
        {face === 'ai' ? <AiChatPanel view={view} /> : <WorkingCopyPanel view={view} />}
      </LeftColumn>
      <div className="flex min-w-0 flex-1 flex-col">
        {view.snapshot.status.length ? <SceneStream view={view} specs={specs} handle={handle} />
          : <div className="flex flex-1 items-center justify-center text-sm text-hint" data-testid="changes-clean">Nothing to commit: the working copy is clean.</div>}
      </div>
    </div>
  )
}

/** Resolve: the conflict wizard, with the history (or the AI) in the left column. */
export function ResolveScene({ view }: { view: RepoView }) {
  const face = view.read.face
  return (
    <div className="flex min-h-0 flex-1" data-testid="scene-resolve">
      <LeftColumn view={view} face={face} onFace={(f) => setFace(view.id, f as Face)}
        faces={[{ id: 'around', label: 'History', icon: <ListTree size={13} /> }, { id: 'ai', label: 'AI', icon: <Bot size={13} /> }]}>
        {face === 'ai' ? <AiChatPanel view={view} /> : <div className="flex min-h-0 flex-1 flex-col"><Graph view={view} narrow /></div>}
      </LeftColumn>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConflictWizard view={view} />
      </div>
    </div>
  )
}
