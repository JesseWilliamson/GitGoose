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

  it('gives lane 0 to whichever trunk tip comes first', () => {
    // origin/main (O) is ahead of local main (B); the trunk line runs through both.
    const rows = layout([c('O', 'B'), c('F', 'A'), c('B', 'A'), c('A')], { head: 'F', trunk: ['B', 'O'] })
    expect(rows.map((r) => [r.hash, r.lane])).toEqual([['O', 0], ['F', 1], ['B', 0], ['A', 0]])
  })

  it('lets HEAD join the trunk lane when HEAD is behind it', () => {
    // Checked out an older trunk commit (B): the trunk line reaches it first, in lane 0.
    const rows = layout([c('C', 'B'), c('B', 'A'), c('A')], { head: 'B', trunk: ['C'] })
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(rows[1]!.edges).toContainEqual({ part: 'top', from: 1, to: 0, color: 1, pending: true })
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
