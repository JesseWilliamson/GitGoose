import { DropdownMenu } from 'radix-ui'
import {
 addRemote, addWorktree, lockWorktree, pruneWorktrees, removeWorktree, checkRemoteTags, cleanupBranches, clearPushUrl, deleteRemoteTag, editRemoteUrl, fastForward, fetchAll, fetchRemote, pushBranch, pushTags, pushTo, remoteNames, removeRemote, renameRemote, setUpstream,
 savePatches, stashToBranch, checkout, cherryPick, cherryPickMany, compare, compareSinceFork, copy, fixupInto, pop, reword, squashCommit, stashApply, stashDrop, copyCommits, dropCommits, moveCommits, currentBranchRef, deleteBranch, deleteRemoteBranch, deleteTag, dropOptions,
  merge, newBranch, newTag, push, rebase, renameBranch, reset, revert, shortRef,
} from '../lib/actions'
import { shortHash, stashLabel } from '../lib/format'
import { ask } from '../lib/actions'
import { getLog, openRepo, updateRepo, useStore } from '../lib/store'
import { api } from '../lib/api'
import type { ReactNode } from 'react'
import { recomposeWithAi } from './RecomposeDialog'
import { CM, DM } from './ui'

/** One item per remote: a plain item when there is only one remote, a submenu when there are several. */
function PerRemote({ names, label, onPick, danger }: { names: string[]; label: (remote: string) => string; onPick: (remote: string) => void; danger?: boolean }): ReactNode {
  if (names.length === 0) return null
  if (names.length === 1) return <CM.Item danger={danger} onSelect={() => onPick(names[0]!)}>{label(names[0]!)}</CM.Item>
  return (
    <CM.Sub label={label('…').replace(/ …$/, '')}>
      {names.map((n) => <CM.Item key={n} danger={danger} onSelect={() => onPick(n)}>{n}</CM.Item>)}
    </CM.Sub>
  )
}

/** Right-click menu for the graph. Rows record what was clicked in the store; this renders for it. */
export function GraphMenu({ repoId }: { repoId: string }) {
  const menu = useStore((s) => s.menu)
  const view = useStore((s) => s.repos[repoId])
  if (!menu || !view) return <CM.Content><CM.Label>Nothing here</CM.Label></CM.Content>
  const snap = view.snapshot
  const head = currentBranchRef(snap)
  const headName = snap.head.branch ?? 'HEAD'
  const aiOn = (useStore.getState().settings?.aiProvider ?? 'off') !== 'off'

  if (menu.kind === 'ref') {
    const r = menu.ref
    const name = shortRef(r)
    const isHead = head?.name === r.name
    const remotes = remoteNames(view)
    const worktree = r.kind === 'local' ? view.worktrees.find((w) => !w.current && w.branch === name) : undefined
    const upstream = r.upstream ? snap.refs.find((x) => x.name === r.upstream) : undefined
    // Not checked out, nothing of its own, behind its upstream: moving it forward loses nothing.
    const canFastForward = r.kind === 'local' && !isHead && !!upstream && (r.behind ?? 0) > 0 && (r.ahead ?? 0) === 0
    /** Remote branches with the same name, the usual thing to track (all remote branches can be typed). */
    const tracking = r.kind === 'local' ? snap.refs.filter((x) => x.kind === 'remote' && x.name !== r.upstream && x.shortName.endsWith(`/${name}`)) : []
    return (
      <CM.Content>
        <CM.Label>{r.kind === 'tag' ? `Tag ${name}` : r.kind === 'remote' ? `Remote branch ${name}` : `Branch ${name}`}</CM.Label>
        {!isHead && <CM.Item onSelect={() => void checkout(repoId, r.name)}>Check out {name}</CM.Item>}
        {!isHead && r.kind !== 'tag' && head && (
          <>
            <CM.Item onSelect={() => void merge(repoId, r.name)}>Merge {name} into {headName}</CM.Item>
            <CM.Sub label="Merge options">
              <CM.Item onSelect={() => void merge(repoId, r.name, { noFf: true })}>Always create a merge commit</CM.Item>
              <CM.Item onSelect={() => void merge(repoId, r.name, { squash: true })}>Squash {name} into {headName}</CM.Item>
              <CM.Item onSelect={() => void merge(repoId, r.name, { noCommit: true })}>Merge without committing</CM.Item>
            </CM.Sub>
            <CM.Item onSelect={() => void rebase(repoId, r.name)}>Rebase {headName} onto {name}</CM.Item>
          </>
        )}
        {!isHead && snap.head.hash && (
          <CM.Sub label="Compare">
            <CM.Item onSelect={() => compare(repoId, snap.head.hash!, r.name, headName, name)}>{name} with {headName}</CM.Item>
            <CM.Item onSelect={() => void compareSinceFork(repoId, snap.head.hash!, r.name)}>What {name} changed since it forked from {headName}</CM.Item>
          </CM.Sub>
        )}
        <CM.Separator />
        <CM.Item onSelect={() => newBranch(repoId, r.name)}>Create branch here…</CM.Item>
        {r.kind === 'local' && (
          <>
            {isHead ? <CM.Item onSelect={() => push(repoId)}>Push {name}</CM.Item> : <CM.Item onSelect={() => void pushBranch(repoId, name)}>Push {name}</CM.Item>}
            <PerRemote names={remotes} label={(n) => `Push to ${n}…`} onPick={(n) => pushTo(repoId, name, n)} />
            {canFastForward && <CM.Item onSelect={() => void fastForward(repoId, name)}>Fast-forward {name} to {shortRef(r.upstream!)}</CM.Item>}
            {r.kind === 'local' && remotes.length > 0 && (
              <CM.Sub label={r.upstream ? 'Track another remote branch' : 'Track a remote branch'}>
                {tracking.map((t) => <CM.Item key={t.name} onSelect={() => void setUpstream(repoId, name, t.name)}>{t.shortName}</CM.Item>)}
                <CM.Separator />
                <CM.Item onSelect={() => ask(`Track a remote branch with ${name}`, 'Remote branch', 'Track', (u) => void setUpstream(repoId, name, u.trim()), { placeholder: `origin/${name}` })}>Other…</CM.Item>
              </CM.Sub>
            )}
            {r.upstream && <CM.Item onSelect={() => void setUpstream(repoId, name, null)}>Stop tracking {shortRef(r.upstream)}</CM.Item>}
            {worktree ? <CM.Item onSelect={() => void openRepo(worktree.path)}>Open the worktree with {name}</CM.Item>
              : !isHead && <CM.Item onSelect={() => addWorktree(repoId, name)}>Check out in a new worktree…</CM.Item>}
            <CM.Item onSelect={() => renameBranch(repoId, name)}>Rename {name}…</CM.Item>
            {!isHead && <CM.Item danger onSelect={() => void deleteBranch(repoId, name)}>Delete {name}</CM.Item>}
          </>
        )}
        {r.kind === 'remote' && head && head.upstream !== r.name && (
          <CM.Item onSelect={() => void setUpstream(repoId, head.shortName, r.name)}>Make {headName} track {name}</CM.Item>
        )}
        {r.kind === 'remote' && <CM.Item danger onSelect={() => deleteRemoteBranch(repoId, r.name)}>Delete {name} on remote…</CM.Item>}
        {r.kind === 'tag' && (
          <>
            <PerRemote names={remotes} label={(n) => `Push ${name} to ${n}`} onPick={(n) => void pushTags(repoId, n, name)} />
            <CM.Item danger onSelect={() => void deleteTag(repoId, name)}>Delete tag {name}</CM.Item>
            <PerRemote names={remotes} danger label={(n) => `Delete ${name} on ${n}…`} onPick={(n) => deleteRemoteTag(repoId, n, name)} />
          </>
        )}
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
        <CM.Item onSelect={() => void pushTags(repoId, name, null)}>Push all tags to {name}</CM.Item>
        <CM.Item onSelect={() => void checkRemoteTags(repoId, name)}>Check which tags are on {name}</CM.Item>
        {remote && (
          <>
            <CM.Separator />
            <CM.Item onSelect={() => editRemoteUrl(repoId, name)}>Edit URL…</CM.Item>
            <CM.Item onSelect={() => editRemoteUrl(repoId, name, true)}>{remote.pushUrl ? 'Edit push URL…' : 'Use a different URL for pushing…'}</CM.Item>
            {remote.pushUrl && <CM.Item onSelect={() => void clearPushUrl(repoId, name)}>Push to the fetch URL again</CM.Item>}
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
        {!w.current && <CM.Item disabled={!!w.prunable} onSelect={() => void openRepo(w.path)}>Open in a new tab</CM.Item>}
        <CM.Item disabled={!!w.prunable} onSelect={() => void api.revealPath(w.path)}>Reveal in file manager</CM.Item>
        <CM.Item onSelect={() => copy(w.path, 'Copied path')}>Copy path</CM.Item>
        {!w.main && (
          <>
            <CM.Separator />
            {w.locked === undefined
              ? <CM.Item onSelect={() => void lockWorktree(repoId, w.path, true)}>Lock (keep it when its folder is missing)</CM.Item>
              : <CM.Item onSelect={() => void lockWorktree(repoId, w.path, false)}>Unlock</CM.Item>}
            {w.prunable ? <CM.Item onSelect={() => void pruneWorktrees(repoId)}>Forget missing worktrees</CM.Item>
              : !w.current && <CM.Item danger onSelect={() => removeWorktree(repoId, w.path)}>Remove worktree</CM.Item>}
          </>
        )}
      </CM.Content>
    )
  }

  if (menu.kind === 'section') {
    const remotes = remoteNames(view)
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
          <CM.Item disabled={remotes.length === 0} onSelect={() => void fetchAll(repoId)}>Fetch all</CM.Item>
        </CM.Content>
      )
    }
    return (
      <CM.Content>
        <PerRemote names={remotes} label={(n) => `Push all tags to ${n}`} onPick={(n) => void pushTags(repoId, n, null)} />
        <PerRemote names={remotes} label={(n) => `Check which tags are on ${n}`} onPick={(n) => void checkRemoteTags(repoId, n)} />
        {view.remoteTags && <CM.Item onSelect={() => updateRepo(repoId, { remoteTags: null })}>Hide the "local only" marks</CM.Item>}
        {remotes.length === 0 && <CM.Label>No remotes</CM.Label>}
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
    return (
      <CM.Content>
        <CM.Label>{n} commits selected</CM.Label>
        <CM.Item onSelect={() => void cherryPickMany(repoId, menu.hashes)}>Cherry-pick {n} commits onto {headName}</CM.Item>
        <CM.Separator />
        <CM.Item onSelect={() => void copyCommits(repoId, menu.hashes, 'diff')}>Copy as diff</CM.Item>
        <CM.Item onSelect={() => void copyCommits(repoId, menu.hashes, 'patch')}>Copy as patch</CM.Item>
        <CM.Item onSelect={() => void savePatches(repoId, menu.hashes)}>Save as {n} patch files…</CM.Item>
        <CM.Item onSelect={() => copy(menu.hashes.join('\n'), 'Copied SHAs')}>Copy SHAs</CM.Item>
        {menu.hashes.every((h) => view.editable.includes(h)) && (
          <>
            <CM.Separator />
            <CM.Item danger onSelect={() => void dropCommits(repoId, menu.hashes)}>Drop {n} commits</CM.Item>
          </>
        )}
        {aiOn && (
          <>
            <CM.Separator />
            <CM.Item onSelect={() => recomposeWithAi(repoId, menu.hashes)}>Recompose with AI…</CM.Item>
          </>
        )}
      </CM.Content>
    )
  }

  const hash = menu.hash
  const commit = getLog(repoId).commits[getLog(repoId).index.get(hash) ?? -1]
  /** Where this commit sits among the ones drop/move can edit (newest first), or -1. */
  const editAt = view.editable.indexOf(hash)
  const hasStaged = snap.status.some((e) => e.kind !== 'untracked' && e.kind !== 'unmerged' && e.index !== '.')
  const isHeadCommit = hash === snap.head.hash
  return (
    <CM.Content>
      <CM.Label>{hash.slice(0, 7)} {commit?.subject}</CM.Label>
      <CM.Item onSelect={() => newBranch(repoId, hash)}>Create branch here…</CM.Item>
      <CM.Item onSelect={() => newTag(repoId, hash)}>Create tag here…</CM.Item>
      <CM.Item onSelect={() => void checkout(repoId, hash)} disabled={isHeadCommit}>Check out this commit (detached)</CM.Item>
      <CM.Separator />
      <CM.Item onSelect={() => void cherryPick(repoId, hash)} disabled={isHeadCommit}>Cherry-pick onto {headName}</CM.Item>
      <CM.Item onSelect={() => void revert(repoId, hash)}>Revert this commit</CM.Item>
      <CM.Sub label="Compare">
        <CM.Item onSelect={() => compare(repoId, hash, null)}>With the working tree</CM.Item>
        <CM.Item disabled={isHeadCommit || !snap.head.hash} onSelect={() => compare(repoId, hash, snap.head.hash!, shortHash(hash), headName)}>With {headName}</CM.Item>
      </CM.Sub>
      {editAt >= 0 && (
        <>
          <CM.Separator />
          <CM.Item disabled={editAt === 0} onSelect={() => void moveCommits(repoId, [hash], view.editable[editAt - 1]!, 'above')}>Move commit up</CM.Item>
          <CM.Item disabled={editAt === view.editable.length - 1} onSelect={() => void moveCommits(repoId, [hash], view.editable[editAt + 1]!, 'below')}>Move commit down</CM.Item>
          <CM.Item onSelect={() => void reword(repoId, hash)}>Reword…</CM.Item>
          <CM.Item disabled={editAt === view.editable.length - 1} onSelect={() => void squashCommit(repoId, hash, 'squash')}>Squash into the commit below</CM.Item>
          <CM.Item disabled={editAt === view.editable.length - 1} onSelect={() => void squashCommit(repoId, hash, 'fixup')}>Fixup into the commit below (drop this message)</CM.Item>
          <CM.Item disabled={!hasStaged} onSelect={() => void fixupInto(repoId, hash)}>Fixup staged changes into this commit</CM.Item>
          <CM.Item danger onSelect={() => void dropCommits(repoId, [hash])}>Drop commit</CM.Item>
        </>
      )}
      {aiOn && <CM.Item onSelect={() => recomposeWithAi(repoId, [hash])}>Split with AI…</CM.Item>}
      <CM.Sub label={`Reset ${headName} to here`}>
        <CM.Item onSelect={() => void reset(repoId, hash, 'soft')}>Soft: keep changes staged</CM.Item>
        <CM.Item onSelect={() => void reset(repoId, hash, 'mixed')}>Mixed: keep changes unstaged</CM.Item>
        <CM.Item onSelect={() => void reset(repoId, hash, 'hard')}>Hard: discard changes (undoable)</CM.Item>
      </CM.Sub>
      <CM.Separator />
      <CM.Item onSelect={() => void copyCommits(repoId, [hash], 'patch')}>Copy as patch</CM.Item>
      <CM.Item onSelect={() => void savePatches(repoId, [hash])}>Save as patch file…</CM.Item>
      <CM.Item onSelect={() => copy(hash, 'Copied SHA')}>Copy SHA</CM.Item>
      {commit && <CM.Item onSelect={() => copy(commit.subject, 'Copied message')}>Copy message</CM.Item>}
    </CM.Content>
  )
}

/** The menu that appears where a branch was dropped, offering what the drop can mean. */
export function DropMenu() {
  const drop = useStore((s) => s.drop)
  const active = useStore((s) => (s.active ? s.repos[s.active] : null))
  if (!drop || !active) return null
  const options = dropOptions(active.id, active.snapshot, drop.source, drop.target)
  const close = () => useStore.setState({ drop: null })
  return (
    <DropdownMenu.Root open onOpenChange={(o) => !o && close()}>
      <DropdownMenu.Trigger asChild>
        <span style={{ position: 'fixed', left: drop.x, top: drop.y, width: 1, height: 1 }} />
      </DropdownMenu.Trigger>
      <DM.Content>
        <DM.Label>Drop {shortRef(drop.source)} on {drop.target.ref ? shortRef(drop.target.ref) : drop.target.hash.slice(0, 7)}</DM.Label>
        {options.length === 0 && <DM.Item onSelect={close} disabled>Nothing to do</DM.Item>}
        {options.map((o) => (
          <DM.Item key={o.label} onSelect={() => { close(); o.run() }}>{o.label}</DM.Item>
        ))}
      </DM.Content>
    </DropdownMenu.Root>
  )
}
