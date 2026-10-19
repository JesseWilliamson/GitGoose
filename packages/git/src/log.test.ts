import { makeFixture } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { GRAPH_REVS, LogStream, orderFlag } from './log'
import { GitRunner } from './runner'
import { searchLog } from './search'

describe('LogStream order', () => {
  it('maps the commit order setting to git’s flag', () => {
    expect(orderFlag('date')).toBe('--date-order')
    expect(orderFlag('topo')).toBe('--topo-order')
  })

  // The command log records every git process the runner starts, so the argv is read from there:
  // the real git ran with it (no mocks).
  for (const [order, flag] of [['date', '--date-order'], ['topo', '--topo-order']] as const) {
    it(`walks with ${flag} in ${order} order`, async () => {
      const r = makeFixture('branches')
      const runner = new GitRunner({ cwd: r.dir })
      const log = new LogStream(runner, GRAPH_REVS, undefined, [], order)
      const { commits } = await log.page(0, 100)
      log.dispose()
      expect(commits).toHaveLength(7)
      const args = runner.history.find((c) => c.args[0] === 'log')!.args
      expect(args[1]).toBe(flag)
      expect(args).not.toContain(order === 'topo' ? '--date-order' : '--topo-order')
    })
  }

  it('defaults to date order', async () => {
    const r = makeFixture('linear')
    const runner = new GitRunner({ cwd: r.dir })
    const log = new LogStream(runner)
    await log.page(0, 10)
    log.dispose()
    expect(runner.history.find((c) => c.args[0] === 'log')!.args).toContain('--date-order')
  })

  it('search walks in the same order as the graph, so its hits step through it top to bottom', async () => {
    const r = makeFixture('branches')
    const runner = new GitRunner({ cwd: r.dir })
    expect(await searchLog(runner, GRAPH_REVS, 'F', { order: 'topo' })).toEqual([r.git('rev-parse', 'wip').trim()])
    expect(runner.history.find((c) => c.args[0] === 'log')!.args[1]).toBe('--topo-order')
  })
})
