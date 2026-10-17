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
 * GitKraken keeps the checked-out branch in the leftmost column. We do the same by seeding lane 0
 * with HEAD before the walk: commits above HEAD (newer work on other branches) see lane 0 as
 * taken and use lanes to its right; when HEAD arrives it lands in lane 0 and its first-parent
 * chain inherits it all the way down.
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
  /** Colour index of the line (lanes keep their colour from tip to end). */
  color: number
  /**
   * True for the reserved HEAD lane above HEAD itself. The UI draws it dashed, joining the
   * "uncommitted changes" row at the top to HEAD, and hides it when there are no changes.
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
  color: number
  /** The seeded HEAD lane, before HEAD has been reached. */
  pending?: boolean
}

export interface LayoutOptions {
  /** HEAD's commit. Reserves lane 0 for it and its first-parent history. */
  head?: string
  /** How many colours the palette has. Colour indexes cycle through 0..colors-1. */
  colors?: number
}

export class GraphLayout {
  private lanes: (Lane | null)[] = []
  private nextColor = 1
  private colors: number

  constructor(opts: LayoutOptions = {}) {
    this.colors = opts.colors ?? 8
    if (opts.head) this.lanes[0] = { hash: opts.head, color: 0, pending: true }
    else this.nextColor = 0
  }

  private newColor(): number {
    const c = this.nextColor
    this.nextColor = (this.nextColor + 1) % this.colors
    return c
  }

  private freeSlot(exclude = -1): number {
    for (let i = 0; i < this.lanes.length; i++) if (this.lanes[i] === null && i !== exclude) return i
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
    let color: number
    if (incoming.length) {
      lane = incoming[0]!
      color = lanes[lane]!.color
    } else {
      lane = this.freeSlot()
      color = this.newColor()
    }

    // Lines from the top edge: either into this node, or straight past it.
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i]
      if (!l) continue
      if (l.hash === commit.hash) {
        edges.push({ part: 'top', from: i, to: lane, color: l.color, ...(l.pending ? { pending: true } : {}) })
      } else {
        edges.push({ part: 'pass', from: i, to: i, color: l.color, ...(l.pending ? { pending: true } : {}) })
      }
    }
    for (const i of incoming) lanes[i] = null

    // 2 and 3. Hand the parents down.
    const [first, ...rest] = commit.parents
    if (first !== undefined) {
      lanes[lane] = { hash: first, color }
      edges.push({ part: 'bottom', from: lane, to: lane, color })
    }
    for (const p of rest) {
      let target = lanes.findIndex((l) => l?.hash === p)
      let pc: number
      if (target >= 0) {
        pc = lanes[target]!.color
      } else {
        target = this.freeSlot(lane)
        pc = this.newColor()
        lanes[target] = { hash: p, color: pc }
      }
      edges.push({ part: 'bottom', from: lane, to: target, color: pc })
    }

    // Free columns at the right edge are dropped so the graph narrows again after merges.
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()

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
