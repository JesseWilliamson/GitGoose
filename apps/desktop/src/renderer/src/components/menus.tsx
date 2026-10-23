import { DropdownMenu } from 'radix-ui'
import {
 checkoutPull, createPull, openPull, lfsPull, lfsTrack, lfsUntrack, bisectMark, hideInGraph, showInGraph, soloInGraph, unsoloInGraph, addRemote, addSubmodule, addWorktree, removeSubmodule, syncSubmodules, updateSubmodules, lockWorktree, pruneWorktrees, removeWorktree, checkRemoteTags, cleanupBranches, clearPushUrl, deleteRemoteTag, editRemoteUrl, fastForward, fetchAll, fetchRemote, pushBranch, pushTags, pushTo, remoteNames, removeRemote, renameRemote, setUpstream,
 savePatches, stashToBranch, checkout, forcePushBranch, pinBranch, publishBranch, pruneRemote, pull, pullRemoteBranch, revealInHistory, trackRemoteBranch, cherryPick, cherryPickMany, compare, compareSinceFork, copy, fixupInto, pop, reword, squashCommit, squashTogether, stashApply, stashDrop, copyCommits, dropCommits, moveCommits, currentBranchRef, deleteBranch, deleteRemoteBranch, deleteTag,
  merge, newBranch, newTag, push, rebase, renameBranch, reset, revert, shortRef,
} from '../lib/actions'
import { shortHash, stashLabel } from '../lib/format'
import { ask } from '../lib/actions'
import { chainBase, getLog, openRepo, updateRepo, useStore, type RepoView } from '../lib/store'
import { api } from '../lib/api'
import type { ReactNode } from 'react'
import type { Ref } from '@gitgoose/shared'
import { recomposeWithAi } from './RecomposeDialog'
import { startReview } from '../lib/review'
import { startWalkthrough } from '../lib/walkthrough'
import { showImpact } from '../lib/impact'
import { CM, DM } from './ui'
import {
  firstReason, whyNotAi, whyNotCheckout, whyNotCherryPick, whyNotClearPushUrl, whyNotCompareChain, whyNotCompareTwo, whyNotCompareWithHead, whyNotCreatePull,
  whyNotDeleteBranch, whyNotEdit, whyNotEditMany, whyNotFastForward, whyNotFetchAll, whyNotFixupStaged, whyNotForcePush, whyNotHideInGraph, whyNotHideRemoteTagMarks,
  whyNotMakeHeadTrack, whyNotMergeOrRebase, whyNotMoveDown, whyNotMoveUp, whyNotNewWorktreeFor, whyNotOpenSubmodule, whyNotOpenWorktree, whyNotPull, whyNotPush,
  whyNotRecompose, whyNotRemoveWorktree, whyNotSquash, whyNotStopTracking, whyNotTrackAsLocal, whyNotTrackRemote, whyNotUseRemote,
} from '../lib/menuRules'

/** One item per remote: a plain item when there is only one remote, a submenu when there are several. */
function PerRemote({ view, label, onPick, danger }: { view: RepoView; label: (remote: string) => string; onPick: (remote: string) => void; danger?: boolean }): ReactNode {
  const names = remoteNames(view)
  // No remote: still there, greyed, so the user learns the action exists and what it needs.
  if (names.length === 0) return <CM.Item danger={danger} reason={whyNotUseRemote(view)} onSelect={() => {}}>{label('a remote')}</CM.Item>
  if (names.length === 1) return <CM.Item danger={danger} onSelect={() => onPick(names[0]!)}>{label(names[0]!)}</CM.Item>
  return (
    <CM.Sub label={label('…').replace(/ …$/, '')}>
      {names.map((n) => <CM.Item key={n} danger={danger} onSelect={() => onPick(n)}>{n}</CM.Item>)}
    </CM.Sub>
  )
}

/**
 * What a branch (or tag) can do relative to HEAD: check it out, fast-forward it, merge it in,
 * rebase onto it. Shared by the branch menu and the menu of the commit at the branch's tip.
 */
function BranchActions({ repoId, r }: { repoId: string; r: Ref }) {
  const snap = useStore((s) => s.repos[repoId]?.snapshot)
  if (!snap) return null
  const headName = snap.head.branch ?? 'HEAD'
  const name = shortRef(r)
  if (snap.head.branch === r.shortName && r.kind === 'local') return null
  const mergeWhy = whyNotMergeOrRebase(snap, r)
  const ffWhy = whyNotFastForward(snap, r)
  return (
    <>
      <CM.Item reason={whyNotCheckout(snap, r)} onSelect={() => void checkout(repoId, r.name)}>Check out {name}</CM.Item>
      {/* Fast-forward only makes sense for a local branch that tracks something; for others it is just noise. */}
      {r.kind === 'local' && r.upstream && <CM.Item reason={ffWhy} onSelect={() => void fastForward(repoId, name)}>Fast-forward {name} to {shortRef(r.upstream)}</CM.Item>}
      <CM.Item reason={mergeWhy} onSelect={() => void merge(repoId, r.name)}>Merge {name} into {headName}</CM.Item>
      <CM.Sub label="Merge options" reason={mergeWhy}>
        <CM.Item onSelect={() => void merge(repoId, r.name, { noFf: true })}>Always create a merge commit</CM.Item>
        <CM.Item onSelect={() => void merge(repoId, r.name, { squash: true })}>Squash {name} into {headName}</CM.Item>
        <CM.Item onSelect={() => void merge(repoId, r.name, { noCommit: true })}>Merge without committing</CM.Item>
      </CM.Sub>
      <CM.Item reason={mergeWhy} onSelect={() => void rebase(repoId, r.name)}>Rebase {headName} onto {name}</CM.Item>
    </>
  )
}

/**
 * The branch a commit row stands for when it is a branch's tip: a local branch before a remote
 * one, and never the checked-out branch (merging or rebasing onto yourself does nothing).
 */
export function tipBranch(refs: Ref[], hash: string, headBranch: string | undefined): Ref | undefined {
  const at = refs.filter((r) => r.hash === hash && (r.kind === 'local' || r.kind === 'remote'))
  const local = at.filter((r) => r.kind === 'local' && r.shortName !== headBranch)
  if (local.length) return local[0]
  // A remote branch whose local twin is HEAD is "the branch I'm on" too: skip it.
  return at.find((r) => r.kind === 'remote' && !r.name.endsWith('/HEAD') && (!headBranch || r.shortName.slice(r.shortName.indexOf('/') + 1) !== headBranch))
}

/** Right-click menu for the graph. Rows record what was clicked in the store; this renders for it. */
export function GraphMenu({ repoId }: { repoId: string }) {
  const menu = useStore((s) => s.menu)
  const view = useStore((s) => s.repos[repoId])
  if (!menu || !view) return <CM.Content><CM.Label>Nothing here</CM.Label></CM.Content>
  const snap = view.snapshot
  const head = currentBranchRef(snap)
  const headName = snap.head.branch ?? 'HEAD'
  /** AI items are always there; with AI off they are greyed and say where to turn it on. */
  const aiWhy = whyNotAi(useStore.getState().settings)
  /** What the loaded log knows about a commit's parents (the recompose rule needs to tell merges apart). */
  const parentsOf = (h: string) => { const l = getLog(repoId); return l.commits[l.index.get(h) ?? -1]?.parents }

  if (menu.kind === 'ref') {
    const r = menu.ref
    const name = shortRef(r)
    const isHead = head?.name === r.name
    const hidden = snap.filter.hidden.includes(r.name)
    const soloed = snap.filter.solo.includes(r.name)
    const pinned = view.pins.includes(name)
    const worktree = r.kind === 'local' ? view.worktrees.find((w) => !w.current && w.branch === name) : undefined
    /** Remote branches with the same name, the usual thing to track (all remote branches can be typed). */
    const tracking = r.kind === 'local' ? snap.refs.filter((x) => x.kind === 'remote' && x.name !== r.upstream && x.shortName.endsWith(`/${name}`)) : []
    const compareItem = (
      <CM.Sub label="Compare" reason={whyNotCompareWithHead(snap, r)}>
        <CM.Item onSelect={() => compare(repoId, snap.head.hash!, r.name, headName, name)}>{name} with {headName}</CM.Item>
        <CM.Item onSelect={() => void compareSinceFork(repoId, snap.head.hash!, r.name)}>What {name} changed since it forked from {headName}</CM.Item>
      </CM.Sub>
    )
    const graphItems = (
      <>
        <CM.Item onSelect={() => void revealInHistory(repoId, r.hash)}>Reveal in History</CM.Item>
        {hidden ? <CM.Item onSelect={() => showInGraph(repoId, r.name)}>Show in the graph</CM.Item>
          : <CM.Item reason={whyNotHideInGraph(snap, r)} onSelect={() => hideInGraph(repoId, r.name)}>Hide in the graph</CM.Item>}
        {soloed ? <CM.Item onSelect={() => unsoloInGraph(repoId, r.name)}>Stop soloing {name}</CM.Item>
          : <CM.Item onSelect={() => soloInGraph(repoId, r.name)}>{snap.filter.solo.length ? `Solo ${name} too` : `Solo ${name} (show only it)`}</CM.Item>}
      </>
    )
    const mergeWhy = whyNotMergeOrRebase(snap, r)
    const mergeItems = (
      <>
        <CM.Item reason={mergeWhy} onSelect={() => void merge(repoId, r.name)}>Merge {name} into {headName}</CM.Item>
        <CM.Sub label="Merge options" reason={mergeWhy}>
          <CM.Item onSelect={() => void merge(repoId, r.name, { noFf: true })}>Always create a merge commit</CM.Item>
          <CM.Item onSelect={() => void merge(repoId, r.name, { squash: true })}>Squash {name} into {headName}</CM.Item>
          <CM.Item onSelect={() => void merge(repoId, r.name, { noCommit: true })}>Merge without committing</CM.Item>
        </CM.Sub>
        <CM.Item reason={mergeWhy} onSelect={() => void rebase(repoId, r.name)}>Rebase {headName} onto {name}</CM.Item>
      </>
    )

    // Tower's order for a local branch: check out; new things from it; bring it into HEAD; sync
    // with its remote; look at it; pin; rename and delete; copy.
    if (r.kind === 'local') {
      return (
        <CM.Content>
          <CM.Label>Branch {name}</CM.Label>
          <CM.Item reason={whyNotCheckout(snap, r)} onSelect={() => void checkout(repoId, r.name)}>Check out {name}</CM.Item>
          {worktree ? <CM.Item onSelect={() => void openRepo(worktree.path)}>Open the worktree with {name}</CM.Item>
            : <CM.Item reason={whyNotNewWorktreeFor(snap, r)} onSelect={() => addWorktree(repoId, name)}>Check out in a new worktree…</CM.Item>}
          <CM.Item onSelect={() => newBranch(repoId, r.name)}>Create branch from {name}…</CM.Item>
          <CM.Separator />{mergeItems}
          <CM.Separator />
          <CM.Item reason={whyNotPull(snap, r)} onSelect={() => void pull(repoId)}>Pull{r.upstream ? ` ${shortRef(r.upstream)}` : ''}</CM.Item>
          <CM.Item reason={whyNotFastForward(snap, r)} onSelect={() => void fastForward(repoId, name)}>Fast-forward {name}{r.upstream ? ` to ${shortRef(r.upstream)}` : ''}</CM.Item>
          {r.upstream && !r.upstreamGone
            ? <CM.Item reason={whyNotPush(r)} onSelect={() => (isHead ? push(repoId) : void pushBranch(repoId, name))}>Push {name}</CM.Item>
            : <PerRemote view={view} label={(n) => `Publish ${name} to ${n}`} onPick={(n) => void publishBranch(repoId, name, n)} />}
          <CM.Item danger reason={whyNotForcePush(r)} onSelect={() => forcePushBranch(repoId, name)}>Force push {name} with lease…</CM.Item>
          <PerRemote view={view} label={(n) => `Push to ${n}…`} onPick={(n) => pushTo(repoId, name, n)} />
          <CM.Sub label={r.upstream ? 'Track another remote branch' : 'Track a remote branch'} reason={whyNotTrackRemote(view)}>
            {tracking.map((t) => <CM.Item key={t.name} onSelect={() => void setUpstream(repoId, name, t.name)}>{t.shortName}</CM.Item>)}
            <CM.Separator />
            <CM.Item onSelect={() => ask(`Track a remote branch with ${name}`, 'Remote branch', 'Track', (u) => void setUpstream(repoId, name, u.trim()), { placeholder: `origin/${name}` })}>Other…</CM.Item>
          </CM.Sub>
          <CM.Item reason={whyNotStopTracking(r)} onSelect={() => void setUpstream(repoId, name, null)}>Stop tracking{r.upstream ? ` ${shortRef(r.upstream)}` : ''}</CM.Item>
          <CM.Item reason={whyNotCreatePull(view)} onSelect={() => createPull(repoId, name)}>Create pull request…</CM.Item>
          <CM.Separator />
          {compareItem}
          <CM.Item reason={aiWhy} onSelect={() => startReview(repoId, { kind: 'branch', branch: name })}>Review {name} with AI</CM.Item>
          <CM.Item reason={aiWhy} onSelect={() => startWalkthrough(repoId, { kind: 'branch', branch: name })}>Walk me through {name}</CM.Item>
          <CM.Item onSelect={() => showImpact(repoId, { kind: 'branch', branch: name })}>What could {name} affect?</CM.Item>
          <CM.Separator />
          {pinned ? <CM.Item onSelect={() => void pinBranch(repoId, name, false)}>Unpin {name}</CM.Item>
            : <CM.Item onSelect={() => void pinBranch(repoId, name, true)}>Pin {name}</CM.Item>}
          {graphItems}
          <CM.Separator />
          <CM.Item onSelect={() => renameBranch(repoId, name)}>Rename {name}…</CM.Item>
          <CM.Item danger reason={whyNotDeleteBranch(snap, r)} onSelect={() => void deleteBranch(repoId, name)}>Delete {name}</CM.Item>
          <CM.Separator />
          <CM.Item onSelect={() => copy(name, 'Copied name')}>Copy name</CM.Item>
        </CM.Content>
      )
    }

    if (r.kind === 'remote') {
      return (
        <CM.Content>
          <CM.Label>Remote branch {name}</CM.Label>
          <CM.Item reason={whyNotTrackAsLocal(snap, r)} onSelect={() => trackRemoteBranch(repoId, r.name)}>Track {name}…</CM.Item>
          <CM.Item onSelect={() => void checkout(repoId, r.name)}>Check out {name}</CM.Item>
          <CM.Item onSelect={() => newBranch(repoId, r.name)}>Create branch from {name}…</CM.Item>
          <CM.Separator />
          <CM.Item reason={whyNotMergeOrRebase(snap, r)} onSelect={() => void pullRemoteBranch(repoId, r.name)}>Pull {name} into {headName}</CM.Item>
          {mergeItems}
          <CM.Item reason={whyNotMakeHeadTrack(snap, r)} onSelect={() => void setUpstream(repoId, headName, r.name)}>Make {headName} track {name}</CM.Item>
          <CM.Separator />
          {compareItem}
          {graphItems}
          <CM.Separator />
          <CM.Item danger onSelect={() => deleteRemoteBranch(repoId, r.name)}>Delete {name} on remote…</CM.Item>
          <CM.Separator />
          <CM.Item onSelect={() => copy(name, 'Copied name')}>Copy name</CM.Item>
        </CM.Content>
      )
    }

    return (
      <CM.Content>
        <CM.Label>Tag {name}</CM.Label>
        <CM.Item onSelect={() => void checkout(repoId, r.name)}>Check out {name}</CM.Item>
        <PerRemote view={view} label={(n) => `Push ${name} to ${n}`} onPick={(n) => void pushTags(repoId, n, name)} />
        <CM.Item onSelect={() => newBranch(repoId, r.name)}>Create branch from {name}…</CM.Item>
        <CM.Separator />
        {compareItem}
        <CM.Item onSelect={() => void revealInHistory(repoId, r.hash)}>Reveal in History</CM.Item>
        <CM.Separator />
        <CM.Item danger onSelect={() => void deleteTag(repoId, name)}>Delete tag {name}</CM.Item>
        <PerRemote view={view} danger label={(n) => `Delete ${name} on ${n}…`} onPick={(n) => deleteRemoteTag(repoId, n, name)} />
        <CM.Separator />
        <CM.Item onSelect={() => copy(name, 'Copied name')}>Copy name</CM.Item>
      </CM.Content>
    )
  }

  if (menu.kind === 'remote') {
    const name = menu.remote
    const remote = view.remotes.find((x) => x.name === name)
    return (
      <CM.Content>
        <CM.Label>Remote {name}{remote ? ` · ${remote.fetchUrl}` : ''}</CM.Label>
        <CM.Item onSelect={() => void fetchRemote(repoId, name)}>Fetch {name}</CM.Item>
        <CM.Item onSelect={() => void pruneRemote(repoId, name)}>Prune {name} (forget branches deleted there)</CM.Item>
        {snap.filter.hidden.includes(`refs/remotes/${name}/*`)
          ? <CM.Item onSelect={() => showInGraph(repoId, `refs/remotes/${name}/*`)}>Show {name}'s branches in the graph</CM.Item>
          : <CM.Item onSelect={() => hideInGraph(repoId, `refs/remotes/${name}/*`)}>Hide {name}'s branches in the graph</CM.Item>}
        <CM.Item onSelect={() => void pushTags(repoId, name, null)}>Push all tags to {name}</CM.Item>
        <CM.Item onSelect={() => void checkRemoteTags(repoId, name)}>Check which tags are on {name}</CM.Item>
        {remote && (
          <>
            <CM.Separator />
            <CM.Item onSelect={() => editRemoteUrl(repoId, name)}>Edit URL…</CM.Item>
            <CM.Item onSelect={() => editRemoteUrl(repoId, name, true)}>{remote.pushUrl ? 'Edit push URL…' : 'Use a different URL for pushing…'}</CM.Item>
            <CM.Item reason={whyNotClearPushUrl(remote)} onSelect={() => void clearPushUrl(repoId, name)}>Push to the fetch URL again</CM.Item>
            <CM.Item onSelect={() => renameRemote(repoId, name)}>Rename {name}…</CM.Item>
            <CM.Item onSelect={() => copy(remote.fetchUrl, 'Copied URL')}>Copy URL</CM.Item>
            <CM.Separator />
            <CM.Item danger onSelect={() => void removeRemote(repoId, name)}>Remove {name}</CM.Item>
          </>
        )}
      </CM.Content>
    )
  }

  if (menu.kind === 'worktree') {
    const w = view.worktrees.find((x) => x.path === menu.path)
    if (!w) return <CM.Content><CM.Label>That worktree is gone</CM.Label></CM.Content>
    return (
      <CM.Content>
        <CM.Label>{w.path}</CM.Label>
        <CM.Item reason={whyNotOpenWorktree(w)} onSelect={() => void openRepo(w.path)}>Open in a new tab</CM.Item>
        <CM.Item disabled={!!w.prunable} onSelect={() => void api.revealPath(w.path)}>Reveal in file manager</CM.Item>
        <CM.Item onSelect={() => copy(w.path, 'Copied path')}>Copy path</CM.Item>
        {!w.main && (
          <>
            <CM.Separator />
            {w.locked === undefined
              ? <CM.Item onSelect={() => void lockWorktree(repoId, w.path, true)}>Lock (keep it when its folder is missing)</CM.Item>
              : <CM.Item onSelect={() => void lockWorktree(repoId, w.path, false)}>Unlock</CM.Item>}
            {w.prunable ? <CM.Item onSelect={() => void pruneWorktrees(repoId)}>Forget missing worktrees</CM.Item>
              : <CM.Item danger reason={whyNotRemoveWorktree(w)} onSelect={() => removeWorktree(repoId, w.path)}>Remove worktree</CM.Item>}
          </>
        )}
      </CM.Content>
    )
  }

  if (menu.kind === 'pull') {
    const p = view.pulls?.state === 'ok' ? view.pulls.pulls.find((x) => x.number === menu.number) : undefined
    if (!p) return <CM.Content><CM.Label>Refresh the list</CM.Label></CM.Content>
    return (
      <CM.Content>
        <CM.Label>#{p.number} {p.title}</CM.Label>
        <CM.Item onSelect={() => void checkoutPull(repoId, p.number)}>Check out (as pr/{p.number})</CM.Item>
        <CM.Item onSelect={() => openPull(p.url)}>Open on GitHub</CM.Item>
        <CM.Item onSelect={() => copy(p.url, 'Copied URL')}>Copy URL</CM.Item>
      </CM.Content>
    )
  }

  if (menu.kind === 'lfs-pattern') {
    return (
      <CM.Content>
        <CM.Label>{menu.pattern}</CM.Label>
        <CM.Item onSelect={() => void lfsUntrack(repoId, menu.pattern)}>Stop tracking with LFS</CM.Item>
        <CM.Item onSelect={() => copy(menu.pattern, 'Copied pattern')}>Copy pattern</CM.Item>
      </CM.Content>
    )
  }

  if (menu.kind === 'submodule') {
    const m = view.submodules.find((x) => x.path === menu.path)
    if (!m) return <CM.Content><CM.Label>That submodule is gone</CM.Label></CM.Content>
    const abs = `${snap.path}/${m.path}`
    return (
      <CM.Content>
        <CM.Label>{m.path} · {m.url}</CM.Label>
        <CM.Item reason={whyNotOpenSubmodule(m)} onSelect={() => void openRepo(abs)}>Open in a new tab</CM.Item>
        <CM.Item onSelect={() => void updateSubmodules(repoId, [m.path])}>{m.checkedOut ? 'Check out the recorded commit' : 'Clone and check out'}</CM.Item>
        <CM.Item reason={whyNotOpenSubmodule(m)} onSelect={() => void api.revealPath(abs)}>Reveal in file manager</CM.Item>
        <CM.Item onSelect={() => copy(m.url, 'Copied URL')}>Copy URL</CM.Item>
        <CM.Separator />
        <CM.Item danger onSelect={() => void removeSubmodule(repoId, m.path)}>Remove submodule</CM.Item>
      </CM.Content>
    )
  }

  if (menu.kind === 'section') {
    if (menu.section === 'lfs') {
      return (
        <CM.Content>
          <CM.Item onSelect={() => lfsTrack(repoId)}>Track a pattern…</CM.Item>
          <CM.Item onSelect={() => void lfsPull(repoId)}>Pull LFS files</CM.Item>
          <CM.Item onSelect={() => useStore.setState({ dialog: { kind: 'lfs-locks', repoId } })}>Show locks…</CM.Item>
        </CM.Content>
      )
    }
    if (menu.section === 'submodules') {
      return (
        <CM.Content>
          <CM.Item onSelect={() => void updateSubmodules(repoId)}>Update all (clone missing, check out recorded commits)</CM.Item>
          <CM.Item onSelect={() => void syncSubmodules(repoId)}>Sync URLs from .gitmodules</CM.Item>
          <CM.Item onSelect={() => addSubmodule(repoId)}>Add submodule…</CM.Item>
        </CM.Content>
      )
    }
    if (menu.section === 'worktrees') {
      return (
        <CM.Content>
          <CM.Item onSelect={() => addWorktree(repoId)}>Add worktree…</CM.Item>
          <CM.Item onSelect={() => void pruneWorktrees(repoId)}>Forget missing worktrees</CM.Item>
        </CM.Content>
      )
    }
    if (menu.section === 'local') {
      return (
        <CM.Content>
          <CM.Item onSelect={() => newBranch(repoId)}>New branch…</CM.Item>
          <CM.Item onSelect={() => cleanupBranches(repoId)}>Clean up branches…</CM.Item>
        </CM.Content>
      )
    }
    if (menu.section === 'remotes') {
      return (
        <CM.Content>
          <CM.Item onSelect={() => addRemote(repoId)}>Add remote…</CM.Item>
          <CM.Item reason={whyNotFetchAll(view)} onSelect={() => void fetchAll(repoId)}>Fetch all</CM.Item>
        </CM.Content>
      )
    }
    return (
      <CM.Content>
        <PerRemote view={view} label={(n) => `Push all tags to ${n}`} onPick={(n) => void pushTags(repoId, n, null)} />
        <PerRemote view={view} label={(n) => `Check which tags are on ${n}`} onPick={(n) => void checkRemoteTags(repoId, n)} />
        <CM.Item reason={whyNotHideRemoteTagMarks(view.remoteTags)} onSelect={() => updateRepo(repoId, { remoteTags: null })}>Hide the "local only" marks</CM.Item>
      </CM.Content>
    )
  }

  if (menu.kind === 'stash') {
    const s = menu.stash
    return (
      <CM.Content>
        <CM.Label>{s.ref}: {stashLabel(s.message)}</CM.Label>
        <CM.Item onSelect={() => void stashApply(repoId, s.index)}>Apply stash</CM.Item>
        <CM.Item onSelect={() => pop(repoId, s.index)}>Pop stash</CM.Item>
        <CM.Item onSelect={() => stashToBranch(repoId, s.index)}>Create a branch from this stash…</CM.Item>
        <CM.Separator />
        <CM.Item danger onSelect={() => void stashDrop(repoId, s.index)}>Drop stash</CM.Item>
      </CM.Content>
    )
  }

  if (menu.kind === 'commits') {
    const n = menu.hashes.length
    // Consecutive commits have one combined change (the side panel lists its files already).
    const base = chainBase(repoId, menu.hashes)
    const editManyWhy = whyNotEditMany(view, menu.hashes)
    return (
      <CM.Content>
        <CM.Label>{n} commits selected</CM.Label>
        <CM.Item onSelect={() => void cherryPickMany(repoId, menu.hashes)}>Cherry-pick {n} commits onto {headName}</CM.Item>
        <CM.Item reason={whyNotCompareTwo(menu.hashes)} onSelect={() => compare(repoId, menu.hashes[1]!, menu.hashes[0]!)}>Compare the two</CM.Item>
        <CM.Item reason={whyNotCompareChain(base)} onSelect={() => compare(repoId, base!, menu.hashes[0]!, `before ${shortHash(menu.hashes[n - 1]!)}`, shortHash(menu.hashes[0]!))}>Compare before and after all {n}</CM.Item>
        <CM.Separator />
        <CM.Item onSelect={() => void copyCommits(repoId, menu.hashes, 'diff')}>Copy as diff</CM.Item>
        <CM.Item onSelect={() => void copyCommits(repoId, menu.hashes, 'patch')}>Copy as patch</CM.Item>
        <CM.Item onSelect={() => void savePatches(repoId, menu.hashes)}>Save as {n} patch files…</CM.Item>
        <CM.Item onSelect={() => copy(menu.hashes.join('\n'), 'Copied SHAs')}>Copy SHAs</CM.Item>
        <CM.Separator />
        <CM.Item reason={editManyWhy} onSelect={() => void squashTogether(repoId, menu.hashes)}>Squash {n} commits into one</CM.Item>
        <CM.Item danger reason={editManyWhy} onSelect={() => void dropCommits(repoId, menu.hashes)}>Drop {n} commits</CM.Item>
        <CM.Separator />
        <CM.Item reason={firstReason(aiWhy, whyNotRecompose(view, menu.hashes, parentsOf))} onSelect={() => recomposeWithAi(repoId, menu.hashes)}>Recompose with AI…</CM.Item>
        <CM.Item reason={aiWhy} onSelect={() => startReview(repoId, { kind: 'commits', hashes: menu.hashes })}>Review {n} commits with AI</CM.Item>
        <CM.Item reason={aiWhy} onSelect={() => startWalkthrough(repoId, { kind: 'commits', hashes: menu.hashes })}>Walk me through {n} commits</CM.Item>
        <CM.Item onSelect={() => showImpact(repoId, { kind: 'commits', hashes: menu.hashes })}>What could {n} commits affect?</CM.Item>
      </CM.Content>
    )
  }

  const hash = menu.hash
  const commit = getLog(repoId).commits[getLog(repoId).index.get(hash) ?? -1]
  const editWhy = whyNotEdit(view, hash)
  /** When this commit is a branch's tip, the branch's own actions come first, as on its pill. */
  const tip = tipBranch(snap.refs, hash, snap.head.branch)
  return (
    <CM.Content>
      {tip && (
        <>
          <CM.Label>Branch {shortRef(tip)}</CM.Label>
          <BranchActions repoId={repoId} r={tip} />
          <CM.Separator />
        </>
      )}
      <CM.Label>{hash.slice(0, 7)} {commit?.subject}</CM.Label>
      <CM.Item onSelect={() => newBranch(repoId, hash)}>Create branch here…</CM.Item>
      <CM.Item onSelect={() => newTag(repoId, hash)}>Create tag here…</CM.Item>
      <CM.Item onSelect={() => void checkout(repoId, hash)} reason={whyNotCheckout(snap, hash)}>Check out this commit (detached)</CM.Item>
      <CM.Separator />
      <CM.Item onSelect={() => void cherryPick(repoId, hash)} reason={whyNotCherryPick(snap, hash)}>Cherry-pick onto {headName}</CM.Item>
      <CM.Item onSelect={() => void revert(repoId, hash)}>Revert this commit</CM.Item>
      <CM.Sub label="Compare">
        <CM.Item onSelect={() => compare(repoId, hash, null)}>With the working tree</CM.Item>
        <CM.Item reason={whyNotCompareWithHead(snap, hash)} onSelect={() => compare(repoId, hash, snap.head.hash!, shortHash(hash), headName)}>With {headName}</CM.Item>
      </CM.Sub>
      <CM.Separator />
      <CM.Item reason={whyNotMoveUp(view, hash)} onSelect={() => { const at = view.editable.indexOf(hash); void moveCommits(repoId, [hash], view.editable[at - 1]!, 'above') }}>Move commit up</CM.Item>
      <CM.Item reason={whyNotMoveDown(view, hash)} onSelect={() => { const at = view.editable.indexOf(hash); void moveCommits(repoId, [hash], view.editable[at + 1]!, 'below') }}>Move commit down</CM.Item>
      <CM.Item reason={editWhy} onSelect={() => void reword(repoId, hash)}>Reword…</CM.Item>
      <CM.Item reason={whyNotSquash(view, hash)} onSelect={() => void squashCommit(repoId, hash, 'squash')}>Squash into the commit below</CM.Item>
      <CM.Item reason={whyNotSquash(view, hash)} onSelect={() => void squashCommit(repoId, hash, 'fixup')}>Fixup into the commit below (drop this message)</CM.Item>
      <CM.Item reason={whyNotFixupStaged(view, hash)} onSelect={() => void fixupInto(repoId, hash)}>Fixup staged changes into this commit</CM.Item>
      <CM.Item danger reason={editWhy} onSelect={() => void dropCommits(repoId, [hash])}>Drop commit</CM.Item>
      <CM.Item reason={firstReason(aiWhy, whyNotRecompose(view, [hash], parentsOf))} onSelect={() => recomposeWithAi(repoId, [hash])}>Split with AI…</CM.Item>
      <CM.Item reason={aiWhy} onSelect={() => startReview(repoId, { kind: 'commits', hashes: [hash] })}>Review this commit with AI</CM.Item>
      <CM.Item reason={aiWhy} onSelect={() => startWalkthrough(repoId, { kind: 'commits', hashes: [hash] })}>Walk me through this commit</CM.Item>
      <CM.Item onSelect={() => showImpact(repoId, { kind: 'commits', hashes: [hash] })}>What could this commit affect?</CM.Item>
      <CM.Sub label={snap.bisect ? 'Bisect' : 'Bisect: find the commit that broke something'}>
        <CM.Item onSelect={() => void bisectMark(repoId, hash, 'bad')}>{snap.bisect ? 'Mark bad (has the bug)' : 'Start: this commit is bad (has the bug)'}</CM.Item>
        <CM.Item onSelect={() => void bisectMark(repoId, hash, 'good')}>{snap.bisect ? 'Mark good (no bug)' : 'Start: this commit is good (no bug)'}</CM.Item>
        {snap.bisect && <CM.Item onSelect={() => void bisectMark(repoId, hash, 'skip')}>Skip (cannot test it)</CM.Item>}
      </CM.Sub>
      <CM.Sub label={`Reset ${headName} to here`}>
        <CM.Item onSelect={() => void reset(repoId, hash, 'soft')}>Soft: keep changes staged</CM.Item>
        <CM.Item onSelect={() => void reset(repoId, hash, 'mixed')}>Mixed: keep changes unstaged</CM.Item>
        <CM.Item onSelect={() => void reset(repoId, hash, 'hard')}>Hard: discard changes</CM.Item>
      </CM.Sub>
      <CM.Separator />
      <CM.Item onSelect={() => void copyCommits(repoId, [hash], 'patch')}>Copy as patch</CM.Item>
      <CM.Item onSelect={() => void savePatches(repoId, [hash])}>Save as patch file…</CM.Item>
      <CM.Item onSelect={() => copy(hash, 'Copied SHA')}>Copy SHA</CM.Item>
      {commit && <CM.Item onSelect={() => copy(commit.subject, 'Copied message')}>Copy message</CM.Item>}
    </CM.Content>
  )
}

/**
 * Double-clicking a commit row where several local branches point: "Check out main", "Check out
 * release", at the pointer. One branch (or none) needs no question and never shows this.
 */
export function CheckoutMenu() {
  const choice = useStore((s) => s.checkoutChoice)
  const active = useStore((s) => s.active)
  if (!choice || !active) return null
  const close = () => useStore.setState({ checkoutChoice: null })
  return (
    <DropdownMenu.Root open onOpenChange={(o) => !o && close()}>
      <DropdownMenu.Trigger asChild>
        <span style={{ position: 'fixed', left: choice.x, top: choice.y, width: 1, height: 1 }} />
      </DropdownMenu.Trigger>
      <DM.Content>
        {choice.branches.map((b) => (
          <DM.Item key={b.name} onSelect={() => { close(); void checkout(active, b.name) }}>Check out {shortRef(b)}</DM.Item>
        ))}
      </DM.Content>
    </DropdownMenu.Root>
  )
}
