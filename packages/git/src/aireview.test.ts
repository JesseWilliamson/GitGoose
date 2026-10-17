import { initRepo } from '@gitsquid/fixtures'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'
import { numberedDiff, reviewableLines, verifyFindings } from './review'

function setup() {
  const r = initRepo()
  r.commit('root', { 'src/price.ts': 'export function total(price: number, count: number): number {\n  return price * count\n}\n', 'README.md': 'hi\n' })
  r.write('src/price.ts', 'export function total(price: number, count: number): number {\n  const t = price * count\n  return t\n}\n')
  return r
}

describe('review input and verification', () => {
  it('numbers new-side lines, marks removed ones, and says which function a hunk is in', async () => {
    const r = setup()
    const repo = await Repo.open(r.dir, {})
    const input = await repo.reviewInput({ kind: 'working' })
    expect(input).toMatchObject({ label: 'Uncommitted changes', head: 'worktree', skipped: [] })
    const text = numberedDiff(input.files, (p) => input.texts.get(p) ?? null)
    expect(text).toContain('=== src/price.ts (modified) ===')
    expect(text).toContain('@@ lines 1-4, in function total (lines 1-4) @@')
    expect(text).toContain('    2+|   const t = price * count')
    expect(text).toContain('     -|   return price * count')
    expect(reviewableLines(input.files).get('src/price.ts')).toEqual([{ start: 1, end: 4 }])
    repo.dispose()
  })

  it('keeps findings on changed lines and drops the rest, saying why', async () => {
    const r = setup()
    const repo = await Repo.open(r.dir, {})
    const input = await repo.reviewInput({ kind: 'working' })
    const lines = reviewableLines(input.files)
    const text = (p: string) => input.texts.get(p) ?? null
    const answer = {
      summary: 'Introduces a temporary.',
      findings: [
        { path: 'src/price.ts', startLine: 2, endLine: 3, type: 'maintainability', severity: 'minor', title: 'Needless temporary', message: 'Return the product directly.', suggestion: '  return price * count' },
        { path: 'src/price.ts', startLine: 2, endLine: 2, type: 'style', severity: 'nit', title: 'Name', message: 'Call it subtotal.' },
        { path: 'src/other.ts', startLine: 1, endLine: 1, type: 'bug', severity: 'major', title: 'Invented', message: 'Not in the diff.' },
        { path: 'src/price.ts', startLine: 40, endLine: 41, type: 'bug', severity: 'major', title: 'Far away', message: 'Outside the change.' },
        { path: 'src/price.ts', startLine: 2, endLine: 2, type: 'bug', severity: 'apocalyptic', title: 'Odd', message: 'Unknown severity.' },
        { path: 'src/price.ts', startLine: 2, endLine: 3, type: 'maintainability', severity: 'minor', title: 'Needless temporary', message: 'Duplicate.' },
      ],
    }
    const v = verifyFindings(answer, lines, text, 'assertive')
    expect(v.summary).toBe('Introduces a temporary.')
    expect(v.findings.map((f) => f.title)).toEqual(['Needless temporary', 'Name'])
    expect(v.findings[0]).toMatchObject({ id: 'F1', original: ['  const t = price * count', '  return t'], suggestion: '  return price * count' })
    expect(v.dropped).toEqual([
      { title: 'Invented', reason: 'src/other.ts is not in this change' },
      { title: 'Far away', reason: 'lines 40-41 of src/price.ts are not part of the change' },
      { title: 'Odd', reason: 'unknown severity or type' },
    ])
    // Profiles filter too: chill drops nits and style; quiet keeps only serious bugs.
    expect(verifyFindings(answer, lines, text, 'chill').findings.map((f) => f.title)).toEqual(['Needless temporary'])
    expect(verifyFindings(answer, lines, text, 'quiet').findings).toEqual([])
    expect(verifyFindings('nonsense', lines, text, 'chill')).toEqual({ summary: '', findings: [], dropped: [] })
    repo.dispose()
  })

  it('covers staged changes, a branch since it forked, and a run of commits', async () => {
    const r = initRepo()
    r.commit('root', { 'a.txt': 'a\n' })
    r.git('checkout', '-q', '-b', 'feature')
    const c1 = r.commit('one', { 'b.txt': 'b\n' })
    const c2 = r.commit('two', { 'c.txt': 'c\n' })
    r.checkout('main')
    r.commit('main moves', { 'm.txt': 'm\n' })
    r.write('a.txt', 'staged\n')
    r.git('add', 'a.txt')
    const repo = await Repo.open(r.dir, {})
    const paths = async (s: Parameters<Repo['reviewInput']>[0]) => (await repo.reviewInput(s)).files.map((f) => f.path)
    expect(await paths({ kind: 'staged' })).toEqual(['a.txt'])
    const br = await repo.reviewInput({ kind: 'branch', branch: 'feature' })
    expect([br.label, br.head, br.files.map((f) => f.path)]).toEqual(['feature since main', c2, ['b.txt', 'c.txt']])
    expect(await paths({ kind: 'commits', hashes: [c2, c1] })).toEqual(['b.txt', 'c.txt'])
    await expect(repo.reviewInput({ kind: 'commits', hashes: [c2, r.head()] })).rejects.toThrow(/follow each other/)
    repo.dispose()
  })
})
