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
 * HEAD does not affect the layout: every commit sits where it would with nothing checked out, so
 * a checkout moves nothing. The "uncommitted changes" row sits above everything, joined to HEAD by
 * a dashed line that runs straight down one column. That column is decided when HEAD arrives:
 * HEAD's own column if no row above uses it, else the leftmost column no row above uses (and the
 * line turns into HEAD's node, like any line arriving from another column). Rows above HEAD do
 * not carry the line, since they may already be on screen; see `headLane`.
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
   * True for the end of the dashed line from the "uncommitted changes" row, on HEAD's row. The UI
   * draws it dashed, and hides it when there are no changes.
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
}

export interface LayoutOptions {
  /** HEAD's commit, for the dashed line from the "uncommitted changes" row (see `headLane`). */
  head?: string
  /**
   * Tips of the main line, e.g. main and origin/main. Lane 0 is kept for whichever arrives first.
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
  /** HEAD, until it has been laid out. */
  private head: string | null
  /** Every column a node or line uses in the rows above HEAD, until HEAD arrives. */
  private usedAbove = new Set<number>()
  /**
   * The column of the dashed line from the "uncommitted changes" row down to HEAD, straight
   * through every row above HEAD; null until HEAD has been laid out (or with no HEAD).
   */
  headLane: number | null = null
  /** Its colour: HEAD's. */
  headColor = 0

  constructor(opts: LayoutOptions = {}) {
    this.colors = opts.colors ?? 8
    const trunk = opts.trunk ?? []
    if (trunk.length) {
      this.trunk = new Set(trunk)
      this.lanes[0] = null
    }
    this.head = opts.head ?? null
  }

  /** Lines never change column except at a node, so a column's colour is a lane's colour. */
  private colorOf(column: number): number {
    return column % this.colors
  }

  private freeSlot(exclude = -1): number {
    for (let i = this.trunk ? 1 : 0; i < this.lanes.length; i++) if (this.lanes[i] === null && i !== exclude) return i
    return this.lanes.length
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

    // Lines from the top edge: either into this node, or straight past it.
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i]
      if (!l) continue
      edges.push({ part: l.hash === commit.hash ? 'top' : 'pass', from: i, to: l.hash === commit.hash ? lane : i, color: this.colorOf(i) })
    }
    for (const i of incoming) lanes[i] = null

    // 2 and 3. Hand the parents down.
    const [first, ...rest] = commit.parents
    if (first !== undefined) {
      lanes[lane] = { hash: first }
      edges.push({ part: 'bottom', from: lane, to: lane, color })
    }
    for (const p of rest) {
      let target = lanes.findIndex((l) => l?.hash === p)
      if (target < 0) {
        target = this.freeSlot(lane)
        lanes[target] = { hash: p }
      }
      edges.push({ part: 'bottom', from: lane, to: target, color: this.colorOf(target) })
    }

    // Free columns at the right edge are dropped so the graph narrows again after merges
    // (all but the held trunk lane).
    while (lanes.length > (this.trunk ? 1 : 0) && lanes[lanes.length - 1] === null) lanes.pop()

    if (this.head !== null) {
      if (commit.hash === this.head) {
        // HEAD: pick the dashed line's column and bring it into the node.
        let col = lane
        if (this.usedAbove.has(col)) for (col = 0; this.usedAbove.has(col);) col++
        this.headLane = col
        this.headColor = color
        edges.push({ part: 'top', from: col, to: lane, color, pending: true })
        this.head = null
        this.usedAbove.clear()
      } else {
        this.usedAbove.add(lane)
        for (const e of edges) {
          this.usedAbove.add(e.from)
          this.usedAbove.add(e.to)
        }
      }
    }

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
