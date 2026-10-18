import type { AiTask } from '@gitsquid/shared'
import clsx from 'clsx'
import { Check, ChevronDown, ChevronUp, Circle, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cancelAi, useAiRuns, type AiRunInfo } from '../lib/ai'
import { Spinner } from './ui'

/** What each request is doing, as the card's title. */
const LABEL: Record<AiTask['kind'], string> = {
  'commit-message': 'Writing a commit message',
  'explain-commit': 'Explaining the commit',
  'explain-error': 'Explaining the error',
  'resolve-conflict': 'Resolving the conflict',
  recompose: 'Planning the new commits',
  review: 'Reviewing the change',
  'assess-impact': 'Assessing the impact',
  ask: 'Answering your question',
  walkthrough: 'Writing the walkthrough',
  'fix-finding': 'Fixing the finding',
  'push-checks': 'Checking the push',
}

/**
 * One card per AI request on its way, bottom left (bottom right would cover the Commit button,
 * where commit messages are written). It answers "is anything happening, and how long will it
 * be": the current step, the time so far against how long this kind of request took lately, and,
 * on demand, what the agent shares as it works (its thinking, its tool calls, its plan).
 */
export function AiActivity() {
  const runs = useAiRuns((s) => s.runs)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!runs.length) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [runs.length])
  if (!runs.length) return null
  return (
    <div className="pointer-events-none fixed bottom-8 left-2 z-40 flex w-80 max-w-[calc(100vw-1rem)] flex-col gap-2" data-testid="ai-activity">
      {runs.map((r) => <RunCard key={r.requestId} run={r} now={now} />)}
    </div>
  )
}

function RunCard({ run, now }: { run: AiRunInfo; now: number }) {
  const [open, setOpen] = useState(false)
  const a = run.activity
  const elapsed = Math.max(0, now - run.started)
  const step = a?.step || 'Starting'
  const slow = run.usually !== null && elapsed > run.usually * 1.5
  const hasDetail = !!a && (!!a.thought || a.tools.length > 0 || a.plan.length > 0)
  const done = a?.plan.filter((p) => p.status === 'completed').length ?? 0
  return (
    <div className="pointer-events-auto overflow-hidden rounded-lg border border-line bg-raised text-[13px] shadow-xl shadow-black/30" data-testid="ai-run"
      data-kind={run.kind}>
      <div className="flex items-start gap-2 p-3 pb-2">
        <Sparkles size={14} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{LABEL[run.kind]}</div>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <Spinner />
            <span className="min-w-0 flex-1 truncate" data-testid="ai-step" title={step}>
              {step}
              {a?.step === 'Writing the answer' && a.chars > 0 && <span className="text-faint"> · {formatChars(a.chars)}</span>}
            </span>
          </div>
        </div>
        <button onClick={() => cancelAi(run.requestId)} title="Stop" className="rounded p-0.5 text-faint hover:bg-hover hover:text-fg" data-testid="ai-stop">
          <X size={14} />
        </button>
      </div>
      {/* Time so far against the usual: a filling bar when there is a usual (it stops short of the
          end, since it is a guess), else a pulse that only says "working". */}
      <div className="mx-3 h-1 overflow-hidden rounded-full bg-line">
        {run.usually ? (
          <div className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-linear"
            style={{ width: `${Math.min(95, (elapsed / run.usually) * 100)}%` }} />
        ) : (
          <div className="h-full w-full animate-pulse rounded-full bg-accent/50" />
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-faint">
        <span data-testid="ai-elapsed">{formatTime(elapsed)}</span>
        {run.usually !== null && (
          <span className={clsx(slow && 'text-warn')}>{slow ? 'taking longer than usual' : `usually about ${formatTime(run.usually)}`}</span>
        )}
        {a && a.plan.length > 0 && <span>· step {Math.min(done + 1, a.plan.length)} of {a.plan.length}</span>}
        <span className="flex-1" />
        {hasDetail && (
          <button onClick={() => setOpen(!open)} className="flex items-center gap-0.5 rounded px-1 hover:bg-hover hover:text-fg" data-testid="ai-details">
            {open ? 'Hide' : 'Details'} {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        )}
      </div>
      {open && a && <Details activity={a} />}
    </div>
  )
}

function Details({ activity: a }: { activity: NonNullable<AiRunInfo['activity']> }) {
  const thought = useRef<HTMLPreElement>(null)
  // Follow the thinking as it grows, like a terminal.
  useEffect(() => {
    if (thought.current) thought.current.scrollTop = thought.current.scrollHeight
  }, [a.thought])
  return (
    <div className="flex max-h-72 flex-col gap-2 overflow-auto border-t border-line px-3 py-2 text-xs" data-testid="ai-detail">
      {a.plan.length > 0 && (
        <ul className="flex flex-col gap-0.5" data-testid="ai-plan">
          {a.plan.map((p, i) => (
            <li key={i} className={clsx('flex items-start gap-1.5', p.status === 'completed' ? 'text-faint line-through' : p.status === 'in_progress' ? 'text-fg' : 'text-muted')}>
              <StatusIcon status={p.status} /> <span className="min-w-0">{p.content}</span>
            </li>
          ))}
        </ul>
      )}
      {a.tools.length > 0 && (
        <ul className="flex flex-col gap-0.5" data-testid="ai-tools">
          {a.tools.map((t) => (
            <li key={t.id} className={clsx('flex items-start gap-1.5', t.status === 'failed' ? 'text-del' : 'text-muted')}>
              <StatusIcon status={t.status} /> <span className="min-w-0 truncate" title={t.title}>{t.title}</span>
            </li>
          ))}
        </ul>
      )}
      {a.thought && (
        <pre ref={thought} className="selectable max-h-40 overflow-auto font-sans whitespace-pre-wrap text-muted italic" data-testid="ai-thought">{a.thought}</pre>
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: 'pending' | 'in_progress' | 'completed' | 'failed' }) {
  if (status === 'completed') return <Check size={12} className="mt-px shrink-0 text-add" />
  if (status === 'failed') return <X size={12} className="mt-px shrink-0" />
  if (status === 'in_progress') return <span className="mt-px shrink-0"><Spinner /></span>
  return <Circle size={12} className="mt-px shrink-0 text-faint" />
}

/** 0:07, 1:32, 12:05. */
export function formatTime(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function formatChars(n: number): string {
  return n < 1000 ? `${n} characters` : `${(n / 1000).toFixed(1)}k characters`
}
