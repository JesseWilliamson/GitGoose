const MIN = 60
const HOUR = 3600
const DAY = 86400

/** "5 min ago", "3 days ago", or a date for anything older than a month. */
export function relativeTime(unixSeconds: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - unixSeconds)
  if (d < MIN) return 'just now'
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`
  if (d < DAY * 30) {
    const n = Math.floor(d / DAY)
    return n === 1 ? 'yesterday' : `${n} days ago`
  }
  return absoluteDate(unixSeconds)
}

export function absoluteDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function dateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return ((parts[0]![0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '')).toUpperCase()
}

/** A stable colour index for a string (author avatars). */
export function hashColor(s: string, n = 8): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % n
}

export function laneColor(i: number): string {
  return `var(--lane-${((i % 8) + 8) % 8})`
}

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

/** "merge" -> "Merge". (CSS `capitalize` would turn "merge in progress" into "Merge In Progress".) */
/** How to call an operation in prose: `git am` is "patch" ("The patch stopped", "Abort patch"). */
export function opName(op: string): string {
  return op === 'am' ? 'patch' : op
}

export function sentence(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

/** A date per Settings → Appearance → Dates. */
export function formatDate(unixSeconds: number, mode: 'relative' | 'absolute' | 'both' | string): string {
  if (mode === 'absolute') return absoluteDate(unixSeconds)
  if (mode === 'both') {
    const rel = relativeTime(unixSeconds)
    const abs = absoluteDate(unixSeconds)
    return rel === abs ? abs : `${rel} · ${abs}`
  }
  return relativeTime(unixSeconds)
}

/**
 * A stash's message for display: a message the user typed loses git's "On main: " prefix; an
 * automatic one ("WIP on main: abc123 subject") keeps it, since it is the only description.
 */
export function stashLabel(message: string): string {
  return message.replace(/^On [^:]+: /, '')
}
