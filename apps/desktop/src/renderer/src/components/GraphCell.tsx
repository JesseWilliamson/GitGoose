import type { Row } from '@gitgoose/graph'
import { memo } from 'react'
import { edgePath } from '../lib/edges'
import { laneColor } from '../lib/format'

/** Graph row height: two lines (author and refs over hash and subject), or one line when compact. */
export const ROW_H = 52
export const ROW_H_COMPACT = 24
/** Extra height on the first row of a month, for its heading ("March 2026"). */
export const HEADER_H = 26
/** Lane spacing: a hollow node is small, so lanes can sit close. */
export const LANE_W = 24
const PAD = 6
/**
 * Lanes the row content moves aside for, at most. Real histories can have dozens open at once;
 * past this many the text stays put and the far nodes are pinned, faded, at the edge.
 */
export const MAX_LANES = 8
/** The content never starts closer than this many lanes in, so short rows line up with one another. */
const MIN_LANES = 2

/** Node radius and line width for a row height. */
export const nodeRadius = (h: number) => (h < ROW_H ? 4.5 : 5.5)
export const lineWidth = (h: number) => (h < ROW_H ? 2 : 2.5)

export const laneX = (lane: number) => PAD + lane * LANE_W + LANE_W / 2

/**
 * How wide the graph part of a row is: just past the lanes it uses. The text of a
 * commit on a busy stretch of history starts further right than one on a quiet stretch, which
 * is what makes the shape of the history readable without a fixed column.
 */
export const cellWidth = (lanes: number) => PAD + Math.min(MAX_LANES, Math.max(MIN_LANES, lanes)) * LANE_W

/**
 * One row of the graph as SVG. The layout already decided everything; this only draws the
 * edges (see edgePath) and the node.
 *
 * Nodes are hollow rings in the lane colour: the page shows through, so a run of commits reads
 * as beads on a line rather than a column of discs. A merge is a smaller ring, HEAD gets a
 * second ring outside, a stash is a dashed box. The author is beside the text, not in the node.
 * `offset` is the height of a month heading above the node: the lines run through it.
 */
export const GraphCell = memo(function GraphCell({ row, width, showPending, isHead, h = ROW_H, offset = 0, stash }: {
  row: Row
  width: number
  showPending: boolean
  isHead: boolean
  h?: number
  offset?: number
  /** A stash: drawn as a dashed box (it is not a commit on any branch). */
  stash?: boolean
}) {
  const total = h + offset
  const mid = offset + h / 2
  // A node whose lane is past the last lane the row makes room for is kept at the right edge,
  // faded, rather than clipped away and leaving a row with no node.
  const lastX = width - LANE_W / 2
  const offscreen = laneX(row.lane) > lastX
  const cx = offscreen ? lastX : laneX(row.lane)
  const color = laneColor(row.color)
  const r = nodeRadius(h)
  const stroke = lineWidth(h)
  return (
    <svg width={width} height={total} className="block shrink-0 overflow-hidden" aria-hidden data-node={row.merge ? 'merge' : 'commit'}
      data-offscreen={offscreen || undefined}>
      {row.edges.map((e, i) => {
        if (e.pending && !showPending) return null
        return (
          <path key={i} d={edgePath(e.part, laneX(e.from), laneX(e.to), total, mid)} fill="none" stroke={laneColor(e.color)} strokeWidth={stroke}
            strokeLinecap="round" strokeLinejoin="round" strokeDasharray={e.pending ? '3 4' : undefined} opacity={e.pending ? 0.7 : 1} />
        )
      })}
      <g opacity={offscreen ? 0.45 : undefined}>
        {stash ? (
          <g data-testid="stash-node">
            <rect x={cx - r - 2} y={mid - r - 2} width={(r + 2) * 2} height={(r + 2) * 2} rx={3} fill="var(--gs-bg)" stroke={color} strokeWidth={2} strokeDasharray="3 2" />
            {/* An archive box: lid and body. */}
            <path transform={`translate(${cx} ${mid}) scale(${(r + 2) / 8})`} d="M-5 -4h10v3h-10z M-4 -1v5h8v-5 M-1.5 1h3" fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
          </g>
        ) : (
          <g data-testid="commit-node">
            {isHead && <circle cx={cx} cy={mid} r={r + 4} fill="none" stroke={color} strokeWidth={1.5} opacity={0.6} />}
            <circle cx={cx} cy={mid} r={row.merge ? r - 1.5 : r} fill="var(--gs-bg)" stroke={color} strokeWidth={stroke} />
          </g>
        )}
      </g>
    </svg>
  )
})

/** The "uncommitted changes" node: hollow and dashed with a pencil, in HEAD's lane, joined to HEAD below. */
export function WipCell({ width, hasHead, h = ROW_H, lane, color }: { width: number; hasHead: boolean; h?: number; lane: number; color: number }) {
  const cx = laneX(lane)
  const stroke = laneColor(color)
  const r = nodeRadius(h) + 2
  const s = r / 9
  return (
    <svg width={width} height={h} className="block shrink-0" aria-hidden data-testid="wip-node" data-lane={lane}>
      {hasHead && <path d={`M${cx} ${h / 2 + r}V${h}`} stroke={stroke} strokeWidth={lineWidth(h)} strokeDasharray="3 4" opacity={0.7} />}
      <circle cx={cx} cy={h / 2} r={r} fill="var(--gs-bg)" stroke={stroke} strokeWidth={2} strokeDasharray="3 2" />
      {/* A pencil: "you are editing here". */}
      <path transform={`translate(${cx} ${h / 2}) scale(${s})`} d="M-3 3l1-3 4-4 2 2-4 4z" fill={stroke} />
    </svg>
  )
}
