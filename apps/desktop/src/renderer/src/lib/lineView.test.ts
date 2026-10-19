import { initRepo, makeFixture, type FixtureRepo } from '@gitgoose/fixtures'
import { GraphLayout, type LayoutCommit, type Row } from '@gitgoose/graph'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { lineEdges, lineIndexOf, lineThrough, type LineLog } from './lineView'

/** Same revisions and order as the app's LogStream. */
function logOf(dir: string): LayoutCommit[] {
  const out = execFileSync('git', ['log', '--date-order', '--format=%H %P', '--branches', '--remotes', '--tags', 'HEAD', '--'], { cwd: dir, encoding: 'utf8' })
  return out.split('\n').filter(Boolean).map((l) => {
    const [hash, ...parents] = l.split(' ')
    return { hash: hash!, parents }
  })
}

/** A log built the way store.ts builds it: page by page, every map only ever extended. */
class TestLog implements LineLog {
  commits: LayoutCommit[] = []
  rows: Row[] = []
  index = new Map<string, number>()
  firstChildren = new Map<string, string[]>()
  constructor(private layout: GraphLayout) {}
  push(page: LayoutCommit[]): void {
    const rows = this.layout.push(page)
    page.forEach((c, i) => {
      this.index.set(c.hash, this.commits.length)
      this.commits.push(c)
      this.rows.push(rows[i]!)
      const p = c.parents[0]
      if (p) {
        const list = this.firstChildren.get(p)
        if (list) list.push(c.hash)
        else this.firstChildren.set(p, [c.hash])
      }
    })
  }
}

function load(r: FixtureRepo, pageSize = Infinity): { log: TestLog; commits: LayoutCommit[] } {
  const commits = logOf(r.dir)
  const head = r.git('rev-parse', 'HEAD').trim()
  const log = new TestLog(new GraphLayout({ head, trunk: [r.git('rev-parse', 'main').trim()] }))
  for (let i = 0; i < commits.length; i += Math.min(pageSize, commits.length)) log.push(commits.slice(i, i + pageSize))
  return { log, commits }
}

const rev = (r: FixtureRepo, name: string) => r.git('rev-parse', name).trim()
const hashes = (log: TestLog, line: Uint32Array) => [...line].map((i) => log.commits[i]!.hash)
/** git's own first-parent chain from a commit: what the line below its top must be, exactly. */
const firstParentChain = (r: FixtureRepo, hash: string) => r.git('rev-list', '--first-parent', hash).trim().split('\n')

describe('lineThrough', () => {
  it('is exactly the first-parent chain from the top of the line, for every commit of a criss-cross history', () => {
    const r = makeFixture('criss-cross')
    const { log, commits } = load(r)
    for (const c of commits) {
      const line = hashes(log, lineThrough(log, c.hash))
      expect(line).toContain(c.hash)
      expect(line).toEqual(firstParentChain(r, line[0]!))
    }
    // Each side of the criss-cross is its own line: the merges' second parents stay out.
    expect(hashes(log, lineThrough(log, rev(r, 'main')))).toEqual(firstParentChain(r, 'main'))
    expect(hashes(log, lineThrough(log, rev(r, 'side')))).toEqual(firstParentChain(r, 'side'))
  })

  it('follows the first parent through an octopus merge, and never into the other merged branches', () => {
    // main at base merged one, two and three: git leaves base out of the parents (it is an
    // ancestor of all three), so the octopus's first parent is "on one".
    const r = makeFixture('octopus')
    const { log } = load(r)
    const [main, one, base] = [rev(r, 'main'), rev(r, 'one'), rev(r, 'one~1')]
    expect(rev(r, 'main^1')).toBe(one)
    for (const h of [main, one, base]) expect(hashes(log, lineThrough(log, h))).toEqual([main, one, base])
    // Two and three were merged as second and third parents: up stops at each, down joins base.
    for (const b of ['two', 'three']) expect(hashes(log, lineThrough(log, rev(r, b)))).toEqual([rev(r, b), base])
  })

  it('walks up only through the lane it came from, and stops at a fork', () => {
    // main: A - B        topic (from A): X - Y - Z   (the e2e fixture of lineview.spec.ts)
    const r = initRepo()
    const A = r.commit('A', { 'a.txt': 'a\n' })
    const B = r.commit('B', { 'b.txt': 'b\n' })
    r.git('checkout', '-q', '-b', 'topic', A)
    const X = r.commit('X', { 'x.txt': 'x\n' })
    const Y = r.commit('Y', { 'y.txt': 'y\n' })
    const Z = r.commit('Z', { 'z.txt': 'z\n' })
    r.checkout('main')
    const { log } = load(r)
    expect(hashes(log, lineThrough(log, Y))).toEqual([Z, Y, X, A])
    expect(hashes(log, lineThrough(log, X))).toEqual([Z, Y, X, A])
    // A is where topic forked off; from A, up is main's lane, not topic's.
    expect(hashes(log, lineThrough(log, A))).toEqual([B, A])
    expect(hashes(log, lineThrough(log, B))).toEqual([B, A])
  })

  it('grows downward as pages load, and agrees with the whole log at the end', () => {
    const r = makeFixture('branches')
    const all = load(r).log
    const partial = new TestLog(new GraphLayout({ head: rev(r, 'HEAD'), trunk: [rev(r, 'main')] }))
    const commits = logOf(r.dir)
    const target = rev(r, 'feature')
    let previous: string[] = []
    for (let i = 0; i < commits.length; i += 2) {
      partial.push(commits.slice(i, i + 2))
      const line = hashes(partial, lineThrough(partial, target))
      if (!partial.index.has(target)) expect(line).toEqual([])
      // What was there stays there: a new page only adds rows further down.
      expect(line.slice(0, previous.length)).toEqual(previous)
      previous = line
    }
    expect(previous).toEqual(hashes(all, lineThrough(all, target)))
    expect(previous).toEqual(firstParentChain(r, previous[0]!))
  })

  it('is empty for a commit that is not loaded', () => {
    const { log } = load(makeFixture('linear'))
    expect(lineThrough(log, 'f'.repeat(40))).toHaveLength(0)
  })
})

describe('lineIndexOf', () => {
  it('finds a row in the line, or -1', () => {
    const line = Uint32Array.from([0, 3, 4, 9])
    expect([0, 3, 4, 9, 1, 10].map((r) => lineIndexOf(line, r))).toEqual([0, 1, 2, 3, -1, -1])
    expect(lineIndexOf(new Uint32Array(0), 0)).toBe(-1)
  })
})

describe('lineEdges', () => {
  const row: Row = {
    hash: 'x', lane: 1, color: 1, merge: false, width: 3,
    edges: [
      { part: 'pass', from: 0, to: 0, color: 0 },
      { part: 'pass', from: 2, to: 2, color: 2, pending: true },
      { part: 'top', from: 1, to: 1, color: 1 },
      { part: 'bottom', from: 1, to: 0, color: 1 },
    ],
  }
  it('draws only the line, in the row\'s own lane, and keeps HEAD\'s dashed line', () => {
    expect(lineEdges(row, 1, 5, true)).toEqual([
      { part: 'pass', from: 2, to: 2, color: 2, pending: true },
      { part: 'top', from: 1, to: 1, color: 1 },
      { part: 'bottom', from: 1, to: 1, color: 1 },
    ])
  })
  it('turns in from the child\'s lane, in the child\'s colour, and ends at the top and bottom of the line', () => {
    expect(lineEdges(row, 2, 5, false).filter((e) => !e.pending)).toEqual([{ part: 'top', from: 2, to: 1, color: 5 }])
    expect(lineEdges(row, -1, 0, false).filter((e) => !e.pending)).toEqual([])
  })
})
