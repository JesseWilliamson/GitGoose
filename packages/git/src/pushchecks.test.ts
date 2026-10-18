import { makeFixture } from '@gitgoose/fixtures'
import { describe, expect, it } from 'vitest'
import { pushCheckOutcome, secretPushCheck, verifyPushChecks } from './pushchecks'
import { Repo } from './repo'
import { reviewableLines } from './review'
import { parseCustomChecks } from './reviewrules'

describe('pre-push checks', () => {
  it('reads custom_checks from a .coderabbit.yaml, leaving out the ones turned off', () => {
    const yaml = [
      'reviews:',
      '  path_instructions:',
      '    - path: "src/**"',
      '      instructions: "ignored here"',
      '  pre_merge_checks:',
      '    custom_checks:',
      '      - name: "No debug logging"',
      '        mode: error',
      '        instructions: |',
      '          No console.log calls in src/.',
      '          Logging goes through logger.ts.',
      '      - mode: warning',
      '        name: Changelog',
      '        instructions: >',
      '          User-facing changes add a line',
      '          to CHANGELOG.md.',
      '      - name: Old rule',
      '        mode: off',
      '        instructions: never mind',
      'chat:',
      '  auto_reply: true',
    ].join('\n')
    expect(parseCustomChecks(yaml)).toEqual([
      { name: 'No debug logging', mode: 'block', instructions: 'No console.log calls in src/.\nLogging goes through logger.ts.' },
      { name: 'Changelog', mode: 'warn', instructions: 'User-facing changes add a line to CHANGELOG.md.' },
    ])
    expect(parseCustomChecks('reviews:\n  profile: chill\n')).toEqual([])
  })

  it('gives every check one verdict, and does not believe failures about lines it was not shown', () => {
    const checks = (['A', 'B', 'C', 'D', 'E'] as const).map((name) => ({ name, instructions: '…', mode: 'block' as const, source: 'settings' as const }))
    const lines = new Map([['src/a.ts', [{ start: 10, end: 14 }]]])
    const raw = {
      results: [
        { id: 'C1', verdict: 'pass', reason: 'Fine.' },
        { id: 'C2', verdict: 'fail', reason: 'Logs.', evidence: [{ path: 'src/a.ts', line: 12 }, { path: 'src/a.ts', line: 90 }] },
        { id: 'C2', verdict: 'pass', reason: 'second answer for C2 is ignored' },
        { id: 'C3', verdict: 'fail', reason: 'Somewhere else.', evidence: [{ path: 'src/other.ts', line: 1 }] },
        { id: 'C4', verdict: 'maybe' },
        { id: 'C9', verdict: 'fail', reason: 'not a check we sent' },
      ],
    }
    const out = verifyPushChecks(raw, checks, lines)
    expect(out.map((r) => [r.name, r.verdict])).toEqual([['A', 'pass'], ['B', 'fail'], ['C', 'inconclusive'], ['D', 'inconclusive'], ['E', 'inconclusive']])
    expect(out[1]!.evidence).toEqual([{ path: 'src/a.ts', line: 12 }])
    expect(out[2]!.reason).toContain('pointed only at lines that are not in this push')
    expect(out[4]!.reason).toBe('The AI did not answer for this check.')
    // Garbage in: still one (inconclusive) verdict per check, never a pass.
    expect(verifyPushChecks('not json', checks, lines).every((r) => r.verdict === 'inconclusive')).toBe(true)
  })

  it('blocks only on a blocking failure; warns on other failures and on blocking checks it could not judge', () => {
    const r = (mode: 'warn' | 'block', verdict: 'pass' | 'fail' | 'inconclusive') => ({ name: 'x', mode, source: 'settings' as const, verdict, reason: '', evidence: [] })
    expect(pushCheckOutcome([r('block', 'pass'), r('warn', 'inconclusive')])).toBe('go')
    expect(pushCheckOutcome([r('warn', 'fail')])).toBe('warn')
    expect(pushCheckOutcome([r('block', 'inconclusive')])).toBe('warn')
    expect(pushCheckOutcome([r('warn', 'fail'), r('block', 'fail')])).toBe('block')
  })

  it('finds what a push would send, with or without an upstream, and scans it for secrets', async () => {
    const r = makeFixture('with-remote')
    const repo = await Repo.open(r.dir, {})
    // The fixture starts one commit ahead of origin/main.
    expect((await repo.outgoing()).commits.map((c) => c.subject)).toEqual(['local only'])
    r.git('push', '-q')
    expect(await repo.outgoing()).toMatchObject({ commits: [], label: '' })
    r.commit('feat: one', { 'a.txt': 'one\n' })
    r.commit('feat: two\n\nWith a body.', { 'b.ts': `const k = "${'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}"\n` })
    const out = await repo.outgoing()
    expect(out.commits.map((c) => [c.subject, c.body])).toEqual([['feat: two', 'With a body.'], ['feat: one', '']])
    expect(out.label).toBe('2 commits to origin/main')
    const input = await repo.reviewInput({ kind: 'outgoing' })
    expect(input.files.map((f) => f.path)).toEqual(['a.txt', 'b.ts'])
    expect(secretPushCheck(input.files)).toMatchObject({ verdict: 'fail', mode: 'block', evidence: [{ path: 'b.ts', line: 1 }] })
    expect(reviewableLines(input.files).get('a.txt')).toEqual([{ start: 1, end: 1 }])

    // A new branch with no upstream: the commits no remote has.
    r.git('checkout', '-q', '-b', 'topic')
    r.commit('topic work', { 'c.txt': 'c\n' })
    const topic = await repo.outgoing()
    expect(topic.commits.map((c) => c.subject)).toEqual(['topic work', 'feat: two', 'feat: one'])
    expect(topic.label).toBe('3 commits to a new remote branch')
    repo.dispose()
  })
})
