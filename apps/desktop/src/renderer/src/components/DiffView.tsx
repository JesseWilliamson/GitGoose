import type { BlameLine, Commit, DiffTarget, FileDiff, HunkSelection, ReviewFinding } from '@gitgoose/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { Ellipsis, Minus, Plus } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AskPanel } from './AskPanel'
import { Avatar } from './Avatar'
import { CodePeekPanel, identifierFromClick } from './CodePeek'
import { ImageDiff, imageMime } from './ImageDiff'

type SvgView = 'image' | 'text'
/** The last choice for SVGs, kept while the app runs: it tends to hold across files. */
let lastSvgView: SvgView = 'image'
import { discard, openDiffTool, openFile, openInEditor, restoreFileFrom, run } from '../lib/actions'
import { api } from '../lib/api'
import { formatDate, relativeTime, shortHash, splitPath } from '../lib/format'
import { pairs, segments, splitRows, wordDiff, type Ranges } from '../lib/diffLayout'
import { tokenize, type Tokens } from '../lib/highlight'
import { heatByCommit, heatColor } from '../lib/heat'
import { avatarSrc } from '../lib/avatar'
import { codeLineHeight, ensureLoaded, reportError, saveSettings, updateRepo, useSetting, type FileMode, type RepoView } from '../lib/store'
import { Button, DM, Segmented, Spinner } from './ui'
import { findingsFor } from '../lib/review'


/**
 * One file in Details, under the commit (or working copy, or comparison) it belongs to (ADR-011):
 * its diff, its history or its blame. It has no close: what Details shows follows the selection
 * (lib/openFile.ts), so the way to another file is a click in the list above.
 */
export function FileView({ view, target, mode }: { view: RepoView; target: DiffTarget; mode: FileMode }) {
  const setMode = (m: FileMode) => openFile(view.id, target, m)
  const { dir, name } = splitPath(target.path)
  const where = target.kind === 'commit' ? `in ${shortHash(target.hash)}`
    : target.kind === 'range' ? `${shortHash(target.from)} → ${target.to ? shortHash(target.to) : 'working tree'}`
    : target.kind === 'staged' ? 'staged' : target.kind === 'untracked' ? 'untracked' : 'unstaged'
  const layout = useSetting('diffLayout')
  /** The revision this file view is "at", for blame, restore, open and save. */
  const rev = target.kind === 'commit' ? target.hash : target.kind === 'range' ? (target.to ?? undefined) : undefined

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="file-view">
      {/* The name, then the controls; in a narrow Details the controls wrap onto a second line
          rather than pushing the name out of sight. */}
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-card px-3 py-1.5">
        <div className="min-w-0 flex-1 basis-48 truncate text-sm" data-testid="file-view-name">
          <span className="text-hint">{dir}</span><span className="font-semibold">{name}</span>
          <span className="ml-2 text-xs text-muted-foreground">{where}</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {mode === 'diff' && (
            <Segmented label="Diff layout" value={layout} onChange={(l) => void saveSettings({ diffLayout: l })} testId={(l) => `layout-${l}`}
              options={[{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Split' }]} />
          )}
          <Segmented label="View" value={mode} onChange={setMode} testId={(m) => `mode-${m}`}
            options={[{ value: 'diff', label: 'Diff' }, { value: 'history', label: 'History' }, { value: 'blame', label: 'Blame' }]} />
          {mode === 'diff' && <FileActions view={view} target={target} />}
          <FileMenu view={view} target={target} mode={mode} rev={rev} />
        </div>
      </div>
      {mode === 'diff' && <DiffPane view={view} target={target} />}
      {mode === 'history' && <HistoryPane view={view} path={target.path} />}
      {mode === 'blame' && <BlamePane view={view} path={target.path} rev={rev} />}
    </div>
  )
}

// ------------------------------------------------------------------ diff

/** Code panes use the code font settings (Settings → Appearance), set as CSS variables in applyTheme. */
const CODE_STYLE: React.CSSProperties = {
  fontFamily: 'var(--gs-code-font)', fontSize: 'var(--gs-code-size)', tabSize: 'var(--gs-tab-size)' as unknown as number,
}

type Item =
  | { kind: 'hunk'; hunk: number }
  | { kind: 'line'; hunk: number; line: number }
  /** Split view: a removed line (left) beside the added line paired with it (right). */
  | { kind: 'row'; hunk: number; left: number | null; right: number | null }

/** Which change lines are selected, per hunk. */
type Sel = Map<number, Set<number>>

function DiffPane({ view, target }: { view: RepoView; target: DiffTarget }) {
  const context = useSetting('contextLines')
  const ignoreWhitespace = useSetting('ignoreWhitespace')
  const split = useSetting('diffLayout') === 'split'
  // Side by side, each half is narrow: wrap rather than scroll two columns sideways.
  const wrap = useSetting('wrapLines') || split
  const highlight = useSetting('syntaxHighlighting')
  const highlightMaxKb = useSetting('highlightMaxKb')
  const lineH = codeLineHeight(useSetting('codeFontSize'))
  const [diff, setDiff] = useState<FileDiff | null | undefined>(undefined)
  const [tokens, setTokens] = useState<{ old: Tokens | null; new: Tokens | null } | null>(null)
  const [sel, setSel] = useState<Sel>(new Map())
  const anchor = useRef<{ hunk: number; line: number } | null>(null)
  const key = JSON.stringify(target)
  // Working-tree diffs reload when files change; diffs between revisions never change.
  const reloadOn = target.kind === 'commit' || (target.kind === 'range' && target.to) ? 0 : `${view.worktreeTick}:${JSON.stringify(view.snapshot.status)}`

  useEffect(() => {
    let live = true
    api.diff(view.id, target, { context, ignoreWhitespace }).then((d) => {
      if (!live) return
      setDiff(d)
      setSel(new Map())
    }, (e) => {
      if (!live) return
      setDiff(null)
      reportError('Could not load diff', e)
    })
    return () => { live = false }
  }, [view.id, key, reloadOn, context, ignoreWhitespace])

  // Highlight the old and new sides separately, so each is real source the grammar understands.
  useEffect(() => {
    setTokens(null)
    if (!diff || diff.binary || !highlight) return
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const h of diff.hunks) for (const l of h.lines) {
      if (l.kind !== '+') oldLines.push(l.text)
      if (l.kind !== '-') newLines.push(l.text)
    }
    if (oldLines.length + newLines.length > 20_000) return
    const dark = document.documentElement.dataset.theme !== 'light'
    let live = true
    const max = highlightMaxKb * 1024
    Promise.all([tokenize(oldLines.join('\n'), diff.path, dark, max), tokenize(newLines.join('\n'), diff.path, dark, max)])
      .then(([o, n]) => live && setTokens({ old: o, new: n }), () => {})
    return () => { live = false }
  }, [diff, highlight, highlightMaxKb])

  const { items, tokenIndex, words } = useMemo(() => {
    const items: Item[] = []
    const tokenIndex: { side: 'old' | 'new'; i: number }[][] = []
    /** Changed-word ranges per hunk and line, for lines paired with a counterpart. */
    const words: Map<number, Ranges>[] = []
    let oi = 0
    let ni = 0
    diff?.hunks.forEach((h, hi) => {
      items.push({ kind: 'hunk', hunk: hi })
      tokenIndex[hi] = []
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
      if (split) for (const r of splitRows(h)) items.push({ kind: 'row', hunk: hi, left: r.left, right: r.right })
      h.lines.forEach((l, li) => {
        if (!split) items.push({ kind: 'line', hunk: hi, line: li })
        if (l.kind === '-') tokenIndex[hi]![li] = { side: 'old', i: oi++ }
        else if (l.kind === '+') tokenIndex[hi]![li] = { side: 'new', i: ni++ }
        else {
          tokenIndex[hi]![li] = { side: 'new', i: ni++ }
          oi++
        }
      })
    })
    return { items, tokenIndex, words }
  }, [diff, split])

  const scrollRef = useRef<HTMLDivElement>(null)
  // AI review findings on this diff's lines (when its new side is what was reviewed).
  const findings = findingsFor(view, target)
  const findingAt = (newNo?: number) => (newNo === undefined ? undefined : findings.find((f) => newNo >= f.startLine && newNo <= f.endLine))
  const marker = (f: ReviewFinding | undefined) => f && (
    <span role="button" data-testid="finding-marker" title={`${f.severity}: ${f.title} (click for the review)`}
      // pointerdown, not mousedown: cancelling it also stops the mousedown that would select the
      // line (browsers skip mouse events after a cancelled pointerdown), and a pointerdown
      // cancelled further up would otherwise swallow our mousedown the same way.
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        updateRepo(view.id, (v) => (v.review ? { review: { ...v.review, focus: f.id }, center: { kind: 'review' } } : {}))
      }}
      className={clsx('absolute inset-y-0 left-0 w-1 cursor-pointer', f.severity === 'critical' || f.severity === 'major' ? 'bg-destructive' : f.severity === 'minor' ? 'bg-warn' : 'bg-muted-foreground/70')} />
  )
  /** The name Code Peek shows (Ctrl/Cmd+click in the diff), or null. */
  const [peek, setPeek] = useState<string | null>(null)
  /** An SVG is text to git but a picture to its author: shown rendered, or as a text diff. */
  const [svgView, setSvgView] = useState<SvgView>(lastSvgView)
  const pickSvgView = (v: SvgView) => { lastSvgView = v; setSvgView(v) }
  const peekRev = target.kind === 'commit' ? target.hash : target.kind === 'range' ? target.to : null
  // A hunk header carries buttons (h-row 24), so it is a row of its own height rather than a code
  // line's: at small code sizes the buttons used to stick out of it.
  const hunkH = Math.max(lineH, 28)
  // Wrapped lines have different heights, so the virtualizer measures each row; otherwise rows
  // are a fixed height derived from the code font size (no measuring, cheaper scrolling).
  const virt = useVirtualizer({
    count: items.length, getScrollElement: () => scrollRef.current, overscan: 30,
    estimateSize: (i) => (items[i]?.kind === 'hunk' ? hunkH : lineH),
    ...(wrap ? { measureElement: (el: Element) => el.getBoundingClientRect().height } : {}),
  })
  useEffect(() => virt.measure(), [lineH, hunkH, wrap, split, virt])

  if (diff === undefined) return <div className="flex flex-1 items-center justify-center text-hint"><Spinner /></div>
  if (diff === null) return <div className="flex flex-1 items-center justify-center text-sm text-hint">No changes to show</div>

  // Line and hunk staging work on the diff as shown; with whitespace hidden, the patch would
  // carry changes the user never saw, so it is switched off (whole-file staging still works).
  const editable = (target.kind === 'unstaged' || target.kind === 'staged' || target.kind === 'untracked') && !ignoreWhitespace
  const selectedCount = [...sel.values()].reduce((n, s) => n + s.size, 0)

  const apply = (action: 'stage' | 'unstage' | 'discard', hunks: HunkSelection[]) => {
    if (target.kind === 'commit' || target.kind === 'range') return
    const label = { stage: 'Stage', unstage: 'Unstage', discard: 'Discard' }[action]
    void run(view.id, `${label} ${hunks.some((h) => h.lines) ? 'lines' : 'hunk'}`, () => api.applySelection(view.id, { target, action, hunks, context }), {
      quiet: action !== 'discard',
    })
  }
  const selectionHunks = (): HunkSelection[] => [...sel.entries()].filter(([, s]) => s.size).map(([hunk, s]) => ({ hunk, lines: [...s] }))

  /**
   * One line's stage/unstage button, shown in its gutter on hover. The affordance used to be a
   * sentence above the diff telling people to click lines; a + where the line is says it without
   * words, and takes one click instead of select-then-press. Selection still does ranges.
   */
  const lineButton = (hunk: number, line: number, kind: string) => {
    if (!editable || kind === ' ') return null
    const staged = target.kind === 'staged'
    const label = staged ? 'Unstage this line' : 'Stage this line'
    return (
      <button data-testid="line-apply" title={label} aria-label={label} style={{ height: lineH }}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
        onClick={(e) => { e.stopPropagation(); apply(staged ? 'unstage' : 'stage', [{ hunk, lines: [line] }]) }}
        className={clsx('absolute top-0 left-0 z-10 hidden w-[18px] items-center justify-center rounded-sm font-sans text-background group-hover:flex',
          staged ? 'bg-muted-foreground hover:brightness-110' : 'bg-add hover:brightness-110')}>
        {staged ? <Minus size={12} /> : <Plus size={12} />}
      </button>
    )
  }

  const toggle = (hunk: number, line: number, shift: boolean) => {
    if (!editable) return
    const l = diff.hunks[hunk]!.lines[line]!
    if (l.kind === ' ') return
    setSel((prev) => {
      const next = new Map(prev)
      const set = new Set(next.get(hunk) ?? [])
      if (shift && anchor.current && anchor.current.hunk === hunk) {
        const [a, b] = [anchor.current.line, line].sort((x, y) => x - y)
        for (let i = a!; i <= b!; i++) if (diff.hunks[hunk]!.lines[i]!.kind !== ' ') set.add(i)
      } else if (set.has(line)) set.delete(line)
      else set.add(line)
      next.set(hunk, set)
      return next
    })
    anchor.current = { hunk, line }
  }

  /** What is selected, and what can be done with it: only here while a selection exists. */
  const selectionActions = selectedCount === 0 || target.kind === 'commit' || target.kind === 'range' ? null : (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{selectedCount} {selectedCount === 1 ? 'line' : 'lines'} selected</span>
      {target.kind !== 'staged' && <Button size="sm" variant="primary" data-testid="stage-lines" onClick={() => apply('stage', selectionHunks())}>Stage lines</Button>}
      {target.kind === 'staged' && <Button size="sm" variant="primary" onClick={() => apply('unstage', selectionHunks())}>Unstage lines</Button>}
      {target.kind === 'unstaged' && <Button size="sm" onClick={() => apply('discard', selectionHunks())}>Discard lines</Button>}
      <Button size="sm" variant="ghost" onClick={() => setSel(new Map())}>Clear</Button>
    </div>
  )

  const isSvg = !diff.binary && /\.svg$/i.test(target.path)
  const asImage = (diff.binary && !!imageMime(target.path)) || (isSvg && svgView === 'image')

  const hint = diff.oldPath ? `Renamed from ${diff.oldPath}`
    : !asImage && !editable && ignoreWhitespace && target.kind !== 'commit' && target.kind !== 'range' ? 'Whitespace changes are hidden, so line and hunk staging are off (Settings → Diff).' : ''

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {(selectionActions || hint || isSvg) && (
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3 text-xs">
          {isSvg && (
            <div className="flex shrink-0 items-center gap-1" data-testid="svg-view">
              {(['image', 'text'] as SvgView[]).map((v) => (
                <button key={v} onClick={() => pickSvgView(v)} aria-pressed={svgView === v}
                  className={clsx('rounded px-2 py-1', svgView === v ? 'bg-select font-medium' : 'text-muted-foreground hover:bg-accent')}>
                  {v === 'image' ? 'Image' : 'Text'}
                </button>
              ))}
            </div>
          )}
          <span className="min-w-0 flex-1 truncate text-muted-foreground" data-testid="diff-hint">{hint}</span>
          {selectionActions}
        </div>
      )}
      {asImage ? (
        <ImageDiff repoId={view.id} target={target} path={target.path} />
      ) : diff.binary ? (
        <div className="flex flex-1 items-center justify-center text-sm text-hint">Binary file</div>
      ) : diff.hunks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-hint">{diff.change === 'added' ? 'Empty file' : 'Only the file mode changed'}</div>
      ) : (
        <div ref={scrollRef} className="selectable min-h-0 flex-1 overflow-auto" style={CODE_STYLE} data-testid="diff-lines"
          onMouseDownCapture={(e) => {
            // Ctrl/Cmd+click a name: peek at it (before line selection sees the click).
            const name = identifierFromClick(e)
            if (!name) return
            e.preventDefault()
            e.stopPropagation()
            setPeek(name)
          }}>
          <div style={{ height: virt.getTotalSize(), position: 'relative', minWidth: '100%' }} className={wrap ? 'w-full' : 'w-max'}>
            {virt.getVirtualItems().map((vi) => {
              const it = items[vi.index]!
              const h = it.kind === 'hunk' ? hunkH : lineH
              const style = {
                position: 'absolute' as const, top: 0, left: 0, minWidth: '100%', transform: `translateY(${vi.start}px)`,
                ...(wrap ? { minHeight: h, right: 0 } : { height: h, lineHeight: `${h}px` }),
              }
              const hunk = diff.hunks[it.hunk]!
              if (it.kind === 'hunk') {
                return (
                  <div key={vi.key} ref={wrap ? virt.measureElement : undefined} data-index={vi.index} style={style} className="flex items-center gap-2 border-y border-border/50 bg-card pr-3 pl-2 text-hint">
                    <span className="sticky left-2 truncate">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ {hunk.section}</span>
                    {editable && (
                      <span className="sticky right-3 ml-auto flex gap-1 font-sans">
                        {target.kind !== 'staged' && <Button size="sm" data-testid="stage-hunk" onClick={() => apply('stage', [{ hunk: it.hunk }])}>Stage hunk</Button>}
                        {target.kind === 'staged' && <Button size="sm" onClick={() => apply('unstage', [{ hunk: it.hunk }])}>Unstage hunk</Button>}
                        {target.kind === 'unstaged' && <Button size="sm" variant="ghost" onClick={() => apply('discard', [{ hunk: it.hunk }])}>Discard hunk</Button>}
                      </span>
                    )}
                  </div>
                )
              }
              const textOf = (li: number) => {
                const ti = tokenIndex[it.hunk]![li]!
                const l = hunk.lines[li]!
                return <LineText text={l.text} tokens={tokens?.[ti.side]?.[ti.i] ?? null} ranges={words[it.hunk]!.get(li) ?? []} kind={l.kind} noNewline={l.noNewline} />
              }
              if (it.kind === 'row') {
                const half = (li: number | null, side: 'left' | 'right') => {
                  if (li === null) return <div className={clsx('flex w-1/2 min-w-0 bg-card/40', side === 'right' && 'border-l border-border')} />
                  const l = hunk.lines[li]!
                  const selected = sel.get(it.hunk)?.has(li) ?? false
                  return (
                    <div data-testid="diff-cell" data-kind={l.kind} data-side={side} data-new={side === 'right' ? l.newNo : undefined}
                      onMouseDown={(e) => { if (l.kind !== ' ' && e.button === 0 && e.detail === 1) { e.preventDefault(); toggle(it.hunk, li, e.shiftKey) } }}
                      className={clsx('group flex w-1/2 min-w-0 whitespace-pre-wrap break-all', side === 'right' && 'border-l border-border',
                        l.kind === '+' && 'bg-add-bg', l.kind === '-' && 'bg-del-bg', l.kind !== ' ' && editable && 'cursor-pointer',
                        selected && 'ring-1 ring-primary ring-inset brightness-125')}>
                      <span className={clsx('relative w-10 shrink-0 pr-1 text-right text-hint', selected && 'bg-select')}>
                        {side === 'right' && marker(findingAt(l.newNo))}
                        {lineButton(it.hunk, li, l.kind)}
                        {side === 'left' ? (l.oldNo ?? '') : (l.newNo ?? '')}
                      </span>
                      <span className="min-w-0 flex-1 pr-2 pl-2">{textOf(li)}</span>
                    </div>
                  )
                }
                return (
                  <div key={vi.key} style={style} ref={virt.measureElement} data-index={vi.index} data-testid="diff-row" className="flex">
                    {half(it.left, 'left')}
                    {half(it.right, 'right')}
                  </div>
                )
              }
              const line = hunk.lines[it.line]!
              const selected = sel.get(it.hunk)?.has(it.line) ?? false
              return (
                <div key={vi.key} style={style} ref={wrap ? virt.measureElement : undefined} data-index={vi.index}
                  data-testid="diff-line" data-kind={line.kind} data-new={line.newNo}
                  onMouseDown={(e) => { if (line.kind !== ' ' && e.button === 0 && e.detail === 1) { e.preventDefault(); toggle(it.hunk, it.line, e.shiftKey) } }}
                  onDoubleClick={() => { if (target.kind !== 'commit') void openInEditor(`${view.snapshot.path}/${target.path}`, line.newNo ?? line.oldNo ?? 1) }}
                  title={target.kind !== 'commit' ? 'Double-click to open in your editor at this line' : undefined}
                  className={clsx('group flex', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre', line.kind === '+' && 'bg-add-bg', line.kind === '-' && 'bg-del-bg',
                    line.kind !== ' ' && editable && 'cursor-pointer', selected && 'ring-1 ring-primary ring-inset brightness-125')}>
                  <span className={clsx('sticky left-0 flex w-[84px] shrink-0 self-stretch bg-background text-right text-hint', selected && 'bg-select')}>
                    {line.kind !== '-' && marker(findingAt(line.newNo))}
                    {lineButton(it.hunk, it.line, line.kind)}
                    <span className="w-9 pr-1">{line.oldNo ?? ''}</span>
                    <span className="w-9 pr-1">{line.newNo ?? ''}</span>
                    <span className={clsx('w-3 text-center', line.kind === '+' && 'text-add', line.kind === '-' && 'text-destructive')}>{line.kind === ' ' ? '' : line.kind}</span>
                  </span>
                  <span className="min-w-0 pr-4 pl-2">{textOf(it.line)}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {peek && <CodePeekPanel repoId={view.id} repoPath={view.snapshot.path} name={peek} rev={peekRev} onClose={() => setPeek(null)} />}
      {view.ask && view.ask.path === target.path && <AskPanel repoId={view.id} ask={view.ask} />}
    </div>
  )
}

/** A line's text: syntax colours, with the words that changed (against its paired line) marked. */
function LineText({ text, tokens, ranges, kind, noNewline }: {
  text: string; tokens: { content: string; color?: string }[] | null; ranges: Ranges; kind: ' ' | '+' | '-'; noNewline?: boolean
}) {
  const segs = segments(text, tokens, ranges)
  return (
    <>
      {segs.map((s, k) => (
        <span key={k} style={{ color: s.color }} data-changed={s.changed || undefined}
          className={s.changed ? (kind === '+' ? 'rounded-sm bg-add/30' : 'rounded-sm bg-destructive/30') : undefined}>{s.text}</span>
      ))}
      {noNewline && <span className="ml-2 text-hint" title="No newline at end of file">⏎̸</span>}
    </>
  )
}

/**
 * Stage / unstage / discard this whole file, in the view's own bar beside the layout and mode
 * controls. They are the file's actions, not the diff's, so they live with the file's title
 * instead of in a second bar under it; the diff's bar below is now only there when the diff has
 * something to say (a rename, an SVG's view, a line selection).
 */
function FileActions({ view, target }: { view: RepoView; target: DiffTarget }) {
  if (target.kind === 'commit' || target.kind === 'range') return null
  if (target.kind === 'staged') {
    return <Button size="sm" data-testid="unstage-file" onClick={() => void run(view.id, 'Unstage', () => api.unstagePaths(view.id, [target.path]), { quiet: true })}>Unstage file</Button>
  }
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button size="sm" data-testid="stage-file" onClick={() => void run(view.id, 'Stage', () => api.stagePaths(view.id, [target.path]), { quiet: true })}>Stage file</Button>
      <Button size="sm" variant="ghost" data-testid="discard-file" onClick={() => void discard(view.id, [target.path])}>
        {target.kind === 'untracked' ? 'Delete file' : 'Discard file'}
      </Button>
    </div>
  )
}

/**
 * The file's less-used actions in one menu: what can be done with this version of it (open it,
 * save it, restore it; only when the view is at a revision) and the external diff tool. Hidden
 * when there is nothing in it.
 */
function FileMenu({ view, target, mode, rev }: { view: RepoView; target: DiffTarget; mode: FileMode; rev: string | undefined }) {
  const path = target.path
  const diffTool = mode === 'diff' && target.kind !== 'untracked'
  if (!rev && !diffTool) return null
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button aria-label="File actions" title="File actions" data-testid="file-menu"
          className="no-drag flex size-row-lg items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground">
          <Ellipsis size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DM.Content align="end">
        {rev && (
          <>
            <DM.Label>This version</DM.Label>
            <DM.Item testId="revision-open" onSelect={() => void api.openFileAt(view.id, rev, path).catch((e) => reportError('Could not open the file', e))}>Open this version</DM.Item>
            <DM.Item testId="revision-save" onSelect={() => void api.saveFileAt(view.id, rev, path).catch((e) => reportError('Could not save the file', e))}>Save this version as…</DM.Item>
            <DM.Item testId="revision-restore" onSelect={() => void restoreFileFrom(view.id, path, rev)}>{view.stashes.some((s) => s.hash === rev) ? 'Take this file from the stash' : 'Restore the working copy to this version'}</DM.Item>
          </>
        )}
        {rev && diffTool && <DM.Separator />}
        {diffTool && <DM.Item testId="open-diff-tool" title="Open in your external diff tool (Settings → Diff)" onSelect={() => void openDiffTool(view.id, target)}>Open in diff tool</DM.Item>}
      </DM.Content>
    </DropdownMenu.Root>
  )
}

// ------------------------------------------------------------------ history

function HistoryPane({ view, path }: { view: RepoView; path: string }) {
  const dateFormat = useSetting('dateFormat')
  const [commits, setCommits] = useState<Commit[] | null>(null)
  useEffect(() => {
    setCommits(null)
    api.fileHistory(view.id, path).then(setCommits, (e) => reportError('Could not load history', e))
  }, [view.id, path])
  if (!commits) return <div className="flex flex-1 items-center justify-center text-hint"><Spinner /></div>
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="file-history">
      {commits.length === 0 && <div className="p-4 text-sm text-hint">No commits touch this file yet.</div>}
      {commits.map((c) => (
        <button key={c.hash}
          onClick={() => openFile(view.id, { kind: 'commit', hash: c.hash, path }, 'diff')}
          className="flex w-full items-center gap-3 border-b border-border/50 px-4 py-2 text-left text-sm hover:bg-accent">
          <span className="font-mono text-xs text-hint">{shortHash(c.hash)}</span>
          <span className="min-w-0 flex-1 truncate">{c.subject}</span>
          <span className="text-xs text-muted-foreground">{c.authorName}</span>
          <span className="w-24 text-right text-xs text-hint">{formatDate(c.authorDate, dateFormat)}</span>
        </button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ blame

function BlamePane({ view, path, rev }: { view: RepoView; path: string; rev?: string }) {
  const [lines, setLines] = useState<BlameLine[] | null>(null)
  useEffect(() => {
    setLines(null)
    api.blame(view.id, path, rev).then(setLines, (e) => {
      setLines([])
      reportError('Could not blame this file', e)
    })
  }, [view.id, path, rev])
  const scrollRef = useRef<HTMLDivElement>(null)
  const lineH = codeLineHeight(useSetting('codeFontSize'))
  const virt = useVirtualizer({ count: lines?.length ?? 0, getScrollElement: () => scrollRef.current, estimateSize: () => lineH, overscan: 30 })
  useEffect(() => virt.measure(), [lineH, virt])
  const heats = useMemo(() => heatByCommit(lines ?? []), [lines])
  const avatars = useSetting('avatars')
  if (!lines) return <div className="flex flex-1 items-center justify-center text-hint"><Spinner /></div>
  return (
    <div ref={scrollRef} className="selectable min-h-0 flex-1 overflow-auto" style={CODE_STYLE} data-testid="blame">
      <div style={{ height: virt.getTotalSize(), position: 'relative' }} className="w-max min-w-full">
        {virt.getVirtualItems().map((vi) => {
          const l = lines[vi.index]!
          const first = vi.index === 0 || lines[vi.index - 1]!.hash !== l.hash
          // The heatmap: one colour per commit by how recent it is, so new changes stand out
          // whichever branch they came from (see lib/heat.ts).
          const h = heats.get(l.hash) ?? 0
          const heat = heatColor(h)
          return (
            <div key={vi.key} style={{ position: 'absolute', top: 0, left: 0, minWidth: '100%', height: lineH, lineHeight: `${lineH}px`, transform: `translateY(${vi.start}px)` }}
              className={clsx('flex whitespace-pre', first && vi.index > 0 && 'border-t border-border/50')}>
              <span className="sticky left-0 flex w-[300px] shrink-0 items-center gap-2 pr-2 font-sans text-2xs"
                style={{ background: `color-mix(in srgb, ${heat} 14%, var(--gs-panel))` }}>
                <span className="h-full w-1 shrink-0" style={{ background: heat }} data-testid="blame-heat" data-heat={h} />
                {first && (
                  <button className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-primary" title={`${l.summary}\n${l.author} <${l.email}>`}
                    onClick={() => { updateRepo(view.id, { selected: { kind: 'commit', hash: l.hash } }); void ensureLoaded(view.id, l.hash) }}>
                    <span data-testid="blame-avatar" className="flex shrink-0">
                      <Avatar name={l.author} email={l.email} src={avatarSrc(l.email, avatars)} size={Math.min(16, lineH - 2)} />
                    </span>
                    <span className="font-mono text-hint">{shortHash(l.hash)}</span>
                    <span className="min-w-0 flex-1 truncate">{l.summary}</span>
                    <span className="text-hint">{l.author.split(' ')[0]}</span>
                    <span className="text-hint">{relativeTime(l.date)}</span>
                  </button>
                )}
              </span>
              <span className="w-10 shrink-0 pr-2 text-right text-hint">{l.lineNo}</span>
              <span className="pr-4">{l.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
