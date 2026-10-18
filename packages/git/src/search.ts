import type { GitRunner } from './runner'

/**
 * GitKraken-style search: one query matched against every field at once (message, author name
 * and email, SHA prefix, branch and tag names), returning hits in graph order so "3 of 12" steps
 * through them top to bottom.
 *
 * Why one pass in JS instead of `git log --grep … --author …`: git can OR a message pattern with
 * an author pattern, but not with "this hash prefix" or "a branch named like this", and merging
 * separate result lists would lose the graph's order. Walking the log once with the same
 * revisions and order as the graph (LogStream) and testing each commit here keeps everything in
 * one ordered list. Cost is one history walk, the same as git's own filters; a newer search
 * cancels an older one, so typing quickly never queues walks up.
 */

/** Field separator inside a record, and record separator (neither appears in commit text). */
const FORMAT = '%H%x00%an%x00%ae%x00%B%x1e'

export interface LogSearchOptions {
  /** Branch and tag names by commit (short names like "main", "origin/main", "v1.0"). */
  refNames?: Map<string, string[]>
  /** Stop after this many hits (the UI cannot use more). */
  limit?: number
  signal?: AbortSignal
}

/** Does a commit match? Exported for tests and for anything that already has the fields. */
export function matchesCommit(q: string, c: { hash: string; author: string; email: string; message: string; refs?: string[] }): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return false
  if (/^[0-9a-f]{4,40}$/.test(needle) && c.hash.startsWith(needle)) return true
  if (c.message.toLowerCase().includes(needle)) return true
  if (c.author.toLowerCase().includes(needle) || c.email.toLowerCase().includes(needle)) return true
  return !!c.refs?.some((r) => r.toLowerCase().includes(needle))
}

export function searchLog(runner: GitRunner, revs: string[], query: string, opts: LogSearchOptions = {}): Promise<string[]> {
  const limit = opts.limit ?? 5000
  return new Promise((resolve, reject) => {
    if (!query.trim() || opts.signal?.aborted) return resolve([])
    const child = runner.spawn(['log', '--topo-order', `--format=${FORMAT}`, ...revs, '--'], { readOnly: true })
    const hits: string[] = []
    let buf = ''
    let stderr = ''
    let finished = false
    const finish = (err?: Error) => {
      if (finished) return
      finished = true
      opts.signal?.removeEventListener('abort', onAbort)
      child.kill()
      if (err) reject(err)
      else resolve(hits)
    }
    const onAbort = () => finish()
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk
      let end: number
      while ((end = buf.indexOf('\x1e')) >= 0) {
        // Records after the first start with the newline git puts after each one.
        const rec = buf.slice(0, end).replace(/^\n/, '')
        buf = buf.slice(end + 1)
        const [hash = '', author = '', email = '', message = ''] = rec.split('\0')
        if (matchesCommit(query, { hash, author, email, message, refs: opts.refNames?.get(hash) })) {
          hits.push(hash)
          if (hits.length >= limit) return finish()
        }
      }
    })
    child.stderr!.on('data', (b: Buffer) => (stderr += b.toString('utf8')))
    child.on('close', (code) => {
      if (code === 0 || finished) finish()
      else finish(new Error(stderr.trim() || `git log exited with ${code}`))
    })
    child.on('error', (e) => finish(e))
  })
}
