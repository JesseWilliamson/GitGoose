import type { Row } from '@gitgoose/graph'
import type { AvatarSource, Commit, Ref, StashEntry } from '@gitgoose/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { Archive, Cloud, Crosshair, Laptop, Tag } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { bisectMark, bisectReset, checkout, checkoutRow, showAllInGraph } from '../lib/actions'
import { avatarSrc } from '../lib/avatar'
import { startDrag, type DropTarget } from '../lib/dnd'
import { authorLine, formatDate, laneColor, shortHash, stashLabel } from '../lib/format'
import { lineEnded, lineIndexOf, lineThrough } from '../lib/lineView'
import { ensureLoaded, getLog, loadMore, selectCommit, selectedHashes, selectionCursor, setLine, updateRepo, useSetting, useStore, type RepoView } from '../lib/store'
import { AvatarStack, type StackedAuthor } from './Avatar'
import { cellWidth, GraphCell, ROW_H, WipCell } from './GraphCell'
import { GraphMenu } from './menus'
import { Spinner } from './ui'

const isMac = window.gitgoose?.platform === 'darwin'
/** The author's picture beside the name, the size of the text it sits with. */
const AVATAR = 16
/** The date column's width per date format: the same on every row, so the dates line up on the right. */
const DATE_W: Record<string, number> = { relative: 84, absolute: 96, both: 180 }

/** A local and a remote branch with the same name share one pill. */
interface Pill {
  key: string
  label: string
  local?: Ref
  remotes: Ref[]
  tag?: Ref
  isHead: boolean
}

function pillsFor(refs: readonly Ref[], headBranch: string | undefined, show: { remotes: boolean; tags: boolean }): Pill[] {
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

/**
 * The commit graph: one line per commit (ADR-011). The lanes, then the commit's branches and tags,
 * then its message, which gets the room; the author's picture and the date sit in narrow columns
 * on the right so they line up from row to row (the names are on the picture's hover). The pane is
 * a CSS container: when it is very narrow, the date goes too, without a measurement in script.
 */
export function Graph({ view }: { view: RepoView }) {
  return <GraphList view={view} />
}

/** Settings that change how rows render, read once per list and passed down (rows are memoized). */
export interface RowLook {
  rowH: number
  dateFormat: string
  avatars: AvatarSource
  showRemotes: boolean
  showTags: boolean
  /** The date column's width (DATE_W), the same on every row. */
  dateW: number
}

/** Repositories whose first rows have been marked (see GraphList). */
const rowsMarked = new Set<string>()

function GraphList({ view }: { view: RepoView }) {
  const rowH = ROW_H
  const dateFormat = useSetting('dateFormat')
  const showRemotes = useSetting('showRemoteBranches')
  const showTags = useSetting('showTags')
  const avatars = useSetting('avatars')
  const log = getLog(view.id)
  const dateW = DATE_W[dateFormat] ?? 84
  const look = useMemo<RowLook>(() => ({ rowH, dateFormat, showRemotes, showTags, avatars, dateW }),
    [rowH, dateFormat, showRemotes, showTags, avatars, dateW])
  const snap = view.snapshot

  // The line view (lib/lineView.ts): only the rows on the line through `anchor`, or all rows.
  // `visible` maps list position → log row. It is walked again when a page loads (the line grows
  // down as first parents arrive): one array per page, never per frame, and no relayout.
  // A line whose commit is gone (amended, rebased) moves to the selection, else to HEAD.
  const cursor = selectionCursor(view.selected)
  const anchor = view.line ? [view.line.hash, cursor, snap.head.hash].find((h) => h && log.index.has(h)) ?? null : null
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the log is mutated in place; logVersion says when
  const visible = useMemo(() => (anchor ? lineThrough(log, anchor) : null), [anchor, log, view.logVersion])
  const headRow = snap.head.hash ? log.index.get(snap.head.hash) : undefined
  // The uncommitted changes sit on HEAD's line: in the line view they show only on that line.
  const showWip = (snap.status.length > 0 || !snap.head.hash) && (!visible || (headRow !== undefined && lineIndexOf(visible, headRow) >= 0))
  const offset = showWip ? 1 : 0
  const rowCount = visible ? visible.length : log.commits.length
  // More rows can still come: the history is not all loaded, and (in the line view) the line has
  // not ended at a root commit, below which nothing belongs to it.
  const more = !log.done && !(visible && lineEnded(log, visible))
  const count = rowCount + offset + (more ? 1 : 0)
  /** The log row at list position `item`: -1 for the WIP row, -2 for the "Loading…" row. */
  const rowOf = (item: number): number => {
    const k = item - offset
    if (k < 0) return -1
    if (k >= rowCount) return -2
    return visible ? visible[k]! : k
  }
  /** The list position of log row `row` (-1: the WIP row), or -1 when it is not shown. */
  const itemOf = (row: number): number => {
    if (row < 0) return showWip ? 0 : -1
    if (!visible) return row + offset
    const k = lineIndexOf(visible, row)
    return k < 0 ? -1 : k + offset
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  /**
   * Space added above and below the line view's rows so the selected row can stay exactly where
   * it was on screen when the graph collapses (a short line has too few rows above it to scroll
   * to the same place). Zero when all rows show.
   */
  const [space, setSpace] = useState({ top: 0, min: 0 })
  const virt = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    // Every row is the same height, so the virtualizer's estimate is exact and it never measures.
    estimateSize: () => rowH,
    paddingStart: space.top,
    overscan: 15,
  })

  const items = virt.getVirtualItems()
  const lastVisible = items.length ? items[items.length - 1]!.index : 0
  // Startup timeline (read by tools/bench): the frame that first draws each repository's commit
  // rows, marked from the animation frame after the commit (the frame they are painted in).
  const hasRows = rowCount > 0
  useLayoutEffect(() => {
    if (!hasRows || rowsMarked.has(view.id)) return
    rowsMarked.add(view.id)
    requestAnimationFrame(() => performance.mark('gitgoose:rows', { detail: view.id }))
  }, [hasRows, view.id])
  // Fetch the next page when the user gets within a few hundred rows of the end. A line ends
  // where its next first parent is not loaded yet, so near the end of the line it loads on (page
  // after page if it must) until the parent arrives or the history ends.
  useEffect(() => {
    if (more && lastVisible > offset + rowCount - (visible ? 50 : 400)) void loadMore(view.id)
  }, [lastVisible, view.logVersion, view.id, more, visible, offset, rowCount])

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

  const selectedSet = useMemo(() => new Set(selectedHashes(view.selected)), [view.selected])
  const editableSet = useMemo(() => new Set(view.editable), [view.editable])
  const stashByHash = useMemo(() => new Map(view.stashes.map((s) => [s.hash, s])), [view.stashes])
  // Keep the selected row in view when it changes (keyboard navigation, jumping to a parent).
  /** The log row the keyboard moves from: -1 for the WIP row, undefined for none. */
  const cursorRow = view.selected.kind === 'wip' ? -1 : cursor ? log.index.get(cursor) : undefined
  const selectedIndex = cursorRow === undefined ? -1 : itemOf(cursorRow)
  const lastScrolled = useRef(-1)
  useEffect(() => {
    if (selectedIndex >= 0 && selectedIndex !== lastScrolled.current) {
      lastScrolled.current = selectedIndex
      virt.scrollToIndex(selectedIndex, { align: 'auto' })
    }
  }, [selectedIndex, virt])

  // When the graph collapses to a line or expands again, the selected row stays where it was on
  // screen, so the eye does not have to find it again. Before the browser paints, work
  // out where the row was (from the previous render's list) and scroll the new list to match.
  // (The list's own top does not move: the line bar floats over it, see LineBar. Runs on every
  // render, so it reads nothing from the DOM that would force a layout while scrolling.)
  const scrollTop = useRef(0)
  const before = useRef<{ key: string; itemOf: (row: number) => number; pad: number } | null>(null)
  const pendingScroll = useRef<number | null>(null)
  const viewKey = anchor ? `line:${anchor}` : 'all'
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const scrollTo = (y: number) => {
      el.scrollTop = y
      scrollTop.current = el.scrollTop
    }
    if (pendingScroll.current !== null) {
      scrollTo(pendingScroll.current)
      pendingScroll.current = null
    }
    const prev = before.current
    if (prev && prev.key !== viewKey) {
      const was = cursorRow === undefined ? -1 : prev.itemOf(cursorRow)
      const now = selectedIndex
      let next = { top: 0, min: 0 }
      if (was >= 0 && now >= 0) {
        // The row's distance from the top of the list's viewport, before; the same after.
        const y = prev.pad + was * rowH - scrollTop.current
        const top = visible ? Math.max(0, y - now * rowH) : 0
        const target = top + now * rowH - y
        next = { top, min: visible ? target + el.clientHeight : 0 }
        lastScrolled.current = now
        if (next.top === space.top && next.min === space.min) scrollTo(target)
        else pendingScroll.current = target
      }
      if (next.top !== space.top || next.min !== space.min) setSpace(next)
    }
    before.current = { key: viewKey, itemOf, pad: space.top }
  })

  // Esc lets go of the line view (View → Line View), unless something else has the keyboard.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !useStore.getState().repos[view.id]?.line) return
      const t = e.target as Node
      if (t !== document.body && !scrollRef.current?.contains(t)) return
      setLine(view.id, null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view.id])

  // The last row may be the "Loading…" placeholder; keyboard selection stops at the last commit.
  // Landing there scrolls near the end, which loads the next page, so End can be pressed again.
  const lastSelectable = offset + rowCount - 1
  const select = (wanted: number, range = false) => {
    const i = Math.min(Math.max(wanted, 0), lastSelectable)
    if (i < 0) return
    const r = rowOf(i)
    if (r === -1) {
      if (!range) updateRepo(view.id, { selected: { kind: 'wip' } })
    } else {
      const c = log.commits[r]
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

  // The WIP row and the first commit share HEAD's lane; the WIP row makes room for as many
  // lanes as the first commit does, so its text lines up with the row below.
  const wipLanes = log.rows[0]?.width ?? 1

  return (
    <div className="@container relative flex min-h-0 min-w-0 flex-1 flex-col">
      <BisectBar view={view} />
      <FilterBar view={view} />
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            ref={scrollRef}
            data-testid="graph-scroll"
            tabIndex={0}
            onKeyDown={onKeyDown}
            onScroll={(e) => { scrollTop.current = e.currentTarget.scrollTop }}
            className="min-h-0 flex-1 overflow-auto outline-none"
          >
            <div style={{ height: virt.getTotalSize(), minHeight: space.min, position: 'relative' }}>
              {items.map((item) => {
                const i = item.index
                const style = { position: 'absolute' as const, top: 0, left: 0, right: 0, height: item.size, transform: `translateY(${item.start}px)` }
                const r = rowOf(i)
                if (r === -1) {
                  return <WipRow key="wip" style={style} view={view} cellW={cellWidth(visible ? 1 : wipLanes)} look={look} selected={view.selected.kind === 'wip'}
                    lane={visible ? 0 : log.layout.headLane} color={log.layout.headColor} />
                }
                const commit = log.commits[r]
                const row = log.rows[r]
                if (!commit || !row) {
                  return (
                    <div key="loading" style={style} className="flex items-center gap-2 px-3 text-xs text-hint">
                      <Spinner /> Loading history…
                    </div>
                  )
                }
                // In the line view a row draws only the line: joined to the line's row above (its
                // child on the line), and on down when the commit has a parent.
                const up = visible && i - offset > 0 ? log.rows[visible[i - offset - 1]!] : undefined
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
                    detachedHead={!!snap.head.detached && commit.hash === snap.head.hash}
                    selected={selectedSet.has(commit.hash)}
                    editable={editableSet.has(commit.hash)}
                    stash={commit.stash ? stashByHash.get(commit.hash) : undefined}
                    bisect={bisectMarks?.get(commit.hash)}
                    showPending={showWip}
                    look={look}
                    lineAbove={visible ? (up ? up.lane : -1) : undefined}
                    lineAboveColor={up?.color}
                    lineBelow={visible ? commit.parents.length > 0 : undefined}
                  />
                )
              })}
            </div>
          </div>
        </ContextMenu.Trigger>
        <GraphMenu repoId={view.id} />
      </ContextMenu.Root>
      {visible && anchor && <LineBar view={view} hash={anchor} hidden={log.commits.length - visible.length} />}
    </div>
  )
}

/**
 * Says the graph shows one line of history, and how to get the rest back. It floats over the
 * bottom of the graph instead of taking a row of its own: pushing the list down would move the
 * very rows the user is looking at.
 */
function LineBar({ view, hash, hidden }: { view: RepoView; hash: string; hidden: number }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
      <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-md border border-border bg-card px-3 py-1 text-xs shadow-lg" data-testid="line-bar">
        <span className="min-w-0 truncate">
          Showing the line through <span className="font-mono">{shortHash(hash)}</span> · {hidden} {hidden === 1 ? 'commit' : 'commits'} hidden · Esc to show all
        </span>
        <button onClick={() => setLine(view.id, null)} className="shrink-0 rounded px-1.5 font-medium text-primary hover:bg-accent">Show all</button>
      </div>
    </div>
  )
}

const WIP_TARGET = JSON.stringify({ kind: 'wip' } satisfies DropTarget)

function WipRow({ style, view, cellW, look, selected, lane, color }: {
  style: React.CSSProperties; view: RepoView; cellW: number; look: RowLook; selected: boolean
  /** HEAD's lane and colour, where the dashed line down to HEAD runs. */
  lane: number; color: number
}) {
  const st = view.snapshot.status
  const staged = st.filter((e) => e.kind !== 'untracked' && e.kind !== 'unmerged' && e.index !== '.').length
  const conflicts = st.filter((e) => e.kind === 'unmerged').length
  const counts = (
    <>
      {st.length > 0 && <span className="shrink-0 rounded bg-popover px-1.5 text-2xs not-italic">{st.length} changed</span>}
      {staged > 0 && <span className="shrink-0 rounded bg-add-bg px-1.5 text-2xs text-add not-italic">{staged} staged</span>}
      {conflicts > 0 && <span className="shrink-0 rounded bg-del-bg px-1.5 text-2xs text-destructive not-italic">{conflicts} conflicts</span>}
    </>
  )
  const label = view.snapshot.head.hash ? 'Uncommitted changes' : 'No commits yet'
  return (
    <div
      style={style}
      data-testid="wip-row"
      // Drops here mean "into the working copy": cherry-pick, merge, apply a stash or a file (lib/dnd.ts).
      data-drop-target={WIP_TARGET}
      onClick={() => updateRepo(view.id, { selected: { kind: 'wip' } })}
      data-selected={selected || undefined}
      className="group flex items-center text-sm"
    >
      <div className={clsx('pointer-events-none absolute inset-y-0.5 right-1 rounded-sm', selected ? 'bg-select' : 'group-hover:bg-accent')} style={{ left: cellW - 2 }} />
      <WipCell width={cellW} hasHead={!!view.snapshot.head.hash} h={look.rowH} lane={lane} color={color} />
      <div className="relative flex h-full min-w-0 flex-1 items-center gap-2 pr-3 pl-1 whitespace-nowrap text-muted-foreground italic">
        <span className="min-w-0 truncate">{label}</span>
        {counts}
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
  good: 'border-add/50 text-add', bad: 'border-destructive/50 text-destructive', skip: 'border-border text-muted-foreground', 'first bad': 'border-destructive bg-destructive text-white',
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
  /** HEAD is detached at this commit: it gets a HEAD pill, since no branch pill says "you are here". */
  detachedHead: boolean
  selected: boolean
  /** On the part of the current branch that can be reordered (dropPlan reads it from the store; kept so a change re-renders). */
  editable: boolean
  /** Set when this row is a stash (its entry, for the label and the menu). */
  stash?: StashEntry
  showPending: boolean
  look: RowLook
  /** The line view's edges for this row (see GraphCell); undefined when all rows show. */
  lineAbove?: number
  lineAboveColor?: number
  lineBelow?: boolean
}) {
  const { commit, row, repoId, look } = props
  /** The author, then any co-authors from the commit's trailers: one avatar each, stacked. */
  const people = useMemo<StackedAuthor[]>(
    () => [{ name: commit.authorName, email: commit.authorEmail }, ...(commit.coAuthors ?? [])]
      .map((p) => ({ ...p, src: avatarSrc(p.email, look.avatars) })),
    [commit.authorName, commit.authorEmail, commit.coAuthors, look.avatars],
  )
  const pills = useMemo(() => (props.refs ? pillsFor(props.refs, props.headBranch, { remotes: look.showRemotes, tags: look.showTags }) : []),
    [props.refs, props.headBranch, look.showRemotes, look.showTags])
  const head = props.detachedHead
  const cellW = cellWidth(props.lineAbove === undefined ? row.width : 1)

  /**
   * Drag the commit (or the selection it is part of) somewhere: onto another row to move or squash
   * it, onto the working copy to cherry-pick it, onto a branch to pick it there (lib/dnd.ts). A
   * stash row drags the stash. A branch pill inside the row starts its own drag.
   */
  const onDragStart = (e: DragEvent) => {
    if ((e.target as HTMLElement).closest('[data-testid="ref-pill"]')) return
    if (props.stash) return startDrag(e.dataTransfer, { kind: 'stash', index: props.stash.index, hash: props.stash.hash, ref: props.stash.ref })
    const sel = useStore.getState().repos[repoId]?.selected
    startDrag(e.dataTransfer, { kind: 'commits', hashes: sel?.kind === 'commits' && sel.hashes.includes(commit.hash) ? sel.hashes : [commit.hash] })
  }
  /** Where a drop lands on this row (above, onto, below) is worked out from the pointer: see DragBadge. */
  const dropTarget = useMemo(() => JSON.stringify({ kind: 'row', hash: commit.hash, where: 'onto' } satisfies DropTarget), [commit.hash])

  /** The pills and marks, at most `max` branch pills before a "+N" (HEAD counts as one). */
  const marks = (max: number) => (
    <>
      {head && <HeadPill />}
      {props.bisect && (
        <span className={clsx('flex h-[18px] shrink-0 items-center rounded border px-1.5 text-2xs font-medium', BISECT_PILL[props.bisect])} data-testid="bisect-pill">{props.bisect}</span>
      )}
      {props.stash && (
        <span className="flex h-[18px] shrink-0 items-center gap-1 rounded border border-dashed border-border px-1.5 text-2xs text-muted-foreground" data-testid="stash-pill">
          <Archive size={10} /> {props.stash.ref}
        </span>
      )}
      {pills.slice(0, max - Number(head)).map((p) => (
        <RefPill key={p.key} pill={p} color={row.color} repoId={repoId} hash={commit.hash} />
      ))}
      {pills.length > max - Number(head) && (
        <span className="shrink-0 rounded-[4px] bg-popover px-1.5 text-2xs font-medium text-muted-foreground" title={pills.slice(max - Number(head)).map((p) => p.label).join('\n')}>
          +{pills.length - max + Number(head)}
        </span>
      )}
    </>
  )
  const subject = props.stash ? stashLabel(props.stash.message) : commit.subject
  // "Ada Lovelace and Grace Hopper" on the line, everyone with their address in the tooltip.
  const authors = authorLine(commit.authorName, commit.coAuthors)
  const authorsTitle = commit.coAuthors ? people.map((p) => `${p.name} <${p.email}>`).join('\n') : undefined

  /** Everything a row does, whichever way it is drawn: select, menu, drag commits, take drops. */
  const rowProps = {
    'data-testid': 'commit-row',
    'data-hash': commit.hash,
    'data-lane': row.lane,
    // Shift-click would otherwise also select the text between the two rows, and a double-click
    // the word under the pointer.
    onMouseDown: (e: React.MouseEvent) => (e.shiftKey || e.detail > 1) && e.preventDefault(),
    // The second click of a double-click (detail 2) leaves the selection alone: with Ctrl or Shift
    // held it would otherwise toggle the commit back off or grow a range.
    onClick: (e: React.MouseEvent) => e.detail < 2 && selectCommit(repoId, commit.hash, { range: e.shiftKey, toggle: isMac ? e.metaKey : e.ctrlKey }),
    // Check out what is here (see checkoutRow). A stash is not something to check out; the pills
    // have their own double-click and stop it reaching the row.
    onDoubleClick: (e: React.MouseEvent) => {
      if (props.stash) return
      selectCommit(repoId, commit.hash)
      checkoutRow(repoId, commit.hash, { x: e.clientX, y: e.clientY })
    },
    onContextMenu: (e: React.MouseEvent) => {
      // A right-click on a branch pill bubbles up to here; the pill already set the menu target.
      // (The pill must not stopPropagation: the menu's trigger is the list container above us.)
      if ((e.target as HTMLElement).closest('[data-testid="ref-pill"]')) return
      // On one of several selected commits, the menu acts on all of them.
      const sel = useStore.getState().repos[repoId]?.selected
      if (props.stash) useStore.setState({ menu: { kind: 'stash', stash: props.stash } })
      else if (sel?.kind === 'commits' && sel.hashes.includes(commit.hash)) useStore.setState({ menu: { kind: 'commits', hashes: sel.hashes } })
      else useStore.setState({ menu: { kind: 'commit', hash: commit.hash } })
    },
    draggable: true,
    onDragStart,
    'data-drop-target': dropTarget,
    'data-drop-zones': 'thirds',
    'data-selected': props.selected || undefined,
  }

  return (
    <div
      {...rowProps}
      className="group flex items-stretch text-sm"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height: look.rowH, transform: `translateY(${props.top}px)` }}
    >
      {/* The selected row's tint: the one selection blue (bg-select, as on the WIP row, the sidebar
          and the palette), not the lane colour, so "selected" reads the same on every branch. It
          starts after the lanes, so the lines on the left stay clean, and stops 2 px short of the
          row's top and bottom, so consecutive selected rows stay distinct. */}
      <div
        className={clsx('pointer-events-none absolute right-1 rounded-sm', props.selected ? 'bg-select' : 'group-hover:bg-accent')}
        style={{ left: cellW - 2, top: 2, bottom: 2 }}
        data-testid="row-tint"
      />
      <GraphCell row={row} width={cellW} showPending={props.showPending} isHead={props.isHead} h={look.rowH} stash={!!commit.stash}
        lineAbove={props.lineAbove} lineAboveColor={props.lineAboveColor} lineBelow={props.lineBelow} />
      {/* Branches and tags first: they are labels on the commit, read before its message. A merge's
          message is muted (it says where history came from, not what changed); the SHA shows on
          the selected row, where you would copy it. */}
      <div className="relative flex min-w-0 flex-1 items-center gap-1.5 pr-3 pl-1" data-testid="row-body">
        {marks(2)}
        <span className={clsx('min-w-0 flex-1 truncate', (row.merge || props.stash) && 'text-muted-foreground', props.stash && 'italic')}
          data-testid="row-subject">{subject}</span>
        {props.selected && <span className="shrink-0 font-mono text-2xs text-hint" data-testid="row-sha">{shortHash(commit.hash)}</span>}
        {/* Who: the picture only (the names are on hover), so the message keeps the width. */}
        <span className="ml-1.5 flex shrink-0 items-center" data-testid="row-author" aria-label={authors} title={authorsTitle ?? `${commit.authorName} <${commit.authorEmail}>`}>
          <span data-testid="row-avatar" className="flex shrink-0"><AvatarStack people={people} size={AVATAR} max={2} /></span>
        </span>
        <span style={{ width: look.dateW }} className="hidden shrink-0 truncate text-right text-xs text-hint tabular-nums @[360px]:inline" data-testid="row-date">
          {formatDate(commit.authorDate, look.dateFormat)}
        </span>
      </div>
    </div>
  )
})

function RefPill({ pill, color, repoId, hash }: { pill: Pill; color: number; repoId: string; hash: string }) {
  const ref = pill.local ?? pill.remotes[0] ?? pill.tag!
  return (
    <span
      draggable
      data-testid="ref-pill"
      data-ref={ref.name}
      // A branch dragged here, or commits: see lib/dnd.ts. Inside its row, the pill is the nearer target.
      data-drop-target={JSON.stringify({ kind: 'ref', ref } satisfies DropTarget)}
      onDragStart={(e) => startDrag(e.dataTransfer, { kind: 'ref', ref })}
      onContextMenu={() => useStore.setState({ menu: { kind: 'ref', ref, hash } })}
      onDoubleClick={(e) => {
        // The row's own double-click would check out the commit's branch (or ask which); the pill
        // means this ref, so the row must not see it.
        e.stopPropagation()
        void checkout(repoId, ref.name)
      }}
      title={[pill.local?.name, ...pill.remotes.map((r) => r.name), pill.tag?.name].filter(Boolean).join('\n')}
      className={clsx(
        'flex h-[18px] max-w-44 min-w-0 shrink cursor-grab items-center gap-1 rounded-[4px] px-1.5 text-2xs font-semibold',
        pill.isHead ? 'bg-primary text-primary-foreground' : pill.tag ? 'bg-warn text-black' : 'text-foreground',
      )}
      // The checked-out branch is solid accent and tags solid amber, as in Tower; other branches
      // take a tint of their lane so the pill still says which line of history it sits on.
      style={pill.isHead || pill.tag ? undefined : { background: `color-mix(in srgb, ${laneColor(color)} 28%, transparent)` }}
    >
      {pill.tag ? <Tag size={10} className="shrink-0" /> : null}
      <span className="truncate">{pill.label}</span>
      {pill.local && !pill.isHead && <Laptop size={10} className="shrink-0 opacity-70" />}
      {pill.remotes.length > 0 && <Cloud size={10} className="shrink-0 opacity-70" />}
    </span>
  )
}

/**
 * Where a detached HEAD is: the checked-out branch's look (solid accent), since it answers the
 * same question, "where am I?". It is not a ref, so it has none of a branch pill's handlers: a
 * right-click, drag or double-click on it is one on its row (the commit).
 */
function HeadPill() {
  return (
    <span data-testid="head-pill" title="HEAD is detached here: new commits belong to no branch until you create one"
      className="flex h-[18px] shrink-0 items-center gap-1 rounded-[4px] bg-primary px-1.5 text-2xs font-semibold text-primary-foreground">
      <Crosshair size={10} className="shrink-0" /> HEAD
    </span>
  )
}

/** Says when the graph leaves branches out (hidden or not soloed), with the way back. */
function FilterBar({ view }: { view: RepoView }) {
  const { hidden, solo } = view.snapshot.filter
  if (!hidden.length && !solo.length) return null
  const name = (r: string) => r.replace(/^refs\/(heads|remotes|tags)\//, '').replace(/\/\*$/, ' (all)')
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-primary/10 px-3 text-xs" data-testid="graph-filter">
      <span className="min-w-0 flex-1 truncate">
        {solo.length ? `Showing only ${solo.map(name).join(', ')}` : `${hidden.length} hidden: ${hidden.map(name).join(', ')}`}
      </span>
      <button onClick={() => showAllInGraph(view.id)} className="rounded px-1.5 font-medium text-primary hover:bg-accent">Show all</button>
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
    <div className={clsx('flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs', b.found ? 'bg-destructive/10' : 'bg-warn/10')} data-testid="bisect-bar">
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {b.found ? (
        <button onClick={() => { updateRepo(id, { selected: { kind: 'commit', hash: b.found! } }); void ensureLoaded(id, b.found!) }} className="rounded px-1.5 font-medium text-primary hover:bg-accent">Show it</button>
      ) : b.bad && b.good.length > 0 && head && (
        <>
          <button onClick={() => void bisectMark(id, head, 'good')} className="rounded px-1.5 font-medium text-add hover:bg-accent">Good</button>
          <button onClick={() => void bisectMark(id, head, 'bad')} className="rounded px-1.5 font-medium text-destructive hover:bg-accent">Bad</button>
          <button onClick={() => void bisectMark(id, head, 'skip')} className="rounded px-1.5 font-medium text-muted-foreground hover:bg-accent" title="Cannot test this one (it does not build, say)">Skip</button>
        </>
      )}
      <button onClick={() => void bisectReset(id)} className="rounded px-1.5 font-medium text-muted-foreground hover:bg-accent">Stop bisecting</button>
    </div>
  )
}
