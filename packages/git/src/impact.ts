import { findDefinitions, type Definition } from '@gitgoose/codegraph'
import type { FileDiff } from '@gitgoose/shared'
import { layerOf } from './walkthrough'

export interface ChangedSymbol {
  name: string
  kind: string
  path: string
  line: number
  change: 'changed' | 'added' | 'removed'
  /** The defining line now (before the change, for a removed definition). */
  signature: string
  /** The defining line before the change, when it differs. */
  oldSignature?: string
  /** Added lines inside it: how much of the change this definition carries. */
  touched: number
}

/** Definitions of a file's text on one side of the change. The default reads line patterns. */
export type FindDefinitions = (path: string, text: string, side: 'old' | 'new') => Definition[]

/**
 * Which definitions a change touches: on the new side, every definition a hunk's added lines
 * fall in (changed, or added if it did not exist before); on the old side, definitions that are
 * gone. Pure: texts come from the caller, and so may the definitions (the code graph's, when it
 * has parsed that content).
 */
export function changedSymbols(files: FileDiff[], after: (path: string) => string | null, before: (path: string) => string | null, find: FindDefinitions = (p, t) => findDefinitions(p, t)): ChangedSymbol[] {
  const out: ChangedSymbol[] = []
  for (const f of files) {
    if (f.binary) continue
    const newText = f.change === 'deleted' ? null : after(f.path)
    const oldText = f.change === 'added' ? null : before(f.oldPath ?? f.path)
    const newDefs = newText ? find(f.path, newText, 'new') : []
    const oldDefs = oldText ? find(f.oldPath ?? f.path, oldText, 'old') : []
    const key = (d: Definition) => `${d.kind} ${d.name}`
    const oldByKey = new Map(oldDefs.map((d) => [key(d), d]))
    const newNames = new Set(newDefs.map(key))
    const touched = new Map<Definition, number>()
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind !== '+' || l.newNo === undefined) continue
        // The innermost definition around the added line.
        let best: Definition | undefined
        for (const d of newDefs) if (d.line <= l.newNo && l.newNo <= d.endLine && (!best || d.line >= best.line)) best = d
        if (best) touched.set(best, (touched.get(best) ?? 0) + 1)
      }
    }
    for (const [d, n] of touched) {
      const old = oldByKey.get(key(d))
      out.push({ name: d.name, kind: d.kind, path: f.path, line: d.line, change: old ? 'changed' : 'added', signature: d.signature, ...(old && old.signature !== d.signature ? { oldSignature: old.signature } : {}), touched: n })
    }
    for (const d of oldDefs) if (!newNames.has(key(d))) out.push({ name: d.name, kind: d.kind, path: f.oldPath ?? f.path, line: d.line, change: 'removed', signature: d.signature, touched: 0 })
  }
  return out
}

/** Is this a test file? (Same rules as the reading order.) */
export function isTestPath(path: string): boolean {
  return layerOf(path) === 'tests'
}

/** Test files that, by name, go with `path`: price.ts → price.test.ts, price.spec.ts, test_price.py, price_test.go. */
export function testsByName(path: string, allPaths: string[]): string[] {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
  if (!base) return []
  const re = new RegExp(`(^|/)(${base}\\.(test|spec)\\.[a-z]+|test_${base}\\.py|${base}_test\\.(go|py))$`)
  return allPaths.filter((p) => re.test(p))
}
