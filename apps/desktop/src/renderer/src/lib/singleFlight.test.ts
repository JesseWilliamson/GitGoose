import { describe, expect, it } from 'vitest'
import { singleFlight } from './singleFlight'

describe('singleFlight', () => {
  it('shares one run between callers with the same key, and runs again once it has settled', async () => {
    const flights = new Map<string, Promise<number>>()
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const work = async () => (await gate, ++runs)
    const a = singleFlight(flights, 'agent:x', work)
    const b = singleFlight(flights, 'agent:x', work)
    const other = singleFlight(flights, 'agent:y', work)
    expect(b).toBe(a)
    expect(other).not.toBe(a)
    release()
    expect(await a).toBe(await b)
    await other
    expect(runs).toBe(2)
    expect(flights.size).toBe(0)
    expect(await singleFlight(flights, 'agent:x', work)).toBe(3)
  })

  it('does not keep a failed run', async () => {
    const flights = new Map<string, Promise<number>>()
    await expect(singleFlight(flights, 'k', () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    expect(await singleFlight(flights, 'k', async () => 1)).toBe(1)
  })
})
