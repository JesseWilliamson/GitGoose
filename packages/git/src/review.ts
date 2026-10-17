import { enclosingDefinition, findDefinitions } from '@gitsquid/codegraph'
import { FINDING_TYPES, SEVERITIES, type FileDiff, type FindingSeverity, type ReviewFinding, type ReviewProfile } from '@gitsquid/shared'

/**
 * The deterministic half of AI review: what the model is shown, and what is done with its
 * answer. The model judges; this code makes sure that what reaches the screen is about lines
 * that are really in the change.
 */

/** New-side line ranges per file: where findings may point. */
export type ReviewableLines = Map<string, { start: number; end: number }[]>

export function reviewableLines(files: FileDiff[]): ReviewableLines {
  const m: ReviewableLines = new Map()
  for (const f of files) {
    if (f.binary || f.change === 'deleted') continue
    m.set(f.path, f.hunks.filter((h) => h.newLines > 0).map((h) => ({ start: h.newStart, end: h.newStart + h.newLines - 1 })))
  }
  return m
}

/**
 * The diff as the model reads it: every line that exists after the change carries its new line
 * number, so findings can cite lines exactly; removed lines carry none. Each hunk says which
 * definition it is in, when the file's text is known (codegraph).
 */
export function numberedDiff(files: FileDiff[], textAfter: (path: string) => string | null): string {
  const out: string[] = []
  for (const f of files) {
    if (f.binary) {
      out.push(`=== ${f.path} (binary, not shown) ===`, '')
      continue
    }
    const what = f.change === 'added' ? 'new file' : f.change === 'deleted' ? 'deleted' : f.oldPath ? `renamed from ${f.oldPath}` : 'modified'
    out.push(`=== ${f.path} (${what}) ===`)
    const text = f.change === 'deleted' ? null : textAfter(f.path)
    const defs = text ? findDefinitions(f.path, text) : []
    for (const h of f.hunks) {
      const d = enclosingDefinition(defs, h.newStart + Math.min(3, Math.max(0, h.newLines - 1)))
      out.push(`@@ lines ${h.newStart}-${h.newStart + Math.max(0, h.newLines - 1)}${d ? `, in ${d.kind} ${d.name} (lines ${d.line}-${d.endLine})` : ''} @@`)
      for (const l of h.lines) {
        if (l.kind === '-') out.push(`     -| ${l.text}`)
        else out.push(`${String(l.newNo ?? '').padStart(5)}${l.kind === '+' ? '+' : ' '}| ${l.text}`)
      }
    }
    out.push('')
  }
  return out.join('\n')
}

const PROFILE_KEEPS: Record<ReviewProfile, (s: FindingSeverity, type: string) => boolean> = {
  quiet: (s, type) => (s === 'critical' || s === 'major') && (type === 'bug' || type === 'security' || type === 'performance'),
  chill: (s, type) => s !== 'nit' && type !== 'style',
  assertive: () => true,
}

/**
 * Check the model's findings against the change. Kept: findings on a file in the change, whose
 * lines fall inside its hunks (a few lines of slack around them, since a finding about a call
 * may point at the line just above), with a known type and severity, that the profile wants.
 * Everything else is dropped with a reason, so the user can see what was thrown out.
 */
export function verifyFindings(
  raw: unknown,
  lines: ReviewableLines,
  textAfter: (path: string) => string | null,
  profile: ReviewProfile,
): { summary: string; findings: ReviewFinding[]; dropped: { title: string; reason: string }[] } {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as { summary?: unknown; findings?: unknown }
  const list = Array.isArray(obj.findings) ? obj.findings : []
  const findings: ReviewFinding[] = []
  const dropped: { title: string; reason: string }[] = []
  const seen = new Set<string>()
  const SLACK = 2
  for (const [i, f] of list.entries()) {
    const x = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>
    const title = typeof x.title === 'string' ? x.title.trim().slice(0, 200) : ''
    const message = typeof x.message === 'string' ? x.message.trim().slice(0, 4000) : ''
    const path = typeof x.path === 'string' ? x.path.replace(/^\.?\//, '') : ''
    const start = Number(x.startLine)
    const end = Number(x.endLine ?? x.startLine)
    const drop = (reason: string) => dropped.push({ title: title || `finding ${i + 1}`, reason })
    if (!title || !message) { drop('no title or message'); continue }
    const ranges = lines.get(path)
    if (!ranges) { drop(path ? `${path} is not in this change` : 'no file given'); continue }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) { drop('no valid line numbers'); continue }
    if (!ranges.some((r) => start >= r.start - SLACK && end <= r.end + SLACK)) { drop(`lines ${start}-${end} of ${path} are not part of the change`); continue }
    const severity = SEVERITIES.includes(x.severity as FindingSeverity) ? (x.severity as FindingSeverity) : null
    const type = FINDING_TYPES.includes(x.type as never) ? (x.type as ReviewFinding['type']) : null
    if (!severity || !type) { drop('unknown severity or type'); continue }
    if (!PROFILE_KEEPS[profile](severity, type)) continue // asked for less; not an error
    const key = `${path}:${start}:${title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const text = textAfter(path)
    const original = text?.split(/\r?\n/).slice(start - 1, end)
    let suggestion = typeof x.suggestion === 'string' && x.suggestion.trim() ? x.suggestion.replace(/\n$/, '') : undefined
    // A "suggestion" identical to what is there suggests nothing.
    if (suggestion !== undefined && original && suggestion === original.join('\n')) suggestion = undefined
    findings.push({ id: `F${findings.length + 1}`, path, startLine: start, endLine: end, type, severity, title, message, suggestion, original })
  }
  const order = (s: FindingSeverity) => SEVERITIES.indexOf(s)
  findings.sort((a, b) => order(a.severity) - order(b.severity) || a.path.localeCompare(b.path) || a.startLine - b.startLine)
  return { summary: typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 2000) : '', findings, dropped }
}
