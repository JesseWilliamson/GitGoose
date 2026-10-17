import { describe, expect, it } from 'vitest'
import { parseQuery, rankAll, rankEntries, type OmniEntry } from './omni'

const cmd = (title: string): OmniEntry => ({ kind: 'command', key: title, title })
const branch = (title: string, sub = 'local'): OmniEntry => ({ kind: 'branch', key: `refs/heads/${title}`, title, sub })

describe('omni ranking', () => {
  it('puts the group with the best answer first', () => {
    const sources = { command: [cmd('Push'), cmd('Pull'), cmd('New branch')], branch: [branch('main'), branch('push-notifications')] }
    expect(rankAll('push', sources, 'all').map((g) => [g.kind, g.results[0]!.title])).toEqual([['command', 'Push'], ['branch', 'push-notifications']])
    expect(rankAll('main', sources, 'all')[0]!.kind).toBe('branch')
  })

  it('prefers branches to settings and files that match as well', () => {
    const sources = { setting: [{ kind: 'setting' as const, key: 's', title: 'Layout' }], branch: [branch('layout')] }
    expect(rankAll('layout', sources, 'all').map((g) => g.kind)).toEqual(['branch', 'setting'])
  })

  it('finds by the second line too, highlighting only the title', () => {
    const r = rankEntries('origin topic', [branch('topic', 'origin')], 10).results[0]!
    expect(r.ranges).toEqual([[0, 5]])
  })

  it('limits each group when searching everything, and says how many matched', () => {
    const many = Array.from({ length: 30 }, (_, i) => branch(`feature/x-${i}`))
    const g = rankAll('feature', { branch: many }, 'all')[0]!
    expect(g.results).toHaveLength(6)
    expect(g.total).toBe(30)
    expect(rankAll('feature', { branch: many }, 'branch')[0]!.results).toHaveLength(30)
  })

  it('keeps the source order without a query, and only shows what the scope covers', () => {
    const sources = { command: [cmd('Fetch'), cmd('Pull')], branch: [branch('b'), branch('a')] }
    expect(rankAll('', sources, 'all').map((g) => g.results.map((r) => r.title))).toEqual([['Fetch', 'Pull'], ['b', 'a']])
    expect(rankAll('', sources, 'command').map((g) => g.kind)).toEqual(['command'])
  })

  it('reads ">" as "commands only"', () => {
    expect(parseQuery('> pull', 'all')).toEqual({ query: 'pull', scope: 'command' })
    expect(parseQuery('pull', 'file')).toEqual({ query: 'pull', scope: 'file' })
  })
})
