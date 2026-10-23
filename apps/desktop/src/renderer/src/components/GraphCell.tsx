import type { Row } from '@gitgoose/graph'
import { memo, useMemo } from 'react'
import { useAvatarImage } from '../lib/avatar'
import { edgePath } from '../lib/edges'
import { hashColor, initials, laneColor } from '../lib/format'
import { lineEdges } from '../lib/lineView'

/** Graph row height: two lines (author and refs over hash and subject) when comfy. */
export const ROW_H = 52
/** One line per commit when compact (GitKraken's): tall enough for an avatar node of radius 11. */
export const ROW_H_COMPACT = 32
/** Lane spacing: wide enough for an avatar node with the lines either side. */
export const LANE_W = 24
/**
 * Comfy rows draw small ring nodes, so lanes past the first few can sit closer: this many lanes
 * at LANE_W, the rest at TIGHT_W. Most histories have four or fewer open lanes and look as they
 * did; a busy one gains lanes without pushing the text across the window.
 */
export const WIDE_LANES = 4
export const TIGHT_W = 16
const PAD = 6
/**
 * Lanes the comfy rows move aside for, at most. Real histories can have dozens open at once;
 * past this many the text stays put and the far nodes are left out of the row (see `offscreen`).
 * Four at 24 px and four at 16 px is 166 px: the text starts at 166 px at the very most.
 */
export const MAX_LANES = 8
/** The content never starts closer than this many lanes in, so short rows line up with one another. */
const MIN_LANES = 2
/**
 * The compact graph column shows at most this many lanes, like GitKraken's default; the rest are
 * clipped. A fixed column is what lines the messages up in one column.
 */
export const COMPACT_LANES = 8

/**
 * How a commit is drawn. A ring is a small hollow circle in the lane colour (comfy); an avatar is
 * the author's picture ringed in the lane colour, GitKraken-sized (compact).
 */
export type NodeVariant = 'ring' | 'avatar'
export const nodeRadius = (variant: NodeVariant) => (variant === 'avatar' ? 11 : 5.5)
const LINE_W = 2.5
/** The solid lane-coloured bar at the compact graph column's right edge, beside the message (GitKraken's). */
const STRIP_W = 3
/** Space left above and below each row's band and strip, so neighbouring rows read as separate commits. */
const BAND_INSET = 2
/** Dashes: the line to the uncommitted changes, and a stash's line to its base. */
const PENDING_DASH = '3 4'
const STASH_DASH = '2 4'

/** How wide lane `lane` is: LANE_W, or TIGHT_W past the first WIDE_LANES when `tight` (comfy rows). */
const laneW = (lane: number, tight: boolean) => (tight && lane >= WIDE_LANES ? TIGHT_W : LANE_W)
/** Where lane `lane` starts, from the left edge of the lanes (not counting PAD). */
const laneLeft = (lane: number, tight: boolean) => (tight ? Math.min(lane, WIDE_LANES) * LANE_W + Math.max(0, lane - WIDE_LANES) * TIGHT_W : lane * LANE_W)
/** The x of a lane's line and nodes. Lanes 0 to 3 are at the same x in both layouts. `tight`: comfy spacing. */
export const laneX = (lane: number, tight = false) => PAD + laneLeft(lane, tight) + laneW(lane, tight) / 2

/**
 * How wide the graph part of a comfy row is: just past the lanes it uses, as in Tower. The text of
 * a commit on a busy stretch of history starts further right than one on a quiet stretch, which
 * is what makes the shape of the history readable without a fixed column. Never more than 166 px.
 */
export const cellWidth = (lanes: number) => PAD + laneLeft(Math.min(MAX_LANES, Math.max(MIN_LANES, lanes)), true)

/**
 * The compact graph column: the same width on every row (the widest the history has been so far,
 * up to COMPACT_LANES), plus room for the strip, so every message starts at the same x.
 */
export const compactWidth = (maxLanes: number) => PAD + Math.min(COMPACT_LANES, Math.max(MIN_LANES, maxLanes)) * LANE_W + STRIP_W + 2

/** Who to draw inside an avatar node. */
export interface NodeAuthor {
  name: string
  email: string
  /** Avatar image (gitgoose-avatar: URL), or null for initials only. */
  src: string | null
}

/**
 * One row of the graph as SVG. The layout already decided everything; this only draws the
 * edges (see edgePath) and the node.
 *
 * Ring nodes are hollow, in the lane colour: the page shows through, so a run of commits reads
 * as beads on a line rather than a column of discs. A merge is a smaller ring, HEAD gets a
 * second ring outside.
 *
 * Avatar nodes are GitKraken's: the author's picture ringed in the lane colour, with initials
 * in its place while the image loads or when there is none (see AvatarNode); a merge is a plain
 * dot. HEAD gets a ring outside either. With `band`, a faint band in the lane colour runs from
 * the node to the column's right edge and ends in a solid strip, tying the message to its lane;
 * the band stops short of the row's top and bottom so consecutive commits in one lane read as
 * separate blocks.
 *
 * A stash is a tinted card with an archive box, and its line down to the commit it was made on
 * is dashed (the layout marks it): a stash sits beside history, it is not part of it.
 * `refLine` (compact, where the branch pills sit in a column to the left) draws the connector
 * from the left edge to the node, so it is clear which commit a branch points at.
 */
export const GraphCell = memo(function GraphCell({ row, width, showPending, isHead, h = ROW_H, stash, refLine, author, band, lineAbove, lineAboveColor = 0, lineBelow = false }: {
  row: Row
  width: number
  showPending: boolean
  isHead: boolean
  h?: number
  /** A stash: drawn as a dashed card (it is not a commit on any branch). */
  stash?: boolean
  /** The row has branch pills to the left: draw their connector from the left edge to the node. */
  refLine?: boolean
  /** Draw the author as the node (compact) instead of a ring. */
  author?: NodeAuthor
  /** The lane band and strip behind the node (compact, where the column has a fixed width). */
  band?: boolean
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
  // Comfy rows (ring nodes) space lanes tighter past the first few; compact rows (avatars) never do.
  const tight = !author
  const lane = lineAbove === undefined ? row.lane : 0
  const cx = laneX(lane, tight)
  const lastX = width - (band ? STRIP_W : 0) - laneW(lane, tight) / 2
  // The node's whole lane has to fit in the width.
  const offscreen = cx + laneW(lane, tight) / 2 > width - (band ? STRIP_W : 0) + 2
  const color = laneColor(row.color)
  const r = nodeRadius(author ? 'avatar' : 'ring')
  const clip = `clip-${row.hash}`
  return (
    <svg width={width} height={h} className="block shrink-0 overflow-hidden" aria-hidden data-node={row.merge ? 'merge' : 'commit'}
      data-offscreen={offscreen || undefined}>
      {band && (
        <>
          <rect x={Math.min(cx, lastX)} y={BAND_INSET} width={Math.max(0, width - Math.min(cx, lastX))} height={h - BAND_INSET * 2} fill={color} opacity={0.1} data-testid="lane-band" />
          <rect x={width - STRIP_W} y={BAND_INSET} width={STRIP_W} height={h - BAND_INSET * 2} fill={color} data-testid="lane-strip" />
        </>
      )}
      {refLine && !offscreen && <path d={`M0 ${mid}H${cx}`} stroke={color} strokeWidth={2} opacity={0.85} data-testid="ref-line" />}
      {edges.map((e, i) => {
        if (e.pending && !showPending) return null
        const dashed = e.pending ? PENDING_DASH : e.stash ? STASH_DASH : undefined
        return (
          <path key={i} d={edgePath(e.part, laneX(e.from, tight), laneX(e.to, tight), h)} fill="none" stroke={laneColor(e.color)} strokeWidth={e.stash ? 2 : LINE_W}
            strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dashed} opacity={e.pending ? 0.7 : e.stash ? 0.8 : 1}
            data-edge={e.stash ? 'stash' : e.pending ? 'pending' : undefined} />
        )
      })}
      {!offscreen && (
        stash ? (
          <StashNode cx={cx} cy={mid} r={r + (author ? 0 : 2)} color={color} />
        ) : author ? (
          <>
            {/* HEAD's ring sits outside the merge/avatar choice so a merge at HEAD keeps it too. */}
            {isHead && <circle cx={cx} cy={mid} r={r + 3} fill="none" stroke={color} strokeWidth={2} data-testid="head-ring" />}
            {row.merge ? (
              <circle cx={cx} cy={mid} r={5.5} fill={color} stroke="var(--gs-bg)" strokeWidth={1.5} data-testid="merge-node" />
            ) : (
              <AvatarNode cx={cx} cy={mid} r={r} color={color} author={author} clip={clip} />
            )}
          </>
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
 * The author as a graph node: a ring in the lane colour (a stroke, so nothing is painted inside
 * it), and inside it the initials on a coloured disc until the picture has loaded. Once it has,
 * the picture is drawn alone: its transparent parts show the page, not a colour behind it.
 */
function AvatarNode({ cx, cy, r, color, author, clip }: { cx: number; cy: number; r: number; color: string; author: NodeAuthor; clip: string }) {
  const { status, onLoad, onError } = useAvatarImage(author.src)
  const loaded = status === 'loaded'
  const inner = r - 2
  return (
    <g data-testid="avatar-node" data-avatar={status}>
      <circle cx={cx} cy={cy} r={r - 1} fill="none" stroke={color} strokeWidth={2} />
      {!loaded && (
        <>
          <circle cx={cx} cy={cy} r={inner} fill={laneColor(hashColor(author.email))} />
          <text x={cx} y={cy} dy="0.35em" textAnchor="middle" fontSize={9} fontWeight={700} fill="#fff"
            style={{ pointerEvents: 'none', fontFamily: 'var(--font-sans)' }}>{initials(author.name)}</text>
        </>
      )}
      {author.src && status !== 'failed' && (
        <>
          <defs>
            <clipPath id={clip}><circle cx={cx} cy={cy} r={inner} /></clipPath>
          </defs>
          <image href={author.src} x={cx - inner} y={cy - inner} width={inner * 2} height={inner * 2}
            clipPath={`url(#${clip})`} preserveAspectRatio="xMidYMid slice" onLoad={onLoad} onError={onError} />
        </>
      )}
    </g>
  )
}

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
export function WipCell({ width, hasHead, h = ROW_H, lane, color, variant = 'ring' }: {
  width: number; hasHead: boolean; h?: number; lane: number; color: number; variant?: NodeVariant
}) {
  const cx = laneX(lane, variant === 'ring')
  const stroke = laneColor(color)
  // A little bigger than a ring (the pencil needs the room), the same size as an avatar.
  const r = variant === 'avatar' ? nodeRadius('avatar') : nodeRadius('ring') + 2
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
