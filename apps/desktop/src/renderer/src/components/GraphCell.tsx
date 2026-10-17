import type { Row } from '@gitsquid/graph'
import { memo } from 'react'
import { laneColor } from '../lib/format'

/** Graph row height: normal and compact (Settings → Appearance). */
export const ROW_H = 28
export const ROW_H_COMPACT = 22
export const LANE_W = 16
const PAD = 6

export const laneX = (lane: number) => PAD + lane * LANE_W + LANE_W / 2

/**
 * One row of the graph as SVG. The layout already decided everything; this only draws:
 * straight lines for 'pass' edges, and curves for lines that change column on their way into
 * (top half) or out of (bottom half) the node.
 */
export const GraphCell = memo(function GraphCell({ row, width, showPending, isHead, h = ROW_H }: {
  row: Row
  width: number
  h?: number
  /** Draw the dashed HEAD lane (only when there is an uncommitted-changes row above). */
  showPending: boolean
  isHead: boolean
}) {
  const mid = h / 2
  const cx = laneX(row.lane)
  return (
    <svg width={width} height={h} className="block shrink-0 overflow-hidden" aria-hidden>
      {row.edges.map((e, i) => {
        if (e.pending && !showPending) return null
        const x1 = laneX(e.from)
        const x2 = laneX(e.to)
        let d: string
        if (e.part === 'pass') d = `M${x1} 0V${h}`
        else if (e.part === 'top') d = x1 === x2 ? `M${x1} 0V${mid}` : `M${x1} 0C${x1} ${mid * 0.9} ${x2} ${mid * 0.3} ${x2} ${mid}`
        else d = x1 === x2 ? `M${x1} ${mid}V${h}` : `M${x1} ${mid}C${x1} ${mid + mid * 0.7} ${x2} ${mid + mid * 0.1} ${x2} ${h}`
        return (
          <path key={i} d={d} fill="none" stroke={laneColor(e.color)} strokeWidth={2} strokeLinecap="round"
            strokeDasharray={e.pending ? '3 3' : undefined} opacity={e.pending ? 0.7 : 1} />
        )
      })}
      {isHead && <circle cx={cx} cy={mid} r={8} fill="none" stroke={laneColor(row.color)} strokeWidth={1.5} />}
      <circle cx={cx} cy={mid} r={row.merge ? 3.5 : 5} fill={laneColor(row.color)} stroke="var(--gs-bg)" strokeWidth={1.5} />
    </svg>
  )
})

/** The "uncommitted changes" node: hollow and dashed, in HEAD's lane, joined to HEAD below. */
export function WipCell({ width, hasHead, h = ROW_H }: { width: number; hasHead: boolean; h?: number }) {
  const cx = laneX(0)
  return (
    <svg width={width} height={h} className="block shrink-0" aria-hidden>
      {hasHead && <path d={`M${cx} ${h / 2 + 6}V${h}`} stroke={laneColor(0)} strokeWidth={2} strokeDasharray="3 3" opacity={0.7} />}
      <circle cx={cx} cy={h / 2} r={6} fill="var(--gs-bg)" stroke={laneColor(0)} strokeWidth={2} strokeDasharray="3 2" />
    </svg>
  )
}
