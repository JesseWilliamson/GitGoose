import { initRepo } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { GitRunner } from './runner'

describe('GitRunner stdin', () => {
  it('survives git exiting before it reads its input (EPIPE is not an unhandled error)', async () => {
    const r = initRepo()
    const unhandled: unknown[] = []
    const note = (e: unknown) => unhandled.push(e)
    process.on('uncaughtException', note)
    process.on('unhandledRejection', note)
    try {
      const runner = new GitRunner({ cwd: r.dir })
      // `rev-parse --git-dir` never reads stdin and exits at once; 8 MB cannot fit in the pipe.
      const big = 'x'.repeat(8 * 1024 * 1024)
      for (let i = 0; i < 5; i++) {
        const res = await runner.run(['rev-parse', '--git-dir'], { input: big, readOnly: true })
        expect(res.code).toBe(0)
        expect(res.stdout.trim()).toBe('.git')
      }
      // A failing command still reports its own exit code, not the broken pipe.
      await expect(runner.run(['rev-parse', '--verify', 'no-such-ref'], { input: big, readOnly: true })).rejects.toMatchObject({ exitCode: expect.any(Number) })
      await new Promise((res) => setTimeout(res, 50))
    } finally {
      process.off('uncaughtException', note)
      process.off('unhandledRejection', note)
    }
    expect(unhandled).toEqual([])
  })
})
