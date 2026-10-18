import type { FileDiff, PushCheck, PushCheckResult, PushCheckVerdict } from '@gitgoose/shared'
import { secretFindings } from './lint'
import type { ReviewableLines } from './review'

/**
 * Pre-push checks: the deterministic half. The model judges each rule against the outgoing
 * change; this code decides what its answer is allowed to say. Every check sent gets exactly one
 * verdict (a missing or garbled one is "inconclusive", never "pass"), and a failure that points
 * only at lines outside the change is not believed.
 */

const VERDICTS: PushCheckVerdict[] = ['pass', 'fail', 'inconclusive']

export function verifyPushChecks(
  raw: unknown, checks: (PushCheck & { source: PushCheckResult['source'] })[], lines: ReviewableLines,
): PushCheckResult[] {
  const answers = new Map<string, Record<string, unknown>>()
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : []
  for (const a of list) {
    if (!a || typeof a !== 'object') continue
    const id = (a as { id?: unknown }).id
    // The first answer per id counts; ids that were not sent are ignored.
    if (typeof id === 'string' && !answers.has(id)) answers.set(id, a as Record<string, unknown>)
  }
  const inChange = (path: string, line: number) => (lines.get(path) ?? []).some((r) => line >= r.start - 2 && line <= r.end + 2)
  return checks.map((c, i) => {
    const base = { name: c.name, mode: c.mode, source: c.source }
    const a = answers.get(`C${i + 1}`)
    if (!a) return { ...base, verdict: 'inconclusive', reason: 'The AI did not answer for this check.', evidence: [] }
    const verdict = VERDICTS.includes(a.verdict as PushCheckVerdict) ? (a.verdict as PushCheckVerdict) : 'inconclusive'
    const reason = typeof a.reason === 'string' && a.reason.trim() ? a.reason.trim().slice(0, 600) : verdict === 'pass' ? 'Passed.' : 'No reason given.'
    const cited = Array.isArray(a.evidence) ? a.evidence : []
    const evidence = cited.flatMap((e) => {
      const x = (e && typeof e === 'object' ? e : {}) as { path?: unknown; line?: unknown }
      return typeof x.path === 'string' && typeof x.line === 'number' && inChange(x.path, x.line) ? [{ path: x.path, line: x.line }] : []
    }).slice(0, 10)
    // "Fails because of line 40 of a.ts" when line 40 is not in the change: the model is
    // talking about something it was not shown. Say so instead of blocking on it.
    if (verdict === 'fail' && cited.length && !evidence.length) {
      return { ...base, verdict: 'inconclusive', reason: `The AI said this fails, but pointed only at lines that are not in this push. Its reason: ${reason}`, evidence: [] }
    }
    return { ...base, verdict, reason, evidence }
  })
}

/** The built-in check: no secrets on lines the push adds. No AI involved. */
export function secretPushCheck(files: FileDiff[]): PushCheckResult {
  const hits = secretFindings(files)
  const base = { name: 'No secrets in the pushed commits', mode: 'block' as const, source: 'builtin' as const }
  if (!hits.length) return { ...base, verdict: 'pass', reason: 'The secret scan found nothing on the added lines.', evidence: [] }
  const kinds = [...new Set(hits.map((h) => h.title.replace(/^Possible (.+) in the code$/, '$1')))]
  return {
    ...base, verdict: 'fail',
    reason: `Found ${hits.length === 1 ? 'what looks like' : `${hits.length} things that look like`} ${kinds.join(', ')}. Once pushed, it is in the remote's history even if a later commit removes it.`,
    evidence: hits.map((h) => ({ path: h.path, line: h.startLine })),
  }
}

/** Should the user see the results before the push goes ahead? On any failure, or when a blocking check could not be judged. */
export function pushCheckOutcome(results: PushCheckResult[]): 'go' | 'warn' | 'block' {
  if (results.some((r) => r.mode === 'block' && r.verdict === 'fail')) return 'block'
  if (results.some((r) => r.verdict === 'fail' || (r.mode === 'block' && r.verdict === 'inconclusive'))) return 'warn'
  return 'go'
}
