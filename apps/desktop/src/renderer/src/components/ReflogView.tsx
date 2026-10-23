import type { ReflogEntry } from '@gitgoose/shared'
import clsx from 'clsx'
import { History } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useEffect, useState } from 'react'
import { ask, checkout, copy, reset, run } from '../lib/actions'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { ensureLoaded, getLog, reportError, updateRepo, useStore, type RepoView } from '../lib/store'
import { Button, CM } from './ui'

/**
 * The reflog: every place HEAD has been, newest first. It is where "lost" work lives: a
 * deleted branch, a commit dropped by a reset or a rebase. Nothing reaches those commits any more
 * except this log (git's gc deletes them after about 90 days), so the useful action is
 * "restore as a branch", which makes them reachable again.
 */
export function ReflogView({ view }: { view: RepoView }) {
  const [entries, setEntries] = useState<ReflogEntry[] | null>(null)
  const [onlyLost, setOnlyLost] = useState(false)
  const head = view.snapshot.head

  // Reload when HEAD or any ref moves (refsVersion), which is when the reflog changes.
  useEffect(() => {
    api.reflog(view.id).then(setEntries, (e) => reportError('Could not read the reflog', e))
  }, [view.id, view.snapshot.refsVersion, head.hash])

  const shown = entries?.filter((e) => !onlyLost || e.lost) ?? []
  const lostCount = new Set(entries?.filter((e) => e.lost).map((e) => e.hash)).size
  const selected = view.selected.kind === 'commit' ? view.selected.hash : null

  const select = (e: ReflogEntry) => updateRepo(view.id, { selected: { kind: 'commit', hash: e.hash } })
  const showInGraph = async (e: ReflogEntry) => {
    updateRepo(view.id, { selected: { kind: 'commit', hash: e.hash }, center: { kind: 'graph' } })
    await ensureLoaded(view.id, e.hash)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="reflog">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <History size={18} className="text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">Reflog</div>
          <div className="truncate text-xs text-muted-foreground">
            {lostCount ? `${lostCount} commit${lostCount === 1 ? ' is' : 's are'} reachable only from here: restore ${lostCount === 1 ? 'it' : 'them'} as a branch to keep ${lostCount === 1 ? 'it' : 'them'}.` : 'Nothing is lost.'}
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={onlyLost} onChange={(e) => setOnlyLost(e.target.checked)} /> Only lost commits
        </label>
        <Button variant="ghost" onClick={() => updateRepo(view.id, { center: { kind: 'graph' } })}>Back to graph</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries === null && <div className="p-4 text-xs text-muted-foreground/70">Reading the reflog…</div>}
        {entries?.length === 0 && <div className="p-4 text-xs text-muted-foreground/70">HEAD has not moved yet.</div>}
        {shown.map((e) => (
          <ContextMenu.Root key={e.index}>
            <ContextMenu.Trigger asChild>
              <div
                onClick={() => select(e)}
                onDoubleClick={() => (e.lost ? restore(view.id, e) : void showInGraph(e))}
                data-testid="reflog-row" data-hash={e.hash}
                className={clsx('flex h-8 cursor-default items-center gap-3 border-b border-border/50 px-4 text-sm', selected === e.hash ? 'bg-select' : 'hover:bg-accent')}
              >
                <span className="w-20 shrink-0 font-mono text-2xs text-muted-foreground/70">HEAD@{'{'}{e.index}{'}'}</span>
                <span className={clsx('w-28 shrink-0 truncate text-2xs font-medium', ACTION_COLOR[e.action.split(' ')[0]!] ?? 'text-muted-foreground')}>{e.action}</span>
                <span className="min-w-0 flex-1 truncate">{e.message || e.subject}</span>
                {e.lost && <span className="rounded bg-warn/15 px-1.5 text-2xs font-medium text-warn" title="No branch or tag reaches this commit">lost</span>}
                {e.branchHint && <span className="text-2xs text-muted-foreground/70" title={`The tip of ${e.branchHint} when you left it`}>was {e.branchHint}</span>}
                <span className="w-16 shrink-0 font-mono text-2xs text-muted-foreground/70">{e.hash.slice(0, 7)}</span>
                <span className="w-24 shrink-0 text-right text-2xs text-muted-foreground/70">{relativeTime(e.date)}</span>
              </div>
            </ContextMenu.Trigger>
            <CM.Content>
              <CM.Label>{e.hash.slice(0, 7)} {e.subject}</CM.Label>
              <CM.Item onSelect={() => restore(view.id, e)}>Restore as a branch…</CM.Item>
              {!e.lost && getLog(view.id).index.has(e.hash) && <CM.Item onSelect={() => void showInGraph(e)}>Show in the graph</CM.Item>}
              <CM.Item disabled={e.hash === head.hash} onSelect={() => void checkout(view.id, e.hash)}>Check out (detached)</CM.Item>
              {head.branch && (
                <CM.Sub label={`Reset ${head.branch} to here`}>
                  <CM.Item onSelect={() => void reset(view.id, e.hash, 'soft')}>Soft: keep changes staged</CM.Item>
                  <CM.Item onSelect={() => void reset(view.id, e.hash, 'mixed')}>Mixed: keep changes unstaged</CM.Item>
                  <CM.Item onSelect={() => void reset(view.id, e.hash, 'hard')}>Hard: discard changes</CM.Item>
                </CM.Sub>
              )}
              <CM.Separator />
              <CM.Item onSelect={() => copy(e.hash, 'Copied SHA')}>Copy SHA</CM.Item>
            </CM.Content>
          </ContextMenu.Root>
        ))}
      </div>
    </div>
  )
}

const ACTION_COLOR: Record<string, string> = {
  commit: 'text-add', checkout: 'text-primary', reset: 'text-warn', rebase: 'text-warn', merge: 'text-primary', pull: 'text-primary',
}

/** Make a lost commit reachable again: a branch at it, named after the branch it was on when known. */
function restore(id: string, e: ReflogEntry): void {
  const taken = useStore.getState().repos[id]?.snapshot.refs.some((r) => r.kind === 'local' && r.shortName === e.branchHint)
  ask('Restore as a branch', 'Branch name', 'Create branch', (name) => {
    void run(id, `Create branch ${name.trim()}`, () => api.createBranch(id, name.trim(), { at: e.hash }), { success: `Restored ${e.hash.slice(0, 7)} as ${name.trim()}` })
  }, { initial: e.branchHint && !taken ? e.branchHint : `restored-${e.hash.slice(0, 7)}` })
}
