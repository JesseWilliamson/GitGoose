import type { SequenceDiagram } from '@gitgoose/shared'
import { useId } from 'react'
import { layoutSequence } from '../lib/sequence'

/** The model's JSON drawn as our own SVG: no diagram library, nothing the model writes runs. */
export function SequenceSvg({ d }: { d: SequenceDiagram }) {
  const l = layoutSequence(d)
  // Several diagrams on one page (a walkthrough and a chat card) each need their own marker id.
  const arrow = `seq-arrow-${useId().replace(/:/g, '')}`
  return (
    <div className="max-w-full overflow-x-auto rounded-md border border-line bg-panel" data-testid="sequence">
      <svg width={l.width} height={l.height} className="text-fg" role="img" aria-label="Sequence diagram">
        <defs>
          <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
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
            <path d={`M${m.x1},${m.y - 8} h28 v16 h-28`} fill="none" stroke="currentColor" markerEnd={`url(#${arrow})`} />
            <text x={m.x1 + 34} y={m.y + 4} fontSize={11} fill="currentColor">{m.label}</text>
          </g>
        ) : (
          <g key={i}>
            <line x1={m.x1} x2={m.x2} y1={m.y} y2={m.y} stroke="currentColor" markerEnd={`url(#${arrow})`} />
            <text x={(m.x1 + m.x2) / 2} y={m.y - 6} textAnchor="middle" fontSize={11} fill="currentColor">{m.label}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}
