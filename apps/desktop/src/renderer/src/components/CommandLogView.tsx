import type { CommandRecord } from '@gitgoose/shared'
import clsx from 'clsx'
import { Terminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { copy } from '../lib/actions'
import { api } from '../lib/api'
import { updateRepo, type RepoView } from '../lib/store'
import { Button } from './ui'

const KEEP = 500

/**
 * Every git command GitGoose ran for this repository (GitKraken's activity log): what it ran,
 * how long it took, how it ended, and what git said on stderr. Reads (status, log, for-each-ref
 * on every refresh) are hidden by default; they are most of the traffic and rarely the question.
 */
export function CommandLogView({ view }: { view: RepoView }) {
  const [records, setRecords] = useState<CommandRecord[]>([])
  const [reads, setReads] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  /** The same list for the poller, which outlives any one render's `records`. */
  const current = useRef<CommandRecord[]>([])

  // Poll while open: ask only for what is newer, and re-ask for ones still running.
  useEffect(() => {
    let live = true
    let latest = 0
    const tick = async () => {
      const running = current.current.filter((r) => r.durationMs === null)
      const since = running.length ? Math.min(...running.map((r) => r.id)) - 1 : latest
      const fresh = await api.commandLog(view.id, since).catch(() => [])
      if (!live || !fresh.length) return
      latest = Math.max(latest, fresh[0]!.id)
      const byId = new Map(current.current.map((r) => [r.id, r]))
      for (const r of fresh) byId.set(r.id, r)
      current.current = [...byId.values()].sort((a, b) => b.id - a.id).slice(0, KEEP)
      setRecords(current.current)
    }
    void tick()
    const t = setInterval(() => void tick(), 1000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [view.id])

  const shown = records.filter((r) => reads || !r.readOnly)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="command-log">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <Terminal size={18} className="text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">Git command log</div>
          <div className="truncate text-xs text-muted-foreground">Newest first. Click one to see what git printed.</div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={reads} onChange={(e) => setReads(e.target.checked)} /> Show reads
        </label>
        <Button variant="ghost" onClick={() => updateRepo(view.id, { center: { kind: 'graph' } })}>Back to graph</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-xs">
        {shown.length === 0 && <div className="p-4 font-sans text-xs text-hint">Nothing yet{reads ? '' : ' (reads are hidden)'}.</div>}
        {shown.map((r) => {
          const failed = r.code !== null && r.code !== 0
          const cmd = `git ${r.args.map((a) => (/[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`
          return (
            <div key={r.id} className="border-b border-border/50" data-testid="command-row" data-failed={failed || undefined}>
              <div onClick={() => setOpen(open === r.id ? null : r.id)} className="flex h-7 cursor-default items-center gap-3 px-4 hover:bg-accent">
                <span className="w-16 shrink-0 text-hint">{new Date(r.start).toLocaleTimeString([], { hour12: false })}</span>
                <span className={clsx('min-w-0 flex-1 truncate', failed && 'text-destructive')} title={cmd}>{cmd}</span>
                <span className="w-16 shrink-0 text-right text-hint">{r.durationMs === null ? 'running' : `${r.durationMs} ms`}</span>
                <span className={clsx('w-8 shrink-0 text-right', failed ? 'text-destructive' : 'text-hint')} title="Exit code">{r.code ?? ''}</span>
              </div>
              {open === r.id && (
                <div className="bg-background px-4 py-2">
                  <pre className="selectable max-h-60 overflow-auto whitespace-pre-wrap text-muted-foreground">{r.stderr.trim() || '(nothing on stderr)'}</pre>
                  <Button size="sm" variant="ghost" className="mt-1 font-sans" onClick={() => copy(cmd, 'Copied command')}>Copy command</Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
