import type { Row } from '@gitsquid/graph'
import type { Commit, Ref } from '@gitsquid/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { Cloud, Laptop, Tag } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { memo, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { checkout } from '../lib/actions'
import { hashColor, initials, laneColor, relativeTime, shortHash } from '../lib/format'
import { getLog, loadMore, updateRepo, useStore, type RepoView } from '../lib/store'
import { GraphCell, LANE_W, ROW_H, WipCell } from './GraphCell'
import { GraphMenu } from './menus'
import { Spinner } from './ui'

const REFS_W = 160
const AUTHOR_W = 140
const DATE_W = 100
const SHA_W = 68
const MAX_LANES = 24
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

function pillsFor(refs: Ref[], headBranch: string | undefined): Pill[] {
  const byName = new Map<string, Pill>()
  const out: Pill[] = []
  for (const r of refs) {
    if (r.kind === 'stash') continue
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

export function Graph({ view }: { view: RepoView }) {
  const log = getLog(view.id)
  const snap = view.snapshot
  const showWip = snap.status.length > 0 || !snap.head.hash
  const offset = showWip ? 1 : 0
  const count = log.commits.length + offset + (log.done ? 0 : 1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
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
  const graphW = Math.min(log.maxWidth, MAX_LANES) * LANE_W + 12

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

  const select = (i: number) => {
    if (i < 0 || i >= count) return
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
    else if (e.key === 'PageDown') { e.preventDefault(); select(Math.min(count - 1, cur + 20)) }
    else if (e.key === 'PageUp') { e.preventDefault(); select(Math.max(0, cur - 20)) }
    else if (e.key === 'Home') { e.preventDefault(); select(0) }
    else if (e.key === 'End') { e.preventDefault(); select(count - 1) }
  }

  return (
    // @container: the author, date and SHA columns appear only when the pane is wide enough,
    // so the commit message never gets squeezed out (container queries, not window size,
    // because the side panels decide how wide this pane is).
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center border-b border-line bg-panel text-[11px] font-semibold tracking-wide whitespace-nowrap text-faint uppercase">
        <div style={{ width: REFS_W }} className="shrink-0 truncate px-3">Branch / Tag</div>
        <div style={{ width: graphW }} className="shrink-0 truncate px-1">Graph</div>
        <div className="min-w-0 flex-1 truncate px-2">Commit message</div>
        <div style={{ width: AUTHOR_W }} className={clsx('shrink-0 truncate px-2', COL_AUTHOR)}>Author</div>
        <div style={{ width: DATE_W }} className={clsx('shrink-0 truncate px-2', COL_DATE)}>Date</div>
        <div style={{ width: SHA_W }} className={clsx('shrink-0 truncate px-2', COL_SHA)}>SHA</div>
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
                const style = { position: 'absolute' as const, top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${item.start}px)` }
                if (showWip && i === 0) {
                  return <WipRow key="wip" style={style} view={view} graphW={graphW} selected={view.selected.kind === 'wip'} />
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
                    style={style}
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

function WipRow({ style, view, graphW, selected }: { style: React.CSSProperties; view: RepoView; graphW: number; selected: boolean }) {
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
      <div style={{ width: REFS_W }} className="shrink-0 px-3" />
      <WipCell width={graphW} hasHead={!!view.snapshot.head.hash} />
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2 whitespace-nowrap text-muted italic">
        <span className="min-w-0 truncate">{view.snapshot.head.hash ? '// WIP: uncommitted changes' : '// No commits yet'}</span>
        {st.length > 0 && <span className="shrink-0 rounded bg-raised px-1.5 text-[11px] not-italic">{st.length} changed</span>}
        {staged > 0 && <span className="shrink-0 rounded bg-add-bg px-1.5 text-[11px] text-add not-italic">{staged} staged</span>}
        {conflicts > 0 && <span className="shrink-0 rounded bg-del-bg px-1.5 text-[11px] text-del not-italic">{conflicts} conflicts</span>}
      </div>
    </div>
  )
}

const CommitRow = memo(function CommitRow(props: {
  style: React.CSSProperties
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
}) {
  const { commit, row, repoId } = props
  const [dropping, setDropping] = useState(false)
  const pills = useMemo(() => (props.refs ? pillsFor(props.refs, props.headBranch) : []), [props.refs, props.headBranch])

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
      style={props.style}
      data-testid="commit-row"
      data-hash={commit.hash}
      onClick={() => updateRepo(repoId, { selected: { kind: 'commit', hash: commit.hash } })}
      onContextMenu={() => useStore.setState({ menu: { kind: 'commit', hash: commit.hash } })}
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
      <GraphCell row={row} width={props.graphW} showPending={props.showPending} isHead={props.isHead} />
      <div className={clsx('min-w-0 flex-1 truncate px-2', props.hit && 'font-semibold text-fg')}>{commit.subject}</div>
      <div style={{ width: AUTHOR_W }} className={clsx('min-w-0 shrink-0 items-center gap-1.5 px-2 text-muted', COL_AUTHOR)}>
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
          style={{ background: laneColor(hashColor(commit.authorEmail)) }}>{initials(commit.authorName)}</span>
        <span className="truncate">{commit.authorName}</span>
      </div>
      <div style={{ width: DATE_W }} className={clsx('shrink-0 truncate px-2 text-muted', COL_DATE)}>{relativeTime(commit.authorDate)}</div>
      <div style={{ width: SHA_W }} className={clsx('shrink-0 px-2 font-mono text-xs text-faint', COL_SHA)}>{shortHash(commit.hash)}</div>
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
      onContextMenu={(e) => {
        e.stopPropagation()
        useStore.setState({ menu: { kind: 'ref', ref, hash } })
      }}
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
