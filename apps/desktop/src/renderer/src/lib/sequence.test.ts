import { describe, expect, it } from 'vitest'
import { layoutSequence } from './sequence'

describe('sequence diagram layout', () => {
  it('puts participants in columns and messages in rows; long labels widen their gap', () => {
    const l = layoutSequence({ participants: ['UI', 'Store', 'API'], messages: [
      { from: 'UI', to: 'Store', label: 'add' },
      { from: 'Store', to: 'API', label: 'POST /cart/items with a long explanation' },
      { from: 'Store', to: 'Store', label: 'recount' },
    ] })
    const [ui, store, api] = l.participants.map((p) => p.x)
    // UI to Store: just the minimum (the self message on Store widens Store→API, not this).
    expect(store! - ui!).toBe(130)
    expect(api! - store!).toBeGreaterThanOrEqual('POST /cart/items with a long explanation'.length * 6.5 + 24)
    expect(l.messages.map((m) => [m.self, m.y])).toEqual([[false, 76], [false, 112], [true, 148]])
    expect(l.width).toBeGreaterThan(api!)
    expect(l.height).toBe(20 + 32 + 24 + 3 * 36 + 8)
  })
})
