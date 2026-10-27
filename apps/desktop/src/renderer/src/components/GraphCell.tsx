import type { Row } from '@gitgoose/graph'
import { memo, useMemo } from 'react'
import { edgePath } from '../lib/edges'
import { laneColor } from '../lib/format'
import { lineEdges } from '../lib/lineView'

/**
 * Graph row height: one line per commit (ADR-011), the same as `h-row-lg`. A ring node of radius
 * 5.5 with HEAD's outer ring (radius 9.5) still leaves the lines above and below it visible.
 */
export const ROW_H = 28
/** Lane spacing for the first few lanes: room for a ring with a clear gap to the next line. */
export const LANE_W = 24
/**
 * Lanes past the first few sit closer: this many lanes at LANE_W, the rest at TIGHT_W. Most
 * histories have four or fewer open lanes; a busy one gains lanes without pushing the text across
 * the window.
 */
export const WIDE_LANES = 4
export const TIGHT_W = 16
const PAD = 6
/**
 * Lanes a row moves aside for, at most. Real histories can have dozens open at once;
 * past this many the text stays put and the far nodes are left out of the row (see `offscreen`).
 * Four at 24 px and four at 16 px is 166 px: the text starts at 166 px at the very most.
 */
export const MAX_LANES = 8
/** The content never starts closer than this many lanes in, so short rows line up with one another. */
const MIN_LANES = 2

/** A commit's ring. */
export const NODE_R = 5.5
const LINE_W = 2.5
/** Dashes: the line to the uncommitted changes, and a stash's line to its base. */
const PENDING_DASH = '3 4'
const STASH_DASH = '2 4'

/** How wide lane `lane` is: LANE_W, or TIGHT_W past the first WIDE_LANES. */
const laneW = (lane: number) => (lane >= WIDE_LANES ? TIGHT_W : LANE_W)
/** Where lane `lane` starts, from the left edge of the lanes (not counting PAD). */
const laneLeft = (lane: number) => Math.min(lane, WIDE_LANES) * LANE_W + Math.max(0, lane - WIDE_LANES) * TIGHT_W
/** The x of a lane's line and nodes. */
export const laneX = (lane: number) => PAD + laneLeft(lane) + laneW(lane) / 2

/**
 * How wide the graph part of a row is: just past the lanes it uses. The text of a commit on a busy
 * stretch of history starts further right than one on a quiet stretch, which is what makes the
 * shape of the history readable without a fixed column. Never more than 166 px.
 */
export const cellWidth = (lanes: number) => PAD + laneLeft(Math.min(MAX_LANES, Math.max(MIN_LANES, lanes)))

/**
 * One row of the graph as SVG. The layout already decided everything; this only draws the
 * edges (see edgePath) and the node.
 *
 * Nodes are hollow rings in the lane colour: the page shows through, so a run of commits reads
 * as beads on a line rather than a column of discs. A merge is a smaller ring, HEAD gets a
 * second ring outside.
 *
 * A stash is a tinted card with an archive box, and its line down to the commit it was made on
 * is dashed (the layout marks it): a stash sits beside history, it is not part of it.
 */
export const GraphCell = memo(function GraphCell({ row, width, showPending, isHead, h = ROW_H, stash, lineAbove, lineAboveColor = 0, lineBelow = false }: {
  row: Row
  width: number
  showPending: boolean
  isHead: boolean
  h?: number
  /** A stash: drawn as a dashed card (it is not a commit on any branch). */
  stash?: boolean
  /**
   * Set while the graph shows one line of history (lib/lineView.ts): the lane of the line's row
   * above, or -1 at its top. The row then draws only that line, and in lane 0 (see lineEdges). Plain numbers,
   * not an object, so the memo still skips rows whose line did not change.
   */
  lineAbove?: number
  lineAboveColor?: number
  /** In the line view: the line goes on below this commit. */
  lineBelow?: boolean
}) {
  const edges = useMemo(() => (lineAbove === undefined ? row.edges : lineEdges(row, lineAbove, lineAboveColor, lineBelow)),
    [row, lineAbove, lineAboveColor, lineBelow])
  const mid = h / 2
  // A node whose lane is past the last lane the row makes room for is left out: pinning it at
  // the edge would put a dot on top of the last visible lane's line, reading as a commit on a
  // branch it has nothing to do with. The row still shows the lines that pass through it.
  const lane = lineAbove === undefined ? row.lane : 0
  const cx = laneX(lane)
  // The node's whole lane has to fit in the width.
  const offscreen = cx + laneW(lane) / 2 > width + 2
  const color = laneColor(row.color)
  const r = NODE_R
  return (
    <svg width={width} height={h} className="block shrink-0 overflow-hidden" aria-hidden data-node={row.merge ? 'merge' : 'commit'}
      data-offscreen={offscreen || undefined}>
      {edges.map((e, i) => {
        if (e.pending && !showPending) return null
        const dashed = e.pending ? PENDING_DASH : e.stash ? STASH_DASH : undefined
        return (
          <path key={i} d={edgePath(e.part, laneX(e.from), laneX(e.to), h)} fill="none" stroke={laneColor(e.color)} strokeWidth={e.stash ? 2 : LINE_W}
            strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dashed} opacity={e.pending ? 0.7 : e.stash ? 0.8 : 1}
            data-edge={e.stash ? 'stash' : e.pending ? 'pending' : undefined} />
        )
      })}
      {!offscreen && (
        stash ? (
          <StashNode cx={cx} cy={mid} r={r + 2} color={color} />
        ) : (
          <g data-testid="commit-node">
            {isHead && <circle cx={cx} cy={mid} r={r + 4} fill="none" stroke={color} strokeWidth={1.5} opacity={0.6} />}
            <circle cx={cx} cy={mid} r={row.merge ? r - 1.5 : r} fill="var(--gs-bg)" stroke={color} strokeWidth={LINE_W} />
          </g>
        )
      )}
    </svg>
  )
})

/**
 * A stash: a rounded card tinted in its lane colour with a dashed edge, and an archive box (lid,
 * body, handle) drawn on it. Opaque underneath, so the dashed line ends at its edge.
 */
function StashNode({ cx, cy, r, color }: { cx: number; cy: number; r: number; color: string }) {
  const s = r / 8
  return (
    <g data-testid="stash-node">
      <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={r * 0.45} fill="var(--gs-bg)" />
      <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={r * 0.45} fill={color} fillOpacity={0.16}
        stroke={color} strokeWidth={1.75} strokeDasharray="3 2.5" strokeLinecap="round" />
      <g transform={`translate(${cx} ${cy}) scale(${s})`} fill="none" stroke={color} strokeWidth={1.5 / s} strokeLinecap="round" strokeLinejoin="round">
        <rect x={-4.5} y={-4} width={9} height={2.6} rx={0.6} />
        <path d="M-3.6 -1.4v4.4a0.8 0.8 0 0 0 0.8 0.8h5.6a0.8 0.8 0 0 0 0.8 -0.8v-4.4" />
        <path d="M-1.3 0.8h2.6" />
      </g>
    </g>
  )
}

/**
 * The "uncommitted changes" node: hollow and dashed with a pencil, in HEAD's lane, joined to HEAD
 * below by a straight dashed line (the layout keeps HEAD's column for it all the way down).
 */
export function WipCell({ width, hasHead, h = ROW_H, lane, color }: {
  width: number; hasHead: boolean; h?: number; lane: number; color: number
}) {
  const cx = laneX(lane)
  const stroke = laneColor(color)
  // A little bigger than a ring: the pencil needs the room.
  const r = NODE_R + 2
  const s = r / 9
  return (
    <svg width={width} height={h} className="block shrink-0" aria-hidden data-testid="wip-node" data-lane={lane}>
      {hasHead && <path d={`M${cx} ${h / 2 + r}V${h}`} stroke={stroke} strokeWidth={LINE_W} strokeDasharray={PENDING_DASH} opacity={0.7} data-testid="wip-line" />}
      <circle cx={cx} cy={h / 2} r={r} fill="var(--gs-bg)" stroke={stroke} strokeWidth={2} strokeDasharray="3 2" />
      {/* A pencil: "you are editing here". */}
      <path transform={`translate(${cx} ${h / 2}) scale(${s})`} d="M-3 3l1-3 4-4 2 2-4 4z" fill={stroke} />
    </svg>
  )
}
