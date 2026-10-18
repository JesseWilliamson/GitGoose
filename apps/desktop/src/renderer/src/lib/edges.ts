/**
 * The path of one edge. Straight down for lines that stay in their lane. A line that changes
 * lane always does so at a node (the layout guarantees it), and is drawn the way GitKraken draws
 * it: level with the node, then a rounded turn into the other lane.
 *   top:    down the other lane, turn, then across into the node      ╮
 *   bottom: out of the node across, turn, then down the other lane    ╰
 * The one exception is the dashed HEAD line, which can step aside mid-row (see Edge.pending).
 */
export function edgePath(part: 'pass' | 'top' | 'bottom', x1: number, x2: number, h: number): string {
  const mid = h / 2
  // The dashed HEAD line stepping aside for a real line: it leaves early, over the top of the
  // node that took its column (the node is drawn over it), and runs on down its new column.
  if (part === 'pass' && x1 !== x2) return `M${x1} 0C${x1} ${mid * 0.6} ${x2} 0 ${x2} ${mid * 0.6}V${h}`
  if (part === 'pass' || x1 === x2) return part === 'pass' ? `M${x1} 0V${h}` : part === 'top' ? `M${x1} 0V${mid}` : `M${x1} ${mid}V${h}`
  const dir = Math.sign(x2 - x1)
  const r = Math.min(8, Math.abs(x2 - x1), mid)
  if (part === 'top') return `M${x1} 0V${mid - r}Q${x1} ${mid} ${x1 + dir * r} ${mid}H${x2}`
  return `M${x1} ${mid}H${x2 - dir * r}Q${x2} ${mid} ${x2} ${mid + r}V${h}`
}

