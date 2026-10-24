/**
 * The sample histories the figures draw. Each is a list of commits NEWEST FIRST with the first
 * parent first, as `git log` prints them and as @dsviz/git expects. Hashes are short names
 * (M3 = third commit on main) so the pictures can be read without a legend.
 */
import type { Commit, Ref } from '@dsviz/git'

/** GitGoose's lane palette as dsviz tones (see styles.css). */
export const LANE_TONES = ['lane-0', 'lane-1', 'lane-2', 'lane-3', 'lane-4', 'lane-5', 'lane-6', 'lane-7'] as const

const c = (hash: string, parents: string[], label: string, extra: Partial<Commit> = {}): Commit => ({ hash, parents, label, ...extra })

/**
 * The report's example: main with two features, feature-a merged first, feature-b forked lower
 * and still open. Straight lanes leave feature-b in its column; compact lanes close feature-a's
 * column at the fork and feature-b slides left into it.
 */
export const twoFeatures: Commit[] = [
  c('B3', ['B2'], 'feature-b tip'),
  c('M4', ['M3'], 'main'),
  c('M3', ['M2', 'A2'], 'merge feature-a'),
  c('B2', ['B1'], 'feature-b'),
  c('A2', ['A1'], 'feature-a'),
  c('A1', ['M2'], 'feature-a'),
  c('B1', ['M1'], 'feature-b'),
  c('M2', ['M1'], 'fork point'),
  c('M1', ['M0'], 'main'),
  c('M0', [], 'main'),
]
export const twoFeaturesRefs: Ref[] = [
  { name: 'main', hash: 'M4', kind: 'branch' },
  { name: 'feature-b', hash: 'B3', kind: 'branch' },
]

/** The history the lane walk is stepped through on: a merge, a fork, and a tip arriving late. */
export const walk: Commit[] = [
  c('M5', ['M4', 'A2'], "merge 'feature-a'"),
  c('B2', ['B1'], 'feature-b'),
  c('A2', ['A1'], 'feature-a'),
  c('M4', ['M3'], 'main'),
  c('A1', ['M3'], 'feature-a'),
  c('B1', ['M2'], 'feature-b'),
  c('M3', ['M2'], 'main'),
  c('M2', ['M1'], 'main'),
  c('M1', [], 'main'),
]
export const walkRefs: Ref[] = [
  { name: 'main', hash: 'M5', kind: 'branch' },
  { name: 'feature-b', hash: 'B2', kind: 'branch' },
  { name: 'feature-a', hash: 'A2', kind: 'branch' },
]

/**
 * Dates lie. feature was rebased onto main after main's last commit: its commits keep their old
 * AUTHOR dates (1, 2) but get new COMMIT dates (5, 6). Sorting by author date puts the rebased
 * commits below M3, their parent: a child above its parent breaks the lane walk.
 */
export const rebased: Commit[] = [
  c('F2', ['F1'], 'feature: part two', { date: 6, authorDate: 2 }),
  c('F1', ['M3'], 'feature: part one', { date: 5, authorDate: 1 }),
  c('M3', ['M2'], 'main: newest', { date: 4 }),
  c('M2', ['M1'], 'main', { date: 3 }),
  c('M1', [], 'main', { date: 0 }),
]
export const rebasedRefs: Ref[] = [
  { name: 'feature', hash: 'F2', kind: 'branch' },
  { name: 'main', hash: 'M3', kind: 'branch' },
]

/** A feature whose tip is newer than main's: without a pin, the feature takes the left column. */
export const lateMain: Commit[] = [
  c('F3', ['F2'], 'feature'),
  c('F2', ['F1'], 'feature'),
  c('M3', ['M2'], 'main tip'),
  c('F1', ['M2'], 'feature'),
  c('M2', ['M1'], 'main'),
  c('M1', [], 'main'),
]
export const lateMainRefs: Ref[] = [
  { name: 'feature', hash: 'F3', kind: 'branch' },
  { name: 'main', hash: 'M3', kind: 'branch' },
]

/** topic sits straight on top of main's tip B: its own first-parent line runs down to B. */
export const onTop: Commit[] = [
  c('Z', ['Y'], 'topic'),
  c('Y', ['X'], 'topic'),
  c('X', ['B'], 'topic'),
  c('B', ['A'], 'main tip'),
  c('A', [], 'main'),
]
export const onTopRefs: Ref[] = [
  { name: 'topic', hash: 'Z', kind: 'branch' },
  { name: 'main', hash: 'B', kind: 'branch' },
]

/** Four features merged into main, as the report's "taming a wide graph" figure. */
export const wide: Commit[] = [
  c('M9', ['M8', 'D2'], 'merge feature-4'),
  c('M8', ['M7', 'C2'], 'merge feature-3'),
  c('D2', ['D1'], 'feature-4'),
  c('M7', ['M6', 'B2'], 'merge feature-2'),
  c('C2', ['C1'], 'feature-3'),
  c('M6', ['M5', 'A2'], 'merge feature-1'),
  c('B2', ['B1'], 'feature-2'),
  c('D1', ['M4'], 'feature-4'),
  c('A2', ['A1'], 'feature-1'),
  c('C1', ['M3'], 'feature-3'),
  c('M5', ['M4'], 'main'),
  c('B1', ['M2'], 'feature-2'),
  c('M4', ['M3'], 'main'),
  c('A1', ['M1'], 'feature-1'),
  c('M3', ['M2'], 'main'),
  c('M2', ['M1'], 'main'),
  c('M1', [], 'main'),
]
export const wideRefs: Ref[] = [{ name: 'main', hash: 'M9', kind: 'branch' }]
export const wideMerges = ['M9', 'M8', 'M7', 'M6']

/**
 * GitGoose's own picture: the trunk pinned left whatever is checked out, HEAD's lane next to it
 * with the uncommitted changes as a dashed node at the top, a stash beside the commit it was made
 * on, remote and local main sharing a pill. `head` is which branch is checked out.
 */
export function goose(head: 'main' | 'feature'): { commits: Commit[]; refs: Ref[]; pin: string[] } {
  const tip = head === 'main' ? 'M5' : 'F3'
  const commits: Commit[] = [
    c('wip', [tip], 'Uncommitted changes', { kind: 'wip' }),
    c('F3', ['F2'], 'Search: ranking'),
    c('M5', ['M4', 'G2'], "Merge 'fix-login'"),
    c('F2', ['F1'], 'Search: index'),
    c('G2', ['G1'], 'Login: handle redirect'),
    c('stash', ['M4'], 'WIP on main: tidy settings', { kind: 'stash' }),
    c('M4', ['M3'], 'Cache user profile'),
    c('G1', ['M3'], 'Login: reproduce the bug'),
    c('F1', ['M2'], 'Search: tokenizer'),
    c('M3', ['M2'], 'Add settings page'),
    c('M2', ['M1'], 'Project skeleton'),
    c('M1', [], 'Initial commit'),
  ]
  const refs: Ref[] = [
    { name: 'HEAD', hash: tip, kind: 'head' },
    { name: 'main', hash: 'M5', kind: 'branch' },
    { name: 'origin/main', hash: 'M5', kind: 'remote' },
    { name: 'search', hash: 'F3', kind: 'branch' },
    { name: 'fix-login', hash: 'G2', kind: 'branch' },
    { name: 'v1.2', hash: 'M4', kind: 'tag' },
  ]
  // the trunk always owns column 0; HEAD's line (the WIP row's first parent) takes the next one
  return { commits, refs, pin: ['M5'] }
}

/** A long history for the viewport figure: main with a side branch merged every few commits. */
export function tall(n = 40): Commit[] {
  const out: Commit[] = []
  // walk from the newest commit down; every fifth commit on main merges a two-commit side branch
  for (let i = n; i >= 1; i--) {
    const merges = i % 5 === 0 && i > 2
    out.push(c(`M${i}`, merges ? [`M${i - 1}`, `S${i}b`] : i > 1 ? [`M${i - 1}`] : [], merges ? `merge side-${i}` : `main ${i}`))
    if (merges) {
      out.push(c(`S${i}b`, [`S${i}a`], `side-${i}`))
      out.push(c(`S${i}a`, [`M${i - 2}`], `side-${i}`))
    }
  }
  return out
}
