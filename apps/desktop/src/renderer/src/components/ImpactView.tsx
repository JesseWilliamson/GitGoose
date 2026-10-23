import type { ImpactResult } from '@gitgoose/shared'
import clsx from 'clsx'
import { Radar, Sparkles } from 'lucide-react'
import { openInEditor } from '../lib/actions'
import { useAiEnabled } from '../lib/ai'
import { indexingText } from '../lib/codegraph'
import { assessImpact, showImpact } from '../lib/impact'
import { updateRepo, type RepoView } from '../lib/store'
import { RailToggle, ThreadRail, useRailOpen } from './ThreadRail'
import { Button, Spinner } from './ui'
import { AiTargetButton } from './AiTargetButton'

const CHANGE_STYLE = { changed: 'bg-warn/15 text-warn', added: 'bg-add/15 text-add', removed: 'bg-destructive/15 text-destructive' }

/**
 * What a change could affect beyond itself. Everything here is found locally (codegraph, git
 * grep, history); "Assess impact" then asks the model which of these uses are at risk, and it
 * may only point at the ones listed.
 */
export function ImpactView({ view }: { view: RepoView }) {
  const st = view.impact
  const aiOn = useAiEnabled()
  const chat = useRailOpen('impact')
  if (!st) return null
  const r = st.result
  const risk = new Map(r?.assessment?.risks.map((x) => [x.id, x.why]) ?? [])
  const bySymbol = new Map<string, ImpactResult['callers']>()
  for (const c of r?.callers ?? []) bySymbol.set(c.symbol, [...(bySymbol.get(c.symbol) ?? []), c])
  const open = (path: string, line: number) => void openInEditor(`${view.snapshot.path}/${path}`, line)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="impact">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <Radar size={18} className="text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">Impact: {r?.label ?? '…'}</div>
          <div className="truncate text-xs text-muted-foreground">
            {st.loading ? (indexingText(view.codegraph) ?? 'Looking for uses…') : r ? `${r.symbols.length} definition${r.symbols.length === 1 ? '' : 's'} touched, used in ${r.callers.length} other place${r.callers.length === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        {aiOn && r && r.callers.length > 0 && <AiTargetButton area="impact" />}
        {aiOn && r && r.callers.length > 0 && (
          st.requestId ? <Button disabled><Spinner /> Assessing…</Button>
            : <Button onClick={() => assessImpact(view.id)} data-testid="assess-impact"><Sparkles size={13} /> Assess impact</Button>
        )}
        <Button onClick={() => showImpact(view.id, st.scope)}>Again</Button>
        {aiOn && r && <RailToggle kind="impact" />}
        <Button variant="ghost" onClick={() => updateRepo(view.id, { center: { kind: 'graph' } })}>Back to graph</Button>
      </div>
      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4 text-sm">
        {st.error && <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive">{st.error}</div>}
        {r?.assessment && (
          <div className="mb-4 max-w-4xl rounded-md border border-primary/30 bg-primary/5 p-3" data-testid="impact-assessment">
            <p>{r.assessment.summary || 'Assessed.'}</p>
            <p className="mt-1 text-xs text-muted-foreground">{r.assessment.risks.length} use{r.assessment.risks.length === 1 ? '' : 's'} at risk{r.assessment.dropped ? ` · ${r.assessment.dropped} answer${r.assessment.dropped === 1 ? '' : 's'} ignored (not one of the listed uses)` : ''}</p>
          </div>
        )}
        {r && (
          <>
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase">Definitions touched</h3>
            {!r.symbols.length && <p className="text-muted-foreground/70">None found (no known language, or only top-level code changed).</p>}
            <div className="mb-5 flex max-w-4xl flex-wrap gap-2" data-testid="impact-symbols">
              {r.symbols.map((s) => (
                <button key={`${s.path}:${s.name}:${s.change}`} onClick={() => open(s.path, s.line)} className="flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 hover:border-primary">
                  <span className={clsx('rounded px-1 text-2xs font-medium', CHANGE_STYLE[s.change])}>{s.change}</span>
                  <span className="font-mono text-xs">{s.name}</span>
                  <span className="text-2xs text-muted-foreground/70">{s.kind}</span>
                </button>
              ))}
            </div>

            <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase">Used elsewhere</h3>
            {!r.callers.length && <p className="mb-5 text-muted-foreground/70">No uses outside the change.</p>}
            <div className="mb-5 max-w-5xl" data-testid="impact-callers">
              {[...bySymbol].map(([symbol, list]) => (
                <div key={symbol} className="mb-3">
                  <div className="mb-1 font-mono text-xs font-semibold">{symbol}</div>
                  {list.map((c) => (
                    <div key={c.id} data-testid="impact-caller" data-risk={risk.has(c.id) || undefined} className={clsx('rounded px-1', risk.has(c.id) && 'bg-destructive/10')}>
                      <button onClick={() => open(c.path, c.line)} className="flex w-full items-center gap-3 py-0.5 text-left hover:text-primary">
                        <span className="w-64 shrink-0 truncate font-mono text-xs text-muted-foreground">{c.path}:{c.line}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{c.text}</span>
                        {c.within && <span className="shrink-0 text-2xs text-muted-foreground/70">{c.within}</span>}
                        {c.test && <span className="shrink-0 rounded bg-accent px-1 text-2xs text-muted-foreground">test</span>}
                      </button>
                      {risk.has(c.id) && <p className="pb-1 pl-1 text-xs text-destructive">⚠ {risk.get(c.id)}</p>}
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase">Tests</h3>
            <div className="mb-5" data-testid="impact-tests">
              {r.tests.length ? r.tests.map((t) => <div key={t} className="font-mono text-xs">{t}</div>) : <p className="text-muted-foreground/70">No tests found for this code.</p>}
            </div>
          </>
        )}
      </div>
      {aiOn && chat && r && !st.requestId && (
        <ThreadRail repoId={view.id} kind="impact" anchor={{ kind: 'impact', scope: st.scope }} threadId={st.threadId}
          onThread={(id) => updateRepo(view.id, (v) => (v.impact ? { impact: { ...v.impact, threadId: id } } : {}))}
          hint="Ask what a change to one of these definitions could break, or which tests to run." />
      )}
      </div>
    </div>
  )
}
