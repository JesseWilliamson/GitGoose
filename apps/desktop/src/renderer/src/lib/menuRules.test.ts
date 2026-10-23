import type { Ref, RepoSnapshot, StatusEntry } from '@gitgoose/shared'
import { describe, expect, it } from 'vitest'
import {
  firstReason, whyNotAi, whyNotCheckout, whyNotCherryPick, whyNotClearPushUrl, whyNotCompareChain, whyNotCompareTwo, whyNotCompareWithHead,
  whyNotCreatePull, whyNotDeleteBranch, whyNotEdit, whyNotEditMany, whyNotFastForward, whyNotFetchAll, whyNotFixupStaged, whyNotForcePush,
  whyNotHideInGraph, whyNotMakeHeadTrack, whyNotMergeOrRebase, whyNotMoveDown, whyNotMoveUp, whyNotOpenSubmodule, whyNotOpenWorktree, whyNotPull,
  whyNotPush, whyNotRecompose, whyNotRemoveWorktree, whyNotSquash, whyNotStopTracking, whyNotTrackAsLocal, whyNotTrackRemote, whyNotUseRemote,
  whyNotWithoutStaged, type RuleView,
} from './menuRules'

const H = (c: string) => c.repeat(40)
const local = (shortName: string, extra: Partial<Ref> = {}): Ref => ({ kind: 'local', shortName, name: `refs/heads/${shortName}`, hash: H('a'), ...extra })
const remote = (shortName: string, extra: Partial<Ref> = {}): Ref => ({ kind: 'remote', shortName, name: `refs/remotes/${shortName}`, hash: H('a'), ...extra })

function snapshot(patch: { branch?: string | null; hash?: string; refs?: Ref[]; status?: StatusEntry[] } = {}): RepoSnapshot {
  const branch = patch.branch === null ? undefined : (patch.branch ?? 'main')
  return {
    head: { branch, hash: patch.hash ?? H('a'), detached: !branch },
    refs: patch.refs ?? [local('main')],
    status: patch.status ?? [],
  } as unknown as RepoSnapshot
}
const view = (patch: Parameters<typeof snapshot>[0] & { editable?: string[]; remotes?: RuleView['remotes'] } = {}): RuleView => ({
  snapshot: snapshot(patch), editable: patch.editable ?? [], remotes: patch.remotes ?? [],
})
const staged: StatusEntry = { path: 'a.txt', kind: 'changed', index: 'M', worktree: '.' }
const unstaged: StatusEntry = { path: 'a.txt', kind: 'changed', index: '.', worktree: 'M' }

// Newest first, as the store has them: c3 is HEAD, c1 the oldest commit after the last merge.
const [c3, c2, c1, merge] = [H('3'), H('2'), H('1'), H('9')]

describe('editing commits', () => {
  const v = view({ editable: [c3, c2, c1] })
  it('allows commits after the last merge and says why not for others', () => {
    expect(whyNotEdit(v, c2)).toBeUndefined()
    expect(whyNotEdit(v, merge)).toMatch(/newer than its last merge/)
    expect(whyNotEdit(view({ branch: null, editable: [] }), c2)).toMatch(/Check out a branch first/)
  })
  it('several commits must all be editable', () => {
    expect(whyNotEditMany(v, [c3, c2])).toBeUndefined()
    expect(whyNotEditMany(v, [c3, merge])).toMatch(/last merge/)
  })
  it('the newest cannot move up and the oldest cannot move down or squash', () => {
    expect(whyNotMoveUp(v, c3)).toBe('This is the newest commit that can be edited')
    expect(whyNotMoveUp(v, c2)).toBeUndefined()
    expect(whyNotMoveDown(v, c1)).toBe('This is the oldest commit that can be edited')
    expect(whyNotMoveDown(v, c2)).toBeUndefined()
    expect(whyNotSquash(v, c1)).toMatch(/oldest commit that can be edited/)
    expect(whyNotSquash(v, c3)).toBeUndefined()
    expect(whyNotSquash(v, merge)).toMatch(/last merge/)
  })
  it('fixup of staged changes needs staged changes', () => {
    expect(whyNotFixupStaged(view({ editable: [c3] }), c3)).toBe('Stage some changes first')
    expect(whyNotFixupStaged(view({ editable: [c3], status: [unstaged] }), c3)).toBe('Stage some changes first')
    expect(whyNotFixupStaged(view({ editable: [c3], status: [staged] }), c3)).toBeUndefined()
    expect(whyNotFixupStaged(view({ editable: [], status: [staged] }), c3)).toMatch(/last merge/)
  })
  it('stash-only-staged style items count staged files', () => {
    expect(whyNotWithoutStaged(0)).toBe('Stage some changes first')
    expect(whyNotWithoutStaged(2)).toBeUndefined()
  })
})

describe('recompose', () => {
  const v = view({ editable: [c3, c2, c1] })
  const parents = (m: Record<string, string[]>) => (h: string) => m[h]
  it('works on a run of editable commits, or on one', () => {
    expect(whyNotRecompose(v, [c2])).toBeUndefined()
    expect(whyNotRecompose(v, [c3, c2])).toBeUndefined()
    expect(whyNotRecompose(v, [c1, c2, c3])).toBeUndefined()
  })
  it('refuses a merge commit, naming it', () => {
    expect(whyNotRecompose(v, [merge], parents({ [merge]: [c1, c2] }))).toBe('Recompose cannot include a merge commit')
  })
  it('refuses commits that are not newer than the last merge', () => {
    expect(whyNotRecompose(v, [H('7')], parents({ [H('7')]: [c1] }))).toMatch(/newer than its last merge/)
    expect(whyNotRecompose(v, [c2, H('7')])).toMatch(/newer than its last merge/)
  })
  it('refuses commits with a gap between them', () => {
    expect(whyNotRecompose(v, [c3, c1])).toMatch(/follow each other/)
  })
  it('needs a branch', () => {
    expect(whyNotRecompose(view({ branch: null, editable: [] }), [c1])).toMatch(/Check out a branch first/)
  })
})

describe('checking out and comparing', () => {
  const s = snapshot({ refs: [local('main'), local('dev', { hash: H('b') }), remote('origin/main'), local('same')], hash: H('a') })
  it('HEAD cannot be checked out, cherry-picked or compared with itself', () => {
    expect(whyNotCheckout(s, H('a'))).toBe('This is HEAD')
    expect(whyNotCheckout(s, H('b'))).toBeUndefined()
    expect(whyNotCherryPick(s, H('a'))).toBe('This is HEAD')
    expect(whyNotCherryPick(s, H('b'))).toBeUndefined()
    expect(whyNotCompareWithHead(s, H('a'))).toBe('This is HEAD')
    expect(whyNotCompareWithHead(s, H('b'))).toBeUndefined()
  })
  it('the checked-out branch is already checked out', () => {
    expect(whyNotCheckout(s, s.refs[0]!)).toBe('This branch is checked out')
    expect(whyNotCheckout(s, s.refs[1]!)).toBeUndefined()
    expect(whyNotCheckout(s, s.refs[2]!)).toBeUndefined()
  })
  it('comparing a branch with HEAD', () => {
    expect(whyNotCompareWithHead(s, s.refs[0]!)).toBe('This is the current branch')
    expect(whyNotCompareWithHead(s, s.refs[1]!)).toBeUndefined()
    expect(whyNotCompareWithHead(s, s.refs[3]!)).toMatch(/same commit as HEAD/)
  })
  it('an unborn branch has nothing to pick onto or compare with', () => {
    const empty = { ...snapshot(), head: { branch: 'main', hash: undefined, detached: false } } as RepoSnapshot
    expect(whyNotCherryPick(empty, H('b'))).toMatch(/no commit/)
    expect(whyNotCompareWithHead(empty, H('b'))).toMatch(/no HEAD commit/)
  })
})

describe('merge and rebase', () => {
  const s = snapshot({ refs: [local('main'), local('dev')] })
  it('not onto the current branch, and not without one', () => {
    expect(whyNotMergeOrRebase(s, s.refs[0]!)).toBe('This is the current branch')
    expect(whyNotMergeOrRebase(s, s.refs[1]!)).toBeUndefined()
    expect(whyNotMergeOrRebase(snapshot({ branch: null, refs: s.refs }), s.refs[1]!)).toBe('Check out a branch first')
  })
})

describe('fast-forward, pull, push', () => {
  const up = remote('origin/dev')
  const mk = (extra: Partial<Ref>) => {
    const dev = local('dev', { upstream: up.name, ...extra })
    return { dev, snap: snapshot({ refs: [local('main'), dev, up] }) }
  }
  it('fast-forward needs a branch that is only behind', () => {
    const { dev, snap } = mk({ behind: 2, ahead: 0 })
    expect(whyNotFastForward(snap, dev)).toBeUndefined()
    expect(whyNotFastForward(mk({ behind: 0, ahead: 0 }).snap, mk({ behind: 0, ahead: 0 }).dev)).toBe('Already up to date')
    expect(whyNotFastForward(mk({ behind: 2, ahead: 1 }).snap, mk({ behind: 2, ahead: 1 }).dev)).toBe('Has commits of its own: pull or merge instead')
  })
  it('fast-forward needs a remote branch to follow, and not the checked-out one', () => {
    const noUp = local('dev')
    expect(whyNotFastForward(snapshot({ refs: [local('main'), noUp] }), noUp)).toBe('Not tracking a remote branch')
    const gone = local('dev', { upstream: up.name, upstreamGone: true })
    expect(whyNotFastForward(snapshot({ refs: [local('main'), gone] }), gone)).toBe('Not tracking a remote branch')
    const main = local('main', { upstream: 'refs/remotes/origin/main', behind: 1, ahead: 0 })
    expect(whyNotFastForward(snapshot({ refs: [main, remote('origin/main')] }), main)).toMatch(/checked out/)
    expect(whyNotFastForward(snapshot(), remote('origin/x'))).toMatch(/local branch/)
  })
  it('pull works on the checked-out branch when it tracks something', () => {
    const main = local('main', { upstream: 'refs/remotes/origin/main' })
    const snap = snapshot({ refs: [main, remote('origin/main'), local('dev')] })
    expect(whyNotPull(snap, main)).toBeUndefined()
    expect(whyNotPull(snap, snap.refs[2]!)).not.toBeUndefined()
    expect(whyNotPull(snapshot(), local('main'))).toBe('Not tracking a remote branch')
    expect(whyNotPull(snapshot({ branch: null }), undefined)).toBe('Check out a branch first')
  })
  it('push: tracking, and something to push', () => {
    expect(whyNotPush(local('main'))).toBe('Not tracking a remote branch: publish it first')
    expect(whyNotPush(local('main', { upstream: up.name, upstreamGone: true }))).toMatch(/publish it first/)
    expect(whyNotPush(local('main', { upstream: up.name, ahead: 0 }))).toBe('Nothing to push')
    expect(whyNotPush(local('main', { upstream: up.name, ahead: 2 }))).toBeUndefined()
    // ahead unknown: allow, git will say
    expect(whyNotPush(local('main', { upstream: up.name }))).toBeUndefined()
    expect(whyNotPush(undefined)).toBe('Check out a branch first')
  })
  it('force push needs a tracked branch but not commits', () => {
    expect(whyNotForcePush(local('main'))).toBe('Not tracking a remote branch: publish it first')
    expect(whyNotForcePush(local('main', { upstream: up.name, ahead: 0 }))).toBeUndefined()
  })
  it('stop tracking needs an upstream', () => {
    expect(whyNotStopTracking(local('main'))).toBe('Not tracking a remote branch')
    expect(whyNotStopTracking(local('main', { upstream: up.name }))).toBeUndefined()
  })
})

describe('branches', () => {
  const s = snapshot({ refs: [local('main'), local('dev'), remote('origin/main'), remote('origin/dev')] })
  it('the current branch cannot be deleted or hidden', () => {
    expect(whyNotDeleteBranch(s, s.refs[0]!)).toMatch(/^The current branch cannot be deleted/)
    expect(whyNotDeleteBranch(s, s.refs[1]!)).toBeUndefined()
    expect(whyNotHideInGraph(s, s.refs[0]!)).toBe('The current branch is always shown')
    expect(whyNotHideInGraph(s, s.refs[1]!)).toBeUndefined()
  })
  it('a remote branch with a local namesake is checked out, not tracked again', () => {
    expect(whyNotTrackAsLocal(s, s.refs[2]!)).toMatch(/A local branch main already exists/)
    expect(whyNotTrackAsLocal(snapshot({ refs: [local('main')] }), remote('origin/feature'))).toBeUndefined()
  })
  it('make HEAD track a remote branch unless it does already', () => {
    const main = local('main', { upstream: 'refs/remotes/origin/main' })
    const snap = snapshot({ refs: [main, remote('origin/main'), remote('origin/dev')] })
    expect(whyNotMakeHeadTrack(snap, snap.refs[1]!)).toBe('Already tracking it')
    expect(whyNotMakeHeadTrack(snap, snap.refs[2]!)).toBeUndefined()
    expect(whyNotMakeHeadTrack(snapshot({ branch: null }), remote('origin/dev'))).toBe('Check out a branch first')
  })
})

describe('remotes', () => {
  const none = view()
  const some = view({ remotes: [{ name: 'origin', fetchUrl: 'https://example.com/a.git' }] })
  it('needs a remote to fetch, publish, push to or track', () => {
    expect(whyNotFetchAll(none)).toBe('No remotes')
    expect(whyNotFetchAll(some)).toBeUndefined()
    expect(whyNotUseRemote(none)).toBe('No remotes: add one first')
    expect(whyNotUseRemote(some)).toBeUndefined()
    expect(whyNotTrackRemote(none)).toBe('No remotes: add one first')
    expect(whyNotTrackRemote(some)).toBeUndefined()
  })
  it('a remote branch counts as a remote even when it is not configured', () => {
    expect(whyNotUseRemote(view({ refs: [local('main'), remote('origin/main')] }))).toBeUndefined()
  })
  it('a pull request needs a GitHub remote', () => {
    expect(whyNotCreatePull(some)).toBe('Add a GitHub remote first')
    expect(whyNotCreatePull({ remotes: [{ name: 'origin', fetchUrl: 'git@github.com:me/repo.git' }] })).toBeUndefined()
  })
  it('the push URL can be cleared only when there is one', () => {
    expect(whyNotClearPushUrl({})).toMatch(/fetch URL/)
    expect(whyNotClearPushUrl({ pushUrl: 'x' })).toBeUndefined()
  })
})

describe('worktrees, submodules, selections', () => {
  it('worktrees', () => {
    expect(whyNotOpenWorktree({ current: true })).toBe('This is the worktree you are in')
    expect(whyNotOpenWorktree({ current: false, prunable: 'gone' })).toBe('Its folder is missing')
    expect(whyNotOpenWorktree({ current: false })).toBeUndefined()
    expect(whyNotRemoveWorktree({ current: true })).toMatch(/open another one/)
    expect(whyNotRemoveWorktree({ current: false })).toBeUndefined()
  })
  it('a submodule that is not cloned cannot be opened', () => {
    expect(whyNotOpenSubmodule({})).toMatch(/Not cloned yet/)
    expect(whyNotOpenSubmodule({ checkedOut: 'abc' })).toBeUndefined()
  })
  it('comparing selections', () => {
    expect(whyNotCompareTwo([c1, c2, c3])).toBe('Select exactly two commits')
    expect(whyNotCompareTwo([c1, c2])).toBeUndefined()
    expect(whyNotCompareChain(undefined)).toMatch(/follow each other/)
    expect(whyNotCompareChain(c1)).toBeUndefined()
  })
})

describe('AI', () => {
  it('is off until a provider is chosen, and says where to turn it on', () => {
    expect(whyNotAi(undefined)).toBe('Turn on AI features in Settings → AI')
    expect(whyNotAi(null)).toBe('Turn on AI features in Settings → AI')
    expect(whyNotAi({ aiProvider: 'off' })).toBe('Turn on AI features in Settings → AI')
    expect(whyNotAi({ aiProvider: 'agent' })).toBeUndefined()
    expect(whyNotAi({ aiProvider: 'anthropic' })).toBeUndefined()
  })
  it('firstReason keeps the first one that applies', () => {
    expect(firstReason(undefined, 'a', 'b')).toBe('a')
    expect(firstReason(undefined, undefined)).toBeUndefined()
  })
})
