import { findDefinitions, type Definition } from '@gitsquid/codegraph'
import type { FileDiff } from '@gitsquid/shared'
import { layerOf } from './walkthrough'

/**
 * Which definitions a change touches: on the new side, every definition a hunk's added lines
 * fall in (changed, or added if it did not exist before); on the old side, definitions that are
 * gone. Pure: texts come from the caller.
 */
export function changedSymbols(files: FileDiff[], after: (path: string) => string | null, before: (path: string) => string | null) {
  const out: { name: string; kind: string; path: string; line: number; change: 'changed' | 'added' | 'removed' }[] = []
  for (const f of files) {
    if (f.binary) continue
    const newText = f.change === 'deleted' ? null : after(f.path)
    const oldText = f.change === 'added' ? null : before(f.oldPath ?? f.path)
    const newDefs = newText ? findDefinitions(f.path, newText) : []
    const oldDefs = oldText ? findDefinitions(f.oldPath ?? f.path, oldText) : []
    const oldNames = new Set(oldDefs.map((d) => `${d.kind} ${d.name}`))
    const newNames = new Set(newDefs.map((d) => `${d.kind} ${d.name}`))
    const touched = new Set<Definition>()
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind !== '+' || l.newNo === undefined) continue
        // The innermost definition around the added line.
        let best: Definition | undefined
        for (const d of newDefs) if (d.line <= l.newNo && l.newNo <= d.endLine && (!best || d.line >= best.line)) best = d
        if (best) touched.add(best)
      }
    }
    for (const d of touched) out.push({ name: d.name, kind: d.kind, path: f.path, line: d.line, change: oldNames.has(`${d.kind} ${d.name}`) ? 'changed' : 'added' })
    for (const d of oldDefs) if (!newNames.has(`${d.kind} ${d.name}`)) out.push({ name: d.name, kind: d.kind, path: f.oldPath ?? f.path, line: d.line, change: 'removed' })
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
