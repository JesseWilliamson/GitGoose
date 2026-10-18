import type { Row } from '@gitgoose/graph'
import { memo } from 'react'
import { edgePath } from '../lib/edges'
import { hashColor, initials, laneColor } from '../lib/format'

/** Graph row height: normal and compact (Settings → Appearance). */
export const ROW_H = 32
export const ROW_H_COMPACT = 24
/** Wide enough for an avatar node (radius 11) with room for the lines either side. */
export const LANE_W = 24
const PAD = 6

/** Node radius and line width for a row height: full size, a little smaller when compact. */
export const nodeRadius = (h: number) => (h < ROW_H ? 9 : 11)
export const lineWidth = (h: number) => (h < ROW_H ? 2 : 2.5)
/** The solid lane-coloured bar at the graph column's right edge, beside the message. */
const STRIP_W = 3
/** Space left above and below each row's band and strip, so neighbouring rows read as separate commits. */
export const bandInset = (h: number) => (h < ROW_H ? 1.5 : 2)

export const laneX = (lane: number) => PAD + lane * LANE_W + LANE_W / 2

export interface NodeAuthor {
  name: string
  email: string
  /** Avatar image (gitgoose-avatar: URL), or null for initials only. */
  src: string | null
}

/**
 * One row of the graph as SVG. The layout already decided everything; this only draws the
 * edges (see edgePath), the node, and, when the row has branch pills, a line from the pills to
 * the node so it is clear which commit a branch points at.
 *
 * Nodes: a commit is its author's avatar ringed in the lane colour (initials
 * underneath, so they show while the image loads or when there is none); a merge is a small
 * dot; HEAD gets an extra outer ring. Behind each node, a faint band in its lane colour runs
 * from the node to the right edge, ending in a solid strip: it ties the message to its lane.
 * The band and strip stop short of the row's top and bottom (bandInset), so a run of commits in
 * one lane shows as separate blocks rather than one long bar. Edges still span the full height.
 */
export const GraphCell = memo(function GraphCell({ row, width, showPending, isHead, h = ROW_H, author, stash, refLine }: {
  row: Row
  width: number
  showPending: boolean
  isHead: boolean
  h?: number
  author: NodeAuthor
  /** A stash: drawn as a dashed box (it is not a commit on any branch). */
  stash?: boolean
  /** The row has branch pills: draw their connector from the left edge to the node. */
  refLine?: boolean
}) {
  const mid = h / 2
  // A node whose lane is past the column's width (many lanes open, column not widened) is kept
  // at the right edge, faded, rather than clipped away and leaving a row with no node.
  const lastX = width - STRIP_W - LANE_W / 2
  const offscreen = laneX(row.lane) > lastX
  const cx = offscreen ? lastX : laneX(row.lane)
  const color = laneColor(row.color)
  const r = nodeRadius(h)
  const stroke = lineWidth(h)
  const clip = `clip-${row.hash}`
  const inset = bandInset(h)
  return (
    <svg width={width} height={h} className="block shrink-0 overflow-hidden" aria-hidden data-node={row.merge ? 'merge' : 'commit'}
      data-offscreen={offscreen || undefined}>
      <rect x={cx} y={inset} width={Math.max(0, width - cx)} height={h - inset * 2} fill={color} opacity={0.1} data-testid="lane-band" />
      <rect x={width - STRIP_W} y={inset} width={STRIP_W} height={h - inset * 2} fill={color} data-testid="lane-strip" />
      {refLine && <path d={`M0 ${mid}H${cx}`} stroke={color} strokeWidth={2} opacity={0.85} data-testid="ref-line" />}
      {row.edges.map((e, i) => {
        if (e.pending && !showPending) return null
        return (
          <path key={i} d={edgePath(e.part, laneX(e.from), laneX(e.to), h)} fill="none" stroke={laneColor(e.color)} strokeWidth={stroke}
            strokeLinecap="round" strokeLinejoin="round" strokeDasharray={e.pending ? '3 4' : undefined} opacity={e.pending ? 0.7 : 1} />
        )
      })}
      <g opacity={offscreen ? 0.45 : undefined}>
        {stash ? (
          <g data-testid="stash-node">
            <rect x={cx - r + 1} y={mid - r + 1} width={(r - 1) * 2} height={(r - 1) * 2} rx={3} fill="var(--gs-bg)" stroke={color} strokeWidth={2} strokeDasharray="3 2" />
            {/* An archive box: lid and body. */}
            <path transform={`translate(${cx} ${mid}) scale(${r / 11})`} d="M-5 -4h10v3h-10z M-4 -1v5h8v-5 M-1.5 1h3" fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
          </g>
        ) : row.merge ? (
          <circle cx={cx} cy={mid} r={r > 9 ? 5.5 : 4.5} fill={color} stroke="var(--gs-bg)" strokeWidth={1.5} />
        ) : (
          <g data-testid="avatar-node">
            {isHead && <circle cx={cx} cy={mid} r={r + 3} fill="none" stroke={color} strokeWidth={2} />}
            <circle cx={cx} cy={mid} r={r} fill={color} />
            <circle cx={cx} cy={mid} r={r - 2} fill={laneColor(hashColor(author.email))} />
            <text x={cx} y={mid} dy="0.35em" textAnchor="middle" fontSize={r > 9 ? 9 : 7.5} fontWeight={700} fill="#fff"
              style={{ pointerEvents: 'none', fontFamily: 'var(--font-sans)' }}>{initials(author.name)}</text>
            {author.src && (
              <>
                <defs>
                  <clipPath id={clip}><circle cx={cx} cy={mid} r={r - 2} /></clipPath>
                </defs>
                <image href={author.src} x={cx - (r - 2)} y={mid - (r - 2)} width={(r - 2) * 2} height={(r - 2) * 2}
                  clipPath={`url(#${clip})`} preserveAspectRatio="xMidYMid slice" />
              </>
            )}
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
  const r = nodeRadius(h)
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
