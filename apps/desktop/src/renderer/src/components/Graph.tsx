import type { Row } from '@gitsquid/graph'
import { DEFAULT_GRAPH_COLUMNS, GRAPH_COLUMNS, type Commit, type GraphColumns, type Ref, type StashEntry } from '@gitsquid/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { Archive, Cloud, Laptop, Settings2, Tag } from 'lucide-react'
import { ContextMenu, DropdownMenu } from 'radix-ui'
import { memo, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { AvatarSource } from '@gitsquid/shared'
import { checkout, moveCommits, squashOnto } from '../lib/actions'
import { avatarSrc, useAvatarVariant } from '../lib/avatar'
import { formatDate, laneColor, relativeTime, shortHash, stashLabel } from '../lib/format'
import { ensureLoaded, getLog, loadMore, saveSettings, selectCommit, selectedHashes, selectionCursor, updateRepo, useSetting, useStore, type RepoView } from '../lib/store'
import { GraphCell, LANE_W, ROW_H, ROW_H_COMPACT, WipCell } from './GraphCell'
import { GraphMenu } from './menus'
import { SearchBar } from './SearchBar'
import { bisectMark, bisectReset, showAllInGraph } from '../lib/actions'
import { DM, Spinner } from './ui'

const isMac = window.gitsquid?.platform === 'darwin'
const REFS_W = 160
const AUTHOR_W = 140
const DATE_W: Record<string, number> = { relative: 100, absolute: 110, both: 200 }
const SHA_W = 68
/** Automatic width shows at most this many lanes; wider histories are clipped until the user widens the column. */
const AUTO_LANES = 8
const MIN_GRAPH_W = 64
const MAX_GRAPH_W = 800
export const REF_MIME = 'application/x-gitsquid-ref'
/** Commits being dragged to a new place in the branch (JSON list of hashes). */
export const COMMITS_MIME = 'application/x-gitsquid-commits'
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

  /** Bisect marks on rows: what was marked good / bad / skipped, and the culprit once found. */
  const bisectMarks = useMemo(() => {
    const b = snap.bisect
    if (!b) return null
    const m = new Map<string, BisectMark>()
    for (const h of b.good) m.set(h, 'good')
    for (const h of b.skipped) m.set(h, 'skip')
    if (b.bad) m.set(b.bad, 'bad')
    if (b.found) m.set(b.found, 'first bad')
    return m
  }, [snap.bisect])
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

  const selectedSet = useMemo(() => new Set(selectedHashes(view.selected)), [view.selected])
  const editableSet = useMemo(() => new Set(view.editable), [view.editable])
  const stashByHash = useMemo(() => new Map(view.stashes.map((s) => [s.hash, s])), [view.stashes])
  // Keep the selected row in view when it changes (keyboard navigation, search, jumping to a parent).
  let selectedIndex = -1
  const cursor = selectionCursor(view.selected)
  if (view.selected.kind === 'wip') selectedIndex = showWip ? 0 : -1
  else if (cursor) {
    const ci = log.index.get(cursor)
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
  const select = (wanted: number, range = false) => {
    const i = Math.min(Math.max(wanted, 0), lastSelectable)
    if (i < 0) return
    if (showWip && i === 0) {
      if (!range) updateRepo(view.id, { selected: { kind: 'wip' } })
    } else {
      const c = log.commits[i - offset]
      if (c) selectCommit(view.id, c.hash, { range })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cur = selectedIndex < 0 ? -1 : selectedIndex
    // Shift+arrows grow the selection from where it started, like Shift-click.
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); select(cur + 1, e.shiftKey) }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); select(Math.max(0, cur - 1), e.shiftKey) }
    else if (e.key === 'PageDown') { e.preventDefault(); select(cur + 20) }
    else if (e.key === 'PageUp') { e.preventDefault(); select(cur - 20) }
    else if (e.key === 'Home') { e.preventDefault(); select(0) }
    else if (e.key === 'End') { e.preventDefault(); select(lastSelectable) }
  }

  return (
    // @container: the author, date and SHA columns appear only when the pane is wide enough,
    // so the commit message never gets squeezed out (container queries, not window size,
    // because the side panels decide how wide this pane is).
    <div className="@container relative flex min-h-0 min-w-0 flex-1 flex-col">
      {view.searchOpen && <SearchBar view={view} />}
      <BisectBar view={view} />
      <FilterBar view={view} />
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
                  return <WipRow key="wip" style={style} view={view} graphW={graphW} rowH={rowH} cols={cols} selected={view.selected.kind === 'wip'}
                    lane={log.layout.headLane} color={log.layout.headColor} />
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
                    selected={selectedSet.has(commit.hash)}
                    editable={editableSet.has(commit.hash)}
                    stash={commit.stash ? stashByHash.get(commit.hash) : undefined}
                    hit={hits ? hits.has(commit.hash) : null}
                    bisect={bisectMarks?.get(commit.hash)}
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

function WipRow({ style, view, graphW, rowH, cols, selected, lane, color }: {
  style: React.CSSProperties; view: RepoView; graphW: number; rowH: number; cols: GraphColumns; selected: boolean
  /** HEAD's lane and colour, where the dashed line down to HEAD runs. */
  lane: number; color: number
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
      {cols.graph && <WipCell width={graphW} hasHead={!!view.snapshot.head.hash} h={rowH} lane={lane} color={color} />}
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
type BisectMark = 'good' | 'bad' | 'skip' | 'first bad'
const BISECT_PILL: Record<BisectMark, string> = {
  good: 'border-add/50 text-add', bad: 'border-del/50 text-del', skip: 'border-line text-muted', 'first bad': 'border-del bg-del text-white',
}

const CommitRow = memo(function CommitRow(props: {
  bisect?: BisectMark
  top: number
  repoId: string
  commit: Commit
  row: Row
  refs: Ref[] | undefined
  headBranch: string | undefined
  isHead: boolean
  selected: boolean
  /** On the part of the current branch that can be reordered: draggable, and a drop target. */
  editable: boolean
  /** Set when this row is a stash (its entry, for the label and the menu). */
  stash?: StashEntry
  hit: boolean | null
  showPending: boolean
  graphW: number
  look: RowLook
}) {
  const { commit, row, repoId, look } = props
  const src = avatarSrc(commit.authorEmail, look.avatars, look.avatarVariant)
  const author = useMemo(() => ({ name: commit.authorName, email: commit.authorEmail, src }), [commit.authorName, commit.authorEmail, src])
  const [dropping, setDropping] = useState(false)
  /**
   * Where dragged commits would land: just above (newer than) this one, just below it, or onto
   * it (squash them into it, as in Tower). The row is split in thirds.
   */
  const [dropAt, setDropAt] = useState<'above' | 'onto' | 'below' | null>(null)
  const pills = useMemo(() => (props.refs ? pillsFor(props.refs, props.headBranch, { remotes: look.showRemotes, tags: look.showTags }) : []),
    [props.refs, props.headBranch, look.showRemotes, look.showTags])
  const lane = laneColor(row.color)
  /** Pills (or a stash or bisect mark) in the first column: joined to the node by a line. */
  const labelled = look.cols.refs && (pills.length > 0 || !!props.stash || !!props.bisect)
  // Like GitKraken: without a Date column, recent commits still say when, inside the message cell.
  const recent = !look.cols.date && Date.now() / 1000 - commit.authorDate < 86_400

  const onDragStart = (e: DragEvent) => {
    // A branch pill inside the row starts its own drag.
    if (!props.editable || (e.target as HTMLElement).closest('[data-testid="ref-pill"]')) return
    const sel = useStore.getState().repos[repoId]?.selected
    const hashes = sel?.kind === 'commits' && sel.hashes.includes(commit.hash) ? sel.hashes : [commit.hash]
    e.dataTransfer.setData(COMMITS_MIME, JSON.stringify(hashes))
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(COMMITS_MIME)) {
      if (!props.editable) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const y = (e.clientY - box.top) / box.height
      setDropAt(y < 1 / 3 ? 'above' : y > 2 / 3 ? 'below' : 'onto')
      return
    }
    if (!e.dataTransfer.types.includes(REF_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropping(true)
  }
  const onDrop = (e: DragEvent, ref?: Ref) => {
    setDropping(false)
    const commits = e.dataTransfer.getData(COMMITS_MIME)
    if (commits) {
      e.preventDefault()
      const where = dropAt ?? 'above'
      setDropAt(null)
      const hashes = JSON.parse(commits) as string[]
      if (hashes.includes(commit.hash)) return
      if (where === 'onto') void squashOnto(repoId, hashes, commit.hash)
      else void moveCommits(repoId, hashes, commit.hash, where)
      return
    }
    const raw = e.dataTransfer.getData(REF_MIME)
    if (!raw) return
    e.preventDefault()
    e.stopPropagation()
    useStore.setState({ drop: { x: e.clientX, y: e.clientY, source: JSON.parse(raw) as Ref, target: { ref, hash: commit.hash } } })
  }

  return (
    <div
      data-testid="commit-row"
      data-hash={commit.hash}
      // Shift-click would otherwise also select the text between the two rows.
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      onClick={(e) => selectCommit(repoId, commit.hash, { range: e.shiftKey, toggle: isMac ? e.metaKey : e.ctrlKey })}
      onContextMenu={(e) => {
        // A right-click on a branch pill bubbles up to here; the pill already set the menu target.
        // (The pill must not stopPropagation: the menu's trigger is the list container above us.)
        if ((e.target as HTMLElement).closest('[data-testid="ref-pill"]')) return
        // On one of several selected commits, the menu acts on all of them.
        const sel = useStore.getState().repos[repoId]?.selected
        if (props.stash) useStore.setState({ menu: { kind: 'stash', stash: props.stash } })
        else if (sel?.kind === 'commits' && sel.hashes.includes(commit.hash)) useStore.setState({ menu: { kind: 'commits', hashes: sel.hashes } })
        else useStore.setState({ menu: { kind: 'commit', hash: commit.hash } })
      }}
      draggable={props.editable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => {
        setDropping(false)
        setDropAt(null)
      }}
      onDrop={(e) => onDrop(e)}
      className={clsx(
        'flex items-center text-[13px]',
        props.selected ? 'bg-select' : 'hover:bg-hover',
        dropping && 'outline outline-2 -outline-offset-2 outline-accent',
        props.hit === false && 'opacity-35',
      )}
      // The selected row takes its lane's colour, as in GitKraken (bg-select stays as the class).
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height: look.rowH, transform: `translateY(${props.top}px)`,
        ...(props.selected ? { background: `color-mix(in srgb, ${lane} 24%, var(--gs-bg))` } : {}) }}
    >
      {look.cols.refs && (
        <div style={{ width: REFS_W, ...(labelled && !props.selected ? { background: `color-mix(in srgb, ${lane} 9%, transparent)` } : {}) }}
          className="flex h-full min-w-0 shrink-0 items-center gap-1 overflow-hidden pl-2">
          {props.bisect && (
            <span className={clsx('flex h-5 shrink-0 items-center rounded border px-1.5 text-[11px] font-medium', BISECT_PILL[props.bisect])} data-testid="bisect-pill">{props.bisect}</span>
          )}
          {props.stash && (
            <span className="flex h-5 shrink-0 items-center gap-1 rounded border border-dashed border-line px-1.5 text-[11px] text-muted" data-testid="stash-pill">
              <Archive size={10} /> {props.stash.ref}
            </span>
          )}
          {pills.slice(0, 2).map((p) => (
            <RefPill key={p.key} pill={p} color={row.color} repoId={repoId} hash={commit.hash} onDrop={onDrop} />
          ))}
          {pills.length > 2 && (
            <span className="shrink-0 rounded-[3px] px-1 text-[11px] font-medium" title={pills.slice(2).map((p) => p.label).join('\n')}
              style={{ background: `color-mix(in srgb, ${lane} 30%, transparent)` }}>
              +{pills.length - 2}
            </span>
          )}
          {/* The line from the pills to the node; GraphCell continues it up to the node. */}
          {labelled && <span className="h-0.5 min-w-2 flex-1" style={{ background: lane, opacity: 0.85 }} />}
        </div>
      )}
      {look.cols.graph && (
        <GraphCell row={row} width={props.graphW} showPending={props.showPending} isHead={props.isHead} h={look.rowH} author={author}
          stash={!!commit.stash} refLine={labelled} />
      )}
      <div className={clsx('flex min-w-0 flex-1 items-center gap-2 px-2', props.hit && 'font-semibold text-fg', props.stash && 'text-muted italic')}>
        <span className="min-w-0 flex-1 truncate">{props.stash ? stashLabel(props.stash.message) : commit.subject}</span>
        {recent && <span className="shrink-0 text-[11px] text-faint" data-testid="row-time">{relativeTime(commit.authorDate)}</span>}
      </div>
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
      {dropAt === 'onto' ? (
        <div data-testid="drop-onto" className="pointer-events-none absolute inset-0 rounded-sm outline outline-2 -outline-offset-2 outline-accent" title="Squash into this commit" />
      ) : dropAt && (
        <div data-testid="drop-line" className={clsx('pointer-events-none absolute inset-x-0 h-0.5 bg-accent', dropAt === 'above' ? 'top-0' : 'bottom-0')} />
      )}
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
        'flex h-5 max-w-full min-w-0 shrink cursor-grab items-center gap-1 rounded-[3px] px-1.5 text-[11px] font-medium',
        pill.isHead ? 'text-white' : 'text-fg',
        over && 'ring-2 ring-accent',
      )}
      // Like GitKraken: a filled tab in the lane's colour; the checked-out branch is solid.
      style={{ background: pill.isHead ? laneColor(color) : `color-mix(in srgb, ${laneColor(color)} 30%, transparent)` }}
    >
      {pill.isHead && <span className="text-[10px]">✓</span>}
      {pill.tag ? <Tag size={10} className="shrink-0" /> : null}
      <span className="truncate">{pill.label}</span>
      {pill.local && <Laptop size={10} className="shrink-0 opacity-70" />}
      {pill.remotes.length > 0 && <Cloud size={10} className="shrink-0 opacity-70" />}
    </span>
  )
}

/** Says when the graph leaves branches out (hidden or not soloed), with the way back. */
function FilterBar({ view }: { view: RepoView }) {
  const { hidden, solo } = view.snapshot.filter
  if (!hidden.length && !solo.length) return null
  const name = (r: string) => r.replace(/^refs\/(heads|remotes|tags)\//, '').replace(/\/\*$/, ' (all)')
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-accent/10 px-3 text-[12px]" data-testid="graph-filter">
      <span className="min-w-0 flex-1 truncate">
        {solo.length ? `Showing only ${solo.map(name).join(', ')}` : `${hidden.length} hidden: ${hidden.map(name).join(', ')}`}
      </span>
      <button onClick={() => showAllInGraph(view.id)} className="rounded px-1.5 font-medium text-accent hover:bg-hover">Show all</button>
    </div>
  )
}

/**
 * While bisecting: what to do next, in words. git has checked out a commit to test; you try it
 * (run the app, the tests) and say good or bad, and the range halves each time.
 */
function BisectBar({ view }: { view: RepoView }) {
  const b = view.snapshot.bisect
  if (!b) return null
  const id = view.id
  const head = view.snapshot.head.hash
  const found = b.found ? getLog(id).commits[getLog(id).index.get(b.found) ?? -1] : undefined
  const message = b.found ? `First bad commit: ${b.found.slice(0, 7)}${found ? ` ${found.subject}` : ''}`
    : !b.bad ? 'Bisecting: mark a commit that has the bug as bad.'
    : !b.good.length ? 'Bisecting: now mark a commit without the bug as good.'
    : `Bisecting: test the checked-out commit. ${b.remaining} left to test after it (about ${b.steps} more step${b.steps === 1 ? '' : 's'}).`
  return (
    <div className={clsx('flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]', b.found ? 'bg-del/10' : 'bg-warn/10')} data-testid="bisect-bar">
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {b.found ? (
        <button onClick={() => { updateRepo(id, { selected: { kind: 'commit', hash: b.found! } }); void ensureLoaded(id, b.found!) }} className="rounded px-1.5 font-medium text-accent hover:bg-hover">Show it</button>
      ) : b.bad && b.good.length > 0 && head && (
        <>
          <button onClick={() => void bisectMark(id, head, 'good')} className="rounded px-1.5 font-medium text-add hover:bg-hover">Good</button>
          <button onClick={() => void bisectMark(id, head, 'bad')} className="rounded px-1.5 font-medium text-del hover:bg-hover">Bad</button>
          <button onClick={() => void bisectMark(id, head, 'skip')} className="rounded px-1.5 font-medium text-muted hover:bg-hover" title="Cannot test this one (it does not build, say)">Skip</button>
        </>
      )}
      <button onClick={() => void bisectReset(id)} className="rounded px-1.5 font-medium text-muted hover:bg-hover">Stop bisecting</button>
    </div>
  )
}
