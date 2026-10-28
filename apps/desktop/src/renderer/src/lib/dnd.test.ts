import type { Ref } from '@gitgoose/shared'
import { describe, expect, it } from 'vitest'
import { decodeDrag, dropPlan, encodeDrag, type DragSource, type DropContext, type DropTarget } from './dnd'

/**
 * The drop matrix, one describe per row: what a plain
 * drop does, what Alt does, whether it asks first. Then the pairs that must not be targets.
 */

const H = (c: string) => c.repeat(40)
const local = (name: string, hash: string, extra: Partial<Ref> = {}): Ref => ({ name: `refs/heads/${name}`, shortName: name, kind: 'local', hash, ...extra })
const remote = (name: string, hash: string): Ref => ({ name: `refs/remotes/${name}`, shortName: name, kind: 'remote', hash })
const tagRef = (name: string, hash: string): Ref => ({ name: `refs/tags/${name}`, shortName: name, kind: 'tag', hash })

const main = local('main', H('a'), { upstream: 'refs/remotes/origin/main' })
const topic = local('topic', H('b'))
const feature = local('feature/login', H('c'))
const originMain = remote('origin/main', H('a'))
const originTopic = remote('origin/topic', H('d'))
const originHead = remote('origin/HEAD', H('a'))
const v1 = tagRef('v1', H('e'))

const ctx: DropContext = {
  snapshot: { head: { branch: 'main', hash: H('a'), detached: false }, refs: [main, topic, feature, originMain, originTopic, originHead, v1] },
  editable: [H('a'), H('1'), H('2'), H('3')],
  pinned: ['feature/login'],
}
const ref = (r: Ref): DragSource => ({ kind: 'ref', ref: r })
const on = (r: Ref): DropTarget => ({ kind: 'ref', ref: r })
const plan = (s: DragSource, t: DropTarget, alt = false, c = ctx) => dropPlan(c, s, t, { alt })
const workingCopy: DropTarget = { kind: 'workspace', item: 'working-copy' }
const wip: DropTarget = { kind: 'wip' }
const headRow: DropTarget = { kind: 'row', hash: H('a'), where: 'onto' }
const section = (s: 'branches' | 'tags' | 'pinned' | 'worktrees'): DropTarget => ({ kind: 'section', section: s })

describe('local branch → HEAD branch, Working Copy, WIP row, or HEAD\'s row', () => {
  it.each([['HEAD branch', on(main)], ['Working Copy', workingCopy], ['WIP row', wip], ["HEAD's row", headRow]])('%s: merge, Alt rebases HEAD onto it', (_, t) => {
    expect(plan(ref(topic), t)).toEqual({ label: 'Merge topic into main', op: { op: 'merge', ref: 'refs/heads/topic' } })
    expect(plan(ref(topic), t, true)).toEqual({ label: 'Rebase main onto topic', op: { op: 'rebase', onto: 'refs/heads/topic' } })
  })
  it('HEAD onto itself is not a drop', () => {
    expect(plan(ref(main), on(main))).toBeNull()
    expect(plan(ref(main), workingCopy, true)).toBeNull()
  })
})

describe('local branch → other local branch', () => {
  it('checks the target out and merges into it; Alt rebases the target onto the source', () => {
    expect(plan(ref(feature), on(topic))).toEqual({ label: 'Merge feature/login into topic (checks out topic)', op: { op: 'merge-into', branch: 'topic', ref: 'refs/heads/feature/login' } })
    expect(plan(ref(feature), on(topic), true)).toEqual({ label: 'Rebase topic onto feature/login (checks out topic)', op: { op: 'rebase-onto', branch: 'topic', onto: 'refs/heads/feature/login' } })
  })
  it('the checked-out branch can be dropped on another one too', () => {
    expect(plan(ref(main), on(topic))?.op).toEqual({ op: 'merge-into', branch: 'topic', ref: 'refs/heads/main' })
  })
  it('onto itself is nothing', () => expect(plan(ref(topic), on(topic))).toBeNull())
})

describe('local branch → remote node', () => {
  it('pushes to its upstream there, and asks first; Alt force-pushes with lease', () => {
    expect(plan(ref(main), { kind: 'remote', remote: 'origin' })).toEqual({ label: 'Push main to origin/main', op: { op: 'push', branch: 'main', remote: 'origin', force: false }, confirm: true })
    expect(plan(ref(main), { kind: 'remote', remote: 'origin' }, true)).toEqual({ label: 'Force push main to origin (with lease)', op: { op: 'push', branch: 'main', remote: 'origin', force: true }, confirm: true })
  })
  it('publishes (with tracking) a branch without an upstream there', () => {
    expect(plan(ref(topic), { kind: 'remote', remote: 'origin' })).toMatchObject({ label: 'Publish topic to origin', confirm: true })
  })
})

describe('local branch → remote branch', () => {
  it('pushes onto that remote branch; Alt with lease; both ask', () => {
    expect(plan(ref(topic), on(originTopic))).toEqual({ label: 'Push topic to origin/topic', op: { op: 'push', branch: 'topic', remote: 'origin', remoteBranch: 'topic', force: false }, confirm: true })
    expect(plan(ref(feature), on(originMain), true)).toEqual({ label: 'Force push feature/login to origin/main (with lease)', op: { op: 'push', branch: 'feature/login', remote: 'origin', remoteBranch: 'main', force: true }, confirm: true })
  })
  it('not onto origin/HEAD', () => expect(plan(ref(topic), on(originHead))).toBeNull())
})

describe('local branch → section headers, folders, Pull Requests', () => {
  it('Branches header: create a branch from it (Alt: the same)', () => {
    const p = { label: 'Create a branch from topic…', op: { op: 'new-branch', at: 'refs/heads/topic' } }
    expect(plan(ref(topic), section('branches'))).toEqual(p)
    expect(plan(ref(topic), section('branches'), true)).toEqual(p)
  })
  it('Tags header: create a tag at its tip', () => {
    expect(plan(ref(topic), section('tags'))).toEqual({ label: 'Create a tag at topic…', op: { op: 'new-tag', at: H('b') } })
  })
  it('a folder: rename into it; not into the folder it is already in', () => {
    expect(plan(ref(topic), { kind: 'folder', folder: 'feature' })).toEqual({ label: 'Rename topic to feature/topic', op: { op: 'rename-into', branch: 'topic', folder: 'feature' } })
    expect(plan(ref(feature), { kind: 'folder', folder: 'feature/ui' })?.label).toBe('Rename feature/login to feature/ui/login')
    expect(plan(ref(feature), { kind: 'folder', folder: 'feature' })).toBeNull()
  })
  it('Pinned header: pin, unless it is pinned already', () => {
    expect(plan(ref(topic), section('pinned'))).toEqual({ label: 'Pin topic', op: { op: 'pin', branch: 'topic' } })
    expect(plan(ref(feature), section('pinned'))).toBeNull()
  })
  it('Worktrees header: add a worktree on it; not the branch checked out here', () => {
    expect(plan(ref(topic), section('worktrees'))).toEqual({ label: 'Check out topic in a new worktree…', op: { op: 'add-worktree', branch: 'topic' } })
    expect(plan(ref(main), section('worktrees'))).toBeNull()
  })
  it('Pull Requests item: create a pull request (its own dialog, so no confirm here)', () => {
    expect(plan(ref(topic), { kind: 'workspace', item: 'pulls' })).toEqual({ label: 'Create a pull request for topic…', op: { op: 'create-pr', branch: 'topic' } })
  })
})

describe('remote branch → Branches header', () => {
  const noTopic = { ...ctx, snapshot: { ...ctx.snapshot, refs: ctx.snapshot.refs.filter((r) => r !== topic) } }
  it('checks out a local tracking branch; Alt creates it without checking out', () => {
    expect(plan(ref(originTopic), section('branches'), false, noTopic)).toEqual({ label: 'Check out origin/topic as topic', op: { op: 'track', ref: 'refs/remotes/origin/topic', name: 'topic', checkout: true } })
    expect(plan(ref(originTopic), section('branches'), true, noTopic)).toEqual({ label: 'Create topic tracking origin/topic', op: { op: 'track', ref: 'refs/remotes/origin/topic', name: 'topic', checkout: false } })
  })
  it('when the local branch exists, a plain drop checks it out and Alt has nothing to create', () => {
    expect(plan(ref(originTopic), section('branches'))?.label).toBe('Check out topic')
    expect(plan(ref(originMain), section('branches'))?.label).toBe('Check out main')
    expect(plan(ref(originMain), section('branches'), true)).toBeNull()
  })
})

describe('remote branch → HEAD branch / Working Copy', () => {
  it('pulls it into HEAD; Alt pulls with rebase', () => {
    expect(plan(ref(originTopic), on(main))).toEqual({ label: 'Pull origin/topic into main', op: { op: 'pull', remote: 'origin', branch: 'topic', rebase: false } })
    expect(plan(ref(originTopic), workingCopy, true)).toEqual({ label: 'Pull origin/topic into main with rebase', op: { op: 'pull', remote: 'origin', branch: 'topic', rebase: true } })
  })
})

describe('remote branch → other local branch', () => {
  it('sets it as the upstream (Alt: the same); not when it already is', () => {
    const p = { label: 'Make topic track origin/topic', op: { op: 'set-upstream', branch: 'topic', upstream: 'refs/remotes/origin/topic' } }
    expect(plan(ref(originTopic), on(topic))).toEqual(p)
    expect(plan(ref(originTopic), on(topic), true)).toEqual(p)
    expect(plan(ref(originMain), on(main))?.op.op).toBe('pull') // HEAD's branch is the pull row
    expect(plan(ref(originMain), on({ ...topic, upstream: 'refs/remotes/origin/main' }))).toBeNull()
  })
})

describe('commit(s) → Working Copy / HEAD branch / WIP row', () => {
  const picked = { kind: 'commits' as const, hashes: [H('5'), H('6')] }
  it.each([['Working Copy', workingCopy], ['HEAD branch', on(main)], ['WIP row', wip]])('%s: cherry-pick, Alt reverts', (_, t) => {
    expect(plan(picked, t)).toEqual({ label: 'Cherry-pick 2 commits onto main', op: { op: 'cherry-pick', hashes: [H('5'), H('6')] } })
    expect(plan(picked, t, true)).toEqual({ label: 'Revert 2 commits', op: { op: 'revert', hashes: [H('5'), H('6')] } })
  })
  it('one commit is named by its short hash; HEAD itself is not picked', () => {
    expect(plan({ kind: 'commits', hashes: [H('5')] }, wip)?.label).toBe(`Cherry-pick ${H('5').slice(0, 7)} onto main`)
    expect(plan({ kind: 'commits', hashes: [H('a')] }, wip)).toBeNull()
  })
  it('HEAD\'s own commit can still be reverted', () => {
    expect(plan({ kind: 'commits', hashes: [H('a')] }, wip, true)).toEqual({ label: 'Revert aaaaaaa', op: { op: 'revert', hashes: [H('a')] } })
  })
})

describe('commit → Branches / Tags header', () => {
  it('creates a branch or a tag at the commit', () => {
    expect(plan({ kind: 'commits', hashes: [H('5')] }, section('branches'))).toEqual({ label: 'Create a branch at 5555555…', op: { op: 'new-branch', at: H('5') } })
    expect(plan({ kind: 'commits', hashes: [H('5')] }, section('tags'), true)).toEqual({ label: 'Create a tag at 5555555…', op: { op: 'new-tag', at: H('5') } })
  })
  it('several commits have no one place to put a branch', () => {
    expect(plan({ kind: 'commits', hashes: [H('5'), H('6')] }, section('branches'))).toBeNull()
  })
})

describe('commit(s) → between two commits on the editable part of HEAD', () => {
  it('moves them above or below the target (Alt: the same)', () => {
    expect(plan({ kind: 'commits', hashes: [H('3')] }, { kind: 'row', hash: H('1'), where: 'above' })).toEqual({ label: 'Move 3333333 above 1111111', op: { op: 'move', hashes: [H('3')], target: H('1'), where: 'above' } })
    expect(plan({ kind: 'commits', hashes: [H('1'), H('2')] }, { kind: 'row', hash: H('3'), where: 'below' }, true)?.op).toEqual({ op: 'move', hashes: [H('1'), H('2')], target: H('3'), where: 'below' })
  })
})

describe('commit(s) → onto a commit (editable)', () => {
  it('squashes into it; Alt makes it a fixup that keeps the target\'s message', () => {
    expect(plan({ kind: 'commits', hashes: [H('1')] }, { kind: 'row', hash: H('2'), where: 'onto' })).toEqual({ label: 'Squash 1111111 into 2222222', op: { op: 'squash', hashes: [H('1')], target: H('2'), fixup: false } })
    expect(plan({ kind: 'commits', hashes: [H('1')] }, { kind: 'row', hash: H('2'), where: 'onto' }, true)).toEqual({ label: 'Fixup 1111111 into 2222222 (keeps its message)', op: { op: 'squash', hashes: [H('1')], target: H('2'), fixup: true } })
  })
  it('not onto itself, not from or onto commits off the editable part', () => {
    expect(plan({ kind: 'commits', hashes: [H('1')] }, { kind: 'row', hash: H('1'), where: 'onto' })).toBeNull()
    expect(plan({ kind: 'commits', hashes: [H('9')] }, { kind: 'row', hash: H('1'), where: 'above' })).toBeNull()
    expect(plan({ kind: 'commits', hashes: [H('1')] }, { kind: 'row', hash: H('9'), where: 'onto' })).toBeNull()
  })
})

describe('commit → other local branch', () => {
  it('cherry-picks onto it without checking it out (Alt: the same)', () => {
    const p = { label: 'Cherry-pick 5555555 onto topic (stays on main)', op: { op: 'cherry-pick-onto', branch: 'topic', hashes: [H('5')] } }
    expect(plan({ kind: 'commits', hashes: [H('5')] }, on(topic))).toEqual(p)
    expect(plan({ kind: 'commits', hashes: [H('5')] }, on(topic), true)).toEqual(p)
  })
  it('not onto a remote branch or a tag', () => {
    expect(plan({ kind: 'commits', hashes: [H('5')] }, on(originTopic))).toBeNull()
    expect(plan({ kind: 'commits', hashes: [H('5')] }, on(v1))).toBeNull()
  })
})

describe('tag → remote node', () => {
  it('pushes the tag, asking first', () => {
    expect(plan(ref(v1), { kind: 'remote', remote: 'origin' })).toEqual({ label: 'Push tag v1 to origin', op: { op: 'push-tag', tag: 'v1', remote: 'origin' }, confirm: true })
    expect(plan(ref(v1), { kind: 'remote', remote: 'origin' }, true)?.confirm).toBe(true)
  })
  it('a tag goes nowhere else', () => {
    for (const t of [on(main), workingCopy, section('branches'), section('tags'), wip, headRow]) expect(plan(ref(v1), t)).toBeNull()
  })
})

describe('stash → Working Copy / WIP row', () => {
  const s: DragSource = { kind: 'stash', index: 1, hash: H('7'), ref: 'stash@{1}' }
  it.each([['Working Copy', workingCopy], ['WIP row', wip]])('%s: apply, Alt pops', (_, t) => {
    expect(plan(s, t)).toEqual({ label: 'Apply stash@{1}', op: { op: 'stash-apply', index: 1, pop: false } })
    expect(plan(s, t, true)).toEqual({ label: 'Pop stash@{1}', op: { op: 'stash-apply', index: 1, pop: true } })
  })
  it('not onto branches or rows', () => {
    expect(plan(s, on(main))).toBeNull()
    expect(plan(s, headRow)).toBeNull()
  })
})

describe('a file in a stash or commit file list → Working Copy / WIP row', () => {
  it('applies that file\'s change (Alt: the same)', () => {
    const f: DragSource = { kind: 'files', rev: H('5'), paths: ['src/a.ts'] }
    const p = { label: 'Apply src/a.ts\'s change from 5555555 to the working copy', op: { op: 'apply-file', rev: H('5'), paths: ['src/a.ts'], stash: false } }
    expect(plan(f, wip)).toEqual(p)
    expect(plan(f, workingCopy, true)).toEqual(p)
    expect(plan({ kind: 'files', rev: H('7'), paths: ['a', 'b'], stash: true }, wip)?.label).toBe('Apply the changes to 2 files from the stash to the working copy')
  })
  it('not onto branches or the Stashes item', () => {
    expect(plan({ kind: 'files', rev: H('5'), paths: ['a'] }, on(main))).toBeNull()
    expect(plan({ kind: 'files', rev: H('5'), paths: ['a'] }, { kind: 'workspace', item: 'stashes' })).toBeNull()
  })
})

describe('working-copy file(s) → Stashes item', () => {
  it('stashes only those files', () => {
    expect(plan({ kind: 'files', rev: 'worktree', paths: ['a.txt'] }, { kind: 'workspace', item: 'stashes' })).toEqual({ label: 'Stash a.txt', op: { op: 'stash-files', paths: ['a.txt'] } })
    expect(plan({ kind: 'files', rev: 'worktree', paths: ['a', 'b'] }, { kind: 'workspace', item: 'stashes' }, true)?.label).toBe('Stash 2 files')
  })
  it('working-copy files are already in the working copy', () => {
    expect(plan({ kind: 'files', rev: 'worktree', paths: ['a'] }, wip)).toBeNull()
  })
})

describe('everything else is not a target', () => {
  it.each<[string, DragSource, DropTarget]>([
    ['branch onto a row that is not HEAD', ref(topic), { kind: 'row', hash: H('1'), where: 'onto' }],
    ['branch onto a tag', ref(topic), on(v1)],
    ['branch onto the Stashes item', ref(topic), { kind: 'workspace', item: 'stashes' }],
    ['remote branch onto a remote node', ref(originTopic), { kind: 'remote', remote: 'origin' }],
    ['remote branch onto Tags', ref(originTopic), section('tags')],
    ['remote branch onto a row', ref(originTopic), headRow],
    ['commits onto a remote node', { kind: 'commits', hashes: [H('5')] }, { kind: 'remote', remote: 'origin' }],
    ['commits onto a folder', { kind: 'commits', hashes: [H('5')] }, { kind: 'folder', folder: 'feature' }],
    ['stash onto the Stashes item', { kind: 'stash', index: 0, hash: H('7'), ref: 'stash@{0}' }, { kind: 'workspace', item: 'stashes' }],
  ])('%s', (_, s, t) => {
    expect(plan(s, t)).toBeNull()
    expect(plan(s, t, true)).toBeNull()
  })

  it('with no commits yet nothing merges or cherry-picks into HEAD', () => {
    const unborn = { ...ctx, snapshot: { head: { branch: 'main', detached: false }, refs: [topic] } }
    expect(plan(ref(topic), workingCopy, false, unborn)).toBeNull()
    expect(plan({ kind: 'commits', hashes: [H('5')] }, wip, false, unborn)).toBeNull()
  })

  it('detached HEAD: the Working Copy still takes a merge, named HEAD', () => {
    const detached = { ...ctx, snapshot: { head: { hash: H('a'), detached: true }, refs: [main, topic] } }
    expect(plan(ref(topic), workingCopy, false, detached)?.label).toBe('Merge topic into HEAD')
    // No branch is HEAD, so main is just another branch.
    expect(plan(ref(topic), on(main), false, detached)?.op.op).toBe('merge-into')
  })
})

describe('anything → the AI panel', () => {
  const ai: DropTarget = { kind: 'ai' }
  it.each<[string, DragSource, string]>([
    ['a branch', ref(topic), 'Add branch topic to the AI conversation'],
    ['a tag', ref(v1), 'Add tag v1 to the AI conversation'],
    ['one commit', { kind: 'commits', hashes: [H('1')] }, 'Add commit 1111111 to the AI conversation'],
    ['several commits', { kind: 'commits', hashes: [H('1'), H('2')] }, 'Add 2 commits to the AI conversation'],
    ['a stash', { kind: 'stash', index: 0, hash: H('7'), ref: 'stash@{0}' }, 'Add stash@{0} to the AI conversation'],
    ['files', { kind: 'files', rev: 'worktree', paths: ['a', 'b'] }, 'Add 2 files to the AI conversation'],
  ])('%s becomes a context chip, with or without Alt, and never asks', (_, source, label) => {
    for (const alt of [false, true]) {
      const p = plan(source, ai, alt)
      expect(p?.label).toBe(label)
      expect(p?.op).toEqual({ op: 'ai-context', source })
      expect(p?.confirm).toBeUndefined()
    }
  })
})

describe('payloads', () => {
  it.each<DragSource>([
    { kind: 'ref', ref: topic },
    { kind: 'commits', hashes: [H('1'), H('2')] },
    { kind: 'stash', index: 2, hash: H('7'), ref: 'stash@{2}' },
    { kind: 'files', rev: 'worktree', paths: ['a', 'b'] },
  ])('round-trip through a DataTransfer: %o', (s) => {
    const { mime, data } = encodeDrag(s)
    const back = decodeDrag((m) => (m === mime ? data : ''))
    expect(back).toMatchObject(s)
  })
  it('anything else (a file from the desktop, broken JSON) is not a drag of ours', () => {
    expect(decodeDrag(() => '')).toBeNull()
    expect(decodeDrag((m) => (m.endsWith('-ref') ? '{nope' : ''))).toBeNull()
  })
})
