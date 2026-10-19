import type { Edge, Row } from '@gitgoose/graph'

/**
 * The line view (spec 007, "Line view"): hold Shift and the graph shows only the line of history
 * through one commit.
 *
 * A "branch" is not something git stores: a branch name is a pointer, and the line it stands for is
 * a path through the commit graph. git's own definition of that path is the first parent
 * (`log --first-parent`, what `rebase` replays, which side of a merge is "ours"). The lane layout
 * draws the same definition: a commit's first parent inherits its lane, and a line only moves
 * lane at a fork. So the line through a commit is
 *   - down: its first parent, that one's first parent, and so on, while they are loaded;
 *   - up: the child that handed its lane down to it, that child's such child, and so on. A commit
 *     can have several children whose first parent it is (every branch started from it); the
 *     one in the same lane is the one the layout continued, i.e. "the same branch seen from above".
 *     When none of them is in its lane, the line came in from a fork and the walk stops there.
 */

/** What the walk needs from the log (store.ts LogData has all of it). */
export interface LineLog {
  commits: readonly { hash: string; parents: readonly string[] }[]
  rows: readonly { lane: number }[]
  index: ReadonlyMap<string, number>
  /** hash → the commits whose first parent it is, in graph order. Extended per page, never rebuilt. */
  firstChildren: ReadonlyMap<string, readonly string[]>
}

/**
 * Row indexes of the line through `hash`, in graph order (top to bottom). Empty when `hash` is not
 * loaded. Each entry's next one is its first parent, so the list is a chain.
 */
export function lineThrough(log: LineLog, hash: string): Uint32Array {
  const start = log.index.get(hash)
  if (start === undefined) return new Uint32Array(0)
  const up: number[] = []
  for (let i = start; ;) {
    const lane = log.rows[i]!.lane
    let next = -1
    for (const child of log.firstChildren.get(log.commits[i]!.hash) ?? []) {
      const j = log.index.get(child)
      // The nearest one above in the same lane: a lane holds one line at a time, so there is at
      // most one that continues into this row; nearest is what makes that true even when a lane
      // was freed and reused higher up.
      if (j !== undefined && j < i && j > next && log.rows[j]!.lane === lane) next = j
    }
    if (next < 0) break
    up.push(next)
    i = next
  }
  const down: number[] = []
  for (let i = start; ;) {
    const parent = log.commits[i]!.parents[0]
    const j = parent === undefined ? undefined : log.index.get(parent)
    if (j === undefined) break
    down.push(j)
    i = j
  }
  const out = new Uint32Array(up.length + 1 + down.length)
  for (let k = 0; k < up.length; k++) out[k] = up[up.length - 1 - k]!
  out[up.length] = start
  out.set(down, up.length + 1)
  return out
}

/**
 * The line has reached a root commit: nothing loaded later can belong to it, so the list need not
 * load further pages for it (an orphan branch's line can end near the top of a long history).
 */
export function lineEnded(log: Pick<LineLog, 'commits'>, line: Uint32Array): boolean {
  const last = line.length ? log.commits[line[line.length - 1]!] : undefined
  return !!last && last.parents.length === 0
}

/** Where row `row` sits in `line` (sorted, as lineThrough returns it), or -1. */
export function lineIndexOf(line: Uint32Array, row: number): number {
  let lo = 0
  let hi = line.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = line[mid]!
    if (v === row) return mid
    if (v < row) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

/**
 * The edges of a row while the graph shows only one line: nothing of the other lines, just the
 * line itself in the row's colour. The node keeps its lane, so the line stays where it was drawn.
 * `above` is the lane of the line's row above (its child on the line), or -1 at the top of the
 * line; where that lane differs, the line turns into this node the way the full graph draws it
 * (a 'top' edge down the child's lane, then across). `below` is whether the line goes on down (the
 * commit has a parent). HEAD's dashed line to the "uncommitted changes" row is kept as it was.
 */
export function lineEdges(row: Row, above: number, aboveColor: number, below: boolean): Edge[] {
  const out = row.edges.filter((e) => e.pending)
  if (above >= 0) out.push({ part: 'top', from: above, to: row.lane, color: above === row.lane ? row.color : aboveColor })
  if (below) out.push({ part: 'bottom', from: row.lane, to: row.lane, color: row.color })
  return out
}
