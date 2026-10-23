/**
 * One run per key at a time. While `work` for a key is pending, every caller with that key gets
 * the same promise, so three model pickers on screen asking for one agent's models start one
 * load, not three. The entry is dropped when the promise settles (a later call runs again).
 */
export function singleFlight<T>(flights: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
  let run = flights.get(key)
  if (!run) {
    run = work().finally(() => flights.delete(key))
    flights.set(key, run)
  }
  return run
}
