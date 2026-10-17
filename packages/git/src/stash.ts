import type { StashEntry } from '@gitsquid/shared'

export const STASH_FORMAT = '%gd%x00%H%x00%ct%x00%gs%x1e'

/** Parse `git stash list --format=STASH_FORMAT`. */
export function parseStashList(output: string): StashEntry[] {
  const out: StashEntry[] = []
  for (let rec of output.split('\x1e')) {
    if (rec.startsWith('\n')) rec = rec.slice(1)
    if (!rec) continue
    const [ref = '', hash = '', date = '0', message = ''] = rec.split('\x00')
    const index = Number(/\{(\d+)\}/.exec(ref)?.[1] ?? out.length)
    out.push({ index, ref, hash, date: Number(date), message })
  }
  return out
}
