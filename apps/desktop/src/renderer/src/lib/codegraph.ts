import type { CodeGraphStatus } from '@gitgoose/shared'

/** What to show while a request waits for the code graph, or null when it is not the reason to wait. */
export function indexingText(s: CodeGraphStatus): string | null {
  if (s.state === 'indexing') return s.total ? `Indexing code… ${s.done.toLocaleString()} / ${s.total.toLocaleString()} files` : 'Indexing code…'
  if (s.state === 'error') return `Code index failed${s.message ? `: ${s.message}` : ''}. Using text search.`
  return null
}
