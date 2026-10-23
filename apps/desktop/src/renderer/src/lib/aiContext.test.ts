import type { Ref } from '@gitgoose/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addDropped, chipOf, chipsOf, clearDropped, refKey, removeChip, selectionRef, sourceRef, useContextChips } from './aiContext'
import type { Selection } from './store'

// The store reads window.gitgoose when imported; the chips only need the log's subjects.
vi.mock('./store', () => ({ getLog: () => ({ commits: [{ subject: 'Fix the parser' }], index: new Map([['1'.repeat(40), 0]]) }) }))

const H = (c: string) => c.repeat(40)
const view = (selected: Selection) => ({ id: 'r', selected })
const branch = (name: string, kind: Ref['kind'] = 'local'): Ref => ({ name: `refs/${kind === 'tag' ? 'tags' : 'heads'}/${name}`, shortName: name, kind, hash: H('a') })

beforeEach(() => useContextChips.setState({}, true))

describe('the selection as a reference', () => {
  it.each<[Selection, unknown]>([
    [{ kind: 'commit', hash: H('1') }, { kind: 'commits', hashes: [H('1')] }],
    [{ kind: 'commits', hashes: [H('1'), H('2')], anchor: H('1'), cursor: H('2') }, { kind: 'commits', hashes: [H('1'), H('2')] }],
    [{ kind: 'wip' }, { kind: 'wip' }],
    [{ kind: 'compare', from: H('1'), to: null, fromLabel: 'x', toLabel: 'y' }, { kind: 'compare', from: H('1'), to: null }],
  ])('%o', (sel, ref) => expect(selectionRef(sel)).toEqual(ref))
})

describe('what a drag becomes', () => {
  it('references only: names and hashes, no text', () => {
    expect(sourceRef({ kind: 'ref', ref: branch('topic') })).toEqual({ kind: 'ref', name: 'refs/heads/topic' })
    expect(sourceRef({ kind: 'commits', hashes: [H('1')] })).toEqual({ kind: 'commits', hashes: [H('1')] })
    expect(sourceRef({ kind: 'stash', index: 1, hash: H('9'), ref: 'stash@{1}' })).toEqual({ kind: 'stash', ref: 'stash@{1}', index: 1 })
    expect(sourceRef({ kind: 'files', rev: 'worktree', paths: ['a.ts'], stash: false })).toEqual({ kind: 'files', rev: 'worktree', paths: ['a.ts'] })
  })
})

describe('labels', () => {
  it.each<[Parameters<typeof chipOf>[1], string, string]>([
    [{ kind: 'wip' }, 'wip', 'uncommitted changes'],
    [{ kind: 'commits', hashes: [H('1'), H('2'), H('3')] }, 'commits', '3 commits'],
    [{ kind: 'ref', name: 'refs/heads/feature/x' }, 'branch', 'branch feature/x'],
    [{ kind: 'ref', name: 'refs/remotes/origin/main' }, 'branch', 'branch origin/main'],
    [{ kind: 'ref', name: 'refs/tags/v1' }, 'tag', 'tag v1'],
    [{ kind: 'stash', ref: 'stash@{0}', index: 0 }, 'stash', 'stash@{0}'],
    [{ kind: 'files', rev: 'worktree', paths: ['src/a.ts'] }, 'files', 'a.ts'],
    [{ kind: 'files', rev: H('1'), paths: ['a', 'b'] }, 'files', '2 files'],
    [{ kind: 'compare', from: H('1'), to: H('2') }, 'compare', '1111111..2222222'],
    [{ kind: 'compare', from: H('1'), to: null }, 'compare', '1111111..working tree'],
  ])('%o', (ref, kind, label) => {
    const c = chipOf('r', ref)
    expect([c.kind, c.label]).toEqual([kind, label])
  })

  it('a selected compare uses the names the Details panel shows', () => {
    const [c] = chipsOf(view({ kind: 'compare', from: H('1'), to: H('2'), fromLabel: 'v1', toLabel: 'main' }))
    expect(c!.label).toBe('v1..main')
  })

  it('a commit the log has shows its subject; one it does not have is its short hash', () => {
    expect(chipOf('r', { kind: 'commits', hashes: [H('1')] }).label).toBe('commit 1111111 Fix the parser')
    expect(chipOf('r', { kind: 'commits', hashes: [H('2')] }).label).toBe('commit 2222222')
  })
})

describe('the selection chip', () => {
  it('is there for the selection, first, and follows it', () => {
    expect(chipsOf(view({ kind: 'commit', hash: H('1') })).map((c) => c.label)).toEqual(['commit 1111111 Fix the parser'])
    expect(chipsOf(view({ kind: 'wip' })).map((c) => c.label)).toEqual(['uncommitted changes'])
  })

  it('removed, it stays away for the same selection only', () => {
    const [chip] = chipsOf(view({ kind: 'commit', hash: H('1') }))
    removeChip('r', chip!)
    expect(chipsOf(view({ kind: 'commit', hash: H('1') }))).toEqual([])
    // The hook clears the removal when the selection is another one (see useChips); here the chip of that other selection is shown regardless.
    expect(chipsOf(view({ kind: 'commit', hash: H('2') })).map((c) => c.label)).toEqual(['commit 2222222'])
  })

  it('is used again by the next message: clearing the dropped chips keeps it', () => {
    addDropped('r', { kind: 'ref', ref: branch('topic') })
    expect(chipsOf(view({ kind: 'wip' })).map((c) => c.label)).toEqual(['uncommitted changes', 'branch topic'])
    clearDropped('r')
    expect(chipsOf(view({ kind: 'wip' })).map((c) => c.label)).toEqual(['uncommitted changes'])
  })
})

describe('dropped chips', () => {
  it('the same thing twice is one chip, and the selection chip is not doubled', () => {
    addDropped('r', { kind: 'commits', hashes: [H('1')] })
    addDropped('r', { kind: 'commits', hashes: [H('1')] })
    addDropped('r', { kind: 'ref', ref: branch('topic') })
    addDropped('r', { kind: 'ref', ref: branch('topic') })
    const chips = chipsOf(view({ kind: 'commit', hash: H('1') }))
    expect(chips.map((c) => c.label)).toEqual(['commit 1111111 Fix the parser', 'branch topic'])
    expect(chips[0]!.fromSelection).toBe(true)
  })

  it('× removes a dropped chip, and a chip that is both dropped and selected disappears whole', () => {
    addDropped('r', { kind: 'ref', ref: branch('topic') })
    addDropped('r', { kind: 'commits', hashes: [H('1')] })
    const sel = view({ kind: 'commit', hash: H('1') })
    const [commit, topic] = chipsOf(sel)
    removeChip('r', topic!)
    removeChip('r', commit!)
    expect(chipsOf(sel)).toEqual([])
    expect(useContextChips.getState().r!.dropped).toEqual([])
  })

  it('chips are per repository', () => {
    addDropped('r', { kind: 'ref', ref: branch('topic') })
    expect(chipsOf({ id: 'other', selected: { kind: 'wip' } }).map((c) => c.label)).toEqual(['uncommitted changes'])
    expect(refKey({ kind: 'wip' })).toBe('{"kind":"wip"}')
  })
})
