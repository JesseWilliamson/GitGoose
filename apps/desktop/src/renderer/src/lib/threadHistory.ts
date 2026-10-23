import type { AiThread, ThreadAnchor } from '@gitgoose/shared'

/** What each kind of conversation is, in the AI panel's history list. */
export const ANCHOR_KIND: Record<ThreadAnchor['kind'], string> = {
  free: 'Chat',
  review: 'Review',
  changestack: 'Review',
  explain: 'Explain',
  recompose: 'Recompose',
  walkthrough: 'Walkthrough',
  impact: 'Impact',
  ask: 'Ask',
  error: 'Error',
  conflict: 'Conflict',
  task: 'Task',
}

export interface DayGroup {
  /** "Today", "Yesterday", or "Mar 4" (with the year when it is not this one). */
  label: string
  threads: AiThread[]
}

const startOfDay = (t: number): number => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * The history list, grouped by the local day a conversation was last used. Order within and
 * between groups is the order given (main sends most recently used first).
 */
export function groupThreadsByDay(threads: AiThread[], now = Date.now()): DayGroup[] {
  const today = startOfDay(now)
  const yesterday = startOfDay(today - 1)
  const thisYear = new Date(now).getFullYear()
  const groups: DayGroup[] = []
  const byDay = new Map<number, DayGroup>()
  for (const t of threads) {
    const day = startOfDay(t.updatedAt)
    let g = byDay.get(day)
    if (!g) {
      const d = new Date(day)
      const label = day === today ? 'Today' : day === yesterday ? 'Yesterday'
        : d.toLocaleDateString(undefined, d.getFullYear() === thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
      g = { label, threads: [] }
      byDay.set(day, g)
      groups.push(g)
    }
    g.threads.push(t)
  }
  return groups
}
