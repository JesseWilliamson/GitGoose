import type { ReadingLayer, SequenceDiagram, WalkthroughHunk } from '@gitsquid/shared'
import clsx from 'clsx'
import { BookOpen } from 'lucide-react'
import { useState } from 'react'
import { relativeTime } from '../lib/format'
import { targetFor } from '../lib/review'
import { layoutSequence } from '../lib/sequence'
import { ensureLoaded, updateRepo, type RepoView } from '../lib/store'
import { startWalkthrough, stopWalkthrough } from '../lib/walkthrough'
import { Button, Spinner } from './ui'

const LAYER: Record<ReadingLayer, string> = {
  contract: 'Contracts: types and interfaces',
  implementation: 'Implementation',
  tests: 'Tests',
  config: 'Configuration',
  docs: 'Docs',
}

/**
 * A walkthrough of a change (CodeRabbit's, made local): what it does, how hard it is to
 * review, the files grouped by purpose, a sequence diagram of any flow it changes, every piece
 * in reading order with a one-line summary, and recent history of the same files.
 */
export function WalkthroughView({ view }: { view: RepoView }) {
  const w = view.walkthrough
  const [showTrivial, setShowTrivial] = useState(false)
  if (!w) return null
  const r = w.result
  const open = (path: string) => r && updateRepo(view.id, { center: { kind: 'file', target: targetFor(r, path), mode: 'diff' } })
  const layers = r ? (['contract', 'implementation', 'tests', 'config', 'docs'] as ReadingLayer[]).map((l) => [l, r.hunks.filter((h) => h.layer === l && !h.trivial)] as const).filter(([, hs]) => hs.length) : []
  const trivial = r?.hunks.filter((h) => h.trivial) ?? []
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="walkthrough">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
        <BookOpen size={18} className="text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">Walkthrough: {r?.label ?? '…'}</div>
          <div className="truncate text-xs text-muted">{w.requestId ? 'Reading the change…' : w.error ? 'It failed.' : r ? `${r.hunks.length} pieces in ${new Set(r.hunks.map((h) => h.path)).size} files` : ''}</div>
        </div>
        {r && <EffortBadge effort={r.effort} why={r.effortWhy} />}
        {w.requestId ? <Button onClick={() => stopWalkthrough(view.id)}><Spinner /> Stop</Button> : <Button onClick={() => startWalkthrough(view.id, w.scope)}>Again</Button>}
        <Button variant="ghost" onClick={() => updateRepo(view.id, { center: { kind: 'graph' } })}>Back to graph</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {w.error && <div className="mb-4 rounded-md border border-del/40 bg-del/10 p-3 text-[13px] text-del">{w.error}</div>}
        {r && (
          <>
            <p className="selectable max-w-3xl text-[14px] leading-relaxed" data-testid="walkthrough-summary">{r.summary}</p>

            <h3 className="mt-6 mb-2 text-[12px] font-semibold text-muted uppercase">Changes</h3>
            <div className="grid max-w-4xl gap-2" data-testid="walkthrough-groups">
              {r.groups.map((g) => (
                <div key={g.title} className="rounded-md border border-line bg-panel p-3">
                  <div className="text-[13px] font-semibold">{g.title}</div>
                  {g.description && <p className="mt-0.5 text-[13px] text-muted">{g.description}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {g.files.map((f) => <button key={f} onClick={() => open(f)} className="font-mono text-[12px] text-accent hover:underline">{f}</button>)}
                  </div>
                </div>
              ))}
            </div>

            {r.sequence && (
              <>
                <h3 className="mt-6 mb-2 text-[12px] font-semibold text-muted uppercase">Sequence</h3>
                <SequenceSvg d={r.sequence} />
              </>
            )}

            <h3 className="mt-6 mb-2 text-[12px] font-semibold text-muted uppercase">Reading order</h3>
            <div className="max-w-4xl" data-testid="reading-order">
              {layers.map(([layer, hs]) => (
                <div key={layer} className="mb-3">
                  <div className="mb-1 text-[12px] font-medium text-faint">{LAYER[layer]}</div>
                  {hs.map((h) => <HunkRow key={h.id} h={h} onOpen={() => open(h.path)} />)}
                </div>
              ))}
              {trivial.length > 0 && (
                <div className="mb-3">
                  <button className="text-[12px] text-faint hover:text-fg" onClick={() => setShowTrivial(!showTrivial)} data-testid="trivial-toggle">
                    {trivial.length} small change{trivial.length === 1 ? '' : 's'} (imports, comments, formatting) {showTrivial ? '▾' : '▸'}
                  </button>
                  {showTrivial && trivial.map((h) => <HunkRow key={h.id} h={h} onOpen={() => open(h.path)} />)}
                </div>
              )}
            </div>

            {r.history.length > 0 && (
              <>
                <h3 className="mt-6 mb-2 text-[12px] font-semibold text-muted uppercase">Recent history of these files</h3>
                <div className="max-w-4xl text-[13px]">
                  {r.history.map((c) => (
                    <button key={c.hash} onClick={() => { updateRepo(view.id, { selected: { kind: 'commit', hash: c.hash }, center: { kind: 'graph' } }); void ensureLoaded(view.id, c.hash) }}
                      className="flex w-full items-center gap-3 rounded px-1 py-0.5 text-left hover:bg-hover">
                      <span className="font-mono text-[11px] text-faint">{c.hash.slice(0, 7)}</span>
                      <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                      <span className="text-xs text-faint">{c.author}, {relativeTime(c.date)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {r.skipped.length > 0 && <p className="mt-4 text-xs text-faint">Not included (over the size limit): {r.skipped.join(', ')}.</p>}
          </>
        )}
      </div>
    </div>
  )
}

function EffortBadge({ effort, why }: { effort: number; why: string }) {
  return (
    <span title={why} data-testid="effort" className={clsx('rounded px-2 py-0.5 text-xs font-medium', effort >= 4 ? 'bg-del/15 text-del' : effort === 3 ? 'bg-warn/15 text-warn' : 'bg-add/15 text-add')}>
      Review effort {effort}/5
    </span>
  )
}

function HunkRow({ h, onOpen }: { h: WalkthroughHunk; onOpen: () => void }) {
  return (
    <button onClick={onOpen} data-testid="reading-hunk" className="flex w-full items-baseline gap-3 rounded px-1 py-0.5 text-left text-[13px] hover:bg-hover">
      <span className="w-56 shrink-0 truncate font-mono text-[12px] text-muted">{h.path}:{h.startLine}</span>
      <span className="min-w-0 flex-1">{h.summary ?? (h.within ? `Changes ${h.within}` : 'Changes')}</span>
      <span className="font-mono text-[11px]"><span className="text-add">+{h.added}</span> <span className="text-del">−{h.removed}</span></span>
    </button>
  )
}

/** The model's JSON drawn as our own SVG: no diagram library, nothing the model writes runs. */
function SequenceSvg({ d }: { d: SequenceDiagram }) {
  const l = layoutSequence(d)
  return (
    <div className="max-w-full overflow-x-auto rounded-md border border-line bg-panel" data-testid="sequence">
      <svg width={l.width} height={l.height} className="text-fg" role="img" aria-label="Sequence diagram">
        <defs>
          <marker id="seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>
        {l.participants.map((p) => (
          <g key={p.name}>
            <line x1={p.x} x2={p.x} y1={20 + l.headH} y2={l.height - 8} stroke="var(--color-line)" strokeDasharray="4 4" />
            <rect x={p.x - (p.name.length * 6.5 + 24) / 2} y={20} width={p.name.length * 6.5 + 24} height={l.headH} rx={5} fill="var(--color-raised)" stroke="var(--color-line)" />
            <text x={p.x} y={20 + l.headH / 2 + 4} textAnchor="middle" fontSize={12} fill="currentColor">{p.name}</text>
          </g>
        ))}
        {l.messages.map((m, i) => m.self ? (
          <g key={i}>
            <path d={`M${m.x1},${m.y - 8} h28 v16 h-28`} fill="none" stroke="currentColor" markerEnd="url(#seq-arrow)" />
            <text x={m.x1 + 34} y={m.y + 4} fontSize={11} fill="currentColor">{m.label}</text>
          </g>
        ) : (
          <g key={i}>
            <line x1={m.x1} x2={m.x2} y1={m.y} y2={m.y} stroke="currentColor" markerEnd="url(#seq-arrow)" />
            <text x={(m.x1 + m.x2) / 2} y={m.y - 6} textAnchor="middle" fontSize={11} fill="currentColor">{m.label}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}
