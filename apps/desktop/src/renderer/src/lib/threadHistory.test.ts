import type { AiThread } from '@gitgoose/shared'
import { describe, expect, it } from 'vitest'
import { groupThreadsByDay } from './threadHistory'

const thread = (id: string, updatedAt: number): AiThread =>
  ({ id, repoId: 'r', anchor: { kind: 'free' }, title: id, turns: [], createdAt: updatedAt, updatedAt, head: '' })

// Local times, so the test means the same in every time zone.
const now = new Date(2026, 5, 15, 14, 30).getTime()
const at = (month: number, day: number, h = 9, year = 2026) => new Date(year, month, day, h).getTime()

describe('groupThreadsByDay', () => {
  it('groups by the local day of last use: Today, Yesterday, then dates; order is kept', () => {
    const groups = groupThreadsByDay([
      thread('a', at(5, 15, 13)), thread('b', at(5, 15, 8)),
      thread('c', at(5, 14, 23)),
      thread('d', at(5, 3)), thread('e', at(5, 3, 7)),
      thread('f', at(11, 24, 9, 2025)),
    ], now)
    expect(groups.map((g) => [g.label.replace(/\s/g, ' '), g.threads.map((t) => t.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      [new Date(2026, 5, 3).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).replace(/\s/g, ' '), ['d', 'e']],
      [new Date(2025, 11, 24).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).replace(/\s/g, ' '), ['f']],
    ])
  })

  it('midnight is the edge: a minute after is Today, a minute before is Yesterday', () => {
    const groups = groupThreadsByDay([thread('new', new Date(2026, 5, 15, 0, 1).getTime()), thread('old', new Date(2026, 5, 14, 23, 59).getTime())], now)
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday'])
  })

  it('no threads, no groups', () => {
    expect(groupThreadsByDay([], now)).toEqual([])
  })
})
