import type { FindingSeverity, ReviewFinding } from '@gitgoose/shared'
import clsx from 'clsx'
import { Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { applySuggestion, dismissFinding, fixWithAi, rememberDismissal, startReview, stopReview, targetFor } from '../lib/review'
import { openFile } from '../lib/actions'
import { api } from '../lib/api'
import { toast, updateRepo, useStore, type RepoView } from '../lib/store'
import { OpenChatButton } from './OpenChat'
import { Button, Spinner } from './ui'
import { AiTargetButton } from './AiTargetButton'

export const SEVERITY_STYLE: Record<FindingSeverity, string> = {
  critical: 'bg-destructive text-white',
  major: 'bg-destructive/15 text-destructive',
  minor: 'bg-warn/15 text-warn',
  nit: 'bg-accent text-muted-foreground',
}

/**
 * The findings of the last AI review, grouped by file, most severe first. Every finding here
 * passed verification (it points at lines that are in the change); the ones that did not are
 * listed at the bottom, so nothing is hidden silently.
 */
export function ReviewView({ view }: { view: RepoView }) {
  const r = view.review
  const [showDropped, setShowDropped] = useState(false)
  const focused = useRef<HTMLDivElement>(null)
  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'center' })
  }, [r?.focus])
  if (!r) return null
  const result = r.result
  const findings = result?.findings.filter((f) => !r.dismissed.includes(f.id)) ?? []
  const byFile = new Map<string, ReviewFinding[]>()
  for (const f of findings) byFile.set(f.path, [...(byFile.get(f.path) ?? []), f])
  const counts = (['critical', 'major', 'minor', 'nit'] as FindingSeverity[]).map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n)
  const open = (f: ReviewFinding) => openFile(view.id, targetFor(result!, f.path))

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="review">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <Sparkles size={18} className="text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">Review: {result?.label ?? 'running…'}</div>
          <div className="truncate text-xs text-muted-foreground">
            {r.requestId ? 'Reading the change…' : r.error ? 'The review failed.'
              : findings.length ? counts.map(([s, n]) => `${n} ${s}`).join(' · ') : 'No findings.'}
            {` · ${r.profile} profile`}
          </div>
        </div>
        <AiTargetButton area="review" />
        {r.requestId ? <Button onClick={() => stopReview(view.id)}><Spinner /> Stop</Button>
          : <Button onClick={() => startReview(view.id, r.scope, { incremental: true })} title="Only what changed since this review is sent again">Review again</Button>}
        {result && <OpenChatButton repoId={view.id} threadId={r.threadId} />}
        <Button variant="ghost" onClick={() => updateRepo(view.id, { center: { kind: 'graph' } })}>Back to graph</Button>
      </div>
      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {r.error && <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{r.error}</div>}
        {result?.summary && <p className="selectable mx-4 mt-4 text-sm text-muted-foreground" data-testid="review-summary">{result.summary}</p>}
        {result?.incremental && (
          <div className="mx-4 mt-2 text-xs text-muted-foreground" data-testid="review-incremental">
            Re-review: {result.incremental.sent} changed piece{result.incremental.sent === 1 ? '' : 's'} sent, {result.incremental.unchanged} unchanged.
            {result.incremental.addressed.length > 0 && (
              <span data-testid="review-addressed"> Addressed since last time: {result.incremental.addressed.map((a) => `${a.title} (${a.path})`).join('; ')}.</span>
            )}
          </div>
        )}
        {result && (
          <p className="mx-4 mt-2 text-xs text-hint" data-testid="review-context">
            {result.context.guidelines.length ? `Followed ${result.context.guidelines.join(', ')}` : 'No guideline files (CLAUDE.md, AGENTS.md, …) cover these files'}
            {result.context.pathInstructions.length ? ` · path instructions for ${result.context.pathInstructions.join(', ')}` : ''}
            {` · ${result.context.learnings} learning${result.context.learnings === 1 ? '' : 's'} · `}
            <button className="text-primary hover:underline" onClick={() => useStore.setState({ dialog: { kind: 'learnings', repoId: view.id } })}>Manage learnings</button>
            {result.context.commits ? ` · ${result.context.commits} commit message${result.context.commits === 1 ? '' : 's'}` : ''}
            {result.context.code && (
              <span data-testid="review-code-context" title={result.context.code.source === 'graph' ? 'Parsed by the code graph' : 'The code graph was not ready: line patterns and text search were used'}>
                {` · ${result.context.code.source === 'graph' ? 'code graph' : 'code (no graph yet)'}: ${result.context.code.symbols} changed definition${result.context.code.symbols === 1 ? '' : 's'}, ${result.context.code.uses} use${result.context.code.uses === 1 ? '' : 's'} outside, ${result.context.code.used} definition${result.context.code.used === 1 ? '' : 's'} used, ${result.context.code.tests} test file${result.context.code.tests === 1 ? '' : 's'}${result.context.code.truncated ? ' (cut for size)' : ''}`}
              </span>
            )}
            {result.context.linters?.map((l) => (
              <span key={l.command} data-testid="review-linter">
                {` · ${l.name} `}
                {l.status === 'ran' ? `on ${l.files} file${l.files === 1 ? '' : 's'}: ${l.findings} finding${l.findings === 1 ? '' : 's'}${l.note ? ` (${l.note})` : ''}`
                  : l.status === 'failed' ? <span className="text-warn">failed{l.note ? `: ${l.note}` : ''}</span>
                  : `skipped (${l.note})`}
                {l.status === 'skipped' && l.note?.startsWith('you chose') && (
                  <> <button className="text-primary hover:underline" onClick={() => void api.decideLinter(view.id, l.command, null).then(() => toast({ kind: 'info', title: `The next review will ask about ${l.name} again.` }))}>Ask again</button></>
                )}
              </span>
            ))}
          </p>
        )}
        {result && !findings.length && !r.error && <p className="mx-4 mt-4 text-sm text-hint">Nothing to report{result.findings.length ? ' (all dismissed)' : ''}.</p>}
        {[...byFile].map(([path, list]) => (
          <section key={path} className="mx-4 mt-4">
            <h3 className="mb-2 font-mono text-xs text-muted-foreground">{path}</h3>
            {list.map((f) => (
              <div key={f.id} ref={r.focus === f.id ? focused : undefined} data-testid="finding" data-severity={f.severity}
                className={clsx('mb-2 rounded-md border bg-card p-3', r.focus === f.id ? 'border-primary' : 'border-border')}>
                <div className="flex items-center gap-2">
                  <span className={clsx('rounded px-1.5 text-2xs font-semibold uppercase', SEVERITY_STYLE[f.severity])}>{f.severity}</span>
                  <span className="text-2xs text-hint">{f.type}</span>
                  {f.source && <span className="rounded border border-border px-1 text-2xs text-muted-foreground" data-testid="finding-source" title={f.source === 'scan' ? "Found by GitGoose's built-in secret scan, not the AI" : 'Reported by a linter, not the AI'}>{f.tool}</span>}
                  {f.status && <span className={clsx('text-2xs', f.status === 'new' ? 'text-primary' : 'text-hint')} data-testid="finding-status">{f.status === 'new' ? 'new' : 'still open'}</span>}
                  {f.fromChat && <span className="rounded bg-primary/15 px-1 text-2xs text-primary" data-testid="finding-from-chat" title="Applied from the chat beside the review">from chat</span>}
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{f.title}</span>
                  <button className="font-mono text-2xs text-primary hover:underline" onClick={() => open(f)} title="Show in the diff">
                    lines {f.startLine}{f.endLine !== f.startLine ? `-${f.endLine}` : ''}
                  </button>
                </div>
                <p className="selectable mt-1.5 text-sm whitespace-pre-wrap">{f.message}</p>
                {f.suggestion !== undefined && (
                  <pre className="selectable mt-2 overflow-x-auto rounded border border-border bg-background p-2 font-mono text-xs" data-testid="suggestion">
                    {(f.original ?? []).map((l, i) => <div key={`o${i}`} className="text-destructive">- {l}</div>)}
                    {f.suggestion.split('\n').map((l, i) => <div key={`n${i}`} className="text-add">+ {l}</div>)}
                  </pre>
                )}
                <div className="mt-2 flex gap-2">
                  {f.suggestion !== undefined && <Button size="sm" onClick={() => void applySuggestion(view.id, f)} data-testid="apply-suggestion">Apply suggestion</Button>}
                  <Button size="sm" onClick={() => fixWithAi(view.id, f)} data-testid="fix-with-ai"><Sparkles size={12} /> Fix with AI…</Button>
                  <Button size="sm" variant="ghost" onClick={() => open(f)}>Show in diff</Button>
                  <Button size="sm" variant="ghost" onClick={() => dismissFinding(view.id, f.id)}>Dismiss</Button>
                  {!f.source && <Button size="sm" variant="ghost" onClick={() => rememberDismissal(view.id, f)} data-testid="remember-dismissal" title="Dismiss, and tell future reviews not to flag this">Don't flag again…</Button>}
                </div>
              </div>
            ))}
          </section>
        ))}
        {result && (result.dropped.length > 0 || result.skipped.length > 0) && (
          <div className="mx-4 my-4 text-xs text-hint">
            {result.skipped.length > 0 && <p>Not reviewed (over the size limit): {result.skipped.join(', ')}.</p>}
            {result.dropped.length > 0 && (
              <>
                <button className="hover:text-foreground" onClick={() => setShowDropped(!showDropped)} data-testid="dropped-toggle">
                  {result.dropped.length} finding{result.dropped.length === 1 ? ' was' : 's were'} thrown out by verification {showDropped ? '▾' : '▸'}
                </button>
                {showDropped && (
                  <ul className="mt-1 list-disc pl-5" data-testid="dropped">
                    {result.dropped.map((d, i) => <li key={i}>{d.title}: {d.reason}</li>)}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
