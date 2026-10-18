import { describe, expect, it } from 'vitest'
import { fuzzy, pieces } from './fuzzy'

const score = (q: string, t: string) => fuzzy(q, t)?.score ?? -Infinity

describe('fuzzy', () => {
  it('needs every word, in any order', () => {
    expect(fuzzy('push force', 'Force push (with lease)')).not.toBeNull()
    expect(fuzzy('push rebase', 'Force push (with lease)')).toBeNull()
  })

  it('ranks runs above scattered letters, and word starts above the middle of a word', () => {
    expect(score('branch', 'feature/branch-list')).toBeGreaterThan(score('fbl', 'feature/branch-list'))
    expect(score('list', 'feature/branch-list')).toBeGreaterThan(score('list', 'feature/checklists'))
    expect(score('panel', 'DetailPanel.tsx')).toBeGreaterThan(score('panel', 'xpanelx.tsx'))
  })

  it('ignores letters scattered through the middle of words', () => {
    expect(fuzzy('fetch', 'Save a snapshot of the working tree (changes stay)')).toBeNull()
    expect(fuzzy('fbl', 'feature/branch-list')).not.toBeNull()
  })

  it('puts exact and shorter matches first', () => {
    expect(score('main', 'main')).toBeGreaterThan(score('main', 'maintenance'))
    expect(score('main', 'origin/main')).toBeGreaterThan(score('main', 'origin/feature/main-menu-rework-2024'))
  })

  it('reports what matched, merged, for highlighting', () => {
    expect(fuzzy('push', 'Force push')!.ranges).toEqual([[6, 10]])
    expect(fuzzy('fb', 'feature/branch')!.ranges).toEqual([[0, 1], [8, 9]])
    expect(pieces('Force push', [[6, 10]])).toEqual([{ text: 'Force ', hit: false }, { text: 'push', hit: true }])
  })
})
