/**
 * Commit graph layout: which column ("lane") each commit sits in, and which lines to draw.
 *
 * Input is commits in topological order (children before parents, as `git log --topo-order`
 * gives them). We walk them once, top to bottom, carrying one piece of state: `lanes`, an array
 * where lanes[i] is the hash that the line in column i is travelling down to meet, or null if
 * the column is free.
 *
 * For each commit:
 *   1. Find every lane waiting for it. The leftmost one becomes its column; the others end here
 *      (those are branch points seen from below: two children share this parent).
 *      If no lane waits for it, it is a branch tip: take the first free column.
 *   2. Its first parent inherits its column, so a branch's history runs straight down.
 *   3. Each further parent (a merge) joins a lane already waiting for that parent, or opens a
 *      new lane in the first free column.
 *
 * Every row records the lines crossing it, split at the node's vertical middle:
 *   - 'pass':   a lane that does not involve this commit, straight through top to bottom
 *   - 'top':    from a lane at the top edge into the node (children above that point here)
 *   - 'bottom': from the node out to a parent's lane at the bottom edge
 *
 * Because all state is carried in `lanes`, the walk is incremental: lay out page 1, keep the
 * state, push page 2 later, and nothing above changes. That is what lets the UI show the first
 * screenful of a 100k-commit history before git has finished printing it.
 *
 * Like GitKraken, the main line ("trunk": the default branch, local and remote) owns the leftmost
 * column, whatever is checked out, so a checkout does not reshuffle the graph. Lane 0 is held
 * empty until the first trunk commit arrives; that commit takes it (lines waiting for it curve
 * in) and its first-parent chain inherits it all the way down.
 *
 * HEAD gets a lane reserved from the top too, because the "uncommitted changes" row sits above
 * everything and a dashed line joins it to HEAD. When HEAD is a trunk tip that lane is lane 0;
 * otherwise it starts in lane 1, next to the trunk. Real lines take precedence over the dashed
 * one: a commit that needs a new column may take the dashed line's, and the dashed line steps
 * aside into the next free column. So commits are where they would be with nothing checked out,
 * and checking out an older commit does not push the commits ahead of it off to the side.
 * When HEAD arrives it lands in the leftmost line waiting for it, and the dashed line curves in.
 */

export interface LayoutCommit {
  hash: string
  parents: readonly string[]
}

export type EdgePart = 'pass' | 'top' | 'bottom'

export interface Edge {
  part: EdgePart
  /** Column at the start of the line (top edge for pass/top, the node for bottom). */
  from: number
  /** Column at the end of the line (bottom edge for pass/bottom, the node for top). */
  to: number
  /**
   * Colour index of the line: the colour of its column, so colours run in palette order from the
   * left (as in GitKraken). A curve between columns takes the colour of the branch side.
   */
  color: number
  /**
   * True for the reserved HEAD lane above HEAD itself. The UI draws it dashed, joining the
   * "uncommitted changes" row at the top to HEAD, and hides it when there are no changes.
   * It is the one line that may change column outside a node: a 'pass' with from !== to, where
   * it steps aside for a real line.
   */
  pending?: boolean
}

export interface Row {
  hash: string
  /** Column of this commit's node. */
  lane: number
  color: number
  edges: Edge[]
  /** True when the commit has more than one parent. */
  merge: boolean
  /** Number of columns this row touches (for sizing the graph column). */
  width: number
}

interface Lane {
  hash: string
  /** The seeded HEAD lane, before HEAD has been reached. */
  pending?: boolean
}

export interface LayoutOptions {
  /** HEAD's commit. Reserves a lane for it from the top (see `headLane`). */
  head?: string
  /**
   * Tips of the main line, e.g. main and origin/main. Lane 0 is kept for whichever arrives first.
   * Without it, HEAD's lane is lane 0.
   */
  trunk?: readonly string[]
  /** How many colours the palette has. Colour indexes cycle through 0..colors-1. */
  colors?: number
}

export class GraphLayout {
  private lanes: (Lane | null)[] = []
  private colors: number
  /** While set, lane 0 is held free for the first of these commits to arrive. */
  private trunk: Set<string> | null = null
  /** The dashed line may step aside for real lines (it is not HEAD's trunk lane 0). */
  private movable = false
  /** The lane and colour of the line from the "uncommitted changes" row down to HEAD (at the top). */
  readonly headLane: number = 0
  readonly headColor: number = 0

  constructor(opts: LayoutOptions = {}) {
    this.colors = opts.colors ?? 8
    const trunk = opts.trunk ?? []
    if (trunk.length && !(opts.head && trunk.includes(opts.head))) {
      this.trunk = new Set(trunk)
      this.lanes[0] = null
    }
    if (opts.head) {
      this.headLane = this.lanes.length
      this.headColor = this.colorOf(this.headLane)
      this.lanes[this.headLane] = { hash: opts.head, pending: true }
      this.movable = this.trunk !== null
    }
  }

  /** Lines never change column except at a node, so a column's colour is a lane's colour. */
  private colorOf(column: number): number {
    return column % this.colors
  }

  /** The first column a new line may take: a free one, or the dashed HEAD line's (see claim). */
  private freeSlot(exclude = -1): number {
    for (let i = this.trunk ? 1 : 0; i < this.lanes.length; i++) {
      const l = this.lanes[i]
      if (i !== exclude && (l === null || (l?.pending && this.movable))) return i
    }
    return this.lanes.length
  }

  /**
   * Make column `slot` free for a real line. If the dashed HEAD line is there, it steps aside
   * into the first truly free column (not `keep`), and its edge in this row bends to follow.
   */
  private claim(slot: number, keep: number, pendingEdge: Edge | undefined): void {
    const l = this.lanes[slot]
    if (!l?.pending) return
    let to = this.trunk ? 1 : 0
    while (to < this.lanes.length && (this.lanes[to] !== null || to === slot || to === keep)) to++
    this.lanes[to] = l
    this.lanes[slot] = null
    if (pendingEdge) pendingEdge.to = to
  }

  /** Lay out the next commits. Call repeatedly with consecutive pages. */
  push(commits: readonly LayoutCommit[]): Row[] {
    return commits.map((c) => this.next(c))
  }

  private next(commit: LayoutCommit): Row {
    const lanes = this.lanes
    const edges: Edge[] = []

    // 1. Which lanes are waiting for this commit?
    const incoming: number[] = []
    for (let i = 0; i < lanes.length; i++) if (lanes[i]?.hash === commit.hash) incoming.push(i)

    let lane: number
    if (this.trunk?.has(commit.hash)) {
      lane = 0
      this.trunk = null
    } else {
      lane = incoming.length ? incoming[0]! : this.freeSlot()
    }
    const color = this.colorOf(lane)

    // Lines from the top edge: either into this node, or straight past it. The dashed HEAD line
    // keeps HEAD's colour wherever it has stepped aside to.
    let pendingEdge: Edge | undefined
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i]
      if (!l) continue
      const c = l.pending ? this.headColor : this.colorOf(i)
      if (l.hash === commit.hash) {
        edges.push({ part: 'top', from: i, to: lane, color: c, ...(l.pending ? { pending: true } : {}) })
      } else {
        const e: Edge = { part: 'pass', from: i, to: i, color: c, ...(l.pending ? { pending: true } : {}) }
        if (l.pending) pendingEdge = e
        edges.push(e)
      }
    }
    for (const i of incoming) lanes[i] = null
    // A new branch tip took the dashed line's column.
    this.claim(lane, lane, pendingEdge)

    // 2 and 3. Hand the parents down.
    const [first, ...rest] = commit.parents
    if (first !== undefined) {
      lanes[lane] = { hash: first }
      edges.push({ part: 'bottom', from: lane, to: lane, color })
    }
    for (const p of rest) {
      let target = lanes.findIndex((l) => l?.hash === p)
      // A merge whose parent is HEAD joins the dashed line, which from here down is a real line.
      if (target >= 0 && lanes[target]!.pending) lanes[target] = { hash: p }
      if (target < 0) {
        target = this.freeSlot(lane)
        this.claim(target, lane, pendingEdge)
        lanes[target] = { hash: p }
      }
      edges.push({ part: 'bottom', from: lane, to: target, color: this.colorOf(target) })
    }

    // Free columns at the right edge are dropped so the graph narrows again after merges
    // (all but the held trunk lane).
    while (lanes.length > (this.trunk ? 1 : 0) && lanes[lanes.length - 1] === null) lanes.pop()

    let width = lane + 1
    for (const e of edges) width = Math.max(width, e.from + 1, e.to + 1)
    return { hash: commit.hash, lane, color, edges, merge: commit.parents.length > 1, width }
  }

  /** Columns currently in use, i.e. the width of the line bundle leaving the last row. */
  get openLanes(): number {
    return this.lanes.length
  }
}

/** Lay out a complete list in one call. */
export function layout(commits: readonly LayoutCommit[], opts?: LayoutOptions): Row[] {
  return new GraphLayout(opts).push(commits)
}
