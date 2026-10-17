import { makeFixture } from '@gitsquid/fixtures'
import { writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { Repo } from './repo'

describe('repro4', () => {
  it('C1 overlapping snapshots leave a stale snapshot and bump refsVersion twice', async () => {
    const r = makeFixture('linear')
    const marker = '/tmp/claude-0/-home-user/c012efc6-3f5e-5bf2-a987-9709980fdb95/scratchpad/marker'
    const repo = await Repo.open(r.dir, { gitPath: '/tmp/claude-0/-home-user/c012efc6-3f5e-5bf2-a987-9709980fdb95/scratchpad/slowgit.sh', env: { ...(r.env() as Record<string, string>), SLOWGIT_MARKER: marker } })
    const v0 = (await repo.snapshot()).refsVersion
    writeFileSync(marker, '')
    const a = repo.snapshot()               // e.g. watcher refresh, reads pre-commit state
    await new Promise((res) => setTimeout(res, 300))
    r.commit('made meanwhile', { 'z.txt': 'z\n' })
    const b = await repo.snapshot()         // e.g. post-operation refresh, reads new state
    const sa = await a
    console.log('C1 v0', v0, 'b.refsVersion', b.refsVersion, 'a.refsVersion', sa.refsVersion,
      'lastSnapshot head', repo.lastSnapshot!.head.hash!.slice(0, 7), 'real HEAD', r.head().slice(0, 7))
  })
})
