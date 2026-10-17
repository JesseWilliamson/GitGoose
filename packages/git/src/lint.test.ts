import type { FileDiff } from '@gitsquid/shared'
import { describe, expect, it } from 'vitest'
import { addedLines, lintFindings, parseLintOutput, secretFindings } from './lint'

const ROOT = '/work/repo'

describe('linter output', () => {
  it('reads ESLint JSON with paths made relative', () => {
    const json = JSON.stringify([
      { filePath: '/work/repo/src/a.ts', messages: [{ line: 3, endLine: 4, severity: 2, message: "'x' is assigned a value but never used.", ruleId: 'no-unused-vars' }, { line: 9, severity: 1, message: 'Unexpected console statement.', ruleId: 'no-console' }] },
      { filePath: '/work/repo/src/b.ts', messages: [] },
    ])
    expect(parseLintOutput(json, ROOT)).toEqual([
      { path: 'src/a.ts', line: 3, endLine: 4, severity: 'error', message: "'x' is assigned a value but never used.", rule: 'no-unused-vars' },
      { path: 'src/a.ts', line: 9, endLine: undefined, severity: 'warning', message: 'Unexpected console statement.', rule: 'no-console' },
    ])
  })

  it('reads the one-line formats of ESLint unix, ShellCheck, Ruff and plain tools', () => {
    const out = [
      "/work/repo/src/a.js:1:5: 'x' is defined but never used. [Error/no-unused-vars]",
      'run.sh:3:6: warning: Double quote to prevent globbing and word splitting. [SC2086]',
      'tool.py:1:8: F401 [*] `os` imported but unused',
      './notes.md:12: line too long',
      'Found 3 errors.',
      '12:30: not a path',
    ].join('\n')
    expect(parseLintOutput(out, ROOT)).toEqual([
      { path: 'src/a.js', line: 1, severity: 'error', message: "'x' is defined but never used.", rule: 'no-unused-vars' },
      { path: 'run.sh', line: 3, severity: 'warning', message: 'Double quote to prevent globbing and word splitting.', rule: 'SC2086' },
      { path: 'tool.py', line: 1, severity: 'warning', message: '`os` imported but unused', rule: 'F401' },
      { path: 'notes.md', line: 12, severity: 'warning', message: 'line too long', rule: undefined },
    ])
  })
})

const diff = (path: string, newStart: number, lines: [' ' | '+', string][]): FileDiff => {
  let n = newStart
  return {
    path, change: 'modified', binary: false, header: [],
    hunks: [{ oldStart: newStart, oldLines: lines.filter((l) => l[0] === ' ').length, newStart, newLines: lines.length, section: '', lines: lines.map(([kind, text]) => ({ kind, text, newNo: n++ })) }],
  }
}

describe('tool findings', () => {
  it('keeps only lint reports on changed lines, once each', () => {
    const lines = addedLines([diff('src/a.ts', 10, [[' ', 'a'], ['+', 'b'], [' ', 'c']])])
    const msgs = parseLintOutput(['src/a.ts:11:1: bad [Warning/r1]', 'src/a.ts:11:3: bad [Warning/r1]', 'src/a.ts:10:1: on a context line [Error/r2]', 'src/a.ts:40:1: old problem [Error/r2]', 'other.ts:1:1: elsewhere'].join('\n'), ROOT)
    const { findings, outside } = lintFindings(msgs, lines, 'ESLint')
    expect(outside).toBe(3)
    expect(findings).toMatchObject([{ path: 'src/a.ts', startLine: 11, severity: 'minor', source: 'lint', tool: 'ESLint r1', message: 'bad (ESLint: r1)' }])
  })

  it('flags secrets on added lines only, with the right line', () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const f = diff('config.ts', 1, [[' ', 'export const a = 1'], ['+', 'export const b = 2'], ['+', `export const token = "${token}"`]])
    f.hunks[0]!.lines.push({ kind: '-', text: `const old = "${token}"`, oldNo: 3 })
    const found = secretFindings([f])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ path: 'config.ts', startLine: 3, endLine: 3, type: 'security', severity: 'critical', source: 'scan' })
    expect(found[0]!.message).not.toContain(token)
  })
})
