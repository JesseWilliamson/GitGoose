import { makeFixture, makeLargeRepo, SHAPES, type Shape } from '@gitgoose/fixtures'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { GraphLayout, layout, type LayoutCommit, type Row } from './layout'

const c = (hash: string, ...parents: string[]): LayoutCommit => ({ hash, parents })

/** Render rows as ASCII so layouts read like `git log --graph` in failures. */
function ascii(rows: Row[]): string[] {
  return rows.map((r) => {
    const w = r.width
    const cells = Array.from({ length: w }, () => ' ')
    for (const e of r.edges) if (e.part === 'pass') cells[e.from] = '|'
    cells[r.lane] = r.merge ? 'M' : '*'
    return cells.join('').trimEnd() + ' ' + r.hash
  })
}

/** The two orders the app can walk in (Settings → Graph → Commit order); the layout must handle both. */
const ORDERS = ['--date-order', '--topo-order'] as const

function logOf(dir: string, order: (typeof ORDERS)[number] = '--date-order'): LayoutCommit[] {
  // Same revisions and orders as the app's LogStream.
  const out = execFileSync('git', ['log', order, '--format=%H %P', '--branches', '--remotes', '--tags', 'HEAD', '--'],
    { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 30 })
  return out.split('\n').filter(Boolean).map((l) => {
    const [hash, ...parents] = l.split(' ')
    return { hash: hash!, parents }
  })
}

/**
 * Invariants every layout must satisfy, whatever the history:
 * - every parent link is drawn: a 'bottom' edge from the child's lane to some lane L, then that
 *   lane passes straight down until a 'top' edge brings it into the parent's node
 * - lines never jump: a 'pass' edge stays in its column (HEAD's dashed line too), and two lines
 *   never share a column
 */
function checkInvariants(commits: LayoutCommit[], rows: Row[]): void {
  const index = new Map(commits.map((c, i) => [c.hash, i]))
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const passes = row.edges.filter((e) => e.part === 'pass')
    for (const side of ['from', 'to'] as const) {
      const cols = passes.map((e) => e[side])
      expect(new Set(cols).size, `row ${i}: two lines share a column`).toBe(cols.length)
    }
    expect(passes.every((e) => e.from === e.to), `row ${i}: a line jumps`).toBe(true)
    expect(passes.map((e) => e.to), `row ${i}: a line passes through the node`).not.toContain(row.lane)
    for (const p of commits[i]!.parents) {
      const j = index.get(p)
      if (j === undefined) continue // parent outside the loaded range
      const out = row.edges.filter((e) => e.part === 'bottom').map((e) => e.to)
      // Follow the line down: it must arrive at the parent through a 'top' edge.
      let reached = false
      for (const col of out) {
        let ok = true
        for (let k = i + 1; k < j; k++) {
          if (!rows[k]!.edges.some((e) => e.part === 'pass' && e.from === col)) { ok = false; break }
        }
        if (ok && rows[j]!.edges.some((e) => e.part === 'top' && e.from === col)) { reached = true; break }
      }
      expect(reached, `row ${i}: no line from ${commits[i]!.hash.slice(0, 7)} to its parent ${p.slice(0, 7)}`).toBe(true)
    }
  }
}

describe('layout', () => {
  it('puts a linear history in one lane', () => {
    const rows = layout([c('c', 'b'), c('b', 'a'), c('a')])
    expect(ascii(rows)).toEqual(['* c', '* b', '* a'])
    expect(rows.every((r) => r.lane === 0 && r.color === 0)).toBe(true)
  })

  it('opens a lane for a merge and closes it at the branch point', () => {
    //   M        M merges F into B's line
    //   | F
    //   B |
    //   |/
    //   A
    const rows = layout([c('M', 'B', 'F'), c('F', 'A'), c('B', 'A'), c('A')])
    expect(ascii(rows)).toEqual(['M M', '|* F', '*| B', '* A'])
    expect(rows[0]!.edges).toEqual([
      { part: 'bottom', from: 0, to: 0, color: 0 },
      { part: 'bottom', from: 0, to: 1, color: 1 },
    ])
    // A: lane 0 comes straight in, lane 1 curves in from the right.
    expect(rows[3]!.edges.filter((e) => e.part === 'top')).toEqual([
      { part: 'top', from: 0, to: 0, color: 0 },
      { part: 'top', from: 1, to: 0, color: 1 },
    ])
  })

  it('colours by column, so a column reused by a later branch keeps its colour', () => {
    // Two side branches, one after the other, both in column 1.
    const rows = layout([c('M2', 'M1', 'G'), c('G', 'M1'), c('M1', 'B', 'F'), c('F', 'A'), c('B', 'A'), c('A')])
    expect(rows.map((r) => [r.hash, r.lane, r.color])).toEqual([
      ['M2', 0, 0], ['G', 1, 1], ['M1', 0, 0], ['F', 1, 1], ['B', 0, 0], ['A', 0, 0],
    ])
    for (const r of rows) for (const e of r.edges) expect(e.color).toBe(e.part === 'top' ? e.from : e.to)
  })

  it('reserves lane 0 for HEAD, even when newer commits on other branches come first', () => {
    // other (newer) -> X ; HEAD = B -> A ; X -> A
    const commits = [c('other', 'X'), c('X', 'A'), c('B', 'A'), c('A')]
    const rows = layout(commits, { head: 'B' })
    expect(rows.map((r) => [r.hash, r.lane])).toEqual([['other', 1], ['X', 1], ['B', 0], ['A', 0]])
    // Above HEAD, lane 0 is the dashed line from "uncommitted changes" down to HEAD.
    expect(rows[0]!.edges).toContainEqual({ part: 'pass', from: 0, to: 0, color: 0, pending: true })
    expect(rows[2]!.edges).toContainEqual({ part: 'top', from: 0, to: 0, color: 0, pending: true })
  })

  // The branches fixture: main is A-B-M-E, feature C-D merged at M, wip F off B.
  const branches = [c('E', 'M'), c('M', 'B', 'D'), c('D', 'C'), c('C', 'B'), c('F', 'B'), c('B', 'A'), c('A')]

  it('keeps the trunk in lane 0 whatever is checked out', () => {
    const lanes = (head: string) => layout(branches, { head, trunk: ['E'] }).map((r) => r.lane)
    //            E  M  D  C  F  B  A
    expect(lanes('E')).toEqual([0, 0, 1, 1, 2, 0, 0])
    // Checking out a side branch moves that branch into lane 1, next to the trunk, and nothing else.
    expect(lanes('F')).toEqual([0, 0, 2, 2, 1, 0, 0])
    expect(lanes('D')).toEqual([0, 0, 1, 1, 2, 0, 0])
    const rows = layout(branches, { head: 'F', trunk: ['E'] })
    // (Lane 1 above F is the dashed line to HEAD.)
    expect(ascii(rows)).toEqual(['*| E', 'M| M', '||* D', '||* C', '|*| F', '* B', '* A'])
    // The trunk keeps colour 0; HEAD's dashed line (for the WIP row) runs down lane 1.
    expect(rows.filter((r) => ['E', 'M', 'B', 'A'].includes(r.hash)).every((r) => r.color === 0)).toBe(true)
    expect(rows[0]!.edges).toContainEqual({ part: 'pass', from: 1, to: 1, color: 1, pending: true })
  })

  it('reports where HEAD\'s line runs', () => {
    expect(new GraphLayout({ head: 'E', trunk: ['E'] })).toMatchObject({ headLane: 0, headColor: 0 })
    expect(new GraphLayout({ head: 'F', trunk: ['E'] })).toMatchObject({ headLane: 1, headColor: 1 })
    expect(new GraphLayout({ head: 'F' })).toMatchObject({ headLane: 0, headColor: 0 })
  })

  it('holds lane 0 empty until the trunk arrives, then curves lines waiting for it in', () => {
    // HEAD (X) is ahead of main (B): X comes first, takes lane 1, and its line ends in B in lane 0.
    const rows = layout([c('X', 'B'), c('B', 'A'), c('A')], { head: 'X', trunk: ['B'] })
    expect(rows.map((r) => r.lane)).toEqual([1, 0, 0])
    expect(rows[0]!.edges.some((e) => e.from === 0 || e.to === 0)).toBe(false)
    expect(rows[1]!.edges).toContainEqual({ part: 'top', from: 1, to: 0, color: 1 })
  })

  it('sends a merge of the trunk tip straight to lane 0, not around through a new lane', () => {
    // feature (F, checked out) merged main (B) in: M's second parent is the trunk tip, held in lane 0.
    const commits = [c('M', 'F', 'B'), c('F', 'A'), c('B', 'A'), c('A')]
    const rows = layout(commits, { head: 'M', trunk: ['B'] })
    expect(rows.map((r) => r.lane)).toEqual([1, 1, 0, 0])
    expect(rows[0]!.edges).toContainEqual({ part: 'bottom', from: 1, to: 0, color: 0 })
    // Nothing goes past lane 1, so no line crosses the feature lane to get back to lane 0.
    expect(rows.map((r) => r.width)).toEqual([2, 2, 2, 2])
    checkInvariants(commits, rows)
  })

  it('draws a merge of HEAD solid: the line below the merge is not the dashed one to the WIP row', () => {
    // HEAD = B on main; dev merged main in (M), so M's second parent is HEAD.
    const commits = [c('D2', 'M'), c('M', 'D1', 'B'), c('D1', 'A'), c('B', 'A'), c('A')]
    const rows = layout(commits, { head: 'B', trunk: ['B'] })
    expect(rows.map((r) => r.lane)).toEqual([1, 1, 1, 0, 0])
    // Above the merge: still HEAD's dashed line. Below it: the merge's line, into HEAD.
    expect(rows[1]!.edges).toContainEqual({ part: 'pass', from: 0, to: 0, color: 0, pending: true })
    expect(rows[2]!.edges).toContainEqual({ part: 'pass', from: 0, to: 0, color: 0 })
    expect(rows[3]!.edges).toContainEqual({ part: 'top', from: 0, to: 0, color: 0 })
    checkInvariants(commits, rows)
  })

  it('gives lane 0 to whichever trunk tip comes first', () => {
    // origin/main (O) is ahead of local main (B); the trunk line runs through both.
    const rows = layout([c('O', 'B'), c('F', 'A'), c('B', 'A'), c('A')], { head: 'F', trunk: ['B', 'O'] })
    expect(rows.map((r) => [r.hash, r.lane])).toEqual([['O', 0], ['F', 1], ['B', 0], ['A', 0]])
  })

  it('lets HEAD join the trunk lane when HEAD is behind it', () => {
    // Checked out an older trunk commit (B). Without git's hints the trunk line reaches it first,
    // in lane 0, and the dashed line has to turn into it at the end.
    const rows = layout([c('C', 'B'), c('B', 'A'), c('A')], { head: 'B', trunk: ['C'] })
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(rows[1]!.edges).toContainEqual({ part: 'top', from: 1, to: 0, color: 1, pending: true })
    // With them (C is straight over HEAD), HEAD owns lane 0 from the top: the dashed line runs
    // straight down to it, and the newer trunk commit joins from beside it.
    const g = new GraphLayout({ head: 'B', trunk: ['C'], straight: { overTrunk: [], overHead: ['C'] } })
    expect(g.headLane).toBe(0)
    const hinted = g.push([c('C', 'B'), c('B', 'A'), c('A')])
    expect(hinted.map((r) => r.lane)).toEqual([1, 0, 0])
    expect(hinted[0]!.edges).toContainEqual({ part: 'pass', from: 0, to: 0, color: 0, pending: true })
    expect(hinted[1]!.edges).toContainEqual({ part: 'top', from: 0, to: 0, color: 0, pending: true })
  })

  describe('a branch on top of a reserved line continues it', () => {
    // main: A-B, topic: X-Y-Z on B (Z newest, so it arrives before B).
    const onTop = [c('Z', 'Y'), c('Y', 'X'), c('X', 'B'), c('B', 'A'), c('A')]

    /** Follow HEAD's dashed line from the top of the first row down to HEAD; returns its columns. */
    function pendingPath(rows: Row[], head: string, headLane: number): number[] {
      const cols: number[] = []
      let col = headLane
      for (const r of rows) {
        cols.push(col)
        const e = r.edges.find((x) => x.pending && x.from === col)
        expect(e, `${r.hash}: the dashed line to HEAD is cut`).toBeDefined()
        if (r.hash === head) {
          expect(e!.part).toBe('top')
          // Straight into the node: the line never turned.
          expect(e!.to).toBe(col)
          return cols
        }
        expect(e!.part).toBe('pass')
        col = e!.to
      }
      throw new Error('HEAD never reached')
    }

    it('branch on top of trunk: the tip takes the held lane 0', () => {
      // Without the hint, Z opens lane 1 (lane 0 is held for B) and curves in at B.
      expect(layout(onTop, { trunk: ['B'] }).map((r) => r.lane)).toEqual([1, 1, 1, 0, 0])
      const rows = layout(onTop, { trunk: ['B'], straight: { overTrunk: ['Z'], overHead: [] } })
      expect(ascii(rows)).toEqual(['* Z', '* Y', '* X', '* B', '* A'])
      checkInvariants(onTop, rows)
      // Checked out an older trunk commit (HEAD = A, behind main): HEAD's dashed line runs straight
      // down lane 0, and the newer commits, main's tip included, join it from lane 1.
      const behind = layout(onTop, { head: 'A', trunk: ['B'], straight: { overTrunk: ['Z'], overHead: ['Z', 'B'] } })
      expect(behind.map((r) => r.lane)).toEqual([1, 1, 1, 1, 0])
      checkInvariants(onTop, behind)
    })

    it('branch on top of trunk, checked out: HEAD shares lane 0 with the trunk from the top', () => {
      const g = new GraphLayout({ head: 'Z', trunk: ['B'], straight: { overTrunk: ['Z'], overHead: [] } })
      expect(g.headLane).toBe(0)
      const rows = g.push(onTop)
      expect(rows.map((r) => r.lane)).toEqual([0, 0, 0, 0, 0])
      expect(rows[0]!.edges).toContainEqual({ part: 'top', from: 0, to: 0, color: 0, pending: true })
      checkInvariants(onTop, rows)
    })

    it('branch on top of HEAD with WIP: the dashed line keeps HEAD\'s column, straight; the branch goes beside it', () => {
      // HEAD = B = main. Z is over both the trunk and HEAD, but the dashed line owns lane 0 above B.
      const g = new GraphLayout({ head: 'B', trunk: ['B'], straight: { overTrunk: ['Z'], overHead: ['Z'] } })
      const rows = g.push(onTop)
      expect(rows.map((r) => r.lane)).toEqual([1, 1, 1, 0, 0])
      expect(pendingPath(rows, 'B', g.headLane)).toEqual([0, 0, 0, 0])
      // The branch joins HEAD at its node, from beside it.
      expect(rows[3]!.edges).toContainEqual({ part: 'top', from: 1, to: 0, color: 1 })
      checkInvariants(onTop, rows)

      // HEAD off the trunk (H on a side branch from A, older than Z).
      const side = [c('Z', 'Y'), c('Y', 'H'), c('H', 'A'), c('B', 'A'), c('A')]
      const g2 = new GraphLayout({ head: 'H', trunk: ['B'], straight: { overTrunk: [], overHead: ['Z'] } })
      const rows2 = g2.push(side)
      expect(rows2.map((r) => [r.hash, r.lane])).toEqual([['Z', 2], ['Y', 2], ['H', 1], ['B', 0], ['A', 0]])
      expect(pendingPath(rows2, 'H', g2.headLane)).toEqual([1, 1, 1])
      checkInvariants(side, rows2)
    })

    it('two branches on top of trunk: the first takes lane 0, the second curves in as before', () => {
      // P-Q on B as well; Z is newer than Q.
      const two = [c('Z', 'Y'), c('Q', 'P'), c('Y', 'X'), c('P', 'B'), c('X', 'B'), c('B', 'A'), c('A')]
      const rows = layout(two, { trunk: ['B'], straight: { overTrunk: ['Z', 'Q'], overHead: [] } })
      expect(rows.map((r) => [r.hash, r.lane])).toEqual([['Z', 0], ['Q', 1], ['Y', 0], ['P', 1], ['X', 0], ['B', 0], ['A', 0]])
      checkInvariants(two, rows)
    })

    it('merge in the chain is not straight: git leaves it out, and the layout is as before', () => {
      // topic merged main (M = merge of X and B): its first-parent chain never reaches B, so
      // Repo.straightTips does not list it, and the layout is unchanged.
      const merged = [c('M', 'X', 'B'), c('X', 'A'), c('B', 'A'), c('A')]
      const rows = layout(merged, { trunk: ['B'], straight: { overTrunk: [], overHead: [] } })
      expect(rows).toEqual(layout(merged, { trunk: ['B'] }))
      expect(rows.map((r) => r.lane)).toEqual([1, 1, 0, 0])
      checkInvariants(merged, rows)
    })

    it('only applies to tips: a commit some lane already waits for keeps that lane', () => {
      // feature (F) on top of Z: Z is not a tip, so it stays in F's lane whatever the hint says.
      const stacked = [c('F', 'Z'), ...onTop]
      const rows = layout(stacked, { trunk: ['B'], straight: { overTrunk: ['F', 'Z'], overHead: [] } })
      expect(rows.map((r) => r.lane)).toEqual([0, 0, 0, 0, 0, 0])
      checkInvariants(stacked, rows)
    })

    it('colours stay per column, including the dashed line', () => {
      const two = [c('Z', 'Y'), c('Q', 'P'), c('Y', 'X'), c('P', 'B'), c('X', 'B'), c('B', 'A'), c('A')]
      const rows = layout(two, { head: 'B', trunk: ['B'], straight: { overTrunk: ['Z', 'Q'], overHead: ['Z', 'Q'] } })
      for (const r of rows) {
        expect(r.color).toBe(r.lane)
        for (const e of r.edges) expect(e.color).toBe(e.part === 'top' ? e.from : e.to)
      }
    })

    it('does not take lane 0 when a second-parent reservation already occupies it', () => {
      // HEAD = M (merge of X and B), trunk = B, overTrunk = [Z]. M's second parent B reserves
      // lane 0 before Z arrives. Z must not overwrite that reservation; it goes to a free lane.
      const commits = [c('M', 'X', 'B'), c('Z', 'B'), c('X', 'A'), c('B', 'A'), c('A')]
      const rows = layout(commits, { head: 'M', trunk: ['B'], straight: { overTrunk: ['Z'], overHead: [] } })
      // M takes lane 1 (HEAD), Z must NOT take lane 0 (B is reserved there), so Z goes to lane 2.
      expect(rows.map((r) => [r.hash, r.lane])).toEqual([['M', 1], ['Z', 2], ['X', 1], ['B', 0], ['A', 0]])
      // B must end up in lane 0 where it was reserved by M's second parent.
      expect(rows.find((r) => r.hash === 'B')!.lane).toBe(0)
      checkInvariants(commits, rows)
    })
  })

  it('marks a stash\'s line down to its base, and only that line', () => {
    // A stash (S) made on B, beside the branch tip C.
    const commits: LayoutCommit[] = [{ hash: 'S', parents: ['B'], stash: true }, c('C', 'B'), c('B', 'A'), c('A')]
    const rows = layout(commits)
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0])
    expect(rows[0]!.edges).toEqual([{ part: 'bottom', from: 0, to: 0, color: 0, stash: true }])
    expect(rows[1]!.edges).toContainEqual({ part: 'pass', from: 0, to: 0, color: 0, stash: true })
    expect(rows[2]!.edges).toContainEqual({ part: 'top', from: 0, to: 0, color: 0, stash: true })
    // C's line into B, and everything below B, is ordinary history.
    expect(rows[2]!.edges).toContainEqual({ part: 'top', from: 1, to: 0, color: 1 })
    expect(rows.slice(2).flatMap((r) => r.edges).filter((e) => e.part !== 'top' && e.stash)).toEqual([])
    checkInvariants(commits, rows)
  })

  /** What Repo.straightTips computes, the slow and obvious way: is the base on the tip's first-parent chain? */
  function straightOf(dir: string, base: string): string[] {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
    const tips = new Set(git('for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes').split('\n').filter(Boolean))
    return [...tips].filter((t) => t !== base && git('rev-list', '--first-parent', t).split('\n').includes(base))
  }

  const straightShapes = SHAPES.filter((s) => s !== 'empty').flatMap((s) => ORDERS.map((o) => [s, o] as const))
  it.each(straightShapes)('satisfies invariants with straight tips on the %s fixture in %s', (shape: Shape, order) => {
    const r = makeFixture(shape)
    const commits = logOf(r.dir, order)
    const main = r.git('rev-parse', 'main').trim()
    for (const head of new Set([r.head(), main, ...commits.map((x) => x.hash).slice(0, 5)])) {
      const opts = { head, trunk: [main], straight: { overTrunk: straightOf(r.dir, main), overHead: straightOf(r.dir, head) } }
      const rows = layout(commits, opts)
      checkInvariants(commits, rows)
      // Lane 0 is the trunk's, unless HEAD sits below the trunk tip on its line: then HEAD's
      // straight dashed line holds lane 0 and the newer trunk commits join it from beside.
      const lane0 = opts.straight.overHead.includes(main) ? head : main
      expect(rows.find((x) => x.hash === lane0)!.lane).toBe(0)
      // Paging gives the same rows.
      const g = new GraphLayout(opts)
      expect([...g.push(commits.slice(0, 2)), ...g.push(commits.slice(2, 5)), ...g.push(commits.slice(5))]).toEqual(rows)
    }
  })

  it('gives the same result page by page with straight tips', () => {
    const two = [c('Z', 'Y'), c('Q', 'P'), c('Y', 'X'), c('P', 'B'), c('X', 'B'), c('B', 'A'), c('A')]
    const opts = { head: 'B', trunk: ['B'], straight: { overTrunk: ['Z', 'Q'], overHead: ['Z', 'Q'] } }
    const whole = layout(two, opts)
    for (let cut = 1; cut < two.length; cut++) {
      const g = new GraphLayout(opts)
      expect([...g.push(two.slice(0, cut)), ...g.push(two.slice(cut))]).toEqual(whole)
    }
  })

  it('handles octopus merges and multiple roots', () => {
    const rows = layout([c('O', 'a', 'b', 'c'), c('c', 'r'), c('b', 'r'), c('a', 'r'), c('r'), c('orphan')])
    expect(rows[0]!.edges.filter((e) => e.part === 'bottom').map((e) => e.to)).toEqual([0, 1, 2])
    expect(rows[4]!.edges.filter((e) => e.part === 'top').map((e) => e.from).sort()).toEqual([0, 1, 2])
    expect(rows[5]!.lane).toBe(0) // all lanes closed, the orphan root starts again at the left
  })

  it('gives the same result when fed page by page', () => {
    const commits = logOf(makeLargeRepo(600))
    const whole = layout(commits)
    const g = new GraphLayout()
    const paged = [...g.push(commits.slice(0, 101)), ...g.push(commits.slice(101, 333)), ...g.push(commits.slice(333))]
    expect(paged).toEqual(whole)
    // With a trunk that only arrives on a later page.
    const opts = { head: commits[0]!.hash, trunk: [commits[150]!.hash] }
    const g2 = new GraphLayout(opts)
    expect([...g2.push(commits.slice(0, 101)), ...g2.push(commits.slice(101))]).toEqual(layout(commits, opts))
  })

  const shapesByOrder = SHAPES.filter((s) => s !== 'empty').flatMap((s) => ORDERS.map((o) => [s, o] as const))
  it.each(shapesByOrder)('satisfies invariants on the %s fixture in %s', (shape: Shape, order) => {
    const r = makeFixture(shape)
    const commits = logOf(r.dir, order)
    const head = r.head()
    checkInvariants(commits, layout(commits, { head }))
    const rows = layout(commits, { head })
    expect(rows.find((x) => x.hash === head)!.lane).toBe(0)
    // With main as the trunk, checked out or not: main sits in lane 0 either way.
    const main = r.git('rev-parse', 'main').trim()
    for (const h of new Set([head, ...commits.map((x) => x.hash).slice(0, 5)])) {
      const withTrunk = layout(commits, { head: h, trunk: [main] })
      checkInvariants(commits, withTrunk)
      expect(withTrunk.find((x) => x.hash === main)!.lane).toBe(0)
    }
  })

  it.each(ORDERS)('satisfies invariants on a large generated history in %s', (order) => {
    const commits = logOf(makeLargeRepo(2000), order)
    checkInvariants(commits, layout(commits, { head: commits[0]!.hash }))
    checkInvariants(commits, layout(commits, { head: commits[700]!.hash, trunk: [commits[3]!.hash] }))
  })

  it('lays out 100k commits quickly', () => {
    // Synthetic: a main line with a merged side branch every 50 commits.
    const commits: LayoutCommit[] = []
    const n = 100_000
    for (let i = 0; i < n; i++) {
      const parents = i + 1 < n ? [`m${i + 1}`] : []
      if (i % 50 === 0 && i + 6 < n) parents.push(`s${i}-0`)
      commits.push({ hash: `m${i}`, parents })
      if (i % 50 === 0 && i + 6 < n) {
        for (let k = 0; k < 5; k++) commits.push({ hash: `s${i}-${k}`, parents: [k < 4 ? `s${i}-${k + 1}` : `m${i + 6}`] })
      }
    }
    const t = performance.now()
    const rows = layout(commits)
    const ms = performance.now() - t
    expect(rows).toHaveLength(commits.length)
    expect(ms).toBeLessThan(1000)
  })
})
