import type { ReflogEntry } from '@gitgoose/shared'

/**
 * `git log -g` walks a reflog instead of history: one line per time the ref moved. With
 * --date=unix, %gd prints the selector as HEAD@{<unix time>}, which gives the time of the move
 * (%ct would be the commit's own date). The index is the position, as in HEAD@{n}.
 */
export const REFLOG_FORMAT = '%H%x00%gd%x00%gs%x00%s%x1e'

export function parseReflog(output: string): ReflogEntry[] {
  const out: ReflogEntry[] = []
  for (let rec of output.split('\x1e')) {
    if (rec.startsWith('\n')) rec = rec.slice(1)
    if (!rec) continue
    const [hash = '', selector = '', reflogSubject = '', subject = ''] = rec.split('\x00')
    const colon = reflogSubject.indexOf(': ')
    out.push({
      index: out.length,
      hash,
      date: Number(/\{(\d+)\}$/.exec(selector)?.[1] ?? 0),
      action: colon >= 0 ? reflogSubject.slice(0, colon) : reflogSubject,
      message: colon >= 0 ? reflogSubject.slice(colon + 2) : '',
      subject,
    })
  }
  // "checkout: moving from X to Y" is recorded where HEAD arrives (Y). The entry just before it
  // in time (the next one in this newest-first list) is where HEAD was on X: X's tip back then.
  for (let i = 0; i < out.length - 1; i++) {
    const m = /^moving from (.+) to .+$/.exec(out[i]!.message)
    if (out[i]!.action === 'checkout' && m && !/^[0-9a-f]{40}$/.test(m[1]!)) out[i + 1]!.branchHint ??= m[1]
  }
  return out
}
