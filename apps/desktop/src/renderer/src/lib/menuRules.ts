import { parseGitHubRemote, type Ref, type RepoSnapshot } from '@gitgoose/shared'

/**
 * Why a menu item cannot run right now, as one short sentence, or undefined when it can.
 *
 * An item that cannot run is shown greyed with this sentence as its tooltip (see `reason` on
 * CM.Item / DM.Item): a missing item hides the rule, a greyed one teaches it. These are pure
 * functions of the data the app already has, so the context menus, the toolbar and the AI pane
 * ask the same question and give the same answer, and each rule has a test.
 *
 * Wording: plain words, and when there is something to do about it, say what.
 */
export type Why = string | undefined

/** The part of a repository's view the rules read (structurally a `RepoView`). */
export interface RuleView {
  snapshot: RepoSnapshot
  /** Commits drop / move / recompose can edit: the current branch back to its last merge, newest first. */
  editable: string[]
  remotes: { name: string; fetchUrl: string }[]
}

/** The setting the AI rules read. */
export interface AiSettings { aiProvider?: string }

const asRef = (snap: RepoSnapshot, r: Ref): Ref => snap.refs.find((x) => x.name === r.name) ?? r

/** Any remote at all: configured ones, plus any that only show up through a remote branch. */
function hasRemotes(view: Pick<RuleView, 'remotes' | 'snapshot'>): boolean {
  return view.remotes.length > 0 || view.snapshot.refs.some((r) => r.kind === 'remote')
}

const isCheckedOut = (snap: RepoSnapshot, r: Ref): boolean => r.kind === 'local' && snap.head.branch === r.shortName
const tracksRemote = (r: Ref | undefined): boolean => !!r?.upstream && !r.upstreamGone

// ── Commits that rewrite history ─────────────────────────────────────────────────────────────

const NOT_EDITABLE = 'Only commits of the current branch that are newer than its last merge can be edited'
const NO_BRANCH_EDIT = 'Check out a branch first: editing commits rewrites the current branch'

/** Reword, drop, move, squash, fixup: the commit must be one the app can replay (see `editable`). */
export function whyNotEdit(view: RuleView, hash: string): Why {
  if (!view.snapshot.head.branch) return NO_BRANCH_EDIT
  return view.editable.includes(hash) ? undefined : NOT_EDITABLE
}

/** Drop or squash several commits together: all of them must be editable. */
export function whyNotEditMany(view: RuleView, hashes: string[]): Why {
  if (!view.snapshot.head.branch) return NO_BRANCH_EDIT
  return hashes.every((h) => view.editable.includes(h)) ? undefined : NOT_EDITABLE
}

export function whyNotMoveUp(view: RuleView, hash: string): Why {
  return whyNotEdit(view, hash) ?? (view.editable[0] === hash ? 'This is the newest commit that can be edited' : undefined)
}

export function whyNotMoveDown(view: RuleView, hash: string): Why {
  return whyNotEdit(view, hash) ?? (view.editable[view.editable.length - 1] === hash ? 'This is the oldest commit that can be edited' : undefined)
}

/** Squash or fixup into the commit below. */
export function whyNotSquash(view: RuleView, hash: string): Why {
  return whyNotEdit(view, hash) ?? (view.editable[view.editable.length - 1] === hash ? 'This is the oldest commit that can be edited, so there is none below it' : undefined)
}

/** Fixup the staged changes into this commit. */
export function whyNotFixupStaged(view: RuleView, hash: string): Why {
  const edit = whyNotEdit(view, hash)
  if (edit) return edit
  const staged = view.snapshot.status.some((e) => e.kind !== 'untracked' && e.kind !== 'unmerged' && e.index !== '.')
  return staged ? undefined : 'Stage some changes first'
}

/** The root commit, when the current branch's first-parent line reaches it with no merge on the way. */
function rootBelow(view: RuleView, parentsOf?: (hash: string) => string[] | undefined): string | undefined {
  if (!parentsOf) return undefined
  const oldest = view.editable[view.editable.length - 1]
  if (!oldest) {
    const head = view.snapshot.head.hash
    return head && parentsOf(head)?.length === 0 ? head : undefined
  }
  const below = parentsOf(oldest)?.[0]
  return below && parentsOf(below)?.length === 0 ? below : undefined
}

/**
 * Recompose (several commits) or Split (one) with AI: ordinary commits of the current branch that
 * follow each other, with no merge among or above them. `parentsOf` lets the rule tell a merge
 * commit from one that merely lies below a merge (the log knows; `editable` does not).
 */
export function whyNotRecompose(view: RuleView, hashes: string[], parentsOf?: (hash: string) => string[] | undefined): Why {
  if (!view.snapshot.head.branch) return 'Check out a branch first: recompose rewrites the current branch'
  if (parentsOf && hashes.some((h) => (parentsOf(h)?.length ?? 0) > 1)) return 'Recompose cannot include a merge commit'
  // Recompose (unlike drop and move) also takes the root commit, when the branch's first-parent
  // line reaches it without a merge: it is the commit just below the oldest editable one.
  const chain = [...view.editable]
  const root = rootBelow(view, parentsOf)
  if (root) chain.push(root)
  const at = hashes.map((h) => chain.indexOf(h))
  if (at.some((i) => i < 0)) return 'Recompose works on commits of the current branch that are newer than its last merge'
  const sorted = [...at].sort((a, b) => a - b)
  if (sorted.some((v, i) => i > 0 && v !== sorted[i - 1]! + 1)) return 'Recompose needs commits that follow each other: select a range with Shift-click'
  return undefined
}

// ── Checking out, cherry-picking, comparing ──────────────────────────────────────────────────

/** Check out a commit (a hash, detached) or a ref. */
export function whyNotCheckout(snap: RepoSnapshot, target: string | Ref): Why {
  if (typeof target === 'string') return target === snap.head.hash ? 'This is HEAD' : undefined
  return isCheckedOut(snap, target) ? 'This branch is checked out' : undefined
}

export function whyNotCherryPick(snap: RepoSnapshot, hash: string): Why {
  if (!snap.head.hash) return 'There is no commit to pick onto yet'
  return hash === snap.head.hash ? 'This is HEAD' : undefined
}

/** Compare a commit or a ref with HEAD. */
export function whyNotCompareWithHead(snap: RepoSnapshot, target: string | Ref): Why {
  if (!snap.head.hash) return 'There is no HEAD commit yet'
  if (typeof target === 'string') return target === snap.head.hash ? 'This is HEAD' : undefined
  if (isCheckedOut(snap, target)) return 'This is the current branch'
  return target.hash === snap.head.hash ? 'This points at the same commit as HEAD' : undefined
}

// ── Branches: merge, rebase, pull, push ──────────────────────────────────────────────────────

/** Merge a branch into HEAD, or rebase HEAD onto it. */
export function whyNotMergeOrRebase(snap: RepoSnapshot, ref: Ref): Why {
  if (!snap.head.branch) return 'Check out a branch first'
  return isCheckedOut(snap, ref) ? 'This is the current branch' : undefined
}

/** Fast-forward a local branch to its upstream without checking it out. */
export function whyNotFastForward(snap: RepoSnapshot, ref: Ref): Why {
  const r = asRef(snap, ref)
  if (r.kind !== 'local') return 'Only a local branch can be fast-forwarded'
  if (!tracksRemote(r)) return 'Not tracking a remote branch'
  if (isCheckedOut(snap, r)) return 'This branch is checked out: use Pull instead'
  if (!snap.refs.some((x) => x.name === r.upstream)) return 'Its remote branch is not here yet: fetch first'
  if ((r.ahead ?? 0) > 0 && (r.behind ?? 0) > 0) return 'Has commits of its own: pull or merge instead'
  return (r.behind ?? 0) > 0 ? undefined : 'Already up to date'
}

/** Pull into the checked-out branch. */
export function whyNotPull(snap: RepoSnapshot, ref: Ref | undefined): Why {
  if (!ref) return 'Check out a branch first'
  const r = asRef(snap, ref)
  if (!isCheckedOut(snap, r)) return 'Check out this branch to pull into it'
  return tracksRemote(r) ? undefined : 'Not tracking a remote branch'
}

/** Push a branch to the remote it tracks (a branch that tracks nothing is published instead). */
export function whyNotPush(ref: Ref | undefined): Why {
  if (!ref) return 'Check out a branch first'
  if (!tracksRemote(ref)) return 'Not tracking a remote branch: publish it first'
  return ref.ahead === 0 ? 'Nothing to push' : undefined
}

export function whyNotForcePush(ref: Ref | undefined): Why {
  if (!ref) return 'Check out a branch first'
  return tracksRemote(ref) ? undefined : 'Not tracking a remote branch: publish it first'
}

/** Stop tracking the upstream. */
export function whyNotStopTracking(ref: Ref): Why {
  return ref.upstream ? undefined : 'Not tracking a remote branch'
}

export function whyNotDeleteBranch(snap: RepoSnapshot, ref: Ref): Why {
  return isCheckedOut(snap, ref) ? 'The current branch cannot be deleted: check out another branch first' : undefined
}

export function whyNotHideInGraph(snap: RepoSnapshot, ref: Ref): Why {
  return isCheckedOut(snap, ref) ? 'The current branch is always shown' : undefined
}

export function whyNotNewWorktreeFor(snap: RepoSnapshot, ref: Ref): Why {
  return isCheckedOut(snap, ref) ? 'This branch is already checked out here' : undefined
}

// ── Remotes ──────────────────────────────────────────────────────────────────────────────────

const NO_REMOTES = 'No remotes: add one first'

export function whyNotFetchAll(view: RuleView): Why {
  return hasRemotes(view) ? undefined : 'No remotes'
}

/** Anything that names a remote (publish, push to, delete a tag on, ...). */
export function whyNotUseRemote(view: RuleView): Why {
  return hasRemotes(view) ? undefined : NO_REMOTES
}

/** The "Track a remote branch" submenu. */
export function whyNotTrackRemote(view: RuleView): Why {
  return hasRemotes(view) ? undefined : NO_REMOTES
}

/** "Track <remote branch>" as a new local branch. */
export function whyNotTrackAsLocal(snap: RepoSnapshot, remoteRef: Ref): Why {
  const local = remoteRef.shortName.slice(remoteRef.shortName.indexOf('/') + 1)
  return snap.refs.some((x) => x.name === `refs/heads/${local}`) ? `A local branch ${local} already exists: check it out instead` : undefined
}

/** "Make <current branch> track <remote branch>". */
export function whyNotMakeHeadTrack(snap: RepoSnapshot, remoteRef: Ref): Why {
  const head = snap.head.branch ? snap.refs.find((r) => r.name === `refs/heads/${snap.head.branch}`) : undefined
  if (!head) return 'Check out a branch first'
  return head.upstream === remoteRef.name ? 'Already tracking it' : undefined
}

export function whyNotCreatePull(view: Pick<RuleView, 'remotes'>): Why {
  return view.remotes.some((r) => parseGitHubRemote(r.fetchUrl)) ? undefined : 'Add a GitHub remote first'
}

export function whyNotClearPushUrl(remote: { pushUrl?: string } | undefined): Why {
  return remote?.pushUrl ? undefined : 'It already pushes to the fetch URL'
}

// ── Worktrees, submodules, multi-selection ───────────────────────────────────────────────────

export function whyNotOpenWorktree(w: { current: boolean; prunable?: unknown }): Why {
  if (w.current) return 'This is the worktree you are in'
  return w.prunable ? 'Its folder is missing' : undefined
}

export function whyNotRemoveWorktree(w: { current: boolean }): Why {
  return w.current ? 'You are in this worktree: open another one to remove it' : undefined
}

export function whyNotOpenSubmodule(m: { checkedOut?: unknown }): Why {
  return m.checkedOut ? undefined : 'Not cloned yet: update the submodule first'
}

export function whyNotCompareTwo(hashes: string[]): Why {
  return hashes.length === 2 ? undefined : 'Select exactly two commits'
}

/** "Compare before and after all N": the commits must follow each other (`chainBase` finds out). */
export function whyNotCompareChain(base: string | undefined): Why {
  return base === undefined ? 'The commits must follow each other, and not start at the first commit' : undefined
}

export function whyNotHideRemoteTagMarks(remoteTags: unknown): Why {
  return remoteTags ? undefined : 'No tag check is showing'
}

// ── AI and staged changes ────────────────────────────────────────────────────────────────────

export function whyNotAi(settings: AiSettings | null | undefined): Why {
  return (settings?.aiProvider ?? 'off') === 'off' ? 'Turn on AI features in Settings → AI' : undefined
}

/** The first reason that applies (put the AI-off reason first: nothing else matters until it is on). */
export function firstReason(...reasons: Why[]): Why {
  return reasons.find((r) => r !== undefined)
}

export function whyNotWithoutStaged(staged: number): Why {
  return staged > 0 ? undefined : 'Stage some changes first'
}
