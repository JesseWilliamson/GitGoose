import { EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, gutter, lineNumbers, type DecorationSet } from '@codemirror/view'
import { countConflicts, merge3, type Merge3, type Range } from '@gitsquid/shared'
import clsx from 'clsx'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { basicSetup } from 'codemirror'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addLines, applyNonConflicting, applySide, changes, ignoreSide, initialResult, isResolved, lineStart, mergeField,
  type MergeField, type MergeState, type Side, type StartFrom,
} from '../lib/mergeState'
import { choose } from '../lib/store'
import { Button } from './ui'

/**
 * IntelliJ-style three-pane merge: yours on the left, the result in the middle (editable),
 * theirs on the right. Both sides are diffed against the common ancestor (merge3 in
 * @gitsquid/shared), so every change knows whether the other side touched the same lines.
 * The bookkeeping (block positions, applied/ignored, undo) lives in lib/mergeState.ts.
 */

// ---------------------------------------------------------------- side panes

interface SideMarks {
  deco: DecorationSet
  gutter: RangeSet<GutterMarker>
}

const setMarks = StateEffect.define<SideMarks>()
const sideMarks = StateField.define<SideMarks>({
  create: () => ({ deco: Decoration.none, gutter: RangeSet.empty }),
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setMarks) ? e.value : acc), v),
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
})

interface Actions {
  apply(block: number, side: Side): void
  ignore(block: number, side: Side): void
}

class ActionMarker extends GutterMarker {
  constructor(readonly block: number, readonly side: Side, readonly actions: Actions) {
    super()
  }
  override eq(o: ActionMarker) {
    return o.block === this.block && o.side === this.side
  }
  override toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-m-actions'
    const button = (label: string, title: string, testId: string, act: () => void) => {
      const el = document.createElement('button')
      el.textContent = label
      el.title = title
      el.dataset.testid = testId
      el.dataset.block = String(this.block)
      el.onmousedown = (e) => e.preventDefault()
      el.onclick = (e) => {
        e.stopPropagation()
        act()
      }
      return el
    }
    const apply = button(this.side === 'ours' ? '»' : '«', 'Apply this change to the result', `apply-${this.side}`, () => this.actions.apply(this.block, this.side))
    const ignore = button('×', 'Ignore this change', `ignore-${this.side}`, () => this.actions.ignore(this.block, this.side))
    // The buttons sit next to the result: apply nearest to it.
    if (this.side === 'ours') wrap.append(ignore, apply)
    else wrap.append(apply, ignore)
    return wrap
  }
}

class Spacer extends GutterMarker {
  override toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-m-actions'
    return el
  }
}

function buildSideMarks(view: EditorView, m: Merge3, side: Side, state: MergeState, actions: Actions): SideMarks {
  const doc = view.state.doc
  const deco = new RangeSetBuilder<Decoration>()
  const marks = new RangeSetBuilder<GutterMarker>()
  m.blocks.forEach((b, i) => {
    if (!changes(b, side)) return
    const st = state.blocks[i]!
    const s = st[side]
    const cls = b.kind === 'conflict' ? (isResolved(b, st) ? 'cm-m-resolved' : 'cm-m-conflict') : s === 'pending' ? 'cm-m-pending' : 'cm-m-applied'
    const r = b[side]
    const from = lineStart(doc, r.start)
    const to = r.end > r.start ? lineStart(doc, r.end) : from
    addLines(deco, doc, from, r.end > r.start ? Math.max(from + 1, to) : from, `${cls}${s === 'ignored' ? ' cm-m-ignored' : ''}`, i)
    if (s === 'pending') marks.add(from, from, new ActionMarker(i, side, actions))
  })
  return { deco: deco.finish(), gutter: marks.finish() }
}

// ---------------------------------------------------------------- scroll sync

type Pane = 'ours' | 'result' | 'theirs'

/** Each block's [start, end) lines in a pane: static for the sides, from the block map for the result. */
function blockLines(pane: Pane, m: Merge3, view: EditorView, field: StateField<MergeState>): Range[] {
  if (pane !== 'result') return m.blocks.map((b) => b[pane])
  const doc = view.state.doc
  return view.state.field(field).ranges.map((r) => {
    const start = doc.lineAt(r.from).number - 1
    if (r.to === r.from) return { start, end: start }
    const last = doc.lineAt(r.to)
    return { start, end: last.number - 1 + (r.to > last.from ? 1 : 0) }
  })
}

/** Which block is at the top of `view`, and how far into it (in lines, fractional). */
function anchorAt(view: EditorView, lines: Range[]): { block: number; into: number; frac: number } {
  const top = view.scrollDOM.scrollTop - view.documentPadding.top
  const lb = view.lineBlockAtHeight(Math.max(0, top))
  const line = view.state.doc.lineAt(lb.from).number - 1 + Math.min(1, Math.max(0, (top - lb.top) / lb.height))
  let block = 0
  for (let i = 0; i < lines.length; i++) if (lines[i]!.start <= line) block = i
  const r = lines[block]!
  const len = r.end - r.start
  return { block, into: line - r.start, frac: len ? Math.min(1, (line - r.start) / len) : 0 }
}

function scrollTopFor(view: EditorView, r: Range, same: boolean, a: { into: number; frac: number }): number {
  const len = r.end - r.start
  // Unchanged blocks have the same length everywhere, so keep the exact line; changed ones scale.
  const line = r.start + (same ? Math.min(a.into, len) : a.frac * len)
  const whole = Math.floor(line)
  const doc = view.state.doc
  const lb = view.lineBlockAt(lineStart(doc, Math.min(whole, doc.lines - 1)))
  return lb.top + (line - whole) * lb.height + view.documentPadding.top
}

// ---------------------------------------------------------------- component

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--gs-code-size)', backgroundColor: 'var(--gs-bg)', color: 'var(--gs-fg)' },
  '.cm-scroller': { fontFamily: 'var(--gs-code-font)' },
  '.cm-gutters': { backgroundColor: 'var(--gs-panel)', color: 'var(--gs-faint)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--gs-hover)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--gs-fg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--gs-select) !important' },
  '.cm-m-conflict': { backgroundColor: 'var(--gs-del-bg)' },
  '.cm-m-resolved': { backgroundColor: 'var(--gs-add-bg)' },
  '.cm-m-pending': { backgroundColor: 'color-mix(in srgb, var(--gs-accent) 16%, transparent)' },
  '.cm-m-applied': { backgroundColor: 'color-mix(in srgb, var(--gs-accent) 7%, transparent)' },
  '.cm-m-ignored': { backgroundColor: 'transparent', opacity: '0.55' },
  '.cm-m-empty': { backgroundColor: 'transparent', boxShadow: 'inset 0 2px 0 var(--gs-m-edge, var(--gs-accent))' },
  '.cm-m-empty.cm-m-conflict': { '--gs-m-edge': 'var(--gs-del)' },
  '.cm-m-empty.cm-m-resolved': { '--gs-m-edge': 'var(--gs-add)' },
  '.cm-m-empty-end': { boxShadow: 'inset 0 -2px 0 var(--gs-m-edge, var(--gs-accent))' },
  '.cm-m-actions': { display: 'inline-flex', width: '36px', justifyContent: 'center', gap: '2px' },
  '.cm-m-actions button': {
    padding: '0 3px', lineHeight: '1.2', borderRadius: '3px', color: 'var(--gs-fg)', cursor: 'pointer',
    backgroundColor: 'var(--gs-hover)', fontFamily: 'system-ui, sans-serif', fontSize: '12px',
  },
  '.cm-m-actions button:hover': { backgroundColor: 'var(--gs-accent)', color: 'white' },
})

/** The left pane keeps its gutter (line numbers + buttons) on the right, next to the result. */
const gutterRight = EditorView.theme({
  '.cm-gutters': { order: '2', left: 'auto', right: '0', insetInlineStart: 'auto', insetInlineEnd: '0' },
  '.cm-content': { flexGrow: '1' },
})

export interface MergePanesProps {
  base: string
  ours: string
  theirs: string
  labels: { ours: string; theirs: string }
  onSave(content: string): void
}

export default function MergePanes({ base, ours, theirs, labels, onSave }: MergePanesProps) {
  const m = useMemo(() => merge3(base, ours, theirs), [base, ours, theirs])
  const hosts = { ours: useRef<HTMLDivElement>(null), result: useRef<HTMLDivElement>(null), theirs: useRef<HTMLDivElement>(null) }
  const views = useRef<Partial<Record<Pane, EditorView>>>({})
  const merge = useMemo(() => ({ current: null as MergeField | null }), [])
  const [start, setStart] = useState<StartFrom>('non-conflicting')
  const [status, setStatus] = useState<{ state: MergeState; markers: number } | null>(null)
  const dirty = useRef(false)

  const actions = useMemo<Actions>(() => {
    const act = (make: typeof applySide) => (block: number, side: Side) => {
      const view = views.current.result
      const f = merge.current
      if (view && f) view.dispatch(make(view.state, f.field, m, block, side))
    }
    return { apply: act(applySide), ignore: act(ignoreSide) }
  }, [m, merge])

  // The two read-only sides: created once per merge.
  useEffect(() => {
    const mk = (side: Side) => new EditorView({
      parent: hosts[side].current!,
      state: EditorState.create({
        doc: side === 'ours' ? ours : theirs,
        extensions: [
          side === 'ours' ? [lineNumbers(), gutter({ class: 'cm-m-gutter', markers: (v) => v.state.field(sideMarks).gutter, initialSpacer: () => new Spacer() }), gutterRight]
            : [gutter({ class: 'cm-m-gutter', markers: (v) => v.state.field(sideMarks).gutter, initialSpacer: () => new Spacer() }), lineNumbers()],
          EditorState.readOnly.of(true),
          sideMarks,
          theme,
        ],
      }),
    })
    views.current.ours = mk('ours')
    views.current.theirs = mk('theirs')
    return () => {
      views.current.ours?.destroy()
      views.current.theirs?.destroy()
      delete views.current.ours
      delete views.current.theirs
    }
    // hosts are stable refs
  }, [ours, theirs])

  // The result: recreated when the merge or the starting point changes.
  useEffect(() => {
    const { doc, state } = initialResult(m, start, labels)
    const f = mergeField(m, state)
    merge.current = f
    const publish = (s: EditorState) => {
      const ms = s.field(f.field)
      setStatus({ state: ms, markers: countConflicts(s.doc.toString()) })
      for (const side of ['ours', 'theirs'] as const) {
        const v = views.current[side]
        if (v) v.dispatch({ effects: setMarks.of(buildSideMarks(v, m, side, ms, actions)) })
      }
    }
    const view = new EditorView({
      parent: hosts.result.current!,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          theme,
          f.extension,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) dirty.current = true
            if (u.docChanged || u.startState.field(f.field) !== u.state.field(f.field)) publish(u.state)
          }),
        ],
      }),
    })
    views.current.result = view
    dirty.current = false
    publish(view.state)
    return () => {
      view.destroy()
      delete views.current.result
    }
  }, [m, start, labels.ours, labels.theirs, actions, merge])

  // Scroll sync on block anchors: whichever pane the user scrolls drives the other two.
  useEffect(() => {
    const expected: Partial<Record<Pane, number>> = {}
    const panes: Pane[] = ['ours', 'result', 'theirs']
    const offs = panes.map((p) => {
      const view = views.current[p]
      if (!view) return () => {}
      const onScroll = () => {
        const want = expected[p]
        if (want !== undefined && Math.abs(view.scrollDOM.scrollTop - want) < 2) {
          delete expected[p]
          return
        }
        const f = merge.current
        if (!f) return
        const a = anchorAt(view, blockLines(p, m, view, f.field))
        for (const q of panes) {
          const tv = views.current[q]
          if (q === p || !tv) continue
          const r = blockLines(q, m, tv, f.field)[a.block]
          if (!r) continue
          const top = scrollTopFor(tv, r, m.blocks[a.block]!.kind === 'same', a)
          const max = tv.scrollDOM.scrollHeight - tv.scrollDOM.clientHeight
          const clamped = Math.max(0, Math.min(max, top))
          if (Math.abs(tv.scrollDOM.scrollTop - clamped) < 2) continue
          expected[q] = clamped
          tv.scrollDOM.scrollTop = clamped
        }
      }
      view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
      return () => view.scrollDOM.removeEventListener('scroll', onScroll)
    })
    return () => offs.forEach((off) => off())
  }, [m, start, merge])

  const conflicts = status ? m.blocks.map((b, i) => (b.kind === 'conflict' && !isResolved(b, status.state.blocks[i]!) ? i : -1)).filter((i) => i >= 0) : []
  const pendingChanges = status ? m.blocks.filter((b, i) => b.kind !== 'conflict' && b.kind !== 'same' && (['ours', 'theirs'] as const).some((s) => status.state.blocks[i]![s] === 'pending')).length : 0
  const totalConflicts = m.blocks.filter((b) => b.kind === 'conflict').length
  const markers = status?.markers ?? 0

  const applyAll = () => {
    const view = views.current.result
    const f = merge.current
    const spec = view && f ? applyNonConflicting(view.state, f.field, m) : null
    if (spec) view!.dispatch(spec)
  }

  const go = (dir: 1 | -1) => {
    const view = views.current.result
    const f = merge.current
    if (!view || !f) return
    const st = view.state.field(f.field)
    const targets = (conflicts.length ? conflicts : m.blocks.map((b, i) => (b.kind === 'same' ? -1 : i)).filter((i) => i >= 0))
      .map((i) => st.ranges[i]!.from)
    if (!targets.length) return
    const head = view.state.selection.main.head
    const next = dir > 0 ? (targets.find((p) => p > head) ?? targets[0]!) : ([...targets].reverse().find((p) => p < head) ?? targets[targets.length - 1]!)
    view.dispatch({ selection: { anchor: next }, effects: EditorView.scrollIntoView(next, { y: 'start', yMargin: 40 }) })
    view.focus()
  }

  const changeStart = (next: StartFrom) => {
    if (!dirty.current) return setStart(next)
    choose('Start over?', 'Your changes to the result will be lost.', [
      { label: 'Keep editing' },
      { label: 'Start over', variant: 'danger', run: () => setStart(next) },
    ])
  }

  const canSave = conflicts.length === 0 && markers === 0
  const save = () => {
    const view = views.current.result
    if (view && canSave) onSave(view.state.doc.toString())
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="merge-panes">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-1 text-xs">
        <label className="flex items-center gap-1.5 text-muted">
          Start from
          <select value={start} onChange={(e) => changeStart(e.target.value as StartFrom)} data-testid="merge-start"
            className="h-6 rounded border border-line bg-bg px-1 text-fg">
            <option value="non-conflicting">Non-conflicting changes applied</option>
            <option value="base">The common ancestor</option>
            <option value="markers">Git's merge (with markers)</option>
          </select>
        </label>
        <Button size="sm" onClick={applyAll} disabled={pendingChanges === 0} data-testid="apply-non-conflicting"
          title="Apply every change that only one side made">
          Apply non-conflicting{pendingChanges ? ` (${pendingChanges})` : ''}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => go(-1)} title="Previous conflict" data-testid="prev-conflict"><ChevronUp size={13} /></Button>
        <Button size="sm" variant="ghost" onClick={() => go(1)} title="Next conflict" data-testid="next-conflict"><ChevronDown size={13} /></Button>
        <span className={clsx('ml-auto', conflicts.length ? 'text-del' : 'text-add')} data-testid="conflicts-left">
          {conflicts.length ? `${conflicts.length} of ${totalConflicts} ${totalConflicts === 1 ? 'conflict' : 'conflicts'} left` : markers ? 'Remove the conflict markers' : 'All conflicts resolved'}
        </span>
        <Button size="sm" variant="primary" disabled={!canSave} onClick={save} data-testid="merge-save"
          title={canSave ? 'Write the result and mark the file resolved' : 'Resolve every conflict first'}>
          Save resolution
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-3">
        {(['ours', 'result', 'theirs'] as const).map((p) => (
          <div key={p} className={clsx('flex min-h-0 min-w-0 flex-col', p !== 'ours' && 'border-l border-line')}>
            <div className="shrink-0 truncate border-b border-line px-3 py-1 text-[11px] font-semibold text-muted">
              {p === 'ours' ? `Yours (${labels.ours})` : p === 'theirs' ? `Theirs (${labels.theirs})` : 'Result'}
            </div>
            <div ref={hosts[p]} className="min-h-0 flex-1 overflow-hidden" data-testid={`merge-${p}`} />
          </div>
        ))}
      </div>
    </div>
  )
}
