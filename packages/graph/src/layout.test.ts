import { makeFixture, makeLargeRepo, SHAPES, type Shape } from '@gitsquid/fixtures'
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

function logOf(dir: string): LayoutCommit[] {
  // Same revisions and order as the app's LogStream.
  const out = execFileSync('git', ['log', '--topo-order', '--format=%H %P', '--branches', '--remotes', '--tags', 'HEAD', '--'],
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
 * - lines never jump: a 'pass' edge stays in its column, and two lines never share a column
 */
function checkInvariants(commits: LayoutCommit[], rows: Row[]): void {
  const index = new Map(commits.map((c, i) => [c.hash, i]))
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const cols = row.edges.filter((e) => e.part === 'pass').map((e) => e.from)
    expect(new Set(cols).size, `row ${i}: two lines share a column`).toBe(cols.length)
    expect(cols, `row ${i}: a line passes through the node`).not.toContain(row.lane)
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

  /** The column the dashed line runs down, for every row above HEAD: never used by those rows. */
  function checkDashedLine(rows: Row[], g: GraphLayout, head: string): void {
    const at = rows.findIndex((r) => r.hash === head)
    const col = g.headLane!
    for (const r of rows.slice(0, at)) {
      expect(r.lane, `${r.hash}: node on the dashed line`).not.toBe(col)
      for (const e of r.edges) expect([e.from, e.to], `${r.hash}: line on the dashed line`).not.toContain(col)
    }
    expect(rows[at]!.edges).toContainEqual({ part: 'top', from: col, to: rows[at]!.lane, color: rows[at]!.color, pending: true })
  }
  const run = (commits: LayoutCommit[], opts: { head?: string; trunk?: string[] }) => {
    const g = new GraphLayout(opts)
    return { g, rows: g.push(commits) }
  }

  it('lays out the same whatever is checked out', () => {
    const commits = [c('other', 'X'), c('X', 'A'), c('B', 'A'), c('A')]
    const free = layout(commits).map((r) => r.lane)
    for (const head of ['other', 'X', 'B', 'A']) {
      const { g, rows } = run(commits, { head })
      expect(rows.map((r) => r.lane)).toEqual(free)
      checkDashedLine(rows, g, head)
    }
  })

  // The branches fixture: main is A-B-M-E, feature C-D merged at M, wip F off B.
  const branches = [c('E', 'M'), c('M', 'B', 'D'), c('D', 'C'), c('C', 'B'), c('F', 'B'), c('B', 'A'), c('A')]

  it('keeps the trunk in lane 0 and everything else in place, whatever is checked out', () => {
    //                                     E  M  D  C  F  B  A
    for (const head of ['E', 'F', 'D', 'B']) expect(layout(branches, { head, trunk: ['E'] }).map((r) => r.lane)).toEqual([0, 0, 1, 1, 2, 0, 0])
    const { g, rows } = run(branches, { head: 'F', trunk: ['E'] })
    expect(ascii(rows)).toEqual(['* E', 'M M', '|* D', '|* C', '||* F', '* B', '* A'])
    expect(rows.filter((r) => ['E', 'M', 'B', 'A'].includes(r.hash)).every((r) => r.color === 0)).toBe(true)
    // Nothing above F uses its column: the dashed line runs straight down it.
    expect(g).toMatchObject({ headLane: 2, headColor: 2 })
    expect(run(branches, { head: 'B', trunk: ['E'] }).g.headLane).toBe(3) // columns 0-2 are used above B
    checkDashedLine(rows, g, 'F')
  })

  it('runs the dashed line straight down HEAD\'s own column when nothing above uses it', () => {
    expect(run(branches, { head: 'E', trunk: ['E'] }).g).toMatchObject({ headLane: 0, headColor: 0 })
    const { g, rows } = run([c('X', 'B'), c('B', 'A'), c('A')], { head: 'X', trunk: ['B'] })
    expect(g).toMatchObject({ headLane: 1, headColor: 1 })
    expect(rows[0]!.edges).toContainEqual({ part: 'top', from: 1, to: 1, color: 1, pending: true })
    expect(new GraphLayout({ head: 'F' }).headLane).toBeNull() // not known until HEAD is laid out
  })

  it('does not push the commits ahead of a checked-out commit off to the side', () => {
    // main merged a branch (T3-T2-T1) whose base is HEAD (H), an older commit.
    const commits = [c('Mg', 'P', 'T3'), c('T3', 'T2'), c('T2', 'T1'), c('T1', 'H'), c('H', 'P'), c('P')]
    const { g, rows } = run(commits, { head: 'H', trunk: ['Mg'] })
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 1, 1, 1, 0])
    expect(g.headLane).toBe(2)
    checkDashedLine(rows, g, 'H')
  })

  it('holds lane 0 empty until the trunk arrives, then curves lines waiting for it in', () => {
    // X is ahead of main (B): X comes first, takes lane 1, and its line ends in B in lane 0.
    const rows = layout([c('X', 'B'), c('B', 'A'), c('A')], { trunk: ['B'] })
    expect(rows.map((r) => r.lane)).toEqual([1, 0, 0])
    expect(rows[0]!.edges.some((e) => e.from === 0 || e.to === 0)).toBe(false)
    expect(rows[1]!.edges).toContainEqual({ part: 'top', from: 1, to: 0, color: 1 })
  })

  it('gives lane 0 to whichever trunk tip comes first', () => {
    // origin/main (O) is ahead of local main (B); the trunk line runs through both.
    const rows = layout([c('O', 'B'), c('F', 'A'), c('B', 'A'), c('A')], { head: 'F', trunk: ['B', 'O'] })
    expect(rows.map((r) => [r.hash, r.lane])).toEqual([['O', 0], ['F', 1], ['B', 0], ['A', 0]])
  })

  it('brings the dashed line into an older trunk commit from the side', () => {
    // Checked out B, behind main (C): C sits on lane 0 above it, so the line comes down lane 1.
    const { g, rows } = run([c('C', 'B'), c('B', 'A'), c('A')], { head: 'B', trunk: ['C'] })
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(g.headLane).toBe(1)
    expect(rows[1]!.edges).toContainEqual({ part: 'top', from: 1, to: 0, color: 0, pending: true })
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

  it.each(SHAPES.filter((s) => s !== 'empty'))('satisfies invariants on the %s fixture', (shape: Shape) => {
    const r = makeFixture(shape)
    const commits = logOf(r.dir)
    const head = r.head()
    checkInvariants(commits, layout(commits, { head }))
    // With main as the trunk, checked out or not: main sits in lane 0, nothing else moves, and
    // the dashed line has a clear column.
    const main = r.git('rev-parse', 'main').trim()
    const free = layout(commits, { trunk: [main] }).map((x) => x.lane)
    for (const h of new Set([head, ...commits.map((x) => x.hash).slice(0, 5)])) {
      const { g, rows: withTrunk } = run(commits, { head: h, trunk: [main] })
      checkInvariants(commits, withTrunk)
      expect(withTrunk.find((x) => x.hash === main)!.lane).toBe(0)
      expect(withTrunk.map((x) => x.lane)).toEqual(free)
      checkDashedLine(withTrunk, g, h)
    }
  })

  it('satisfies invariants on a large generated history', () => {
    const commits = logOf(makeLargeRepo(2000))
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
