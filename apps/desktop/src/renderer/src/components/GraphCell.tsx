import type { Row } from '@gitsquid/graph'
import { memo } from 'react'
import { hashColor, initials, laneColor } from '../lib/format'

/** Graph row height: normal and compact (Settings → Appearance). */
export const ROW_H = 32
export const ROW_H_COMPACT = 24
/** Wide enough for an avatar node (radius 11) with room for the lines either side. */
export const LANE_W = 24
const PAD = 6

/** Node radius and line width for a row height: GitKraken-sized, a little smaller when compact. */
export const nodeRadius = (h: number) => (h < ROW_H ? 9 : 11)
export const lineWidth = (h: number) => (h < ROW_H ? 2.5 : 3)

export const laneX = (lane: number) => PAD + lane * LANE_W + LANE_W / 2

export interface NodeAuthor {
  name: string
  email: string
  /** Avatar image (gitsquid-avatar: URL), or null for initials only. */
  src: string | null
}

/**
 * One row of the graph as SVG. The layout already decided everything; this only draws:
 * straight lines for 'pass' edges, and curves for lines that change column on their way into
 * (top half) or out of (bottom half) the node.
 *
 * Nodes, like GitKraken's: a commit is its author's avatar ringed in the lane colour (initials
 * underneath, so they show while the image loads or when there is none); a merge is a small
 * dot; HEAD gets an extra outer ring.
 */
export const GraphCell = memo(function GraphCell({ row, width, showPending, isHead, h = ROW_H, author, stash }: {
  row: Row
  width: number
  showPending: boolean
  isHead: boolean
  h?: number
  author: NodeAuthor
  /** A stash: drawn as a dashed box (it is not a commit on any branch). */
  stash?: boolean
}) {
  const mid = h / 2
  const cx = laneX(row.lane)
  const color = laneColor(row.color)
  const r = nodeRadius(h)
  const stroke = lineWidth(h)
  const clip = `clip-${row.hash}`
  return (
    <svg width={width} height={h} className="block shrink-0 overflow-hidden" aria-hidden data-node={row.merge ? 'merge' : 'commit'}>
      {row.edges.map((e, i) => {
        if (e.pending && !showPending) return null
        const x1 = laneX(e.from)
        const x2 = laneX(e.to)
        let d: string
        if (e.part === 'pass') d = `M${x1} 0V${h}`
        else if (e.part === 'top') d = x1 === x2 ? `M${x1} 0V${mid}` : `M${x1} 0C${x1} ${mid * 0.9} ${x2} ${mid * 0.3} ${x2} ${mid}`
        else d = x1 === x2 ? `M${x1} ${mid}V${h}` : `M${x1} ${mid}C${x1} ${mid + mid * 0.7} ${x2} ${mid + mid * 0.1} ${x2} ${h}`
        return (
          <path key={i} d={d} fill="none" stroke={laneColor(e.color)} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={e.pending ? '3 4' : undefined} opacity={e.pending ? 0.7 : 1} />
        )
      })}
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
    </svg>
  )
})

/** The "uncommitted changes" node: hollow and dashed with a pencil, in HEAD's lane, joined to HEAD below. */
export function WipCell({ width, hasHead, h = ROW_H }: { width: number; hasHead: boolean; h?: number }) {
  const cx = laneX(0)
  const r = nodeRadius(h)
  const s = r / 9
  return (
    <svg width={width} height={h} className="block shrink-0" aria-hidden>
      {hasHead && <path d={`M${cx} ${h / 2 + r}V${h}`} stroke={laneColor(0)} strokeWidth={lineWidth(h)} strokeDasharray="3 4" opacity={0.7} />}
      <circle cx={cx} cy={h / 2} r={r} fill="var(--gs-bg)" stroke={laneColor(0)} strokeWidth={2} strokeDasharray="3 2" />
      {/* A pencil: "you are editing here". */}
      <path transform={`translate(${cx} ${h / 2}) scale(${s})`} d="M-3 3l1-3 4-4 2 2-4 4z" fill={laneColor(0)} />
    </svg>
  )
}
