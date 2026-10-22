/**
 * How recent each commit in a blame is, from 0 (the oldest change still in the file) to 1 (the
 * newest), for the blame heatmap.
 *
 * By rank, not by date: a file with one line from 2015 and everything else from last week would,
 * on a linear time scale, paint last week's ten commits the same hot colour and leave the scale
 * empty in between. Ranking the distinct commits by date spreads them evenly, so "newer than"
 * always reads as "warmer than". Commits with the same date share a rank.
 */
export function heatByCommit(lines: readonly { hash: string; date: number }[]): Map<string, number> {
  const dates = new Map<string, number>()
  for (const l of lines) dates.set(l.hash, l.date)
  const distinct = [...new Set(dates.values())].sort((a, b) => a - b)
  const rank = new Map(distinct.map((d, i) => [d, i]))
  const out = new Map<string, number>()
  for (const [hash, date] of dates) out.set(hash, distinct.length < 2 ? 1 : rank.get(date)! / (distinct.length - 1))
  return out
}

/** The heatmap colour for a heat from heatByCommit (theme tokens --heat-new and --heat-old). */
export const heatColor = (heat: number) => `color-mix(in oklab, var(--heat-new) ${Math.round(heat * 100)}%, var(--heat-old))`
