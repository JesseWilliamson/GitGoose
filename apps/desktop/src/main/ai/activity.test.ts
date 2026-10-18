import type { AiActivity } from '@gitsquid/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityTracker } from './activity'

describe('ActivityTracker', () => {
  let sent: AiActivity[]
  let t: ActivityTracker
  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    t = new ActivityTracker((a) => sent.push(a), 100)
  })
  afterEach(() => vi.useRealTimers())

  it('sends its own steps at once, and batches what streams in', () => {
    t.step('Gathering context')
    expect(sent.map((a) => a.step)).toEqual(['Gathering context'])
    for (let i = 1; i <= 50; i++) t.thought('x'.repeat(i))
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(100)
    // Fifty chunks, one message, with the latest state.
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ step: 'Thinking', thought: 'x'.repeat(50) })
  })

  it('keeps only the end of long thinking', () => {
    t.thought('a'.repeat(5000) + 'the end')
    vi.advanceTimersByTime(100)
    expect(sent[0]!.thought.endsWith('the end')).toBe(true)
    expect(sent[0]!.thought.length).toBeLessThan(2100)
  })

  it('merges tool updates by id; the step follows the tool at work', () => {
    t.tool('a', 'Read src/total.ts', 'in_progress')
    vi.advanceTimersByTime(100)
    expect(sent.at(-1)).toMatchObject({ step: 'Read src/total.ts', tools: [{ id: 'a', title: 'Read src/total.ts', status: 'in_progress' }] })
    t.tool('a', undefined, 'completed')
    vi.advanceTimersByTime(100)
    expect(sent.at(-1)).toMatchObject({ step: 'Thinking', tools: [{ id: 'a', title: 'Read src/total.ts', status: 'completed' }] })
  })

  it('counts what has been written, and says nothing once closed', () => {
    t.writing(1200)
    vi.advanceTimersByTime(100)
    expect(sent.at(-1)).toMatchObject({ step: 'Writing the answer', chars: 1200 })
    t.writing(1300)
    t.close()
    vi.advanceTimersByTime(1000)
    t.step('late')
    expect(sent.at(-1)!.chars).toBe(1200)
  })
})
