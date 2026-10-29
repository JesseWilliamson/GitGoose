import type { DiffTarget, FileDiff, HunkSelection, ReaderLayout, StreamFile } from '@gitgoose/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { Check, ChevronRight, Eye } from 'lucide-react'
import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { discard, openInEditor, run } from '../lib/actions'
import { api } from '../lib/api'
import { pairs, wordDiff, type Ranges } from '../lib/diffLayout'
import { formatDate, shortHash, splitPath } from '../lib/format'
import { tokenize, type Tokens } from '../lib/highlight'
import { codeLineHeight, getLog, setting, useSetting, type RepoView } from '../lib/store'
import { buildStream, cellsFor, digitsOf, numWidth, type StreamAnchor, fileKey, flowLines, ownerOf, rowAt, rowHeight, roomFor, targetOf, viewedKey, type FileState, type StreamBlock, type StreamRow } from '../lib/stream'
import { CODE_STYLE, LineText } from './DiffView'
import { Button } from './ui'

/**
 * The reader (ADR-012): every file of every block in one scrolling list, the way an editor shows a
 * file. One virtualizer over fixed-height rows (lib/stream.ts), so a 3,000-line file scrolls like
 * a 30-line one and jumping to a file lands on its first line exactly. One sticky header says where
 * you are (block, file, layout); the ruler on the right is the whole stream at a glance.
 */

export type { StreamAnchor } from '../lib/stream'

/** The keyboard's way into the reader (the reading cursor lives in the scene, the scrolling here). */
export interface StreamHandle {
  /** Next / previous file (n / p). */
  file(step: 1 | -1): void
  /** Next / previous block: a commit in a range (J / K). Returns false at either end. */
  block(step: 1 | -1): boolean
  /** A screen down or up (Space / Shift+Space), running on into the next file and block. False at the end. */
  page(step: 1 | -1): boolean
  /** Mark the file under the header viewed, or not (v). */
  toggleViewed(): void
  /** Scroll so a file's header is at the top. */
  showFile(blockIndex: number, path: string): void
  /** The file the header shows now. */
  current(): { block: number; file: StreamFile | null } | null
  /** The files of the block the header is in. */
  blockFiles(): StreamFile[] | null
  /** The selected lines, as the diff target and hunk selections they are in. */
  selection(): { target: DiffTarget; diff: FileDiff; hunks: HunkSelection[] } | null
  clearSelection(): void
}

/** The lines selected in one file (only one file at a time): hunk → line indexes. */
interface LineSel {
  key: string
  lines: Map<number, Set<number>>
}

interface Props {
  view: RepoView
  blocks: StreamBlock[]
  loadBlock: (i: number) => void
  loadFiles: (i: number, paths: string[]) => void
  /** Files marked viewed (by viewedKey), and how to change that. */
  viewed: ReadonlySet<string>
  onViewed: (key: string, viewed: boolean) => void
  initialAnchor?: StreamAnchor | null
  onAnchor?: (a: StreamAnchor) => void
  /** The header's current file changed. */
  onCurrent?: (c: { block: number; path: string | null }) => void
  /** Says what comes after the last block (the end card). */
  endCard?: ReactNode
  testId?: string
}

/** A row's identity, for keeping the reader's place when the rows are rebuilt. */
function rowKey(blocks: StreamBlock[], r: StreamRow): string {
  if (r.kind === 'end') return 'end'
  const b = blocks[r.block]!
  if (!('file' in r)) return `${b.key}\u0000${r.kind}`
  const f = b.files?.[r.file]
  const base = f ? fileKey(b, f) : `${b.key}\u0000#${r.file}`
  if (r.kind === 'file') return `${base}\u0000file`
  if (r.kind === 'hunk') return `${base}\u0000h${r.hunk}`
  if (r.kind === 'line') return `${base}\u0000l${r.hunk}:${r.line}`
  if (r.kind === 'split') return `${base}\u0000s${r.hunk}:${r.left}:${r.right}`
  if (r.kind === 'flow') return `${base}\u0000f${r.left}`
  return `${base}\u0000${r.kind}`
}
const fileOfKey = (k: string) => k.split('\u0000').slice(0, 2).join('\u0000')

/** The width of one cell of the code font, measured once per font. */
function useCharWidth(): number {
  const size = useSetting('codeFontSize')
  const family = useSetting('codeFontFamily')
  const [w, setW] = useState(7.2)
  useLayoutEffect(() => {
    const probe = document.createElement('span')
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', fontFamily: 'var(--gs-code-font)', fontSize: 'var(--gs-code-size)' })
    probe.textContent = 'M'.repeat(200)
    document.body.appendChild(probe)
    setW(probe.getBoundingClientRect().width / 200 || 7.2)
    probe.remove()
  }, [size, family])
  return w
}

export const DiffStream = forwardRef<StreamHandle, Props>(function DiffStream(props, ref) {
  const { view, blocks, viewed } = props
  const lineH = codeLineHeight(useSetting('codeFontSize'))
  const tabSize = useSetting('tabSize')
  const charPx = useCharWidth()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 1100, h: 780 })
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const room = useMemo(() => roomFor(box.w, box.h - 32, charPx, lineH, tabSize), [box.w, box.h, charPx, lineH, tabSize])
  const [states, setStates] = useState<ReadonlyMap<string, FileState>>(new Map())
  const setState = (key: string, s: FileState) => setStates((m) => new Map(m).set(key, { ...m.get(key), ...s }))
  const stream = useMemo(() => buildStream(blocks, room, states, { endCard: !!props.endCard }), [blocks, room, states, props.endCard])
  const { rows } = stream
  const working = (b: StreamBlock) => b.target.kind === 'unstaged' || b.target.kind === 'staged'
  const hunkH = Math.max(lineH, blocks.some(working) ? 28 : 24)
  const starts = useMemo(() => {
    const out: number[] = []
    let y = 0
    for (const r of rows) {
      out.push(y)
      y += rowHeight(r, lineH, hunkH)
    }
    return out
  }, [rows, lineH, hunkH])
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowHeight(rows[i]!, lineH, hunkH),
    overscan: 12,
  })
  useEffect(() => virt.measure(), [rows, lineH, hunkH, virt])

  // Keep the reader's place when the rows change under it (a diff arrives, a file opens, the
  // window narrows and a file switches layout): the row at the top stays at the top.
  const keys = useMemo(() => rows.map((r) => rowKey(blocks, r)), [rows, blocks])
  const keyIndex = useMemo(() => new Map(keys.map((k, i) => [k, i])), [keys])
  const top = useRef<{ key: string; offset: number } | null>(props.initialAnchor ?? null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    const a = top.current
    if (!el || !a) return
    let i = keyIndex.get(a.key)
    let offset = a.offset
    if (i === undefined) {
      // That row is gone (a pending file became its lines): its file's header, as far down as it was.
      const head = keyIndex.get(`${fileOfKey(a.key)}\u0000file`)
      if (head === undefined) return
      i = head
    }
    const y = starts[i]! + offset
    if (Math.abs(el.scrollTop - y) > 1) el.scrollTop = y
  }, [keyIndex, starts])
  const onScroll = () => {
    const el = scrollRef.current
    if (!el || !rows.length) return
    const i = rowAt(starts, el.scrollTop)
    top.current = { key: keys[i]!, offset: el.scrollTop - starts[i]! }
    props.onAnchor?.(top.current)
  }

  // What the sticky header shows: the file (and block) of the row at the top.
  const scrollTop = virt.scrollOffset ?? 0
  const topRow = rows.length ? rowAt(starts, scrollTop) : 0
  // On a block's header the reader is at the block's first file (the one just below).
  const ownerRow = rows[topRow]?.kind === 'block' && rows[topRow + 1]?.kind === 'file' ? topRow + 1 : topRow
  const owner = rows[ownerRow] ? ownerOf(rows[ownerRow]!) : null
  const curBlock = owner ? blocks[owner.block] : undefined
  const curFile = owner && owner.file !== null ? curBlock?.files?.[owner.file] ?? null : null
  const onCurrent = props.onCurrent
  useEffect(() => { if (owner) onCurrent?.({ block: owner.block, path: curFile?.path ?? null }) }, [owner?.block, curFile?.path, onCurrent]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load what comes into view: a block's file list, the diffs of files past the line budget.
  const items = virt.getVirtualItems()
  useEffect(() => {
    const pending = new Map<number, string[]>()
    for (const it of items) {
      const r = rows[it.index]
      if (!r) continue
      if (r.kind === 'block-loading') props.loadBlock(r.block)
      if (r.kind === 'pending') {
        // This file and the next few without diffs, in one request.
        const b = blocks[r.block]!
        const list = pending.get(r.block) ?? []
        let lines = 0
        for (let f = r.file; f < (b.files?.length ?? 0) && lines < 3000; f++) {
          const file = b.files![f]!
          if (file.diff || file.binary) continue
          list.push(file.path)
          lines += file.additions + file.deletions
        }
        pending.set(r.block, list)
      }
    }
    for (const [b, paths] of pending) props.loadFiles(b, [...new Set(paths)])
  }, [items, rows, blocks]) // eslint-disable-line react-hooks/exhaustive-deps

  // Syntax colours per file, computed when a file is first in view.
  const [tokens, setTokens] = useState<ReadonlyMap<string, { old: Tokens | null; new: Tokens | null }>>(new Map())
  const highlight = useSetting('syntaxHighlighting')
  const asked = useRef(new Set<string>())
  useEffect(() => {
    if (!highlight) return
    const dark = document.documentElement.dataset.theme !== 'light'
    const max = setting('highlightMaxKb') * 1024
    for (const it of items) {
      const r = rows[it.index]
      if (!r || !('file' in r)) continue
      const b = blocks[r.block]!
      const f = b.files?.[r.file]
      if (!f?.diff) continue
      const key = `${fileKey(b, f)}\u0000${f.diff.hunks.length}:${f.additions}:${f.deletions}`
      if (asked.current.has(key)) continue
      asked.current.add(key)
      const oldLines: string[] = []
      const newLines: string[] = []
      for (const h of f.diff.hunks) for (const l of h.lines) {
        if (l.kind !== '+') oldLines.push(l.text)
        if (l.kind !== '-') newLines.push(l.text)
      }
      if (oldLines.length + newLines.length > 20_000) continue
      void Promise.all([tokenize(oldLines.join('\n'), f.path, dark, max), tokenize(newLines.join('\n'), f.path, dark, max)])
        .then(([o, n]) => setTokens((m) => new Map(m).set(fileKey(b, f), { old: o, new: n })), () => {})
    }
  }, [items, rows, blocks, highlight])

  /** Per file: where each line's tokens are (old or new side, index) and its changed words. */
  const lineInfo = useRef(new Map<FileDiff, { tok: { side: 'old' | 'new'; i: number }[][]; words: Map<number, Ranges>[]; digits: number }>())
  const infoOf = (diff: FileDiff) => {
    let info = lineInfo.current.get(diff)
    if (info) return info
    const tok: { side: 'old' | 'new'; i: number }[][] = []
    const words: Map<number, Ranges>[] = []
    let oi = 0
    let ni = 0
    let maxNo = 1
    diff.hunks.forEach((h, hi) => {
      tok[hi] = []
      const w = new Map<number, Ranges>()
      for (const [a, b] of pairs(h)) {
        if (h.lines[a]!.kind !== '-') continue
        const d = wordDiff(h.lines[a]!.text, h.lines[b]!.text)
        if (d) {
          w.set(a, d.old)
          w.set(b, d.new)
        }
      }
      words[hi] = w
      h.lines.forEach((l, li) => {
        maxNo = Math.max(maxNo, l.oldNo ?? 0, l.newNo ?? 0)
        if (l.kind === '-') tok[hi]![li] = { side: 'old', i: oi++ }
        else if (l.kind === '+') tok[hi]![li] = { side: 'new', i: ni++ }
        else {
          tok[hi]![li] = { side: 'new', i: ni++ }
          oi++
        }
      })
    })
    info = { tok, words, digits: String(maxNo).length }
    lineInfo.current.set(diff, info)
    return info
  }

  // Line selection: in one file at a time. In the working copy it stages, unstages or discards
  // lines; in a commit it is what Shift+R reverts and what Ask asks about.
  const [sel, setSel] = useState<LineSel | null>(null)
  const anchorLine = useRef<{ hunk: number; line: number } | null>(null)
  const toggleLine = (key: string, diff: FileDiff, hunk: number, line: number, shift: boolean) => {
    const l = diff.hunks[hunk]?.lines[line]
    if (!l || l.kind === ' ') return
    setSel((prev) => {
      const lines = new Map(prev?.key === key ? prev.lines : [])
      const set = new Set(lines.get(hunk) ?? [])
      if (shift && anchorLine.current?.hunk === hunk && prev?.key === key) {
        const [a, b] = [anchorLine.current.line, line].sort((x, y) => x - y)
        for (let i = a!; i <= b!; i++) if (diff.hunks[hunk]!.lines[i]!.kind !== ' ') set.add(i)
      } else if (set.has(line)) set.delete(line)
      else set.add(line)
      lines.set(hunk, set)
      return { key, lines }
    })
    anchorLine.current = { hunk, line }
  }
  const selCount = sel ? [...sel.lines.values()].reduce((n, s) => n + s.size, 0) : 0
  const selFile = useMemo(() => {
    if (!sel) return null
    for (const b of blocks) for (const f of b.files ?? []) if (fileKey(b, f) === sel.key) return { b, f }
    return null
  }, [sel, blocks])
  useEffect(() => { if (sel && !selFile) setSel(null) }, [sel, selFile])
  const context = useSetting('contextLines')
  const ignoreWhitespace = useSetting('ignoreWhitespace')
  const apply = (target: DiffTarget, action: 'stage' | 'unstage' | 'discard', hunks: HunkSelection[]) => {
    if (target.kind !== 'unstaged' && target.kind !== 'staged' && target.kind !== 'untracked') return
    const label = { stage: 'Stage', unstage: 'Unstage', discard: 'Discard' }[action]
    setSel(null)
    void run(view.id, `${label} ${hunks.some((h) => h.lines) ? 'lines' : 'hunk'}`, () => api.applySelection(view.id, { target, action, hunks, context }), { quiet: action !== 'discard' })
  }
  const selHunks = (): HunkSelection[] => (sel ? [...sel.lines.entries()].filter(([, s]) => s.size).map(([hunk, s]) => ({ hunk, lines: [...s] })) : [])

  const scrollToRow = useCallback((i: number) => {
    const el = scrollRef.current
    if (!el || i < 0 || i >= starts.length) return
    el.scrollTop = starts[i]!
    onScroll()
  }, [starts]) // eslint-disable-line react-hooks/exhaustive-deps
  const fileRows = useMemo(() => rows.flatMap((r, i) => (r.kind === 'file' ? [i] : [])), [rows])

  useImperativeHandle(ref, () => ({
    file(step) {
      const at = rowAt(starts, (scrollRef.current?.scrollTop ?? 0) + 1)
      const next = step > 0 ? fileRows.find((i) => i > at) : [...fileRows].reverse().find((i) => i < at - 0)
      if (next !== undefined) scrollToRow(next)
    },
    block(step) {
      const at = rowAt(starts, (scrollRef.current?.scrollTop ?? 0) + 1)
      let cur = 0
      stream.blockStart.forEach((s, i) => { if (s <= at) cur = i })
      const to = cur + step
      if (to < 0 || to >= stream.blockStart.length) return false
      scrollToRow(stream.blockStart[to]!)
      return true
    },
    page(step) {
      const el = scrollRef.current
      if (!el) return false
      const was = el.scrollTop
      el.scrollTop += step * Math.max(lineH, el.clientHeight - 3 * lineH)
      onScroll()
      return el.scrollTop !== was
    },
    toggleViewed() {
      if (!curFile) return
      const k = viewedKey(curFile)
      props.onViewed(k, !viewed.has(k))
    },
    showFile(bi, path) {
      const b = blocks[bi]
      const f = b?.files?.find((x) => x.path === path)
      if (b && f) scrollToRow(stream.fileStart.get(fileKey(b, f)) ?? -1)
    },
    current: () => (owner ? { block: owner.block, file: curFile } : null),
    blockFiles: () => curBlock?.files ?? null,
    selection() {
      if (!selFile || !selFile.f.diff || !selCount) return null
      return { target: targetOf(selFile.b.target, selFile.f), diff: selFile.f.diff, hunks: selHunks() }
    },
    clearSelection: () => setSel(null),
  }))

  const totalH = virt.getTotalSize()
  const viewH = box.h

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1" data-testid={props.testId ?? 'diff-stream'}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {curBlock && curFile && rows[topRow]?.kind !== 'file' && (
          <div className="absolute inset-x-0 top-0 z-20 shadow-sm" data-testid="stream-sticky">
            <FileHeader view={view} block={curBlock} file={curFile} index={curBlock.files!.indexOf(curFile)}
              layout={stream.layouts.get(fileKey(curBlock, curFile))} state={states.get(fileKey(curBlock, curFile))}
              viewed={viewed.has(viewedKey(curFile))} onViewed={(v) => props.onViewed(viewedKey(curFile), v)}
              onState={(s) => setState(fileKey(curBlock, curFile), s)} sticky />
          </div>
        )}
        <div ref={scrollRef} onScroll={onScroll} className="selectable min-h-0 flex-1 overflow-y-auto overflow-x-hidden" style={CODE_STYLE} data-testid="stream-scroll" tabIndex={-1}>
          <div style={{ height: totalH, position: 'relative' }}>
            {items.map((it) => {
              const r = rows[it.index]!
              const style: React.CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, height: it.size, transform: `translateY(${it.start}px)` }
              return <Fragment key={keys[it.index]}>{renderRow(style, r)}</Fragment>
            })}
          </div>
        </div>
        {selFile && selCount > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center">
            <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs shadow-lg" data-testid="stream-selection">
              <span>{selCount} {selCount === 1 ? 'line' : 'lines'}</span>
              {selFile.b.target.kind === 'unstaged' && <Button size="sm" variant="primary" data-testid="stage-lines" onClick={() => apply(targetOf(selFile.b.target, selFile.f), 'stage', selHunks())}>Stage <kbd className="ml-1 opacity-70">S</kbd></Button>}
              {selFile.b.target.kind === 'staged' && <Button size="sm" variant="primary" onClick={() => apply(targetOf(selFile.b.target, selFile.f), 'unstage', selHunks())}>Unstage <kbd className="ml-1 opacity-70">U</kbd></Button>}
              {selFile.b.target.kind === 'unstaged' && !selFile.f.untracked && <Button size="sm" onClick={() => apply(targetOf(selFile.b.target, selFile.f), 'discard', selHunks())}>Discard</Button>}
              <Button size="sm" variant="ghost" onClick={() => setSel(null)}>Clear</Button>
            </div>
          </div>
        )}
      </div>
      <Ruler rows={rows} starts={starts} blocks={blocks} total={totalH} top={scrollTop} height={viewH} onJump={(y) => { if (scrollRef.current) scrollRef.current.scrollTop = y }} />
    </div>
  )

  function renderRow(style: React.CSSProperties, r: StreamRow): ReactNode {
    if (r.kind === 'end') return <div style={style} className="flex items-center justify-center font-sans" data-testid="stream-end">{props.endCard}</div>
    const b = blocks[r.block]!
    if (r.kind === 'block') return <div style={style}><BlockHeader view={view} block={b} /></div>
    if (r.kind === 'block-loading') return <div style={style} className="px-4 py-3 font-sans text-xs text-hint">Loading…</div>
    if (r.kind === 'block-empty') return <div style={style} className="px-4 py-3 font-sans text-xs text-hint" data-testid="stream-empty">No changes.</div>
    const f = b.files![r.file]!
    const key = fileKey(b, f)
    if (r.kind === 'file') {
      return (
        <div style={style} className="pt-1">
          <FileHeader view={view} block={b} file={f} index={r.file} layout={stream.layouts.get(key)} state={states.get(key)}
            viewed={viewed.has(viewedKey(f))} onViewed={(v) => props.onViewed(viewedKey(f), v)} onState={(s) => setState(key, s)} />
        </div>
      )
    }
    if (r.kind === 'collapsed') {
      return (
        <div style={style} className="flex items-center gap-2 px-4 font-sans text-xs text-hint" data-testid="stream-collapsed">
          <span>Collapsed: {r.reason}</span>
          <button className="rounded px-1.5 font-medium text-primary hover:bg-accent" onClick={() => setState(key, { open: true })}>Show</button>
        </div>
      )
    }
    if (r.kind === 'note') return <div style={style} className="flex items-center px-4 font-sans text-xs text-hint">{r.text}</div>
    if (r.kind === 'pending') return <div style={style} className="bg-[repeating-linear-gradient(0deg,transparent,transparent_18px,var(--gs-border)_19px)] opacity-30" data-testid="stream-pending" />
    const d = f.diff!
    const info = infoOf(d)
    const tk = tokens.get(key)
    const t = targetOf(b.target, f)
    const editable = working(b) && !ignoreWhitespace
    const lines = sel?.key === key ? sel.lines : null
    const numW = numWidth(digitsOf(d), charPx)
    const cells = cellsFor(room, digitsOf(d))
    if (r.kind === 'hunk') {
      const h = d.hunks[r.hunk]!
      return (
        <div style={style} className="flex items-center gap-2 border-y border-border/50 bg-card/60 pr-3 pl-3 text-hint">
          <span className="min-w-0 truncate">@@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@ {h.section}</span>
          {editable && (
            <span className="ml-auto flex shrink-0 gap-1 font-sans">
              {b.target.kind === 'unstaged' && <Button size="sm" data-testid="stage-hunk" onClick={() => apply(t, 'stage', [{ hunk: r.hunk }])}>Stage hunk</Button>}
              {b.target.kind === 'staged' && <Button size="sm" onClick={() => apply(t, 'unstage', [{ hunk: r.hunk }])}>Unstage hunk</Button>}
              {b.target.kind === 'unstaged' && !f.untracked && <Button size="sm" variant="ghost" onClick={() => apply(t, 'discard', [{ hunk: r.hunk }])}>Discard hunk</Button>}
            </span>
          )}
        </div>
      )
    }
    const text = (hunk: number, li: number, plain = false) => {
      const l = d.hunks[hunk]!.lines[li]!
      const ti = info.tok[hunk]![li]!
      return <LineText text={l.text} tokens={plain ? null : tk?.[ti.side]?.[ti.i] ?? null} ranges={info.words[hunk]!.get(li) ?? []} kind={l.kind} noNewline={l.noNewline} />
    }
    const cellStyle = (cells: number): React.CSSProperties => ({ width: Math.ceil(cells * charPx) + 2, lineHeight: `${lineH}px` })
    const onDown = (hunk: number, li: number) => (e: React.MouseEvent) => {
      const l = d.hunks[hunk]!.lines[li]!
      if (l.kind === ' ' || e.button !== 0 || e.detail !== 1) return
      e.preventDefault()
      toggleLine(key, d, hunk, li, e.shiftKey)
    }
    const isSel = (hunk: number, li: number | null) => li !== null && !!lines?.get(hunk)?.has(li)
    if (r.kind === 'line') {
      const l = d.hunks[r.hunk]!.lines[r.line]!
      return (
        <div style={style} data-testid="diff-line" data-kind={l.kind} data-new={l.newNo} onMouseDown={onDown(r.hunk, r.line)}
          onDoubleClick={() => { if (t.kind !== 'commit') void openInEditor(`${view.snapshot.path}/${f.path}`, l.newNo ?? l.oldNo ?? 1) }}
          className={clsx('group flex', l.kind === '+' && 'bg-add-bg', l.kind === '-' && 'bg-del-bg', l.kind !== ' ' && 'cursor-pointer', isSel(r.hunk, r.line) && 'ring-1 ring-primary ring-inset brightness-125')}>
          <span className="shrink-0 pr-1 text-right text-hint" style={{ width: numW, lineHeight: `${lineH}px` }}>{l.oldNo ?? ''}</span>
          <span className="shrink-0 pr-1 text-right text-hint" style={{ width: numW, lineHeight: `${lineH}px` }}>{l.newNo ?? ''}</span>
          <span className={clsx('w-4 shrink-0 text-center', l.kind === '+' && 'text-add', l.kind === '-' && 'text-destructive')} style={{ lineHeight: `${lineH}px` }}>{l.kind === ' ' ? '' : l.kind}</span>
          <span className="whitespace-pre-wrap break-all pl-1" style={cellStyle(cells.unified)}>{text(r.hunk, r.line)}</span>
        </div>
      )
    }
    if (r.kind === 'split') {
      const half = (li: number | null, side: 'left' | 'right') => {
        const h = d.hunks[r.hunk]!
        if (li === null) return <div className={clsx('flex w-1/2 min-w-0 bg-card/40', side === 'right' && 'border-l border-border')} />
        const l = h.lines[li]!
        return (
          <div data-testid="diff-cell" data-kind={l.kind} data-side={side} data-new={side === 'right' ? l.newNo : undefined} onMouseDown={onDown(r.hunk, li)}
            className={clsx('flex w-1/2 min-w-0', side === 'right' && 'border-l border-border', l.kind === '+' && 'bg-add-bg', l.kind === '-' && 'bg-del-bg',
              l.kind !== ' ' && 'cursor-pointer', isSel(r.hunk, li) && 'ring-1 ring-primary ring-inset brightness-125')}>
            <span className="shrink-0 pr-2 text-right text-hint" style={{ width: numW, lineHeight: `${lineH}px` }}>{side === 'left' ? l.oldNo : l.newNo}</span>
            <span className="whitespace-pre-wrap break-all pl-1" style={cellStyle(cells.splitSide)}>{text(r.hunk, li)}</span>
          </div>
        )
      }
      return <div style={style} className="flex" data-testid="diff-row">{half(r.left, 'left')}{half(r.right, 'right')}</div>
    }
    // Flow: a whole added or deleted file, read down the left column and on down the right. No red
    // or green under it (every line would be the same colour, and syntax colours on a tint lose
    // contrast): a bar at each column's edge says which it is.
    const fl = flowLines(d)
    const added = f.change === 'added' || d.hunks[0]?.lines[0]?.kind === '+'
    const col = (k: number | null, side: 'left' | 'right') => {
      if (k === null) return <div className={clsx('w-1/2', side === 'right' && 'border-l border-border')} />
      const { hunk, line } = fl[k]!
      const l = d.hunks[hunk]!.lines[line]!
      return (
        <div data-testid="flow-cell" data-side={side} data-kind={l.kind} onMouseDown={onDown(hunk, line)}
          className={clsx('flex w-1/2 min-w-0 cursor-pointer border-l-2', added ? 'border-add/60' : 'border-destructive/60', isSel(hunk, line) && 'bg-select')}>
          <span className="shrink-0 pr-2 text-right text-hint" style={{ width: numW, lineHeight: `${lineH}px` }}>{l.newNo ?? l.oldNo}</span>
          <span className="whitespace-pre-wrap break-all pl-1" style={cellStyle(cells.flowColumn)}>{text(hunk, line)}</span>
        </div>
      )
    }
    return <div style={style} className="flex gap-0" data-testid="flow-row">{col(r.left, 'left')}{col(r.right, 'right')}</div>
  }
})

const BADGE: Record<string, { letter: string; cls: string }> = {
  added: { letter: 'A', cls: 'text-add' }, modified: { letter: 'M', cls: 'text-warn' }, deleted: { letter: 'D', cls: 'text-destructive' },
  renamed: { letter: 'R', cls: 'text-primary' }, copied: { letter: 'C', cls: 'text-primary' }, typechange: { letter: 'T', cls: 'text-warn' }, unmerged: { letter: '!', cls: 'text-destructive' },
}
const NEXT_LAYOUT: Record<string, ReaderLayout | undefined> = { auto: 'unified', unified: 'split', split: 'flow', flow: undefined }

/** A file's header: what it is, how it is laid out (the chip cycles Auto → Unified → Split → Flow), viewed. */
function FileHeader({ view, block, file, index, layout, state, viewed, onViewed, onState, sticky }: {
  view: RepoView; block: StreamBlock; file: StreamFile; index: number
  layout?: { layout: ReaderLayout; reason: string }; state?: FileState
  viewed: boolean; onViewed: (v: boolean) => void; onState: (s: FileState) => void; sticky?: boolean
}) {
  const b = BADGE[file.untracked ? 'added' : file.change] ?? BADGE.modified!
  const { dir, name } = splitPath(file.path)
  const total = block.files?.length ?? 0
  const forced = state?.forced
  const t = targetOf(block.target, file)
  return (
    <div className={clsx('flex h-8 items-center gap-2 border-y border-border bg-panel px-3 font-sans text-sm', sticky && 'border-t-0')} data-testid={sticky ? 'stream-sticky-file' : 'stream-file'} data-path={file.path}>
      <span className="w-8 shrink-0 text-2xs text-hint tabular-nums">{index + 1}/{total}</span>
      <span className={clsx('w-3 shrink-0 text-center font-mono text-2xs font-bold', b.cls)}>{file.untracked ? 'U' : b.letter}</span>
      <span className="min-w-0 truncate" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        <span className="text-hint">{dir}</span><span className="font-semibold">{name}</span>
      </span>
      <span className="shrink-0 font-mono text-2xs"><span className="text-add">+{file.additions}</span> <span className="text-destructive">−{file.deletions}</span></span>
      {layout && layout.reason && (
        <button className="shrink-0 rounded px-1.5 text-2xs text-muted-foreground hover:bg-accent" data-testid="layout-chip" data-layout={layout.layout}
          title="How this file is laid out, and why. Click to choose another."
          onClick={() => onState({ forced: NEXT_LAYOUT[forced ?? 'auto'] })}>
          <span className="font-semibold capitalize text-foreground">{layout.layout}</span>{forced ? ' · chosen' : ` · ${layout.reason}`}
        </button>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {block.target.kind === 'unstaged' && (
          <>
            <Button size="sm" data-testid="stage-file" onClick={() => void run(view.id, 'Stage', () => api.stagePaths(view.id, [file.path]), { quiet: true })}>Stage file</Button>
            <Button size="sm" variant="ghost" data-testid="discard-file" onClick={() => void discard(view.id, [file.path])}>{file.untracked ? 'Delete' : 'Discard'}</Button>
          </>
        )}
        {block.target.kind === 'staged' && (
          <Button size="sm" data-testid="unstage-file" onClick={() => void run(view.id, 'Unstage', () => api.unstagePaths(view.id, [file.path]), { quiet: true })}>Unstage file</Button>
        )}
        {t.kind !== 'untracked' && (state?.open !== false) && (
          <button className="rounded p-1 text-hint hover:bg-accent" title="Collapse" onClick={() => onState({ open: false })}><ChevronRight size={12} className="rotate-90" /></button>
        )}
        <button onClick={() => onViewed(!viewed)} data-testid="viewed-toggle" aria-pressed={viewed} title="Mark viewed (V)"
          className={clsx('flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs', viewed ? 'text-add' : 'text-hint hover:bg-accent')}>
          {viewed ? <Check size={12} /> : <Eye size={12} />} Viewed
        </button>
      </span>
    </div>
  )
}

/** The band that opens a block: a commit's subject and who and when, or what part of the working copy. */
function BlockHeader({ view, block }: { view: RepoView; block: StreamBlock }) {
  const dateFormat = useSetting('dateFormat')
  const log = getLog(view.id)
  const c = block.hash ? log.commits[log.index.get(block.hash) ?? -1] : undefined
  const n = block.files?.length
  return (
    <div className="flex h-full flex-col justify-center gap-0.5 border-b border-border bg-card px-4 font-sans" data-testid="stream-block" data-hash={block.hash}>
      <div className="truncate text-sm font-semibold">{c?.subject ?? block.title}</div>
      <div className="flex gap-2 text-xs text-muted-foreground">
        {c && <span>{c.authorName}</span>}
        {c && <span>{formatDate(c.authorDate, dateFormat)}</span>}
        {block.hash && <span className="font-mono text-hint">{shortHash(block.hash)}</span>}
        {n !== undefined && <span>{n} {n === 1 ? 'file' : 'files'}</span>}
      </div>
    </div>
  )
}

/**
 * The whole stream at a glance, 14 px wide on the right: a mark per file (green where it mostly
 * adds, red where it mostly removes) at its place in the stream, and the part on screen. Click to jump.
 */
function Ruler({ rows, starts, blocks, total, top, height, onJump }: {
  rows: StreamRow[]; starts: number[]; blocks: StreamBlock[]; total: number; top: number; height: number; onJump: (y: number) => void
}) {
  const marks = useMemo(() => {
    const out: { y: number; h: number; cls: string }[] = []
    if (!total) return out
    rows.forEach((r, i) => {
      if (r.kind !== 'file') return
      const f = blocks[r.block]?.files?.[r.file]
      if (!f) return
      let end = i + 1
      while (end < rows.length && rows[end]!.kind !== 'file' && rows[end]!.kind !== 'block' && rows[end]!.kind !== 'end') end++
      const y0 = starts[i]!
      const y1 = end < starts.length ? starts[end]! : total
      out.push({ y: y0 / total, h: Math.max(0.004, (y1 - y0) / total), cls: f.additions >= f.deletions * 2 ? 'bg-add/60' : f.deletions >= f.additions * 2 ? 'bg-destructive/60' : 'bg-warn/50' })
    })
    return out
  }, [rows, starts, blocks, total])
  return (
    <div className="relative w-3.5 shrink-0 cursor-pointer border-l border-border bg-panel" data-testid="stream-ruler"
      onMouseDown={(e) => {
        const box = e.currentTarget.getBoundingClientRect()
        onJump(((e.clientY - box.top) / box.height) * total - height / 2)
      }}>
      {marks.map((m, i) => <div key={i} className={clsx('absolute inset-x-[3px] rounded-[1px]', m.cls)} style={{ top: `${m.y * 100}%`, height: `${m.h * 100}%` }} />)}
      {total > height && (
        <div className="pointer-events-none absolute inset-x-0 border-y border-foreground/40 bg-foreground/10" style={{ top: `${(top / total) * 100}%`, height: `${(height / total) * 100}%` }} />
      )}
    </div>
  )
}
