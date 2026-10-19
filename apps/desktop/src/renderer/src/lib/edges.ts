/**
 * The path of one edge in a row `h` tall, whose node sits halfway down. Straight down for lines
 * that stay in their lane. A line that changes lane always does so at a node (the layout
 * guarantees it), and is drawn like this: level with the node, then a rounded
 * turn into the other lane.
 *   top:    down the other lane, turn, then across into the node      ╮
 *   bottom: out of the node across, turn, then down the other lane    ╰
 *   pass across: the one line that changes lane between nodes, HEAD's dashed line stepping aside
 *   for a branch that continues its column (layout rule B). It enters the row in the node's
 *   column, so it cannot turn level with the node; it is an S-curve that leaves the column above
 *   the node and is clear of it by the time it is level with it.
 */
export function edgePath(part: 'pass' | 'top' | 'bottom', x1: number, x2: number, h: number): string {
  const mid = h / 2
  if (part === 'pass' && x1 !== x2) return `M${x1} 0C${x1} ${mid} ${x2} ${mid} ${x2} ${h}`
  if (part === 'pass' || x1 === x2) return part === 'pass' ? `M${x1} 0V${h}` : part === 'top' ? `M${x1} 0V${mid}` : `M${x1} ${mid}V${h}`
  const dir = Math.sign(x2 - x1)
  const r = Math.min(8, Math.abs(x2 - x1), mid)
  if (part === 'top') return `M${x1} 0V${mid - r}Q${x1} ${mid} ${x1 + dir * r} ${mid}H${x2}`
  return `M${x1} ${mid}H${x2 - dir * r}Q${x2} ${mid} ${x2} ${mid + r}V${h}`
}

