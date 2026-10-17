import { initRepo } from '@gitsquid/fixtures'
import { describe, expect, it } from 'vitest'
import { Repo } from './repo'
import { carryOver, hunkKey, numberedDiff, onlyChanged, reviewableLines, verifyFindings } from './review'

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

  it('applies a suggestion only to the lines as reviewed, and writes fixes only over the expected text; both undoable', async () => {
    const r = setup()
    const repo = await Repo.open(r.dir, {})
    const original = ['  const t = price * count', '  return t']
    const id = await repo.applySuggestion('src/price.ts', 2, 3, original, '  return price * count')
    expect(await repo.workingText('src/price.ts')).toBe('export function total(price: number, count: number): number {\n  return price * count\n}\n')
    await expect(repo.applySuggestion('src/price.ts', 2, 3, original, 'x')).rejects.toThrow(/changed since the review/)
    await repo.undo(id)
    expect(await repo.workingText('src/price.ts')).toContain('const t = price * count')

    const before = (await repo.workingText('src/price.ts'))!
    await expect(repo.writeFileChecked('src/price.ts', 'something else', 'new', 'Fix')).rejects.toThrow(/changed since/)
    const w = await repo.writeFileChecked('src/price.ts', before, 'fixed\n', 'Fix')
    expect(await repo.workingText('src/price.ts')).toBe('fixed\n')
    await repo.undo(w)
    expect(await repo.workingText('src/price.ts')).toBe(before)
    repo.dispose()
  })

  it('re-reviews: unchanged hunks are skipped, findings follow their lines or count as addressed', async () => {
    const r = initRepo()
    r.commit('root', { 'a.ts': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n' })
    r.write('a.ts', 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n')
    const repo = await Repo.open(r.dir, {})
    const first = await repo.reviewInput({ kind: 'working' })
    const keys = first.files.flatMap((f) => f.hunks.map((h) => hunkKey(f.path, h)))
    expect(keys).toHaveLength(2)
    const findings = [
      { id: 'F1', path: 'a.ts', startLine: 1, endLine: 1, type: 'style' as const, severity: 'nit' as const, title: 'Shouting', message: 'm', original: ['ONE'] },
      { id: 'F2', path: 'a.ts', startLine: 10, endLine: 10, type: 'style' as const, severity: 'nit' as const, title: 'Shouting too', message: 'm', original: ['TEN'] },
    ]
    // Edit: a line inserted at the top (shifts everything) and TEN fixed.
    r.write('a.ts', 'zero\nONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n')
    const again = await repo.reviewInput({ kind: 'working' })
    const { files, unchanged } = onlyChanged(again.files, new Set(keys))
    expect(unchanged).toBe(0) // the first hunk changed too (it gained "zero")
    expect(files.map((f) => f.hunks.length)).toEqual([1])
    const c = carryOver(findings, (p) => again.texts.get(p) ?? null)
    expect(c.open.map((f) => [f.title, f.startLine, f.status])).toEqual([['Shouting', 2, 'open']])
    expect(c.addressed.map((f) => f.title)).toEqual(['Shouting too'])

    // Nothing changed at all: everything is skipped.
    const same = await repo.reviewInput({ kind: 'working' })
    const sameKeys = same.files.flatMap((f) => f.hunks.map((h) => hunkKey(f.path, h)))
    expect(onlyChanged(same.files, new Set(sameKeys))).toMatchObject({ files: [], unchanged: sameKeys.length })
    repo.dispose()
  })
})
