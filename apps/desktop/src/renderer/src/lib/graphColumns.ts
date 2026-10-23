/**
 * Which columns the compact graph has room for.
 *
 * The compact layout is a table: branch / tag, graph, message, author, date, SHA. Every column but
 * the message has a fixed width, so the message gets what is left, and in a window of ordinary
 * size what was left was about 90 px ("Publish si…"). The message is what a row is for, so it is
 * the one that decides: it keeps at least MESSAGE_SHARE of the row, and columns give way, least
 * important first, until it does.
 *
 * Pure, so the rule can be tested without a window.
 */

/** The branch / tag column (when it has one). */
export const REFS_W = 160
export const AUTHOR_W = 140
export const SHA_W = 68
/** The rows' right padding, which the header lines up with. */
export const RIGHT_PAD = 12
/** The share of the row the message keeps, when the columns allow it. */
export const MESSAGE_SHARE = 0.4

export interface CompactColumns {
  /** Width of the branch / tag column; 0 when the pills follow the message instead. */
  refsW: number
  author: boolean
  date: boolean
  sha: boolean
}

/**
 * The columns that fit a pane `paneW` px wide, given the graph column's width and the date
 * column's. They go in this order, until the message has MESSAGE_SHARE of the row: SHA, then the
 * branch / tag column (its pills move after the message), then author, then date. If even that is
 * not enough (a very narrow pane) the leanest layout is used.
 */
export function compactColumns(paneW: number, graphW: number, dateW: number): CompactColumns {
  const steps: CompactColumns[] = [
    { refsW: REFS_W, author: true, date: true, sha: true },
    { refsW: REFS_W, author: true, date: true, sha: false },
    { refsW: 0, author: true, date: true, sha: false },
    { refsW: 0, author: false, date: true, sha: false },
    { refsW: 0, author: false, date: false, sha: false },
  ]
  return steps.find((c) => messageWidth(paneW, graphW, dateW, c) >= paneW * MESSAGE_SHARE) ?? steps[steps.length - 1]!
}

/** The message column's width for these columns (the rest of the row). */
export function messageWidth(paneW: number, graphW: number, dateW: number, c: CompactColumns): number {
  return paneW - RIGHT_PAD - graphW - c.refsW - (c.author ? AUTHOR_W : 0) - (c.date ? dateW : 0) - (c.sha ? SHA_W : 0)
}
