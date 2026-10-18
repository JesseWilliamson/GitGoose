import type { SequenceDiagram } from '@gitgoose/shared'

/**
 * Where everything in a sequence diagram goes: participants in columns with a lifeline each,
 * messages as rows from top to bottom. A message to oneself is a small loop on the right.
 * Columns widen for long labels (a label is centred between its two lifelines).
 */
export interface SequenceLayout {
  width: number
  height: number
  participants: { name: string; x: number }[]
  messages: { x1: number; x2: number; y: number; label: string; self: boolean }[]
  headH: number
}

const CHAR_W = 6.5

export function layoutSequence(d: SequenceDiagram, opts: { minCol?: number; rowH?: number; pad?: number } = {}): SequenceLayout {
  const { minCol = 130, rowH = 36, pad = 20 } = opts
  const names = d.participants
  const n = names.length
  const boxW = (name: string) => name.length * CHAR_W + 24
  // space[i]: distance from participant i to i+1. Wide enough for both boxes, then for every
  // label between them (a label spanning several columns shares the shortfall among them).
  const space = Array.from({ length: Math.max(0, n - 1) }, (_, i) => Math.max(minCol, (boxW(names[i]!) + boxW(names[i + 1]!)) / 2 + 16))
  let rightRoom = Math.max(minCol / 2, boxW(names[n - 1] ?? '') / 2)
  for (const m of d.messages) {
    const a = names.indexOf(m.from)
    const b = names.indexOf(m.to)
    const need = m.label.length * CHAR_W + 24
    if (a === b) {
      // A self message loops to the right of its lifeline, label beside the loop.
      if (a < n - 1) space[a] = Math.max(space[a]!, need + 40)
      else rightRoom = Math.max(rightRoom, need + 40)
      continue
    }
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const have = space.slice(lo, hi).reduce((sum, g) => sum + g, 0)
    if (have < need) for (let i = lo; i < hi; i++) space[i] = space[i]! + (need - have) / (hi - lo)
  }
  const xs = [pad + Math.max(minCol / 2, boxW(names[0] ?? '') / 2)]
  for (let i = 0; i < n - 1; i++) xs.push(xs[i]! + space[i]!)
  const headH = 32
  return {
    width: Math.ceil(xs[n - 1]! + rightRoom + pad),
    height: pad + headH + 24 + d.messages.length * rowH + 8,
    participants: names.map((name, i) => ({ name, x: xs[i]! })),
    messages: d.messages.map((m, i) => {
      const a = names.indexOf(m.from)
      const b = names.indexOf(m.to)
      return { x1: xs[a]!, x2: xs[b]!, y: pad + headH + 24 + i * rowH, label: m.label, self: a === b }
    }),
    headH,
  }
}
