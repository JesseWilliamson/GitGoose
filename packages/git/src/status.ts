import type { Head, StatusEntry } from '@gitgoose/shared'

export interface ParsedStatus {
  head: Head
  upstream?: string
  ahead: number
  behind: number
  entries: StatusEntry[]
}

/**
 * Parse `git status --porcelain=v2 -z --branch --untracked-files=all`.
 *
 * With -z every entry ends in NUL, and paths are raw bytes (never quoted). Renames are the one
 * odd case: a type-2 entry is followed by a second NUL-terminated field holding the original path.
 */
export function parseStatus(output: string): ParsedStatus {
  const result: ParsedStatus = { head: { detached: false }, ahead: 0, behind: 0, entries: [] }
  const fields = output.split('\x00')
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!
    if (!f) continue
    if (f.startsWith('# ')) {
      const [key, ...rest] = f.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') result.head.hash = value === '(initial)' ? undefined : value
      else if (key === 'branch.head') {
        if (value === '(detached)') result.head.detached = true
        else result.head.branch = value
      } else if (key === 'branch.upstream') result.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          result.ahead = Number(m[1])
          result.behind = Number(m[2])
        }
      }
      continue
    }
    const type = f[0]
    if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = splitN(f, ' ', 9)
      const xy = parts[1]!
      result.entries.push({ path: parts[8]!, index: xy[0]!, worktree: xy[1]!, kind: 'changed' })
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path <NUL> origPath
      const parts = splitN(f, ' ', 10)
      const xy = parts[1]!
      const origPath = fields[++i]!
      result.entries.push({ path: parts[9]!, origPath, index: xy[0]!, worktree: xy[1]!, kind: 'renamed' })
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = splitN(f, ' ', 11)
      const xy = parts[1]!
      result.entries.push({ path: parts[10]!, index: xy[0]!, worktree: xy[1]!, kind: 'unmerged' })
    } else if (type === '?') {
      result.entries.push({ path: f.slice(2), index: '?', worktree: '?', kind: 'untracked' })
    }
  }
  return result
}

/** Split into at most n parts; the last part keeps any remaining separators (paths contain spaces). */
function splitN(s: string, sep: string, n: number): string[] {
  const out: string[] = []
  let start = 0
  for (let k = 0; k < n - 1; k++) {
    const j = s.indexOf(sep, start)
    if (j < 0) break
    out.push(s.slice(start, j))
    start = j + 1
  }
  out.push(s.slice(start))
  return out
}

/** Files with changes in the index (the "staged" list). */
export function isStaged(e: StatusEntry): boolean {
  return e.kind !== 'untracked' && e.kind !== 'unmerged' && e.index !== '.'
}

/** Files with changes in the working tree (the "unstaged" list, including untracked). */
export function isUnstaged(e: StatusEntry): boolean {
  return e.kind === 'untracked' || (e.kind !== 'unmerged' && e.worktree !== '.')
}
