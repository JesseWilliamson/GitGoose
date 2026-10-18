import { fuzzy } from './fuzzy'

/**
 * The omni search's model. Results are plain data (a kind, a key, what to show); what choosing
 * one does lives in one place (OmniSearch's `activate`). Plain data can be ranked, tested and
 * stored as "recent" without dragging closures along.
 */

export type OmniKind = 'command' | 'branch' | 'tag' | 'change' | 'file' | 'stash' | 'setting' | 'commit'

export interface OmniEntry {
  kind: OmniKind
  /** Unique within its kind: a ref name, a path, a hash, a command id. */
  key: string
  title: string
  /** Second line: where it is, who wrote it, what it does. */
  sub?: string
}

export interface OmniResult extends OmniEntry {
  score: number
  /** Matched ranges in the title, for highlighting. */
  ranges: [number, number][]
}

export interface OmniGroup {
  kind: OmniKind
  label: string
  results: OmniResult[]
  /** Matches before the limit, to say "and 40 more". */
  total: number
}

export const GROUP_LABEL: Record<OmniKind, string> = {
  command: 'Commands', branch: 'Branches', tag: 'Tags', change: 'Changed files', file: 'Files', stash: 'Stashes',
  setting: 'Settings', commit: 'Commits',
}

/** The filter chips, in Tab order. 'all' searches everything. */
export const SCOPES = ['all', 'command', 'branch', 'commit', 'file', 'setting'] as const
export type OmniScope = (typeof SCOPES)[number]
export const SCOPE_LABEL: Record<OmniScope, string> = { all: 'All', command: 'Commands', branch: 'Branches', commit: 'Commits', file: 'Files', setting: 'Settings' }

/** Which kinds a scope shows (tags and stashes travel with branches; changed files with files). */
export function kindsOf(scope: OmniScope): OmniKind[] {
  switch (scope) {
    case 'all': return ['command', 'branch', 'tag', 'change', 'file', 'stash', 'setting', 'commit']
    case 'branch': return ['branch', 'tag', 'stash']
    case 'file': return ['change', 'file']
    default: return [scope]
  }
}

/**
 * When groups are put in order, how much each kind's best match is worth on top of its score.
 * A git client is mostly asked about branches, commits and commands; a setting or a file that
 * matches as well should come after them.
 */
export const KIND_WEIGHT: Record<OmniKind, number> = { branch: 25, command: 20, commit: 20, change: 15, tag: 10, stash: 5, file: 0, setting: -15 }

/** How many of each kind to show when searching everything; a scope shows many more. */
const LIMIT: Record<OmniKind, number> = { command: 6, branch: 6, tag: 4, change: 5, file: 8, stash: 3, setting: 4, commit: 8 }
export const SCOPED_LIMIT = 50

/**
 * Rank one kind of entry against the query. The title is matched first; failing that, the title
 * and its second line together (a branch found by its remote, a setting by its section), worth
 * a little less, with only the title's part highlighted.
 */
export function rankEntries(query: string, entries: OmniEntry[], limit: number): { results: OmniResult[]; total: number } {
  const q = query.trim()
  const out: OmniResult[] = []
  for (const e of entries) {
    if (!q) {
      out.push({ ...e, score: 0, ranges: [] })
      continue
    }
    let m = fuzzy(q, e.title)
    if (!m && e.sub) {
      const both = fuzzy(q, `${e.title} ${e.sub}`)
      if (both) m = { score: both.score - 30, ranges: both.ranges.filter(([s]) => s < e.title.length).map(([s, end]) => [s, Math.min(end, e.title.length)]) }
    }
    if (m) out.push({ ...e, score: m.score, ranges: m.ranges })
  }
  // Stable for equal scores: the sources come in a meaningful order (newest commit, HEAD first).
  if (q) out.sort((a, b) => b.score - a.score)
  return { results: out.slice(0, limit), total: out.length }
}

/**
 * Everything ranked and grouped. Groups come in order of their best result, so the group that
 * holds the obvious answer is on top and Enter picks it; ties keep the order of `kinds`.
 */
export function rankAll(query: string, sources: Partial<Record<OmniKind, OmniEntry[]>>, scope: OmniScope): OmniGroup[] {
  const kinds = kindsOf(scope)
  const groups: OmniGroup[] = []
  for (const kind of kinds) {
    const entries = sources[kind]
    if (!entries?.length) continue
    const { results, total } = rankEntries(query, entries, scope === 'all' ? LIMIT[kind] : SCOPED_LIMIT)
    if (results.length) groups.push({ kind, label: GROUP_LABEL[kind], results, total })
  }
  if (query.trim()) {
    const best = (g: OmniGroup) => (g.results[0]?.score ?? -Infinity) + KIND_WEIGHT[g.kind]
    groups.sort((a, b) => best(b) - best(a) || kinds.indexOf(a.kind) - kinds.indexOf(b.kind))
  }
  return groups
}

/** "> pull" searches only commands, like VS Code; the ">" is not part of the query. */
export function parseQuery(raw: string, scope: OmniScope): { query: string; scope: OmniScope } {
  if (raw.startsWith('>')) return { query: raw.slice(1).trim(), scope: 'command' }
  return { query: raw.trim(), scope }
}

// ------------------------------------------------------------------ recent

const RECENT_KEY = 'gitgoose.omni.recent'
const RECENT_MAX = 6

/** What was chosen lately, newest first (this window's local storage; a convenience, nothing more). */
export function loadRecent(): OmniEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? (raw as OmniEntry[]).filter((e) => e && typeof e.key === 'string' && typeof e.title === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

export function rememberRecent(e: OmniEntry): void {
  try {
    const list = [{ kind: e.kind, key: e.key, title: e.title, sub: e.sub }, ...loadRecent().filter((x) => !(x.kind === e.kind && x.key === e.key))]
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)))
  } catch {
    // Storage full or unavailable: there is just no recent list.
  }
}
