import type { Row } from '@gitgoose/graph'
import type { AvatarSource, Commit, Ref, StashEntry } from '@gitgoose/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { Archive, Cloud, Laptop, Tag } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { memo, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { bisectMark, bisectReset, checkout, moveCommits, showAllInGraph, squashOnto } from '../lib/actions'
import { avatarSrc, useAvatarVariant } from '../lib/avatar'
import { authorLine, formatDate, laneColor, monthLabel, sameMonth, shortHash, stashLabel } from '../lib/format'
import { ensureLoaded, getLog, loadMore, selectCommit, selectedHashes, selectionCursor, updateRepo, useSetting, useStore, type LogData, type RepoView } from '../lib/store'
import { AvatarStack, type StackedAuthor } from './Avatar'
import { cellWidth, GraphCell, HEADER_H, ROW_H, ROW_H_COMPACT, WipCell } from './GraphCell'
import { GraphMenu } from './menus'
import { Spinner } from './ui'

const isMac = window.gitgoose?.platform === 'darwin'
export const REF_MIME = 'application/x-gitgoose-ref'
/** Commits being dragged to a new place in the branch (JSON list of hashes). */
export const COMMITS_MIME = 'application/x-gitgoose-commits'
/** Avatar beside the text: two lines tall, or one. */
const AVATAR = 30
const AVATAR_COMPACT = 18
/** The one-line layout's branch / tag column, left of the graph. */
const REFS_W = 160

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

/**
 * Two layouts (Settings → Appearance → Graph layout), the same graph in both. Comfortable is
 * two-line rows beside the nodes: author and branch pills over hash and subject. Compact is one
 * shorter line per commit, with the branch and tag pills moved to a column on the left of the
 * graph, joined to their node by a line, so the line of text is just avatar, hash, subject,
 * author and date. Remounted when the layout changes, so the virtualizer re-measures from scratch.
 */
export function Graph({ view }: { view: RepoView }) {
  const style = useSetting('graphStyle')
  return <GraphList key={style} view={view} compact={style === 'compact'} />
}

/** Settings that change how rows render, read once per list and passed down (rows are memoized). */
export interface RowLook {
  compact: boolean
  rowH: number
  dateFormat: string
  avatars: AvatarSource
  avatarVariant: string
  showRemotes: boolean
  showTags: boolean
}

/**
 * Which rows open a new month, as a flag per commit, grown as pages arrive. Kept outside React
 * state and extended rather than rebuilt: the virtualizer asks for every row's height when the
 * count changes, and that must cost a lookup, not a Date per row.
 */
function useMonthStarts(log: LogData): Uint8Array {
  const cache = useRef<{ commits: Commit[]; flags: Uint8Array; n: number }>({ commits: log.commits, flags: new Uint8Array(0), n: 0 })
  const c = cache.current
  if (c.commits !== log.commits) Object.assign(c, { commits: log.commits, flags: new Uint8Array(0), n: 0 })
  const total = log.commits.length
  if (c.n < total) {
    if (c.flags.length < total) {
      const grown = new Uint8Array(Math.max(total, c.flags.length * 2))
      grown.set(c.flags)
      c.flags = grown
    }
    for (let i = c.n; i < total; i++) {
      // Commit date: the order the log is in, so headings only ever go back in time down the list
      // (author dates do not: a rebase keeps them while giving the commits new places).
      c.flags[i] = i === 0 || !sameMonth(log.commits[i - 1]!.commitDate, log.commits[i]!.commitDate) ? 1 : 0
    }
    c.n = total
  }
  return c.flags
}

function GraphList({ view, compact }: { view: RepoView; compact: boolean }) {
  const rowH = compact ? ROW_H_COMPACT : ROW_H
  const dateFormat = useSetting('dateFormat')
  const showRemotes = useSetting('showRemoteBranches')
  const showTags = useSetting('showTags')
  const avatars = useSetting('avatars')
  const avatarVariant = useAvatarVariant()
  const log = getLog(view.id)
  const look = useMemo<RowLook>(() => ({ compact, rowH, dateFormat, showRemotes, showTags, avatars, avatarVariant }),
    [compact, rowH, dateFormat, showRemotes, showTags, avatars, avatarVariant])
  const snap = view.snapshot
  const showWip = snap.status.length > 0 || !snap.head.hash
  const offset = showWip ? 1 : 0
  const count = log.commits.length + offset + (log.done ? 0 : 1)
  const monthStarts = useMonthStarts(log)
  // One-line rows are a dense list: no month headings.
  const headers = !compact
  const scrollRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowH + (headers && monthStarts[i - offset] ? HEADER_H : 0),
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

  const selectedSet = useMemo(() => new Set(selectedHashes(view.selected)), [view.selected])
  const editableSet = useMemo(() => new Set(view.editable), [view.editable])
  const stashByHash = useMemo(() => new Map(view.stashes.map((s) => [s.hash, s])), [view.stashes])
  // Keep the selected row in view when it changes (keyboard navigation, jumping to a parent).
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

  // The WIP row and the first commit share HEAD's lane; the WIP row makes room for as many
  // lanes as the first commit does, so its text lines up with the row below.
  const wipLanes = log.rows[0]?.width ?? 1

  return (
    // @container: one-line rows drop the author when the pane is narrow (container queries, not
    // window size, because the side panels decide how wide this pane is).
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
            className="min-h-0 flex-1 overflow-auto outline-none"
          >
            <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {items.map((item) => {
                const i = item.index
                const style = { position: 'absolute' as const, top: 0, left: 0, right: 0, height: item.size, transform: `translateY(${item.start}px)` }
                if (showWip && i === 0) {
                  return <WipRow key="wip" style={style} view={view} cellW={cellWidth(wipLanes)} look={look} selected={view.selected.kind === 'wip'}
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
                    month={headers && monthStarts[ci] ? monthLabel(commit.commitDate) : null}
                    repoId={view.id}
                    commit={commit}
                    row={row}
                    refs={refsByHash.get(commit.hash)}
                    headBranch={snap.head.branch}
                    isHead={commit.hash === snap.head.hash}
                    selected={selectedSet.has(commit.hash)}
                    editable={editableSet.has(commit.hash)}
                    stash={commit.stash ? stashByHash.get(commit.hash) : undefined}
                    bisect={bisectMarks?.get(commit.hash)}
                    showPending={showWip}
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
      {st.length > 0 && <span className="shrink-0 rounded bg-raised px-1.5 text-[11px] not-italic">{st.length} changed</span>}
      {staged > 0 && <span className="shrink-0 rounded bg-add-bg px-1.5 text-[11px] text-add not-italic">{staged} staged</span>}
      {conflicts > 0 && <span className="shrink-0 rounded bg-del-bg px-1.5 text-[11px] text-del not-italic">{conflicts} conflicts</span>}
    </>
  )
  const label = view.snapshot.head.hash ? 'Uncommitted changes' : 'No commits yet'
  // One-line rows have the branch column on the left; the WIP row leaves it empty.
  const refsW = look.compact ? REFS_W : 0
  return (
    <div
      style={style}
      data-testid="wip-row"
      onClick={() => updateRepo(view.id, { selected: { kind: 'wip' } })}
      data-selected={selected || undefined}
      className="group flex items-center text-[13px]"
    >
      <div className={clsx('pointer-events-none absolute inset-y-0.5 right-2 rounded-md', selected ? 'bg-select' : 'group-hover:bg-hover')} style={{ left: refsW + cellW - 2 }} />
      {look.compact && <div style={{ width: REFS_W }} className="shrink-0" />}
      <WipCell width={cellW} hasHead={!!view.snapshot.head.hash} h={look.rowH} lane={lane} color={color} />
      <div className="relative flex h-full min-w-0 flex-1 items-center gap-2 border-b border-line/50 pr-5 pl-1 whitespace-nowrap text-muted italic">
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
  good: 'border-add/50 text-add', bad: 'border-del/50 text-del', skip: 'border-line text-muted', 'first bad': 'border-del bg-del text-white',
}

const CommitRow = memo(function CommitRow(props: {
  bisect?: BisectMark
  top: number
  /** "March 2026" when this row is the first of its month: the row grows by HEADER_H for the heading. */
  month: string | null
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
  showPending: boolean
  look: RowLook
}) {
  const { commit, row, repoId, look } = props
  /** The author, then any co-authors from the commit's trailers: one avatar each, stacked. */
  const people = useMemo<StackedAuthor[]>(
    () => [{ name: commit.authorName, email: commit.authorEmail }, ...(commit.coAuthors ?? [])]
      .map((p) => ({ ...p, src: avatarSrc(p.email, look.avatars, look.avatarVariant) })),
    [commit.authorName, commit.authorEmail, commit.coAuthors, look.avatars, look.avatarVariant],
  )
  const [dropping, setDropping] = useState(false)
  /**
   * Where dragged commits would land: just above (newer than) this one, just below it, or onto
   * it (squash them into it, as in Tower). The row is split in thirds.
   */
  const [dropAt, setDropAt] = useState<'above' | 'onto' | 'below' | null>(null)
  const pills = useMemo(() => (props.refs ? pillsFor(props.refs, props.headBranch, { remotes: look.showRemotes, tags: look.showTags }) : []),
    [props.refs, props.headBranch, look.showRemotes, look.showTags])
  const lane = laneColor(row.color)
  const header = props.month ? HEADER_H : 0
  const height = look.rowH + header
  const cellW = cellWidth(row.width)
  /** One-line rows: pills (or a stash or bisect mark) in the column on the left, joined to the node by a line. */
  const labelled = look.compact && (pills.length > 0 || !!props.stash || !!props.bisect)
  /** Where the row's text starts: past the branch column (one-line rows) and the graph. */
  const textX = (look.compact ? REFS_W : 0) + cellW

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
      const y = (e.clientY - box.top - header) / (box.height - header)
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

  /** The pills and marks, at most `max` branch pills before a "+N". */
  const marks = (max: number) => (
    <>
      {props.bisect && (
        <span className={clsx('flex h-[18px] shrink-0 items-center rounded border px-1.5 text-[11px] font-medium', BISECT_PILL[props.bisect])} data-testid="bisect-pill">{props.bisect}</span>
      )}
      {props.stash && (
        <span className="flex h-[18px] shrink-0 items-center gap-1 rounded border border-dashed border-line px-1.5 text-[11px] text-muted" data-testid="stash-pill">
          <Archive size={10} /> {props.stash.ref}
        </span>
      )}
      {pills.slice(0, max).map((p) => (
        <RefPill key={p.key} pill={p} color={row.color} repoId={repoId} hash={commit.hash} onDrop={onDrop} />
      ))}
      {pills.length > max && (
        <span className="shrink-0 rounded-[4px] bg-raised px-1.5 text-[11px] font-medium text-muted" title={pills.slice(max).map((p) => p.label).join('\n')}>
          +{pills.length - max}
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
    // Shift-click would otherwise also select the text between the two rows.
    onMouseDown: (e: React.MouseEvent) => e.shiftKey && e.preventDefault(),
    onClick: (e: React.MouseEvent) => selectCommit(repoId, commit.hash, { range: e.shiftKey, toggle: isMac ? e.metaKey : e.ctrlKey }),
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
    draggable: props.editable,
    onDragStart,
    onDragOver,
    onDragLeave: () => {
      setDropping(false)
      setDropAt(null)
    },
    onDrop: (e: DragEvent) => onDrop(e),
    'data-selected': props.selected || undefined,
  }
  const dropMarks = dropAt === 'onto' ? (
    <div data-testid="drop-onto" className="pointer-events-none absolute inset-x-0 bottom-0 rounded-sm outline outline-2 -outline-offset-2 outline-accent" style={{ top: header }} title="Squash into this commit" />
  ) : dropAt && (
    <div data-testid="drop-line" className={clsx('pointer-events-none absolute inset-x-0 h-0.5 bg-accent', dropAt === 'above' ? '' : 'bottom-0')} style={dropAt === 'above' ? { top: header } : undefined} />
  )

  return (
    <div
      {...rowProps}
      className={clsx('group flex items-stretch text-[13px]', dropping && 'outline outline-2 -outline-offset-2 outline-accent')}
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height, transform: `translateY(${props.top}px)` }}
    >
      {/* The selected row's tint, in its lane colour, as a rounded block that stops short of the
          row's edges: consecutive selected rows stay distinct, and the lines on the left stay clean. */}
      <div
        className={clsx('pointer-events-none absolute right-2 rounded-md', !props.selected && 'group-hover:bg-hover')}
        style={{ left: textX - 2, top: header + 2, bottom: 2, ...(props.selected ? { background: `color-mix(in srgb, ${lane} 22%, var(--gs-bg))` } : {}) }}
        data-testid="row-tint"
      />
      {/* One-line rows: the branch and tag pills in a column of their own, left of the graph, with
          a line in the lane colour running from them to the node (GraphCell draws the rest). */}
      {look.compact && (
        <div style={{ width: REFS_W }} className="flex h-full min-w-0 shrink-0 items-center gap-1 overflow-hidden pl-2" data-testid="refs-cell">
          {marks(2)}
          {labelled && <span className="h-0.5 min-w-2 flex-1" style={{ background: lane, opacity: 0.85 }} />}
        </div>
      )}
      {/* Centred across the row, not tucked against the lanes: the heading then sits in the gap
          above the row's own text and clear of the lines running up the left. */}
      {props.month && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center text-[11px] font-semibold tracking-wider text-faint uppercase"
          style={{ height: HEADER_H }} data-testid="month-header">
          {props.month}
        </div>
      )}
      <GraphCell row={row} width={cellW} showPending={props.showPending} isHead={props.isHead} h={look.rowH} offset={header} stash={!!commit.stash} refLine={labelled} />
      <div
        className="relative flex min-w-0 flex-1 items-center gap-2.5 border-b border-line/50 pr-5 pl-1"
        style={{ marginTop: header }}
        data-testid="row-body"
      >
        <span data-testid="row-avatar" className="flex shrink-0">
          <AvatarStack people={people} size={look.compact ? AVATAR_COMPACT : AVATAR} max={look.compact ? 2 : 3} />
        </span>
        {look.compact ? (
          // One line: the pills are already in the column on the left. The subject is the one
          // thing that must not be squeezed out, so the rest keeps a fixed width or goes.
          <>
            <span className="shrink-0 font-mono text-[12px] text-faint" data-testid="row-sha">{shortHash(commit.hash)}</span>
            <span className={clsx('min-w-0 flex-1 truncate', props.stash && 'text-muted italic')}>{subject}</span>
            <span className="hidden w-32 shrink-0 truncate text-[12px] text-muted @xl:block" data-testid="row-author" title={authorsTitle}>{authors}</span>
            <span className="shrink-0 text-[12px] text-faint" data-testid="row-date">{formatDate(commit.authorDate, look.dateFormat)}</span>
          </>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4">
              <span className="min-w-0 max-w-64 shrink truncate text-muted" data-testid="row-author" title={authorsTitle}>{authors}</span>
              {marks(3)}
              <span className="min-w-0 flex-1" />
              <span className="shrink-0 text-faint" data-testid="row-date">{formatDate(commit.authorDate, look.dateFormat)}</span>
            </div>
            <div className="flex min-w-0 items-center gap-2 leading-4">
              <span className="shrink-0 font-mono text-[12px] text-faint" data-testid="row-sha">{shortHash(commit.hash)}</span>
              <span className={clsx('min-w-0 flex-1 truncate', props.stash && 'text-muted italic')}>{subject}</span>
            </div>
          </div>
        )}
      </div>
      {dropMarks}
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
        'flex h-[18px] max-w-44 min-w-0 shrink cursor-grab items-center gap-1 rounded-[4px] px-1.5 text-[11px] font-semibold',
        pill.isHead ? 'bg-accent text-accent-fg' : pill.tag ? 'bg-warn text-black' : 'text-fg',
        over && 'ring-2 ring-accent',
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
