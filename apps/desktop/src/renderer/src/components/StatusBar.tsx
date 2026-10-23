import { GitBranch, Loader2 } from 'lucide-react'
import { opName, sentence } from '../lib/format'
import { getLog, type RepoView } from '../lib/store'
import { AiJobsChip } from './AiJobsChip'

export function StatusBar({ view }: { view: RepoView }) {
  const snap = view.snapshot
  const log = getLog(view.id)
  const head = snap.head.branch ? snap.refs.find((r) => r.name === `refs/heads/${snap.head.branch}`) : undefined
  return (
    <div className="flex h-statusbar shrink-0 items-center gap-4 border-t border-border bg-card px-3 text-2xs text-muted-foreground" data-testid="status-bar">
      <span className="flex items-center gap-1">
        <GitBranch size={11} />
        {snap.head.branch ?? (snap.head.detached ? `detached at ${snap.head.hash?.slice(0, 7)}` : 'no branch')}
      </span>
      {head?.upstream && <span>{head.upstream.replace('refs/remotes/', '')} ↑{head.ahead ?? 0} ↓{head.behind ?? 0}</span>}
      {snap.operation && <span className="font-semibold text-warn">{sentence(opName(snap.operation))} in progress</span>}
      {view.codegraph.state === 'indexing' && view.codegraph.total > 0 && (
        <span className="flex items-center gap-1" data-testid="codegraph-status" title="Parsing the repository for Peek and Impact">
          <Loader2 size={11} className="animate-spin" /> Indexing code {view.codegraph.done.toLocaleString()} / {view.codegraph.total.toLocaleString()}
        </span>
      )}
      <span className="flex-1" />
      <AiJobsChip />
      <span data-testid="commit-count">{log.commits.length.toLocaleString()}{log.done ? '' : '+'} {log.commits.length === 1 && log.done ? 'commit' : 'commits'}</span>
      <span className="max-w-96 truncate" title={snap.path}>{snap.path}</span>
    </div>
  )
}
