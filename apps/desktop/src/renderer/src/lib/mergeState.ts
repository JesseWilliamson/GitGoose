import { invertedEffects } from '@codemirror/commands'
import { Annotation, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { blockText, type Merge3, type MergeBlock, type Range } from '@gitsquid/shared'

/**
 * The state behind the three-pane merge view (components/MergePanes.tsx), kept free of React so
 * it can be tested with a bare EditorState.
 *
 * The interesting part is where the bookkeeping lives. Which blocks were applied or ignored, and
 * where each block now sits in the result, is a CodeMirror StateField of the result editor:
 *   - positions are mapped through every change (typing above a block moves it down), so
 *     applying a block later still replaces the right text;
 *   - the status changes are StateEffects with `invertedEffects`, so Ctrl+Z undoes "apply"
 *     together with the text it inserted.
 * React only reads that state to draw the toolbar; it never holds a copy that could drift.
 */

export type Side = 'ours' | 'theirs'
/** none: this side did not change the block. */
export type SideState = 'none' | 'pending' | 'applied' | 'ignored'

export interface BlockState {
  ours: SideState
  theirs: SideState
  /** The user typed inside this conflict: it counts as resolved by hand. */
  edited: boolean
}

export interface MergeState {
  /** Where each block (same blocks included) sits in the result document, as offsets. */
  ranges: { from: number; to: number }[]
  blocks: BlockState[]
}

export type StartFrom = 'non-conflicting' | 'base' | 'markers'

const setSide = StateEffect.define<{ block: number; side: Side; value: SideState }>()
const setEdited = StateEffect.define<{ block: number; value: boolean }>()
/** Marks transactions made by the merge buttons, so they do not count as hand edits. */
const fromMerge = Annotation.define<boolean>()

export const other = (s: Side): Side => (s === 'ours' ? 'theirs' : 'ours')
export const sliceLines = (lines: string[], r: Range) => lines.slice(r.start, r.end).join('')
export const withNewline = (s: string) => (s && !s.endsWith('\n') ? s + '\n' : s)
export const changes = (b: MergeBlock, s: Side) => b.kind === 'conflict' || b.kind === 'both-same' || b.kind === s

/**
 * A conflict is resolved once either side is applied (the other can still be appended or
 * ignored, as in IntelliJ), both are ignored (the original stays), or it was edited by hand.
 */
export function isResolved(b: MergeBlock, st: BlockState): boolean {
  if (b.kind !== 'conflict') return true
  return st.edited || st.ours === 'applied' || st.theirs === 'applied' || (st.ours === 'ignored' && st.theirs === 'ignored')
}

/** The starting result document and its block map. */
export function initialResult(m: Merge3, start: StartFrom, labels: { ours: string; theirs: string }): { doc: string; state: MergeState } {
  let doc = ''
  const ranges: MergeState['ranges'] = []
  const blocks: BlockState[] = []
  for (const b of m.blocks) {
    const st: BlockState = { ours: changes(b, 'ours') ? 'pending' : 'none', theirs: changes(b, 'theirs') ? 'pending' : 'none', edited: false }
    let text = sliceLines(m.base, b.base)
    // Git's merge applies the non-conflicting changes too; it only differs at the conflicts.
    if (start !== 'base' && b.kind !== 'conflict' && b.kind !== 'same') {
      text = blockText(m, b)
      if (st.ours === 'pending') st.ours = 'applied'
      if (st.theirs === 'pending') st.theirs = 'applied'
    } else if (start === 'markers' && b.kind === 'conflict') {
      text = `<<<<<<< ${labels.ours}\n${withNewline(sliceLines(m.ours, b.ours))}=======\n${withNewline(sliceLines(m.theirs, b.theirs))}>>>>>>> ${labels.theirs}\n`
    }
    ranges.push({ from: doc.length, to: doc.length + text.length })
    blocks.push(st)
    doc += text
  }
  return { doc, state: { ranges, blocks } }
}

/** The result editor's merge bookkeeping, for one merge. */
export type MergeField = ReturnType<typeof mergeField>

export function mergeField(m: Merge3, init: MergeState) {
  const field = StateField.define<MergeState>({
    create: () => init,
    update(value, tr) {
      let { ranges, blocks } = value
      if (tr.docChanged) {
        // Change blocks claim text typed at their edges (from sticks left, to sticks right);
        // unchanged blocks give it up. So typing at the boundary of a conflict edits the conflict.
        ranges = ranges.map((r, i) => {
          const claim = m.blocks[i]!.kind !== 'same'
          const from = tr.changes.mapPos(r.from, claim ? -1 : 1)
          const to = tr.changes.mapPos(r.to, claim ? 1 : -1)
          return { from, to: Math.max(from, to) }
        })
      }
      for (const e of tr.effects) {
        if (e.is(setSide)) {
          blocks = blocks.map((b, i) => (i === e.value.block ? { ...b, [e.value.side]: e.value.value } : b))
        } else if (e.is(setEdited)) {
          blocks = blocks.map((b, i) => (i === e.value.block ? { ...b, edited: e.value.value } : b))
        }
      }
      return ranges === value.ranges && blocks === value.blocks ? value : { ranges, blocks }
    },
  })

  // Typing inside a conflict marks it edited, in the same transaction (so undo reverts both).
  const markEdits = EditorState.transactionExtender.of((tr) => {
    if (!tr.docChanged || tr.annotation(fromMerge) || tr.isUserEvent('undo') || tr.isUserEvent('redo')) return null
    const st = tr.startState.field(field)
    const hit = new Set<number>()
    tr.changes.iterChangedRanges((fromA, toA) => {
      st.ranges.forEach((r, i) => {
        if (m.blocks[i]!.kind === 'conflict' && !st.blocks[i]!.edited && fromA <= r.to && toA >= r.from) hit.add(i)
      })
    })
    return hit.size ? { effects: [...hit].map((block) => setEdited.of({ block, value: true })) } : null
  })

  // What undo needs to put the statuses back: each effect, with the value it replaced.
  const undoable = invertedEffects.of((tr) => {
    const prev = tr.startState.field(field, false)
    if (!prev) return []
    const out: StateEffect<unknown>[] = []
    for (const e of tr.effects) {
      if (e.is(setSide)) out.push(setSide.of({ ...e.value, value: prev.blocks[e.value.block]![e.value.side] }))
      else if (e.is(setEdited)) out.push(setEdited.of({ block: e.value.block, value: prev.blocks[e.value.block]!.edited }))
    }
    return out
  })

  // Tint each block in the result by its state.
  const tint = EditorView.decorations.compute([field], (state) => {
    const { ranges, blocks } = state.field(field)
    const b = new RangeSetBuilder<Decoration>()
    ranges.forEach((r, i) => {
      const blk = m.blocks[i]!
      if (blk.kind === 'same') return
      const st = blocks[i]!
      const cls = blk.kind === 'conflict'
        ? (isResolved(blk, st) ? 'cm-m-resolved' : 'cm-m-conflict')
        : (st.ours === 'pending' || st.theirs === 'pending' ? 'cm-m-pending' : 'cm-m-applied')
      addLines(b, state.doc, r.from, r.to, cls, i)
    })
    return b.finish()
  })

  return { field, extension: [field, markEdits, undoable, tint] as Extension }
}

/** Line decorations for [from, to); an empty range draws a thin line where the block would be. */
export function addLines(b: RangeSetBuilder<Decoration>, doc: EditorState['doc'], from: number, to: number, cls: string, block: number) {
  if (from === to) {
    const line = doc.lineAt(from)
    const atEnd = from > line.from || (from === doc.length && line.number > 1 && line.length === 0)
    b.add(line.from, line.from, Decoration.line({ class: `${cls} cm-m-empty${atEnd ? ' cm-m-empty-end' : ''}`, attributes: { 'data-block': String(block) } }))
    return
  }
  for (let line = doc.lineAt(from); ; line = doc.line(line.number + 1)) {
    b.add(line.from, line.from, Decoration.line({ class: cls, attributes: { 'data-block': String(block) } }))
    if (line.to >= to - 1 || line.number === doc.lines) break
  }
}

/** Offset of 0-based line `n`, clamped to the end of the document. */
export function lineStart(doc: EditorState['doc'], n: number): number {
  return n + 1 > doc.lines ? doc.length : doc.line(n + 1).from
}

// ---------------------------------------------------------------- the merge buttons, as transactions

/** Put one side's version of a block into the result. */
export function applySide(state: EditorState, field: StateField<MergeState>, m: Merge3, block: number, side: Side): TransactionSpec {
  const st = state.field(field)
  const r = st.ranges[block]!
  const b = m.blocks[block]!
  let insert = sliceLines(m[side], b[side])
  if (b.kind === 'conflict' && st.blocks[block]![other(side)] === 'applied') {
    // Both sides wanted: keep what is there and add this side, ours always first.
    const cur = state.sliceDoc(r.from, r.to)
    insert = side === 'theirs' ? withNewline(cur) + insert : withNewline(insert) + cur
  }
  const effects = [setSide.of({ block, side, value: 'applied' })]
  if (b.kind === 'both-same') effects.push(setSide.of({ block, side: other(side), value: 'applied' }))
  return { changes: { from: r.from, to: r.to, insert }, effects, annotations: fromMerge.of(true), userEvent: 'merge.apply' }
}

/** Decline one side's change. With nothing taken from either side, the block goes back to the base. */
export function ignoreSide(state: EditorState, field: StateField<MergeState>, m: Merge3, block: number, side: Side): TransactionSpec {
  const st = state.field(field)
  const r = st.ranges[block]!
  const b = m.blocks[block]!
  const effects = [setSide.of({ block, side, value: 'ignored' })]
  if (b.kind === 'both-same') effects.push(setSide.of({ block, side: other(side), value: 'ignored' }))
  const baseText = sliceLines(m.base, b.base)
  const reset = st.blocks[block]![other(side)] !== 'applied' && !st.blocks[block]!.edited && state.sliceDoc(r.from, r.to) !== baseText
  return { changes: reset ? { from: r.from, to: r.to, insert: baseText } : undefined, effects, annotations: fromMerge.of(true), userEvent: 'merge.ignore' }
}

/** Every change only one side made (or both made identically), in one transaction. */
export function applyNonConflicting(state: EditorState, field: StateField<MergeState>, m: Merge3): TransactionSpec | null {
  const st = state.field(field)
  const changes: { from: number; to: number; insert: string }[] = []
  const effects: StateEffect<unknown>[] = []
  m.blocks.forEach((b, i) => {
    if (b.kind === 'conflict' || b.kind === 'same') return
    const s = st.blocks[i]!
    if (s.ours !== 'pending' && s.theirs !== 'pending') return
    // Every change in one transaction is relative to the starting document, so no remapping.
    changes.push({ ...st.ranges[i]!, insert: blockText(m, b) })
    for (const side of ['ours', 'theirs'] as const) if (s[side] === 'pending') effects.push(setSide.of({ block: i, side, value: 'applied' }))
  })
  return effects.length ? { changes, effects, annotations: fromMerge.of(true), userEvent: 'merge.apply' } : null
}
