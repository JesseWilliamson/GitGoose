import { describe, expect, it } from 'vitest'
import { COALESCE_MS, equal, followLocation, NavHistory, type FollowHash, type NavLocation } from './nav'

const at = (hash: string, repoId = 'a', center: NavLocation['center'] = { kind: 'graph' }): NavLocation =>
  ({ repoId, selected: { kind: 'commit', hash }, center, file: null, line: null })
const reflog = (hash: string, repoId = 'a') => at(hash, repoId, { kind: 'reflog' })
const file = (hash: string, path: string): NavLocation =>
  ({ ...at(hash), file: { target: { kind: 'commit', hash, path }, mode: 'diff' } })

/** Records each location a second apart, far outside the coalescing window. */
function visit(h: NavHistory, ...locs: NavLocation[]): void {
  for (const loc of locs) h.record(loc, (h.size + 1) * 1000)
}

describe('NavHistory', () => {
  it('steps back and forward through what was recorded', () => {
    const h = new NavHistory()
    visit(h, at('1'), file('1', 'x.ts'), reflog('1'))
    expect(h.canForward()).toBe(false)
    expect(h.back()).toEqual(file('1', 'x.ts'))
    expect(h.back()).toEqual(at('1'))
    expect(h.back()).toBeNull()
    expect(h.canBack()).toBe(false)
    expect(h.forward()).toEqual(file('1', 'x.ts'))
    expect(h.forward()).toEqual(reflog('1'))
    expect(h.forward()).toBeNull()
  })

  it('going somewhere new after going back drops the forward list', () => {
    const h = new NavHistory()
    visit(h, at('1'), at('2'), at('3'))
    h.back()
    h.back()
    h.record(reflog('1'), 10_000)
    expect(h.canForward()).toBe(false)
    expect(h.size).toBe(2)
    expect(h.back()).toEqual(at('1'))
  })

  it('ignores a location equal to the current one (deep, not by reference)', () => {
    const h = new NavHistory()
    visit(h, file('1', 'x.ts'))
    h.record(file('1', 'x.ts'), 5000)
    h.record(JSON.parse(JSON.stringify(file('1', 'x.ts'))), 9000)
    expect(h.size).toBe(1)
  })

  it('selection changes in quick succession are one step (a held arrow key)', () => {
    const h = new NavHistory()
    h.record(at('1'), 0)
    // The first move away is its own step, so back returns to where the key was first pressed.
    h.record(at('2'), 2000)
    for (let i = 3; i < 50; i++) h.record(at(String(i)), 2000 + i * 30)
    expect(h.size).toBe(2)
    expect(h.current).toEqual(at('49'))
    expect(h.back()).toEqual(at('1'))
  })

  it('a pause, or a change of view, is a new step even when it is quick', () => {
    const h = new NavHistory()
    h.record(at('1'), 0)
    h.record(at('2'), 1000)
    h.record(at('3'), 1000 + COALESCE_MS + 1) // a pause: new step
    h.record(reflog('3'), 1000 + COALESCE_MS + 50) // another view: new step
    h.record(reflog('4'), 1000 + COALESCE_MS + 100) // first selection change in the reflog: new step
    expect(h.size).toBe(5)
    // Switching tabs is never folded into the step before it.
    h.record(at('9', 'b'), 1000 + COALESCE_MS + 150)
    expect(h.size).toBe(6)
  })

  it('a selection right after opening a view is its own step', () => {
    const h = new NavHistory()
    h.record(at('1'), 0)
    h.record(reflog('1'), 5000)
    h.record(reflog('2'), 5100)
    expect(h.back()).toEqual(reflog('1'))
  })

  it('nothing joins an entry reached by back or forward', () => {
    const h = new NavHistory()
    visit(h, at('1'), at('2'), at('3'))
    h.back()
    h.record(at('4'), 3100)
    expect(h.size).toBe(3)
    expect(h.back()).toEqual(at('2'))
  })

  it('keeps at most the newest entries', () => {
    const h = new NavHistory(5)
    for (let i = 0; i < 12; i++) h.record(reflog(String(i), i % 2 ? 'a' : 'b'), i * 1000)
    expect(h.size).toBe(5)
    let n = 0
    while (h.back()) n++
    expect(n).toBe(4)
    expect(h.current).toEqual(reflog('7', 'a'))
  })

  it('skips locations whose repository is closed, and steps over ones equal to where you are', () => {
    const h = new NavHistory()
    visit(h, at('1', 'a'), at('1', 'b'), at('2', 'b'), at('1', 'a'), at('5', 'c'))
    const live = (id: string) => id !== 'b'
    // c → a:1; then the next a:1 back is where we already are, and b is closed: nothing left.
    expect(h.back(live)).toEqual(at('1', 'a'))
    expect(h.canBack(live)).toBe(false)
    expect(h.back(live)).toBeNull()
    expect(h.forward(live)).toEqual(at('5', 'c'))
  })

  it('map rewrites every entry', () => {
    const h = new NavHistory()
    visit(h, at('old'), reflog('x'))
    h.map((loc) => (loc.selected.kind === 'commit' && loc.selected.hash === 'old' ? { ...loc, selected: { kind: 'commit', hash: 'new' } } : loc))
    expect(h.back()).toEqual(at('new'))
  })
})

describe('followLocation', () => {
  // A rebase: old1 became new1, old2 was dropped; everything else stayed.
  const follow: FollowHash = (h) => (h === 'old1' ? 'new1' : h === 'old2' ? null : h)
  // The store's rule for the selection, reduced: a moved commit follows, a dropped one goes to HEAD.
  const followSelected = (sel: NavLocation['selected']): NavLocation['selected'] =>
    sel.kind === 'commit' && follow(sel.hash) !== sel.hash ? { kind: 'commit', hash: follow(sel.hash) ?? 'head' } : sel

  it('moves a file diff to the rewritten commit along with the selection', () => {
    const moved = followLocation(file('old1', 'x.ts'), follow, followSelected)
    expect(moved).toEqual(file('new1', 'x.ts'))
  })

  it('closes the file of a commit that is gone, as the selection goes to HEAD', () => {
    expect(followLocation(file('old2', 'x.ts'), follow, followSelected)).toEqual(at('head'))
  })

  it('follows both ends of a comparison and of a range diff, and the line', () => {
    const loc: NavLocation = {
      repoId: 'a',
      selected: { kind: 'compare', from: 'old1', to: null, fromLabel: 'old1', toLabel: 'Working tree' },
      center: { kind: 'graph' },
      file: { target: { kind: 'range', from: 'keep', to: 'old1', path: 'x.ts' }, mode: 'diff' },
      line: { hash: 'old1' },
    }
    const moved = followLocation(loc, follow, followSelected)
    expect(moved.selected).toMatchObject({ from: 'new1', to: null })
    expect(moved.file).toMatchObject({ target: { from: 'keep', to: 'new1' } })
    expect(moved.line).toEqual({ hash: 'new1' })
  })

  it('keeps a dropped commit as the end of a comparison or range diff (the object is still there to diff)', () => {
    const loc: NavLocation = {
      repoId: 'a',
      selected: { kind: 'compare', from: 'old2', to: 'keep', fromLabel: 'old2', toLabel: 'keep' },
      center: { kind: 'graph' },
      file: { target: { kind: 'range', from: 'old2', to: 'keep', path: 'x.ts' }, mode: 'diff' },
      line: null,
    }
    expect(followLocation(loc, follow, followSelected)).toBe(loc)
  })

  it('returns the same object when nothing moved', () => {
    const loc = file('keep', 'x.ts')
    expect(followLocation(loc, follow, followSelected)).toBe(loc)
  })
})

describe('equal', () => {
  it('compares plain data structurally', () => {
    expect(equal({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] })).toBe(true)
    expect(equal({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    expect(equal({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(equal(null, { a: 1 })).toBe(false)
    expect(equal([], {})).toBe(false)
  })
})
