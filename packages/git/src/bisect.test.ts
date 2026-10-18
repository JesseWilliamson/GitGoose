import { initRepo } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'

describe('bisect', () => {
  it('narrows down to the first bad commit, then resets to where it started', async () => {
    const r = initRepo()
    const hashes: string[] = []
    // c5 introduces the "bug": value.txt becomes bad from there on.
    for (let i = 1; i <= 8; i++) hashes.push(r.commit(`c${i}`, { 'value.txt': i >= 5 ? 'bad\n' : 'good\n' }))
    const repo = await Repo.open(r.dir, {})
    expect((await repo.snapshot()).bisect).toBeUndefined()

    await repo.bisectMark(hashes[7]!, 'bad')
    let st = (await repo.snapshot()).bisect!
    expect(st).toEqual({ bad: hashes[7], good: [], skipped: [] })
    await repo.bisectMark(hashes[0]!, 'good')

    // Test whatever git checked out, the way a person would, until it is found.
    for (let guard = 0; guard < 10; guard++) {
      st = (await repo.snapshot()).bisect!
      if (st.found) break
      expect(st.remaining).toBeGreaterThanOrEqual(0)
      const bad = r.git('show', 'HEAD:value.txt') === 'bad\n'
      await repo.bisectMark('HEAD', bad ? 'bad' : 'good')
    }
    expect(st.found).toBe(hashes[4])

    await repo.bisectReset()
    const after = await repo.snapshot()
    expect(after.bisect).toBeUndefined()
    expect(after.head.branch).toBe('main')
    expect(after.head.hash).toBe(hashes[7])
    repo.dispose()
  })
})
