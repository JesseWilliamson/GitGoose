import type { CenterView, RepoView, Selection } from './store'

/**
 * Back and forward, like a browser (Alt+Left / Alt+Right, the mouse's side buttons). Pure: the
 * store wiring is in lib/navigation.ts.
 *
 * A location is where the user is looking: which tab, what is selected in it, what the centre
 * shows, and whether the graph is narrowed to one line. History is a list with a cursor; going
 * somewhere new from the middle of the list drops what was ahead, as a browser does.
 *
 * (lib/history.ts is something else: undo and redo for the recompose draft.)
 */
export interface NavLocation {
  repoId: string
  selected: Selection
  center: CenterView
  line: RepoView['line']
}

interface Entry {
  loc: NavLocation
  /** It differs from the entry before it only in what is selected (a click or an arrow key in the same view). */
  soft: boolean
}

/** Selection changes closer together than this are one step (holding an arrow key through the graph). */
export const COALESCE_MS = 500
export const MAX_ENTRIES = 100

export class NavHistory {
  private entries: Entry[] = []
  private cursor = -1
  /** When the current entry was last recorded; -Infinity after back or forward, so nothing joins it. */
  private lastAt = -Infinity

  constructor(private readonly max = MAX_ENTRIES) {}

  get current(): NavLocation | null {
    return this.entries[this.cursor]?.loc ?? null
  }

  /** How many entries there are and where the cursor is, for tests and debugging. */
  get size(): number {
    return this.entries.length
  }

  get index(): number {
    return this.cursor
  }

  /**
   * The user is now at `loc`. Same as where they were: nothing. Only the selection changed, and
   * the last step was also only that, moments ago: the last step becomes this one, so a held
   * arrow key leaves one entry, not a hundred. Anything else is a new entry; the forward list goes.
   */
  record(loc: NavLocation, now: number): void {
    const cur = this.entries[this.cursor]
    if (cur && equal(cur.loc, loc)) return
    const soft = !!cur && sameView(cur.loc, loc)
    if (cur && soft && cur.soft && now - this.lastAt < COALESCE_MS) {
      this.entries[this.cursor] = { loc, soft: true }
      this.entries.length = this.cursor + 1
      this.lastAt = now
      return
    }
    this.entries.length = this.cursor + 1
    this.entries.push({ loc, soft })
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max)
    this.cursor = this.entries.length - 1
    this.lastAt = now
  }

  /**
   * Step back to the nearest entry that is still somewhere to go: its repository is open (`live`)
   * and it is not where the user already is (closing a tab can leave two alike side by side).
   */
  back(live: (repoId: string) => boolean = () => true): NavLocation | null {
    const i = this.find(-1, live)
    if (i < 0) return null
    return this.moveTo(i)
  }

  forward(live: (repoId: string) => boolean = () => true): NavLocation | null {
    const i = this.find(1, live)
    if (i < 0) return null
    return this.moveTo(i)
  }

  canBack(live: (repoId: string) => boolean = () => true): boolean {
    return this.find(-1, live) >= 0
  }

  canForward(live: (repoId: string) => boolean = () => true): boolean {
    return this.find(1, live) >= 0
  }

  /** Rewrite every entry (a rebase gave commits new hashes; see lib/navigation.ts). */
  map(f: (loc: NavLocation) => NavLocation): void {
    for (const e of this.entries) e.loc = f(e.loc)
  }

  private find(step: 1 | -1, live: (repoId: string) => boolean): number {
    const here = this.entries[this.cursor]?.loc
    for (let i = this.cursor + step; i >= 0 && i < this.entries.length; i += step) {
      const loc = this.entries[i]!.loc
      if (live(loc.repoId) && !(here && equal(here, loc))) return i
    }
    return -1
  }

  private moveTo(i: number): NavLocation {
    this.cursor = i
    this.lastAt = -Infinity
    return this.entries[i]!.loc
  }
}

/** The same tab, centre view and line: only the selection may differ. */
function sameView(a: NavLocation, b: NavLocation): boolean {
  return a.repoId === b.repoId && equal(a.center, b.center) && equal(a.line, b.line)
}

/** Structural equality for plain data (what the store holds: objects, arrays, strings, numbers, null). */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  if (ka.length !== kb.length) return false
  return ka.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}
