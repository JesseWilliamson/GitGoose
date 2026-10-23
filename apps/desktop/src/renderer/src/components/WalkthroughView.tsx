import type { ReadingLayer, WalkthroughHunk } from '@gitgoose/shared'
import clsx from 'clsx'
import { BookOpen } from 'lucide-react'
import { useState } from 'react'
import { relativeTime } from '../lib/format'
import { targetFor } from '../lib/review'
import { ensureLoaded, updateRepo, type RepoView } from '../lib/store'
import { startWalkthrough, stopWalkthrough } from '../lib/walkthrough'
import { MermaidDiagram } from './MermaidDiagram'
import { RailToggle, ThreadRail, useRailOpen } from './ThreadRail'
import { Button, Spinner } from './ui'
import { AiTargetButton } from './AiTargetButton'

const LAYER: Record<ReadingLayer, string> = {
  contract: 'Contracts: types and interfaces',
  implementation: 'Implementation',
  tests: 'Tests',
  config: 'Configuration',
  docs: 'Docs',
}

/**
 * A walkthrough of a change (CodeRabbit's, made local): what it does, how hard it is to
 * review, the files grouped by purpose, a diagram of any flow it changes, every piece
 * in reading order with a one-line summary, and recent history of the same files.
 */
export function WalkthroughView({ view }: { view: RepoView }) {
  const w = view.walkthrough
  const [showTrivial, setShowTrivial] = useState(false)
  const chat = useRailOpen('walkthrough')
  if (!w) return null
  const r = w.result
  const open = (path: string) => r && updateRepo(view.id, { center: { kind: 'file', target: targetFor(r, path), mode: 'diff' } })
  const layers = r ? (['contract', 'implementation', 'tests', 'config', 'docs'] as ReadingLayer[]).map((l) => [l, r.hunks.filter((h) => h.layer === l && !h.trivial)] as const).filter(([, hs]) => hs.length) : []
  const trivial = r?.hunks.filter((h) => h.trivial) ?? []
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="walkthrough">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <BookOpen size={18} className="text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">Walkthrough: {r?.label ?? '…'}</div>
          <div className="truncate text-xs text-muted-foreground">{w.requestId ? 'Reading the change…' : w.error ? 'It failed.' : r ? `${r.hunks.length} pieces in ${new Set(r.hunks.map((h) => h.path)).size} files${w.fromChat ? ' · revised in the chat' : ''}` : ''}</div>
        </div>
        {r && <EffortBadge effort={r.effort} why={r.effortWhy} />}
        <AiTargetButton area="walkthrough" />
        {w.requestId ? <Button onClick={() => stopWalkthrough(view.id)}><Spinner /> Stop</Button> : <Button onClick={() => startWalkthrough(view.id, w.scope)}>Again</Button>}
        {r && <RailToggle kind="walkthrough" />}
        <Button variant="ghost" onClick={() => updateRepo(view.id, { center: { kind: 'graph' } })}>Back to graph</Button>
      </div>
      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {w.error && <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{w.error}</div>}
        {r && (
          <>
            <p className="selectable max-w-3xl text-base leading-relaxed" data-testid="walkthrough-summary">{r.summary}</p>

            <h3 className="mt-6 mb-2 text-xs font-semibold text-muted-foreground uppercase">Changes</h3>
            <div className="grid max-w-4xl gap-2" data-testid="walkthrough-groups">
              {r.groups.map((g) => (
                <div key={g.title} className="rounded-md border border-border bg-card p-3">
                  <div className="text-sm font-semibold">{g.title}</div>
                  {g.description && <p className="mt-0.5 text-sm text-muted-foreground">{g.description}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {g.files.map((f) => <button key={f} onClick={() => open(f)} className="font-mono text-xs text-primary hover:underline">{f}</button>)}
                  </div>
                </div>
              ))}
            </div>

            {r.diagram && (
              <>
                <h3 className="mt-6 mb-2 text-xs font-semibold text-muted-foreground uppercase">Diagram</h3>
                <MermaidDiagram source={r.diagram} />
              </>
            )}

            <h3 className="mt-6 mb-2 text-xs font-semibold text-muted-foreground uppercase">Reading order</h3>
            <div className="max-w-4xl" data-testid="reading-order">
              {layers.map(([layer, hs]) => (
                <div key={layer} className="mb-3">
                  <div className="mb-1 text-xs font-medium text-muted-foreground/70">{LAYER[layer]}</div>
                  {hs.map((h) => <HunkRow key={h.id} h={h} onOpen={() => open(h.path)} />)}
                </div>
              ))}
              {trivial.length > 0 && (
                <div className="mb-3">
                  <button className="text-xs text-muted-foreground/70 hover:text-foreground" onClick={() => setShowTrivial(!showTrivial)} data-testid="trivial-toggle">
                    {trivial.length} small change{trivial.length === 1 ? '' : 's'} (imports, comments, formatting) {showTrivial ? '▾' : '▸'}
                  </button>
                  {showTrivial && trivial.map((h) => <HunkRow key={h.id} h={h} onOpen={() => open(h.path)} />)}
                </div>
              )}
            </div>

            {r.history.length > 0 && (
              <>
                <h3 className="mt-6 mb-2 text-xs font-semibold text-muted-foreground uppercase">Recent history of these files</h3>
                <div className="max-w-4xl text-sm">
                  {r.history.map((c) => (
                    <button key={c.hash} onClick={() => { updateRepo(view.id, { selected: { kind: 'commit', hash: c.hash }, center: { kind: 'graph' } }); void ensureLoaded(view.id, c.hash) }}
                      className="flex w-full items-center gap-3 rounded px-1 py-0.5 text-left hover:bg-accent">
                      <span className="font-mono text-2xs text-muted-foreground/70">{c.hash.slice(0, 7)}</span>
                      <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                      <span className="text-xs text-muted-foreground/70">{c.author}, {relativeTime(c.date)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {r.skipped.length > 0 && <p className="mt-4 text-xs text-muted-foreground/70">Not included (over the size limit): {r.skipped.join(', ')}.</p>}
          </>
        )}
      </div>
      {chat && r && !w.requestId && (
        <ThreadRail repoId={view.id} kind="walkthrough" anchor={{ kind: 'walkthrough', scope: w.scope }} threadId={w.threadId}
          onThread={(id) => updateRepo(view.id, (v) => (v.walkthrough ? { walkthrough: { ...v.walkthrough, threadId: id } } : {}))}
          hint="A revised walkthrough comes back as a card you can apply." />
      )}
      </div>
    </div>
  )
}

function EffortBadge({ effort, why }: { effort: number; why: string }) {
  return (
    <span title={why} data-testid="effort" className={clsx('rounded px-2 py-0.5 text-xs font-medium', effort >= 4 ? 'bg-destructive/15 text-destructive' : effort === 3 ? 'bg-warn/15 text-warn' : 'bg-add/15 text-add')}>
      Review effort {effort}/5
    </span>
  )
}

function HunkRow({ h, onOpen }: { h: WalkthroughHunk; onOpen: () => void }) {
  return (
    <button onClick={onOpen} data-testid="reading-hunk" className="flex w-full items-baseline gap-3 rounded px-1 py-0.5 text-left text-sm hover:bg-accent">
      <span className="w-56 shrink-0 truncate font-mono text-xs text-muted-foreground">{h.path}:{h.startLine}</span>
      <span className="min-w-0 flex-1">{h.summary ?? (h.within ? `Changes ${h.within}` : 'Changes')}</span>
      <span className="font-mono text-2xs"><span className="text-add">+{h.added}</span> <span className="text-destructive">−{h.removed}</span></span>
    </button>
  )
}
