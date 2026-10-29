import type { FileDiff, StreamFile } from '@gitgoose/shared'
import { describe, expect, it } from 'vitest'
import { buildStream, cellsFor, fileKey, roomFor, rowAt, rowHeight, viewedKey, type StreamBlock, type StreamRoom } from './stream'

// About 1106 px of reader at 7.2 px a cell: about 68 cells a half, 140 unified.
const ROOM: StreamRoom = { width: 1106, charPx: 7.2, screenRows: 41, tabSize: 4 }

function file(path: string, lines: [' ' | '+' | '-', string][], extra: Partial<StreamFile> = {}): StreamFile {
  const adds = lines.filter(([k]) => k === '+').length
  const dels = lines.filter(([k]) => k === '-').length
  const diff: FileDiff = {
    path, change: 'modified', binary: false, header: [`diff --git a/${path} b/${path}`, 'index 1a2b3c4..5d6e7f8 100644'],
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, section: '', lines: lines.map(([kind, text]) => ({ kind, text })) }],
  }
  return { path, change: 'modified', additions: adds, deletions: dels, binary: false, diff, ...extra }
}

const block = (files: StreamFile[] | null, key = 'c1'): StreamBlock => ({ key, target: { kind: 'commit', hash: key }, hash: key, title: 's', files })
const kinds = (rows: { kind: string }[]) => rows.map((r) => r.kind)

describe('buildStream', () => {
  it('flows a one-sided file: left column then right, half the rows', () => {
    const f = file('a.ts', Array.from({ length: 5 }, (_, i) => ['+', `line ${i}`] as ['+', string]), { change: 'added' })
    const s = buildStream([block([f])], ROOM, new Map())
    expect(kinds(s.rows)).toEqual(['block', 'file', 'flow', 'flow', 'flow'])
    expect(s.rows.slice(2).map((r) => r.kind === 'flow' && [r.left, r.right])).toEqual([[0, 3], [1, 4], [2, null]])
    expect(s.layouts.get(fileKey(block([f]), f))!.layout).toBe('flow')
  })

  it('splits a modified file that fits, pairing removed with added lines', () => {
    const f = file('m.ts', [[' ', 'a'], ['-', 'b'], ['+', 'B'], ['+', 'C']])
    const s = buildStream([block([f])], ROOM, new Map())
    expect(kinds(s.rows)).toEqual(['block', 'file', 'hunk', 'split', 'split', 'split'])
    expect(s.rows.slice(3).map((r) => r.kind === 'split' && [r.left, r.right])).toEqual([[0, 0], [1, 2], [null, 3]])
  })

  it('keeps the working copy unified (line staging), and wraps a long line to the rows it needs', () => {
    const f = file('w.ts', [['-', 'x'], ['+', 'y'.repeat(300)]])
    const b: StreamBlock = { key: 'u', target: { kind: 'unstaged' }, title: 'Unstaged', files: [f] }
    const s = buildStream([b], ROOM, new Map())
    expect(kinds(s.rows)).toEqual(['block', 'file', 'hunk', 'line', 'line'])
    expect(s.rows.map((r) => (r.kind === 'line' ? r.wrap : 0))).toEqual([0, 0, 0, 1, 3])
    expect(rowHeight(s.rows[4]!, 19, 24)).toBe(57)
  })

  it('collapses generated and huge files unless opened, and keeps room for diffs not loaded yet', () => {
    const lock = file('pnpm-lock.yaml', [['+', 'x']])
    const later: StreamFile = { path: 'later.ts', change: 'modified', additions: 10, deletions: 2, binary: false }
    const b = block([lock, later])
    const s = buildStream([b], ROOM, new Map())
    expect(kinds(s.rows)).toEqual(['block', 'file', 'collapsed', 'file', 'pending'])
    expect(s.rows[4]).toMatchObject({ lines: 15 })
    const opened = buildStream([b], ROOM, new Map([[fileKey(b, lock), { open: true }]]))
    expect(kinds(opened.rows).slice(0, 4)).toEqual(['block', 'file', 'flow', 'file'])
  })

  it('a block whose files have not arrived is one loading row; the end card closes the stream', () => {
    const s = buildStream([block([file('a', [['-', 'b'], ['+', 'a']])], 'c1'), block(null, 'c2')], ROOM, new Map(), { endCard: true })
    expect(kinds(s.rows)).toEqual(['block', 'file', 'hunk', 'split', 'block', 'block-loading', 'end'])
    expect(s.blockStart).toEqual([0, 4])
  })

  it('honours a forced layout from the header chip', () => {
    const f = file('m.ts', [['-', 'b'], ['+', 'B']])
    const b = block([f])
    const s = buildStream([b], ROOM, new Map([[fileKey(b, f), { forced: 'unified' }]]))
    expect(kinds(s.rows)).toEqual(['block', 'file', 'hunk', 'line', 'line'])
  })
})

describe('helpers', () => {
  it('viewedKey is the blob pair when the header has it', () => {
    expect(viewedKey(file('a.ts', [['+', 'x']]))).toBe('a.ts@1a2b3c4..5d6e7f8')
    expect(viewedKey({ path: 'b', change: 'added', additions: 1, deletions: 0, binary: false })).toBe('b@added:1:0')
  })
  it('rowAt finds the row under a y', () => {
    expect([0, 5, 10, 15, 30].map((y) => rowAt([0, 10, 20, 30], y))).toEqual([0, 0, 1, 1, 3])
  })
  it('a 1106 px reader at 7.2 px a cell: two columns of about 70 cells, a little less for long files', () => {
    const r = roomFor(1106, 784, 7.2, 19, 4)
    expect(r.screenRows).toBe(41)
    expect(cellsFor(r, 2).flowColumn).toBe(71)
    expect(cellsFor(r, 4).flowColumn).toBe(69)
    expect(cellsFor(r, 2).unified).toBe(142)
  })
})
