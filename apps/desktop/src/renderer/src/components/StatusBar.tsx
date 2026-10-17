import { GitBranch } from 'lucide-react'
import { getLog, type RepoView } from '../lib/store'

export function StatusBar({ view }: { view: RepoView }) {
  const snap = view.snapshot
  const log = getLog(view.id)
  const head = snap.head.branch ? snap.refs.find((r) => r.name === `refs/heads/${snap.head.branch}`) : undefined
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-muted" data-testid="status-bar">
      <span className="flex items-center gap-1">
        <GitBranch size={11} />
        {snap.head.branch ?? (snap.head.detached ? `detached at ${snap.head.hash?.slice(0, 7)}` : 'no branch')}
      </span>
      {head?.upstream && <span>{head.upstream.replace('refs/remotes/', '')} ↑{head.ahead ?? 0} ↓{head.behind ?? 0}</span>}
      {snap.operation && <span className="font-semibold text-warn capitalize">{snap.operation} in progress</span>}
      <span className="flex-1" />
      <span data-testid="commit-count">{log.commits.length.toLocaleString()}{log.done ? '' : '+'} commits</span>
      <span className="max-w-96 truncate" title={snap.path}>{snap.path}</span>
    </div>
  )
}
