import type { BlameLine, Commit, DiffTarget, FileDiff, HunkSelection, ReviewFinding } from '@gitsquid/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { ChevronDown, ExternalLink, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CodePeekPanel, identifierFromClick } from './CodePeek'
import { ImageDiff, imageMime } from './ImageDiff'
import { discard, openDiffTool, openInEditor, restoreFileFrom, run } from '../lib/actions'
import { api } from '../lib/api'
import { formatDate, hashColor, laneColor, relativeTime, shortHash, splitPath } from '../lib/format'
import { pairs, segments, splitRows, wordDiff, type Ranges } from '../lib/diffLayout'
import { tokenize, type Tokens } from '../lib/highlight'
import { codeLineHeight, ensureLoaded, reportError, saveSettings, updateRepo, useSetting, type FileMode, type RepoView } from '../lib/store'
import { Button, DM, Spinner } from './ui'
import { modName } from '../lib/keys'
import { findingsFor } from '../lib/review'


export function FileView({ view, target, mode }: { view: RepoView; target: DiffTarget; mode: FileMode }) {
  const close = () => updateRepo(view.id, { center: { kind: 'graph' } })
  const setMode = (m: FileMode) => updateRepo(view.id, { center: { kind: 'file', target, mode: m } })
  const { dir, name } = splitPath(target.path)
  const where = target.kind === 'commit' ? `in ${shortHash(target.hash)}`
    : target.kind === 'range' ? `${shortHash(target.from)} → ${target.to ? shortHash(target.to) : 'working tree'}`
    : target.kind === 'staged' ? 'staged' : target.kind === 'untracked' ? 'untracked' : 'unstaged'
  const layout = useSetting('diffLayout')
  /** The revision this file view is "at", for blame, restore, open and save. */
  const rev = target.kind === 'commit' ? target.hash : target.kind === 'range' ? (target.to ?? undefined) : undefined

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="file-view">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <div className="min-w-0 flex-1 truncate text-[13px]">
          <span className="text-faint">{dir}</span><span className="font-semibold">{name}</span>
          <span className="ml-2 text-xs text-muted">{where}</span>
        </div>
        {rev && <RevisionMenu view={view} rev={rev} path={target.path} />}
        {mode === 'diff' && target.kind !== 'untracked' && (
          <Button size="sm" variant="ghost" onClick={() => void openDiffTool(view.id, target)} title="Open in your external diff tool (Settings → Diff)" data-testid="open-diff-tool">
            <ExternalLink size={12} /> Diff tool
          </Button>
        )}
        {mode === 'diff' && (
          <div className="flex rounded-md border border-line p-0.5 text-xs" role="group" aria-label="Diff layout">
            {(['unified', 'split'] as const).map((l) => (
              <button key={l} onClick={() => void saveSettings({ diffLayout: l })} data-testid={`layout-${l}`} aria-pressed={layout === l}
                className={clsx('rounded px-2 py-0.5', layout === l ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}>
                {l === 'unified' ? 'Unified' : 'Split'}
              </button>
            ))}
          </div>
        )}
        <div className="flex rounded-md border border-line p-0.5 text-xs">
          {(['diff', 'history', 'blame'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={clsx('rounded px-2 py-0.5 capitalize', mode === m ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}>
              {m}
            </button>
          ))}
        </div>
        <button onClick={close} title="Close (Esc)" className="rounded p-1 text-muted hover:bg-hover hover:text-fg"><X size={16} /></button>
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
      className={clsx('absolute inset-y-0 left-0 w-1 cursor-pointer', f.severity === 'critical' || f.severity === 'major' ? 'bg-del' : f.severity === 'minor' ? 'bg-warn' : 'bg-faint')} />
  )
  /** The name Code Peek shows (Ctrl/Cmd+click in the diff), or null. */
  const [peek, setPeek] = useState<string | null>(null)
  const peekRev = target.kind === 'commit' ? target.hash : target.kind === 'range' ? target.to : null
  // Wrapped lines have different heights, so the virtualizer measures each row; otherwise rows
  // are a fixed height derived from the code font size (no measuring, cheaper scrolling).
  const virt = useVirtualizer({
    count: items.length, getScrollElement: () => scrollRef.current, estimateSize: () => lineH, overscan: 30,
    ...(wrap ? { measureElement: (el: Element) => el.getBoundingClientRect().height } : {}),
  })
  useEffect(() => virt.measure(), [lineH, wrap, split, virt])

  if (diff === undefined) return <div className="flex flex-1 items-center justify-center text-faint"><Spinner /></div>
  if (diff === null) return <div className="flex flex-1 items-center justify-center text-sm text-faint">No changes to show</div>

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

  const fileActions = target.kind === 'commit' || target.kind === 'range' ? null : (
    <div className="flex items-center gap-2">
      {selectedCount > 0 && (
        <>
          <span className="text-xs text-muted">{selectedCount} {selectedCount === 1 ? 'line' : 'lines'} selected</span>
          {target.kind !== 'staged' && <Button size="sm" variant="primary" data-testid="stage-lines" onClick={() => apply('stage', selectionHunks())}>Stage lines</Button>}
          {target.kind === 'staged' && <Button size="sm" variant="primary" onClick={() => apply('unstage', selectionHunks())}>Unstage lines</Button>}
          {target.kind === 'unstaged' && <Button size="sm" onClick={() => apply('discard', selectionHunks())}>Discard lines</Button>}
          <Button size="sm" variant="ghost" onClick={() => setSel(new Map())}>Clear</Button>
          <span className="mx-1 h-4 w-px bg-line" />
        </>
      )}
      {target.kind !== 'staged' ? (
        <>
          <Button size="sm" onClick={() => void run(view.id, 'Stage', () => api.stagePaths(view.id, [target.path]), { quiet: true })}>Stage file</Button>
          <Button size="sm" variant="ghost" onClick={() => void discard(view.id, [target.path])}>
            {target.kind === 'untracked' ? 'Delete file' : 'Discard file'}
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={() => void run(view.id, 'Unstage', () => api.unstagePaths(view.id, [target.path]), { quiet: true })}>Unstage file</Button>
      )}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(fileActions || diff.oldPath) && (
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3 text-xs">
          <span className="truncate text-muted" data-testid="diff-hint">
            {diff.oldPath ? `Renamed from ${diff.oldPath}` : editable ? `Click lines to select them; shift-click for a range; ${modName()}+click a name to peek.`
              : editable === false && ignoreWhitespace && target.kind !== 'commit' && target.kind !== 'range' ? 'Whitespace changes are hidden, so line and hunk staging are off (Settings → Diff).' : ''}
          </span>
          {fileActions}
        </div>
      )}
      {diff.binary && imageMime(target.path) ? (
        <ImageDiff repoId={view.id} target={target} path={target.path} />
      ) : diff.binary ? (
        <div className="flex flex-1 items-center justify-center text-sm text-faint">Binary file</div>
      ) : diff.hunks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-faint">{diff.change === 'added' ? 'Empty file' : 'Only the file mode changed'}</div>
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
              const style = {
                position: 'absolute' as const, top: 0, left: 0, minWidth: '100%', transform: `translateY(${vi.start}px)`,
                ...(wrap ? { minHeight: lineH, right: 0 } : { height: lineH, lineHeight: `${lineH}px` }),
              }
              const hunk = diff.hunks[it.hunk]!
              if (it.kind === 'hunk') {
                return (
                  <div key={vi.key} ref={wrap ? virt.measureElement : undefined} data-index={vi.index} style={style} className="flex items-center gap-2 border-y border-line/50 bg-panel pr-3 pl-2 text-faint">
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
                  if (li === null) return <div className={clsx('flex w-1/2 min-w-0 bg-panel/40', side === 'right' && 'border-l border-line')} />
                  const l = hunk.lines[li]!
                  const selected = sel.get(it.hunk)?.has(li) ?? false
                  return (
                    <div data-testid="diff-cell" data-kind={l.kind} data-side={side}
                      onMouseDown={(e) => { if (l.kind !== ' ' && e.button === 0 && e.detail === 1) { e.preventDefault(); toggle(it.hunk, li, e.shiftKey) } }}
                      className={clsx('flex w-1/2 min-w-0 whitespace-pre-wrap break-all', side === 'right' && 'border-l border-line',
                        l.kind === '+' && 'bg-add-bg', l.kind === '-' && 'bg-del-bg', l.kind !== ' ' && editable && 'cursor-pointer',
                        selected && 'ring-1 ring-accent ring-inset brightness-125')}>
                      <span className={clsx('relative w-10 shrink-0 pr-1 text-right text-faint', selected && 'bg-select')}>
                        {side === 'right' && marker(findingAt(l.newNo))}
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
                  data-testid="diff-line" data-kind={line.kind}
                  onMouseDown={(e) => { if (line.kind !== ' ' && e.button === 0 && e.detail === 1) { e.preventDefault(); toggle(it.hunk, it.line, e.shiftKey) } }}
                  onDoubleClick={() => { if (target.kind !== 'commit') void openInEditor(`${view.snapshot.path}/${target.path}`, line.newNo ?? line.oldNo ?? 1) }}
                  title={target.kind !== 'commit' ? 'Double-click to open in your editor at this line' : undefined}
                  className={clsx('flex', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre', line.kind === '+' && 'bg-add-bg', line.kind === '-' && 'bg-del-bg',
                    line.kind !== ' ' && editable && 'cursor-pointer', selected && 'ring-1 ring-accent ring-inset brightness-125')}>
                  <span className={clsx('sticky left-0 flex w-[84px] shrink-0 self-stretch bg-bg text-right text-faint', selected && 'bg-select')}>
                    {line.kind !== '-' && marker(findingAt(line.newNo))}
                    <span className="w-9 pr-1">{line.oldNo ?? ''}</span>
                    <span className="w-9 pr-1">{line.newNo ?? ''}</span>
                    <span className={clsx('w-3 text-center', line.kind === '+' && 'text-add', line.kind === '-' && 'text-del')}>{line.kind === ' ' ? '' : line.kind}</span>
                  </span>
                  <span className="min-w-0 pr-4 pl-2">{textOf(it.line)}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {peek && <CodePeekPanel repoId={view.id} repoPath={view.snapshot.path} name={peek} rev={peekRev} onClose={() => setPeek(null)} />}
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
          className={s.changed ? (kind === '+' ? 'rounded-sm bg-add/30' : 'rounded-sm bg-del/30') : undefined}>{s.text}</span>
      ))}
      {noNewline && <span className="ml-2 text-faint" title="No newline at end of file">⏎̸</span>}
    </>
  )
}

/** Restore, open or save the file as it is at a revision. */
function RevisionMenu({ view, rev, path }: { view: RepoView; rev: string; path: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="ghost" data-testid="revision-menu">This version <ChevronDown size={12} /></Button>
      </DropdownMenu.Trigger>
      <DM.Content align="end">
        <DM.Item onSelect={() => void api.openFileAt(view.id, rev, path).catch((e) => reportError('Could not open the file', e))}>Open this version</DM.Item>
        <DM.Item onSelect={() => void api.saveFileAt(view.id, rev, path).catch((e) => reportError('Could not save the file', e))}>Save this version as…</DM.Item>
        <DM.Separator />
        <DM.Item onSelect={() => void restoreFileFrom(view.id, path, rev)}>{view.stashes.some((s) => s.hash === rev) ? 'Take this file from the stash' : 'Restore the working copy to this version'}</DM.Item>
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
  if (!commits) return <div className="flex flex-1 items-center justify-center text-faint"><Spinner /></div>
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="file-history">
      {commits.length === 0 && <div className="p-4 text-sm text-faint">No commits touch this file yet.</div>}
      {commits.map((c) => (
        <button key={c.hash}
          onClick={() => {
            updateRepo(view.id, { selected: { kind: 'commit', hash: c.hash }, center: { kind: 'file', target: { kind: 'commit', hash: c.hash, path }, mode: 'diff' } })
            void ensureLoaded(view.id, c.hash)
          }}
          className="flex w-full items-center gap-3 border-b border-line/50 px-4 py-2 text-left text-[13px] hover:bg-hover">
          <span className="font-mono text-xs text-faint">{shortHash(c.hash)}</span>
          <span className="min-w-0 flex-1 truncate">{c.subject}</span>
          <span className="text-xs text-muted">{c.authorName}</span>
          <span className="w-24 text-right text-xs text-faint">{formatDate(c.authorDate, dateFormat)}</span>
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
  if (!lines) return <div className="flex flex-1 items-center justify-center text-faint"><Spinner /></div>
  const newest = Math.max(...lines.map((l) => l.date), 1)
  const oldest = Math.min(...lines.map((l) => l.date), newest)
  return (
    <div ref={scrollRef} className="selectable min-h-0 flex-1 overflow-auto" style={CODE_STYLE} data-testid="blame">
      <div style={{ height: virt.getTotalSize(), position: 'relative' }} className="w-max min-w-full">
        {virt.getVirtualItems().map((vi) => {
          const l = lines[vi.index]!
          const first = vi.index === 0 || lines[vi.index - 1]!.hash !== l.hash
          // Newer lines get a stronger stripe, so recent changes stand out.
          const age = newest === oldest ? 1 : (l.date - oldest) / (newest - oldest)
          return (
            <div key={vi.key} style={{ position: 'absolute', top: 0, left: 0, minWidth: '100%', height: lineH, lineHeight: `${lineH}px`, transform: `translateY(${vi.start}px)` }}
              className={clsx('flex whitespace-pre', first && vi.index > 0 && 'border-t border-line/50')}>
              <span className="sticky left-0 flex w-[300px] shrink-0 items-center gap-2 bg-panel pr-2 font-sans text-[11px]">
                <span className="h-full w-1 shrink-0" style={{ background: laneColor(hashColor(l.hash)), opacity: 0.25 + age * 0.75 }} />
                {first && (
                  <button className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-accent" title={l.summary}
                    onClick={() => { updateRepo(view.id, { selected: { kind: 'commit', hash: l.hash } }); void ensureLoaded(view.id, l.hash) }}>
                    <span className="font-mono text-faint">{shortHash(l.hash)}</span>
                    <span className="min-w-0 flex-1 truncate">{l.summary}</span>
                    <span className="text-faint">{l.author.split(' ')[0]}</span>
                    <span className="text-faint">{relativeTime(l.date)}</span>
                  </button>
                )}
              </span>
              <span className="w-10 shrink-0 pr-2 text-right text-faint">{l.lineNo}</span>
              <span className="pr-4">{l.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
