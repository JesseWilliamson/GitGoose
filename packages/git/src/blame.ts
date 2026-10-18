import type { BlameLine } from '@gitgoose/shared'

/**
 * Parse `git blame --porcelain`.
 *
 * Each line of the file is introduced by "<hash> <orig-line> <final-line> [<group-size>]".
 * The first time a commit appears, header lines follow (author, author-time, summary, ...);
 * later lines from the same commit omit them, so we remember them per hash. The file's line
 * itself comes last, prefixed by a TAB.
 */
export function parseBlame(output: string): BlameLine[] {
  const info = new Map<string, { author: string; date: number; summary: string }>()
  const result: BlameLine[] = []
  let current: { hash: string; lineNo: number } | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('\t')) {
      if (current) {
        const meta = info.get(current.hash) ?? { author: '', date: 0, summary: '' }
        result.push({ hash: current.hash, lineNo: current.lineNo, text: line.slice(1), ...meta })
      }
      current = null
      continue
    }
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(line)
    if (header) {
      current = { hash: header[1]!, lineNo: Number(header[2]) }
      if (!info.has(current.hash)) info.set(current.hash, { author: '', date: 0, summary: '' })
      continue
    }
    if (!current) continue
    const meta = info.get(current.hash)!
    const sp = line.indexOf(' ')
    const key = sp < 0 ? line : line.slice(0, sp)
    const value = sp < 0 ? '' : line.slice(sp + 1)
    if (key === 'author') meta.author = value
    else if (key === 'author-time') meta.date = Number(value)
    else if (key === 'summary') meta.summary = value
  }
  return result
}
