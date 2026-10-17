import { DropdownMenu } from 'radix-ui'
import {
  checkout, cherryPick, copy, currentBranchRef, deleteBranch, deleteRemoteBranch, deleteTag, dropOptions,
  merge, newBranch, newTag, push, rebase, renameBranch, reset, revert, shortRef,
} from '../lib/actions'
import { getLog, useStore } from '../lib/store'
import { CM, DM } from './ui'

/** Right-click menu for the graph. Rows record what was clicked in the store; this renders for it. */
export function GraphMenu({ repoId }: { repoId: string }) {
  const menu = useStore((s) => s.menu)
  const view = useStore((s) => s.repos[repoId])
  if (!menu || !view) return <CM.Content><CM.Label>Nothing here</CM.Label></CM.Content>
  const snap = view.snapshot
  const head = currentBranchRef(snap)
  const headName = snap.head.branch ?? 'HEAD'

  if (menu.kind === 'ref') {
    const r = menu.ref
    const name = shortRef(r)
    const isHead = head?.name === r.name
    return (
      <CM.Content>
        <CM.Label>{r.kind === 'tag' ? `Tag ${name}` : r.kind === 'remote' ? `Remote branch ${name}` : `Branch ${name}`}</CM.Label>
        {!isHead && <CM.Item onSelect={() => void checkout(repoId, r.name)}>Check out {name}</CM.Item>}
        {!isHead && r.kind !== 'tag' && head && (
          <>
            <CM.Item onSelect={() => void merge(repoId, r.name)}>Merge {name} into {headName}</CM.Item>
            <CM.Item onSelect={() => void rebase(repoId, r.name)}>Rebase {headName} onto {name}</CM.Item>
          </>
        )}
        <CM.Separator />
        <CM.Item onSelect={() => newBranch(repoId, r.name)}>Create branch here…</CM.Item>
        {r.kind === 'local' && (
          <>
            {isHead && <CM.Item onSelect={() => push(repoId)}>Push {name}</CM.Item>}
            <CM.Item onSelect={() => renameBranch(repoId, name)}>Rename {name}…</CM.Item>
            {!isHead && <CM.Item danger onSelect={() => void deleteBranch(repoId, name)}>Delete {name}</CM.Item>}
          </>
        )}
        {r.kind === 'remote' && <CM.Item danger onSelect={() => deleteRemoteBranch(repoId, r.name)}>Delete {name} on remote…</CM.Item>}
        {r.kind === 'tag' && <CM.Item danger onSelect={() => void deleteTag(repoId, name)}>Delete tag {name}</CM.Item>}
        <CM.Separator />
        <CM.Item onSelect={() => copy(name, 'Copied name')}>Copy name</CM.Item>
      </CM.Content>
    )
  }

  const hash = menu.hash
  const commit = getLog(repoId).commits[getLog(repoId).index.get(hash) ?? -1]
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
      <CM.Sub label={`Reset ${headName} to here`}>
        <CM.Item onSelect={() => void reset(repoId, hash, 'soft')}>Soft: keep changes staged</CM.Item>
        <CM.Item onSelect={() => void reset(repoId, hash, 'mixed')}>Mixed: keep changes unstaged</CM.Item>
        <CM.Item onSelect={() => void reset(repoId, hash, 'hard')}>Hard: discard changes (undoable)</CM.Item>
      </CM.Sub>
      <CM.Separator />
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
