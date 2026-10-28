import { describe, expect, it } from 'vitest'
import type { FileDiff } from './index'
import { chooseLayout, collapseReason, displayColumns, fileShape, type ReaderRoom } from './reader'

const ROOM: ReaderRoom = { flowColumn: 70, splitSide: 68, screenRows: 41 }

function diff(lines: [' ' | '+' | '-', string][]): FileDiff {
  return { path: 'f.ts', change: 'modified', binary: false, header: [], hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, section: '', lines: lines.map(([kind, text]) => ({ kind, text })) }] }
}

describe('displayColumns', () => {
  it('expands tabs to the next stop', () => {
    expect(displayColumns('\tx', 4)).toBe(5)
    expect(displayColumns('ab\tx', 4)).toBe(5)
    expect(displayColumns('ab\tx', 8)).toBe(9)
  })
  it('counts wide glyphs as two cells', () => {
    expect(displayColumns('日本語', 4)).toBe(6)
    expect(displayColumns('a😀b', 4)).toBe(4)
    expect(displayColumns('café', 4)).toBe(4)
  })
})

describe('fileShape', () => {
  it('knows one-sided files and the widest line per side', () => {
    expect(fileShape(diff([['+', 'abc'], ['+', 'abcdef']]))).toMatchObject({ lines: 2, oneSided: 'added', longestNew: 6, longestOld: 0 })
    expect(fileShape(diff([['-', 'x']]))).toMatchObject({ oneSided: 'deleted', longestOld: 1 })
    expect(fileShape(diff([[' ', 'ctx'], ['+', 'abcd']]))).toMatchObject({ oneSided: null, longestOld: 3, longestNew: 4 })
  })
})

describe('chooseLayout', () => {
  const added = (n: number, width: number) => fileShape(diff(Array.from({ length: n }, () => ['+', 'x'.repeat(width)] as ['+', string])))
  it('flows a one-sided file that fits a column, with two to spare', () => {
    expect(chooseLayout(added(65, 64), ROOM)).toEqual({ layout: 'flow', reason: 'longest 64 ≤ 68' })
    expect(chooseLayout(added(65, 68), ROOM).layout).toBe('flow')
    expect(chooseLayout(added(65, 69), ROOM).layout).toBe('unified')
  })
  it('does not flow a file longer than two screens', () => {
    expect(chooseLayout(added(4 * 41, 10), ROOM).layout).toBe('flow')
    expect(chooseLayout(added(4 * 41 + 1, 10), ROOM)).toEqual({ layout: 'unified', reason: 'longer than 2 screens' })
  })
  it('a tab-indented line is measured as it shows, so it can stop fitting', () => {
    const tabbed = fileShape(diff(Array.from({ length: 10 }, () => ['+', '\t\t\t' + 'x'.repeat(58)] as ['+', string])), 4)
    expect(tabbed.longestNew).toBe(70)
    expect(chooseLayout(tabbed, ROOM).layout).toBe('unified')
  })
  it('splits a modified file when its longest line fits a side, else unified', () => {
    const fits = fileShape(diff([[' ', 'x'.repeat(66)], ['-', 'a'], ['+', 'b']]))
    expect(chooseLayout(fits, ROOM)).toEqual({ layout: 'split', reason: 'longest 66 ≤ 66 a side' })
    const long = fileShape(diff([[' ', 'x'.repeat(67)], ['-', 'a'], ['+', 'b']]))
    expect(chooseLayout(long, ROOM).layout).toBe('unified')
  })
  it('honours a forced layout only where it can apply', () => {
    const modified = fileShape(diff([['-', 'a'], ['+', 'b']]))
    expect(chooseLayout(modified, ROOM, 'unified').layout).toBe('unified')
    expect(chooseLayout(modified, ROOM, 'flow').layout).toBe('split')
    expect(chooseLayout(added(3, 200), ROOM, 'flow').layout).toBe('flow')
  })
})

describe('collapseReason', () => {
  const f = (path: string, additions = 1, deletions = 0, extra: object = {}) => ({ path, change: 'modified', additions, deletions, binary: false, ...extra })
  it('collapses generated files, pure renames and very long files', () => {
    expect(collapseReason(f('pnpm-lock.yaml'))).toBe('generated')
    expect(collapseReason(f('web/app.min.js'))).toBe('generated')
    expect(collapseReason(f('b.ts', 0, 0, { change: 'renamed', oldPath: 'a.ts' }))).toBe('renamed from a.ts, unchanged')
    expect(collapseReason(f('big.ts', 2000, 966))).toBe('2,966 lines')
    expect(collapseReason(f('src/app.ts', 40, 2))).toBeNull()
  })
})
