import type { Row } from '@gitsquid/graph'
import { DEFAULT_GRAPH_COLUMNS, GRAPH_COLUMNS, type Commit, type GraphColumns, type Ref } from '@gitsquid/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { Cloud, Laptop, Settings2, Tag } from 'lucide-react'
import { ContextMenu, DropdownMenu } from 'radix-ui'
import { memo, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { AvatarSource } from '@gitsquid/shared'
import { checkout } from '../lib/actions'
import { avatarSrc, useAvatarVariant } from '../lib/avatar'
import { formatDate, laneColor, shortHash } from '../lib/format'
import { getLog, loadMore, saveSettings, updateRepo, useSetting, useStore, type RepoView } from '../lib/store'
import { GraphCell, LANE_W, ROW_H, ROW_H_COMPACT, WipCell } from './GraphCell'
import { GraphMenu } from './menus'
import { DM, Spinner } from './ui'

const REFS_W = 160
const AUTHOR_W = 140
const DATE_W: Record<string, number> = { relative: 100, absolute: 110, both: 200 }
const SHA_W = 68
/** Automatic width shows at most this many lanes; wider histories are clipped until the user widens the column. */
const AUTO_LANES = 8
const MIN_GRAPH_W = 64
const MAX_GRAPH_W = 800
export const REF_MIME = 'application/x-gitsquid-ref'
const COL_AUTHOR = 'hidden @2xl:flex'
const COL_DATE = 'hidden @xl:block'
const COL_SHA = 'hidden @3xl:block'

/** A local and a remote branch with the same name share one pill, like GitKraken. */
interface Pill {
  key: string
  label: string
  local?: Ref
  remotes: Ref[]
  tag?: Ref
  isHead: boolean
}

function pillsFor(refs: Ref[], headBranch: string | undefined, show: { remotes: boolean; tags: boolean }): Pill[] {
  const byName = new Map<string, Pill>()
  const out: Pill[] = []
  for (const r of refs) {
    if (r.kind === 'stash') continue
    if (r.kind === 'remote' && !show.remotes) continue
    if (r.kind === 'tag' && !show.tags) continue
    if (r.kind === 'tag') {
      out.push({ key: r.name, label: r.shortName, tag: r, remotes: [], isHead: false })
      continue
    }
    const name = r.kind === 'local' ? r.shortName : r.shortName.slice(r.shortName.indexOf('/') + 1)
    let p = byName.get(name)
    if (!p) {
      p = { key: name, label: r.kind === 'local' ? name : r.shortName, remotes: [], isHead: false }
      byName.set(name, p)
      out.unshift(p)
    }
    if (r.kind === 'local') {
      p.local = r
      p.label = name
      p.isHead = name === headBranch
    } else p.remotes.push(r)
  }
  // HEAD's branch first, then other branches, then tags.
  return out.sort((a, b) => Number(b.isHead) - Number(a.isHead) || Number(!!a.tag) - Number(!!b.tag))
}

/** Remounted when row height changes (compact rows), so the virtualizer re-measures from scratch. */
export function Graph({ view }: { view: RepoView }) {
  const compact = useSetting('compactRows')
  return <GraphList key={compact ? 'compact' : 'normal'} view={view} rowH={compact ? ROW_H_COMPACT : ROW_H} />
}

/** Settings that change how rows render, read once per list and passed down (rows are memoized). */
export interface RowLook {
  rowH: number
  dateFormat: string
  dateW: number
  avatars: AvatarSource
  avatarVariant: string
  showRemotes: boolean
  showTags: boolean
  /** Which optional columns show (gear menu in the header). */
  cols: GraphColumns
}

function GraphList({ view, rowH }: { view: RepoView; rowH: number }) {
  const dateFormat = useSetting('dateFormat')
  const showRemotes = useSetting('showRemoteBranches')
  const showTags = useSetting('showTags')
  const avatars = useSetting('avatars')
  const avatarVariant = useAvatarVariant()
  const cols = useSetting('graphColumns')
  const look = useMemo<RowLook>(() => ({ rowH, dateFormat, dateW: DATE_W[dateFormat] ?? 100, showRemotes, showTags, avatars, avatarVariant, cols }),
    [rowH, dateFormat, showRemotes, showTags, avatars, avatarVariant, cols])
  const log = getLog(view.id)
  const snap = view.snapshot
  const showWip = snap.status.length > 0 || !snap.head.hash
  const offset = showWip ? 1 : 0
  const count = log.commits.length + offset + (log.done ? 0 : 1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 15,
  })

  const items = virt.getVirtualItems()
  const lastVisible = items.length ? items[items.length - 1]!.index : 0
  // Fetch the next page when the user gets within a few hundred rows of the end.
  useEffect(() => {
    if (!log.done && lastVisible > log.commits.length - 400) void loadMore(view.id)
  }, [lastVisible, view.logVersion, view.id, log])

  const refsByHash = useMemo(() => {
    const m = new Map<string, Ref[]>()
    for (const r of snap.refs) {
      const list = m.get(r.hash)
      if (list) list.push(r)
      else m.set(r.hash, [r])
    }
    return m
  }, [snap.refs])

  const hits = useMemo(() => (view.search ? new Set(view.search.hits) : null), [view.search])
  // Real histories can have dozens of lanes open at once (old release branches, tags). Sizing the
  // column to fit them all would crush the commit messages, so like GitKraken we default to a few
  // lanes, clip the rest, and let the user drag the column wider.
  const userW = useStore((s) => s.settings?.graphWidth ?? null)
  const graphW = userW ?? Math.max(MIN_GRAPH_W, Math.min(log.maxWidth, AUTO_LANES) * LANE_W + 12)

  // Keep the selected row in view when it changes (keyboard navigation, search, jumping to a parent).
  let selectedIndex = -1
  if (view.selected.kind === 'wip') selectedIndex = showWip ? 0 : -1
  else {
    const ci = log.index.get(view.selected.hash)
    if (ci !== undefined) selectedIndex = ci + offset
  }
  const lastScrolled = useRef(-1)
  useEffect(() => {
    if (selectedIndex >= 0 && selectedIndex !== lastScrolled.current) {
      lastScrolled.current = selectedIndex
      virt.scrollToIndex(selectedIndex, { align: 'auto' })
    }
  }, [selectedIndex, virt])

  // The last row may be the "Loading…" placeholder; keyboard selection stops at the last commit.
  // Landing there scrolls near the end, which loads the next page, so End can be pressed again.
  const lastSelectable = offset + log.commits.length - 1
  const select = (wanted: number) => {
    const i = Math.min(Math.max(wanted, 0), lastSelectable)
    if (i < 0) return
    if (showWip && i === 0) updateRepo(view.id, { selected: { kind: 'wip' } })
    else {
      const c = log.commits[i - offset]
      if (c) updateRepo(view.id, { selected: { kind: 'commit', hash: c.hash } })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cur = selectedIndex < 0 ? -1 : selectedIndex
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); select(cur + 1) }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); select(Math.max(0, cur - 1)) }
    else if (e.key === 'PageDown') { e.preventDefault(); select(cur + 20) }
    else if (e.key === 'PageUp') { e.preventDefault(); select(cur - 20) }
    else if (e.key === 'Home') { e.preventDefault(); select(0) }
    else if (e.key === 'End') { e.preventDefault(); select(lastSelectable) }
  }

  return (
    // @container: the author, date and SHA columns appear only when the pane is wide enough,
    // so the commit message never gets squeezed out (container queries, not window size,
    // because the side panels decide how wide this pane is).
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center border-b border-line bg-panel text-[11px] font-semibold tracking-wide whitespace-nowrap text-faint uppercase"
        data-testid="graph-header">
        {cols.refs && <div style={{ width: REFS_W }} className="shrink-0 truncate px-3">Branch / Tag</div>}
        {cols.graph && (
          <div style={{ width: graphW }} className="relative shrink-0 truncate px-1">
            Graph{log.maxWidth * LANE_W + 12 > graphW && <span className="ml-1 font-normal normal-case" title="Some lanes are hidden; drag the edge to widen">›</span>}
            <ColumnResizer width={graphW} />
          </div>
        )}
        <div className="min-w-0 flex-1 truncate px-2">Commit message</div>
        {cols.author && <div style={{ width: AUTHOR_W }} className={clsx('shrink-0 truncate px-2', COL_AUTHOR)}>Author</div>}
        {cols.date && <div style={{ width: look.dateW }} className={clsx('shrink-0 truncate px-2', COL_DATE)}>Date</div>}
        {cols.sha && <div style={{ width: SHA_W }} className={clsx('shrink-0 truncate px-2', COL_SHA)}>SHA</div>}
        <ColumnsMenu cols={cols} />
      </div>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            ref={scrollRef}
            data-testid="graph-scroll"
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="min-h-0 flex-1 overflow-auto outline-none"
          >
            <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {items.map((item) => {
                const i = item.index
                const style = { position: 'absolute' as const, top: 0, left: 0, right: 0, height: rowH, transform: `translateY(${item.start}px)` }
                if (showWip && i === 0) {
                  return <WipRow key="wip" style={style} view={view} graphW={graphW} rowH={rowH} cols={cols} selected={view.selected.kind === 'wip'} />
                }
                const ci = i - offset
                const commit = log.commits[ci]
                const row = log.rows[ci]
                if (!commit || !row) {
                  return (
                    <div key="loading" style={style} className="flex items-center gap-2 px-3 text-xs text-faint">
                      <Spinner /> Loading history…
                    </div>
                  )
                }
                return (
                  <CommitRow
                    key={commit.hash}
                    top={item.start}
                    repoId={view.id}
                    commit={commit}
                    row={row}
                    refs={refsByHash.get(commit.hash)}
                    headBranch={snap.head.branch}
                    isHead={commit.hash === snap.head.hash}
                    selected={view.selected.kind === 'commit' && view.selected.hash === commit.hash}
                    hit={hits ? hits.has(commit.hash) : null}
                    showPending={showWip}
                    graphW={graphW}
                    look={look}
                  />
                )
              })}
            </div>
          </div>
        </ContextMenu.Trigger>
        <GraphMenu repoId={view.id} />
      </ContextMenu.Root>
    </div>
  )
}

/**
 * The gear at the end of the header: which columns show, like GitKraken's. The message column
 * always shows (there would be nothing left to click). Container queries still hide the
 * optional columns when the pane gets narrow, so these are a ceiling, not a promise.
 */
function ColumnsMenu({ cols }: { cols: GraphColumns }) {
  const compact = useSetting('compactRows')
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="mr-1 ml-auto flex h-5 w-6 shrink-0 items-center justify-center rounded text-faint normal-case hover:bg-hover hover:text-fg"
          title="Columns" data-testid="graph-columns">
          <Settings2 size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DM.Content align="end">
        <DM.Label>Columns</DM.Label>
        {GRAPH_COLUMNS.slice(0, 2).map((c) => (
          <DM.Check key={c.id} checked={cols[c.id]} testId={`col-${c.id}`} onChange={(v) => void saveSettings({ graphColumns: { ...cols, [c.id]: v } })}>{c.label}</DM.Check>
        ))}
        <DM.Check checked disabled onChange={() => {}}>Commit message</DM.Check>
        {GRAPH_COLUMNS.slice(2).map((c) => (
          <DM.Check key={c.id} checked={cols[c.id]} testId={`col-${c.id}`} onChange={(v) => void saveSettings({ graphColumns: { ...cols, [c.id]: v } })}>{c.label}</DM.Check>
        ))}
        <DM.Separator />
        <DM.Check checked={compact} onChange={(v) => void saveSettings({ compactRows: v })}>Compact rows</DM.Check>
        <DM.Item onSelect={() => void saveSettings({ graphColumns: { ...DEFAULT_GRAPH_COLUMNS }, graphWidth: null })}>Reset columns</DM.Item>
      </DM.Content>
    </DropdownMenu.Root>
  )
}

/** Drag the right edge of the Graph header to resize; double-click to go back to automatic. */
function ColumnResizer({ width }: { width: number }) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    let w = width
    const move = (ev: PointerEvent) => {
      w = Math.min(MAX_GRAPH_W, Math.max(MIN_GRAPH_W, width + ev.clientX - startX))
      // Update the store directly while dragging (smooth); persist once on release.
      useStore.setState((s) => (s.settings ? { settings: { ...s.settings, graphWidth: w } } : s))
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      void saveSettings({ graphWidth: w })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  return (
    <span
      onPointerDown={onPointerDown}
      onDoubleClick={() => void saveSettings({ graphWidth: null })}
      data-testid="graph-resizer"
      title="Drag to resize; double-click for automatic width"
      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-accent/50"
    />
  )
}

function WipRow({ style, view, graphW, rowH, cols, selected }: {
  style: React.CSSProperties; view: RepoView; graphW: number; rowH: number; cols: GraphColumns; selected: boolean
}) {
  const st = view.snapshot.status
  const staged = st.filter((e) => e.kind !== 'untracked' && e.kind !== 'unmerged' && e.index !== '.').length
  const conflicts = st.filter((e) => e.kind === 'unmerged').length
  return (
    <div
      style={style}
      data-testid="wip-row"
      onClick={() => updateRepo(view.id, { selected: { kind: 'wip' } })}
      className={clsx('flex items-center border-b border-line/40 text-[13px]', selected ? 'bg-select' : 'hover:bg-hover')}
    >
      {cols.refs && <div style={{ width: REFS_W }} className="shrink-0 px-3" />}
      {cols.graph && <WipCell width={graphW} hasHead={!!view.snapshot.head.hash} h={rowH} />}
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2 whitespace-nowrap text-muted italic">
        <span className="min-w-0 truncate">{view.snapshot.head.hash ? '// WIP: uncommitted changes' : '// No commits yet'}</span>
        {st.length > 0 && <span className="shrink-0 rounded bg-raised px-1.5 text-[11px] not-italic">{st.length} changed</span>}
        {staged > 0 && <span className="shrink-0 rounded bg-add-bg px-1.5 text-[11px] text-add not-italic">{staged} staged</span>}
        {conflicts > 0 && <span className="shrink-0 rounded bg-del-bg px-1.5 text-[11px] text-del not-italic">{conflicts} conflicts</span>}
      </div>
    </div>
  )
}

/**
 * Memoized: while scrolling, the list re-renders every frame, but each row's props stay equal
 * (its offset `top` is a number, not a fresh style object), so React skips the rows themselves.
 */
const CommitRow = memo(function CommitRow(props: {
  top: number
  repoId: string
  commit: Commit
  row: Row
  refs: Ref[] | undefined
  headBranch: string | undefined
  isHead: boolean
  selected: boolean
  hit: boolean | null
  showPending: boolean
  graphW: number
  look: RowLook
}) {
  const { commit, row, repoId, look } = props
  const src = avatarSrc(commit.authorEmail, look.avatars, look.avatarVariant)
  const author = useMemo(() => ({ name: commit.authorName, email: commit.authorEmail, src }), [commit.authorName, commit.authorEmail, src])
  const [dropping, setDropping] = useState(false)
  const pills = useMemo(() => (props.refs ? pillsFor(props.refs, props.headBranch, { remotes: look.showRemotes, tags: look.showTags }) : []),
    [props.refs, props.headBranch, look.showRemotes, look.showTags])

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(REF_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropping(true)
  }
  const onDrop = (e: DragEvent, ref?: Ref) => {
    setDropping(false)
    const raw = e.dataTransfer.getData(REF_MIME)
    if (!raw) return
    e.preventDefault()
    e.stopPropagation()
    useStore.setState({ drop: { x: e.clientX, y: e.clientY, source: JSON.parse(raw) as Ref, target: { ref, hash: commit.hash } } })
  }

  return (
    <div
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height: look.rowH, transform: `translateY(${props.top}px)` }}
      data-testid="commit-row"
      data-hash={commit.hash}
      onClick={() => updateRepo(repoId, { selected: { kind: 'commit', hash: commit.hash } })}
      onContextMenu={(e) => {
        // A right-click on a branch pill bubbles up to here; the pill already set the menu target.
        // (The pill must not stopPropagation: the menu's trigger is the list container above us.)
        if ((e.target as HTMLElement).closest('[data-testid="ref-pill"]')) return
        useStore.setState({ menu: { kind: 'commit', hash: commit.hash } })
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => onDrop(e)}
      className={clsx(
        'flex items-center text-[13px]',
        props.selected ? 'bg-select' : 'hover:bg-hover',
        dropping && 'outline outline-2 -outline-offset-2 outline-accent',
        props.hit === false && 'opacity-35',
      )}
    >
      {look.cols.refs && (
        <div style={{ width: REFS_W }} className="flex min-w-0 shrink-0 items-center gap-1 overflow-hidden px-2">
          {pills.slice(0, 2).map((p) => (
            <RefPill key={p.key} pill={p} color={row.color} repoId={repoId} hash={commit.hash} onDrop={onDrop} />
          ))}
          {pills.length > 2 && (
            <span className="shrink-0 rounded bg-raised px-1 text-[11px] text-muted" title={pills.slice(2).map((p) => p.label).join(', ')}>
              +{pills.length - 2}
            </span>
          )}
        </div>
      )}
      {look.cols.graph && <GraphCell row={row} width={props.graphW} showPending={props.showPending} isHead={props.isHead} h={look.rowH} author={author} />}
      <div className={clsx('min-w-0 flex-1 truncate px-2', props.hit && 'font-semibold text-fg')}>{commit.subject}</div>
      {/* No avatar here: the graph node already is one. */}
      {look.cols.author && (
        <div style={{ width: AUTHOR_W }} className={clsx('min-w-0 shrink-0 items-center px-2 text-muted', COL_AUTHOR)} data-testid="author-cell">
          <span className="truncate">{commit.authorName}</span>
        </div>
      )}
      {look.cols.date && <div style={{ width: look.dateW }} className={clsx('shrink-0 truncate px-2 text-muted', COL_DATE)}>{formatDate(commit.authorDate, look.dateFormat)}</div>}
      {look.cols.sha && <div style={{ width: SHA_W }} className={clsx('shrink-0 px-2 font-mono text-xs text-faint', COL_SHA)}>{shortHash(commit.hash)}</div>}
      {/* Lines up with the header's gear. */}
      <div className="w-7 shrink-0" />
    </div>
  )
})

function RefPill({ pill, color, repoId, hash, onDrop }: {
  pill: Pill; color: number; repoId: string; hash: string; onDrop: (e: DragEvent, ref?: Ref) => void
}) {
  const ref = pill.local ?? pill.remotes[0] ?? pill.tag!
  const [over, setOver] = useState(false)
  return (
    <span
      draggable={!pill.tag}
      data-testid="ref-pill"
      data-ref={ref.name}
      onDragStart={(e) => {
        e.dataTransfer.setData(REF_MIME, JSON.stringify(ref))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(REF_MIME)) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        onDrop(e, ref)
      }}
      onContextMenu={() => useStore.setState({ menu: { kind: 'ref', ref, hash } })}
      onDoubleClick={() => void checkout(repoId, ref.name)}
      title={[pill.local?.name, ...pill.remotes.map((r) => r.name), pill.tag?.name].filter(Boolean).join('\n')}
      className={clsx(
        'flex h-5 max-w-full min-w-0 shrink cursor-grab items-center gap-1 rounded border px-1.5 text-[11px]',
        pill.isHead ? 'font-semibold text-fg' : 'text-fg/90',
        over && 'ring-2 ring-accent',
      )}
      style={{ borderColor: laneColor(color), background: `color-mix(in srgb, ${laneColor(color)} ${pill.isHead ? 35 : 18}%, transparent)` }}
    >
      {pill.isHead && <span className="text-[10px]">✓</span>}
      {pill.tag ? <Tag size={10} className="shrink-0" /> : null}
      <span className="truncate">{pill.label}</span>
      {pill.local && <Laptop size={10} className="shrink-0 opacity-70" />}
      {pill.remotes.length > 0 && <Cloud size={10} className="shrink-0 opacity-70" />}
    </span>
  )
}
