import { describe, expect, it } from 'vitest'
import type { DiffTarget } from '@gitgoose/shared'
import { belongsTo, isShown, ownerOf, shownFile } from './openFile'
import type { Selection } from './store'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const inA: DiffTarget = { kind: 'commit', hash: A, path: 'x.ts' }
const staged: DiffTarget = { kind: 'staged', path: 'x.ts' }
const range: DiffTarget = { kind: 'range', from: A, to: B, path: 'x.ts' }
const wip: Selection = { kind: 'wip' }
const commitA: Selection = { kind: 'commit', hash: A }
const commitB: Selection = { kind: 'commit', hash: B }

describe('belongsTo', () => {
  it('ties a commit\'s file to that commit, or to a selection of commits that includes it', () => {
    expect(belongsTo(inA, commitA)).toBe(true)
    expect(belongsTo(inA, commitB)).toBe(false)
    expect(belongsTo(inA, { kind: 'commits', hashes: [B, A], anchor: B, cursor: A })).toBe(true)
    expect(belongsTo(inA, wip)).toBe(false)
  })

  it('ties working-copy files to the working copy', () => {
    expect(belongsTo(staged, wip)).toBe(true)
    expect(belongsTo({ kind: 'untracked', path: 'n' }, wip)).toBe(true)
    expect(belongsTo(staged, commitA)).toBe(false)
  })

  it('ties a range to the same comparison, or to consecutive commits it ends at', () => {
    expect(belongsTo(range, { kind: 'compare', from: A, to: B, fromLabel: '', toLabel: '' })).toBe(true)
    expect(belongsTo(range, { kind: 'compare', from: A, to: null, fromLabel: '', toLabel: '' })).toBe(false)
    expect(belongsTo(range, { kind: 'commits', hashes: [B], anchor: B, cursor: B })).toBe(true)
    expect(belongsTo(range, commitB)).toBe(false)
  })
})

describe('ownerOf', () => {
  it('keeps the selection when the file already belongs to it', () => {
    const sel: Selection = { kind: 'commits', hashes: [B, A], anchor: B, cursor: A }
    expect(ownerOf(inA, sel)).toBe(sel)
  })

  it('selects what the file belongs to otherwise', () => {
    expect(ownerOf(inA, commitB)).toEqual(commitA)
    expect(ownerOf(staged, commitA)).toEqual(wip)
    expect(ownerOf(range, wip)).toEqual({ kind: 'compare', from: A, to: B, fromLabel: A.slice(0, 7), toLabel: B.slice(0, 7) })
    expect(ownerOf({ kind: 'range', from: 'HEAD', to: null, path: 'x' }, wip)).toMatchObject({ fromLabel: 'HEAD', toLabel: 'working tree' })
  })
})

describe('shownFile', () => {
  const first: DiffTarget = { kind: 'commit', hash: B, path: 'first.ts' }

  it('shows the open file while it belongs to the selection', () => {
    expect(shownFile({ file: { target: inA, mode: 'blame' }, selected: commitA }, null)).toEqual({ target: inA, mode: 'blame' })
  })

  it('falls back to the selection\'s first file once the selection moves on, without forgetting the open one', () => {
    const view = { file: { target: inA, mode: 'diff' as const }, selected: commitB }
    expect(shownFile(view, first)).toEqual({ target: first, mode: 'diff' })
    expect(isShown(view, first, first)).toBe(true)
    expect(isShown(view, first, inA)).toBe(false)
    // Back on A, the file you were reading is there again.
    expect(shownFile({ ...view, selected: commitA }, null)?.target).toBe(inA)
  })

  it('shows nothing when nothing is open and the selection has no files', () => {
    expect(shownFile({ file: null, selected: wip }, null)).toBeNull()
  })
})
