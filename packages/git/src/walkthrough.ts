import { enclosingDefinition, findDefinitions, type Definition } from '@gitgoose/codegraph'
import type { FileDiff, ReadingLayer, SequenceDiagram, WalkthroughHunk } from '@gitgoose/shared'

/**
 * The deterministic half of a walkthrough: cut the change into hunks, place each in a reading
 * layer, mark the trivial ones, and check what the model says about them.
 */

const TEST = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/
const DOCS = /\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//i
const CONFIG = /\.(json|ya?ml|toml|ini|cfg|conf|lock|env|properties|xml)$|(^|\/)(\.[^/]+rc|Dockerfile|Makefile|\.github\/)/i
const CONTRACT_FILE = /\.d\.ts$|(^|\/)(api|types|interfaces?|schema|contracts?|protocol)\.[a-z]+$|\.proto$|\.graphql$/i

export function layerOf(path: string, within?: { kind: string }): ReadingLayer {
  if (TEST.test(path)) return 'tests'
  if (DOCS.test(path)) return 'docs'
  if (CONFIG.test(path)) return 'config'
  if (CONTRACT_FILE.test(path) || within?.kind === 'interface' || within?.kind === 'type') return 'contract'
  return 'implementation'
}

const ORDER: ReadingLayer[] = ['contract', 'implementation', 'tests', 'config', 'docs']

/**
 * Every hunk of the change as a reading unit (H1, H2, …) in reading order: by layer, then by
 * file, then top to bottom. A hunk is trivial when its changed lines are only whitespace,
 * imports or comments.
 */
export function walkthroughHunks(files: FileDiff[], textAfter: (path: string) => string | null, defsOf: (path: string, text: string) => Definition[] = findDefinitions): WalkthroughHunk[] {
  const out: WalkthroughHunk[] = []
  for (const f of files) {
    const text = f.binary || f.change === 'deleted' ? null : textAfter(f.path)
    const defs = text ? defsOf(f.path, text) : []
    const units = f.binary || !f.hunks.length ? [null] : f.hunks
    for (const h of units) {
      const changed = h ? h.lines.filter((l) => l.kind !== ' ') : []
      const added = changed.filter((l) => l.kind === '+').length
      const removed = changed.length - added
      const start = h ? (h.newLines ? h.newStart : h.oldStart) : 1
      const end = h ? (h.newLines ? h.newStart + h.newLines - 1 : h.oldStart + h.oldLines - 1) : 1
      const d = h && h.newLines ? enclosingDefinition(defs, h.newStart + Math.min(3, h.newLines - 1)) : null
      // Only changes that cannot alter behaviour fold: whitespace, imports, comments. A one-line
      // change can be the most important line of the change (a new field on an interface).
      const trivial = !!h && changed.length > 0 && changed.every((l) => !l.text.trim() || /^\s*(import\b|from\s+\S+\s+import\b|#include\b|use\s+[\w:]+;|(const|let|var)\s+\w+\s*=\s*require\(|\/\/|\/\*|\*|#(?!include|define))/.test(l.text))
      out.push({ id: '', path: f.path, layer: layerOf(f.path, d ?? undefined), startLine: start, endLine: Math.max(start, end), added, removed, trivial, within: d ? `${d.kind} ${d.name}` : undefined })
    }
  }
  out.sort((a, b) => ORDER.indexOf(a.layer) - ORDER.indexOf(b.layer) || a.path.localeCompare(b.path) || a.startLine - b.startLine)
  out.forEach((h, i) => (h.id = `H${i + 1}`))
  return out
}

/** Hunks as the model sees them: id, place, layer, and the changed lines (budgeted). */
export function describeHunks(files: FileDiff[], hunks: WalkthroughHunk[], maxLines = 40): string {
  const byKey = new Map<string, FileDiff>(files.map((f) => [f.path, f]))
  return hunks.map((h) => {
    const f = byKey.get(h.path)!
    const hunk = f.hunks.find((x) => (x.newLines ? x.newStart : x.oldStart) === h.startLine)
    const lines = hunk ? hunk.lines.filter((l) => l.kind !== ' ').map((l) => `${l.kind}${l.text}`) : [f.binary ? '(binary)' : '(no text change)']
    const shown = lines.slice(0, maxLines)
    return [`[${h.id}] ${h.path}:${h.startLine}-${h.endLine} ${h.layer}${h.within ? `, in ${h.within}` : ''} (+${h.added} -${h.removed})`, ...shown, ...(lines.length > maxLines ? [`… ${lines.length - maxLines} more`] : [])].join('\n')
  }).join('\n\n')
}

/**
 * Check the model's walkthrough against the change. Groups may only list files in the change
 * (files no group mentions get an "Other changes" group); hunk summaries only for real ids;
 * effort is clamped to 1-5; a sequence diagram must use its own participants and stay small.
 */
export function verifyWalkthrough(raw: unknown, paths: string[], hunks: WalkthroughHunk[]): {
  summary: string; effort: number; effortWhy: string; groups: { title: string; description: string; files: string[] }[]; sequence: SequenceDiagram | null
} {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const known = new Set(paths)
  const seen = new Set<string>()
  const groups: { title: string; description: string; files: string[] }[] = []
  for (const g of Array.isArray(o.groups) ? o.groups : []) {
    const x = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>
    const files = (Array.isArray(x.files) ? x.files : []).filter((p): p is string => typeof p === 'string' && known.has(p) && !seen.has(p))
    files.forEach((p) => seen.add(p))
    if (files.length && str(x.title, 120)) groups.push({ title: str(x.title, 120), description: str(x.description, 1000), files })
  }
  const rest = paths.filter((p) => !seen.has(p))
  if (rest.length) groups.push({ title: groups.length ? 'Other changes' : 'Changes', description: '', files: rest })
  const summaries = (o.hunks && typeof o.hunks === 'object' ? o.hunks : {}) as Record<string, unknown>
  for (const h of hunks) {
    const s = str(summaries[h.id], 200)
    if (s) h.summary = s
  }
  const effort = Math.min(5, Math.max(1, Math.round(Number(o.effort)) || 3))
  return { summary: str(o.summary, 3000), effort, effortWhy: str(o.effortWhy, 300), groups, sequence: verifySequence(o.sequence) }
}

/** A sequence diagram the model drew, kept only if it uses its own participants and stays small (also json:diagram in chat). */
export function verifySequence(raw: unknown): SequenceDiagram | null {
  if (!raw || typeof raw !== 'object') return null
  const x = raw as Record<string, unknown>
  const participants = (Array.isArray(x.participants) ? x.participants : []).filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim().slice(0, 40))
  const unique = [...new Set(participants)].slice(0, 8)
  const messages = (Array.isArray(x.messages) ? x.messages : []).flatMap((m) => {
    const y = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    const from = typeof y.from === 'string' ? y.from.trim() : ''
    const to = typeof y.to === 'string' ? y.to.trim() : ''
    const label = typeof y.label === 'string' ? y.label.trim().slice(0, 80) : ''
    return unique.includes(from) && unique.includes(to) ? [{ from, to, label }] : []
  }).slice(0, 24)
  return unique.length >= 2 && messages.length ? { participants: unique, messages } : null
}
