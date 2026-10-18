import { describe, expect, it } from 'vitest'
import { history, push, redo, undo } from './history'

describe('history', () => {
  it('undoes and redoes; a new edit after undo drops the redo branch', () => {
    let h = push(push(history('a'), 'b'), 'c')
    h = undo(h)
    expect(h.present).toBe('b')
    h = undo(h)
    expect(h.present).toBe('a')
    expect(undo(h)).toBe(h) // nothing left
    h = redo(h)
    expect(h.present).toBe('b')
    h = push(h, 'd')
    expect(h.future).toEqual([])
    expect(undo(h).present).toBe('b')
  })

  it('collapses edits with the same key into one step, and skips no-op pushes', () => {
    let h = push(history('msg'), 'msg t', 'typing:0')
    h = push(h, 'msg ty', 'typing:0')
    h = push(h, 'msg typ', 'typing:0')
    expect(h.past).toEqual(['msg'])
    h = push(h, 'other', 'typing:1')
    expect(h.past).toEqual(['msg', 'msg typ'])
    expect(push(h, 'other', 'typing:1')).toBe(h)
    expect(undo(undo(h)).present).toBe('msg')
  })
})
