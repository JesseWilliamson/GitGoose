/**
 * An undo/redo stack over immutable values (the recompose draft). `push` records the value
 * being replaced; a `key` lets a burst of small edits (typing a message, a live reorder while
 * dragging) collapse into one undo step: pushes with the same key as the last one replace
 * the present without adding to the past.
 */
export interface History<T> {
  past: T[]
  present: T
  future: T[]
  key: string | null
}

export const history = <T>(present: T): History<T> => ({ past: [], present, future: [], key: null })

export function push<T>(h: History<T>, next: T, key?: string): History<T> {
  if (next === h.present) return h
  const merge = key !== undefined && key === h.key
  return { past: merge ? h.past : [...h.past, h.present], present: next, future: [], key: key ?? null }
}

export function undo<T>(h: History<T>): History<T> {
  const previous = h.past[h.past.length - 1]
  if (previous === undefined) return h
  return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future], key: null }
}

export function redo<T>(h: History<T>): History<T> {
  const [next, ...rest] = h.future
  if (next === undefined) return h
  return { past: [...h.past, h.present], present: next, future: rest, key: null }
}
