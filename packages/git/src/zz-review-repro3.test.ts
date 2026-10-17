import { makeFixture, type FixtureRepo } from '@gitsquid/fixtures'
import { describe, it } from 'vitest'
import { Repo } from './repo'
const open = (r: FixtureRepo) => Repo.open(r.dir, { env: r.env() as Record<string, string> })

describe('repro3', () => {
  it('U1 Undo after a no-op merge undoes the previous commit', async () => {
    const r = makeFixture('linear')
    const repo = await open(r)
    r.write('n.txt', 'n\n'); await repo.stagePaths(['n.txt'])
    await repo.commit('my commit')
    await repo.merge('refs/heads/main~2'.replace('refs/heads/', '')) // ancestor: "Already up to date"
    const label = await repo.undo() // what the "Merge ..." toast's Undo button calls
    console.log('U1 undid:', label, 'HEAD subject now:', r.git('log', '-1', '--format=%s').trim())
  })
})
