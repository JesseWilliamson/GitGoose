import { history, redo, undo } from '@codemirror/commands'
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import { merge3 } from '@gitsquid/shared'
import { describe, expect, it } from 'vitest'
import { applyNonConflicting, applySide, ignoreSide, initialResult, isResolved, mergeField, sourceClass } from './mergeState'

const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`)
const file = (edits: Record<number, string>) => lines.map((l, i) => edits[i + 1] ?? l).join('\n') + '\n'
// Blocks: same, ours (line 2), same, theirs (line 5), same, conflict (line 9), same.
const m = merge3(file({}), file({ 2: 'ours 2', 9: 'ours 9' }), file({ 5: 'theirs 5', 9: 'theirs 9' }))
const CONFLICT = m.blocks.findIndex((b) => b.kind === 'conflict')

function setup(start: 'non-conflicting' | 'base' | 'markers' = 'non-conflicting') {
  const { doc, state } = initialResult(m, start, { ours: 'HEAD', theirs: 'other' })
  const f = mergeField(m, state)
  let s = EditorState.create({ doc, extensions: [history(), f.extension] })
  const run = (spec: TransactionSpec | null) => {
    if (spec) s = s.update(spec).state
  }
  const command = (cmd: typeof undo) => cmd({ state: s, dispatch: (tr: Transaction) => (s = tr.state) })
  const text = (block: number) => {
    const r = s.field(f.field).ranges[block]!
    return s.sliceDoc(r.from, r.to)
  }
  const status = (block: number) => s.field(f.field).blocks[block]!
  return { get s() { return s }, f, run, command, text, status }
}

describe('three-pane merge state', () => {
  it('starts with the one-sided changes applied and the conflict on the base text', () => {
    const t = setup()
    expect(t.s.doc.toString()).toBe(file({ 2: 'ours 2', 5: 'theirs 5' }))
    expect(t.text(CONFLICT)).toBe('line 9\n')
    expect(isResolved(m.blocks[CONFLICT]!, t.status(CONFLICT))).toBe(false)
  })

  it('keeps block positions right after edits above them', () => {
    const t = setup()
    t.run({ changes: { from: 0, insert: 'a new first line\nand another\n' }, userEvent: 'input.type' })
    expect(t.text(CONFLICT)).toBe('line 9\n')
    t.run(applySide(t.s, t.f.field, m, CONFLICT, 'theirs'))
    expect(t.s.doc.toString()).toBe('a new first line\nand another\n' + file({ 2: 'ours 2', 5: 'theirs 5', 9: 'theirs 9' }))
    // Applying the other side as well keeps both, ours first, whatever the order of clicks.
    t.run(applySide(t.s, t.f.field, m, CONFLICT, 'ours'))
    expect(t.text(CONFLICT)).toBe('ours 9\ntheirs 9\n')
  })

  it('counts typing inside a conflict as resolving it, and typing next to it does not leak into neighbours', () => {
    const t = setup()
    const r = t.s.field(t.f.field).ranges[CONFLICT]!
    t.run({ changes: { from: r.from + 'line 9'.length, insert: ' merged' }, userEvent: 'input.type' })
    expect(t.status(CONFLICT).edited).toBe(true)
    expect(isResolved(m.blocks[CONFLICT]!, t.status(CONFLICT))).toBe(true)
    // Text typed at the start of a conflict belongs to the conflict, not the unchanged block before it.
    const r2 = t.s.field(t.f.field).ranges[CONFLICT]!
    t.run({ changes: { from: r2.from, insert: '// ' }, userEvent: 'input.type' })
    expect(t.text(CONFLICT)).toBe('// line 9 merged\n')
    expect(t.text(CONFLICT - 1).endsWith('line 8\n')).toBe(true)
  })

  it('undoes and redoes the status together with the text', () => {
    const t = setup()
    t.run(applySide(t.s, t.f.field, m, CONFLICT, 'ours'))
    expect(t.status(CONFLICT).ours).toBe('applied')
    t.command(undo)
    expect(t.status(CONFLICT).ours).toBe('pending')
    expect(t.text(CONFLICT)).toBe('line 9\n')
    t.command(redo)
    expect(t.status(CONFLICT).ours).toBe('applied')
    expect(t.text(CONFLICT)).toBe('ours 9\n')
    // A hand edit's "edited" flag is undone with the keystrokes.
    t.command(undo)
    const r = t.s.field(t.f.field).ranges[CONFLICT]!
    t.run({ changes: { from: r.from, insert: 'x' }, userEvent: 'input.type' })
    expect(t.status(CONFLICT).edited).toBe(true)
    t.command(undo)
    expect(t.status(CONFLICT).edited).toBe(false)
  })

  it('applies every non-conflicting change at once from the base', () => {
    const t = setup('base')
    expect(t.s.doc.toString()).toBe(file({}))
    t.run(applyNonConflicting(t.s, t.f.field, m))
    expect(t.s.doc.toString()).toBe(file({ 2: 'ours 2', 5: 'theirs 5' }))
    expect(applyNonConflicting(t.s, t.f.field, m)).toBeNull()
  })

  it('ignoring both sides of a marker block puts the base back', () => {
    const t = setup('markers')
    expect(t.text(CONFLICT)).toBe('<<<<<<< HEAD\nours 9\n=======\ntheirs 9\n>>>>>>> other\n')
    t.run(ignoreSide(t.s, t.f.field, m, CONFLICT, 'ours'))
    expect(t.text(CONFLICT)).toBe('line 9\n')
    expect(isResolved(m.blocks[CONFLICT]!, t.status(CONFLICT))).toBe(false)
    t.run(ignoreSide(t.s, t.f.field, m, CONFLICT, 'theirs'))
    expect(isResolved(m.blocks[CONFLICT]!, t.status(CONFLICT))).toBe(true)
    expect(t.s.doc.toString()).toBe(file({ 2: 'ours 2', 5: 'theirs 5' }))
  })

  it('says where each block of the result came from, for colouring it', () => {
    const t = setup()
    const OURS = m.blocks.findIndex((b) => b.kind === 'ours')
    const THEIRS = m.blocks.findIndex((b) => b.kind === 'theirs')
    expect(sourceClass(m.blocks[OURS]!, t.status(OURS))).toBe('cm-m-from-ours')
    expect(sourceClass(m.blocks[THEIRS]!, t.status(THEIRS))).toBe('cm-m-from-theirs')
    expect(sourceClass(m.blocks[CONFLICT]!, t.status(CONFLICT))).toBe('')
    t.run(applySide(t.s, t.f.field, m, CONFLICT, 'theirs'))
    expect(sourceClass(m.blocks[CONFLICT]!, t.status(CONFLICT))).toBe('cm-m-from-theirs')
    t.run(applySide(t.s, t.f.field, m, CONFLICT, 'ours'))
    expect(sourceClass(m.blocks[CONFLICT]!, t.status(CONFLICT))).toBe('cm-m-from-both')
  })
})
