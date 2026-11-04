import type { ChangeInsights } from '@gitgoose/shared'
import { Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSetting, type RepoView } from '../lib/store'

/**
 * What history says about the change about to be committed (computed locally): whose lines are
 * being changed, worth a word with them. Re-read when the set of changed files changes.
 */
export function ChangeHints({ view }: { view: RepoView }) {
  const on = useSetting('changeHints')
  const [ins, setIns] = useState<ChangeInsights | null>(null)
  const key = `${view.snapshot.head.hash}|${view.snapshot.status.filter((e) => e.kind !== 'untracked').map((e) => e.path).sort().join('\0')}`
  useEffect(() => {
    if (!on) return
    let live = true
    const t = setTimeout(() => {
      api.changeInsights(view.id).then((i) => live && setIns(i), () => live && setIns(null))
    }, 500)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [view.id, key, on])
  if (!on || !ins || !ins.owners.length) return null
  const owners = ins.owners.slice(0, 3)
  // A side note, not a step: one quiet line above the commit fields, with what it means in the
  // tooltip (it competed with the Summary field as a tinted box).
  const all = ins.owners.map((o) => `${o.name} (${o.lines})`).join(', ')
  return (
    <div className="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-2xs text-hint" data-testid="change-hints"
      title={`Who last wrote the lines you are changing (git blame): worth a word with them.\n${all}`}>
      <Users size={12} className="shrink-0" />
      {owners.length > 0 && (
        <div className="min-w-0 truncate" data-testid="owners">
          Changing lines by {owners.map((o) => `${o.name} (${o.lines})`).join(', ')}{ins.owners.length > 3 ? ` and ${ins.owners.length - 3} more` : ''}.
        </div>
      )}
    </div>
  )
}
