import { DEFAULT_LAYOUT, setCollapsed } from '@gitsquid/shared'
import { Command } from 'cmdk'
import { RDialogCompat } from './RDialogCompat'
import {
  lfsPull, lfsTrack, snapshot, addRemote, addSubmodule, applyPatchFile, updateSubmodules, addWorktree, applyPatchFromClipboard, checkout, cleanupBranches, fetchAll, initRepo, newBranch, openRepoDialog, openTerminal, pop, pull, push, reopen, stash, undo,
} from '../lib/actions'
import { startReview } from '../lib/review'
import { startWalkthrough } from '../lib/walkthrough'
import { showImpact } from '../lib/impact'
import { saveSettings, useStore } from '../lib/store'

interface Entry {
  id: string
  label: string
  group: string
  hint?: string
  run: () => void
}

/**
 * Every action, searchable by name. The list is built fresh each time it opens, so it always
 * reflects the current repository: its branches become "Check out ..." entries, and so on.
 */
export function CommandPalette() {
  const open = useStore((s) => s.palette)
  const active = useStore((s) => (s.active ? s.repos[s.active] : null))
  const tabs = useStore((s) => s.tabs)
  const repos = useStore((s) => s.repos)
  const settings = useStore((s) => s.settings)
  const close = () => useStore.setState({ palette: false })

  const entries: Entry[] = []
  const add = (group: string, label: string, run: () => void, hint?: string) => entries.push({ id: `${group}:${label}`, group, label, run, hint })

  if (active) {
    const id = active.id
    add('Repository', 'Undo last operation', () => void undo(id), active.undo[0]?.label)
    add('Repository', 'Fetch all remotes', () => void fetchAll(id))
    add('Repository', 'Pull', () => void pull(id))
    add('Repository', 'Pull with rebase', () => void pull(id, 'rebase'))
    add('Repository', 'Pull, fast-forward only', () => void pull(id, 'ff-only'))
    add('Repository', 'Open terminal here', () => void openTerminal(id))
    add('Repository', 'Push', () => push(id))
    add('Repository', 'Force push (with lease)', () => push(id, true))
    add('Repository', 'Edit pre-push checks', () => useStore.setState({ dialog: { kind: 'push-rules', repoId: id } }))
    add('Repository', 'New branch', () => newBranch(id))
    add('Repository', 'Show git command log', () => useStore.setState((s) => ({ repos: { ...s.repos, [id]: { ...s.repos[id]!, center: { kind: 'commands' } } } })))
    add('Repository', 'Show reflog (recover lost commits)', () => useStore.setState((s) => ({ repos: { ...s.repos, [id]: { ...s.repos[id]!, center: { kind: 'reflog' } } } })))
    add('Repository', 'Clean up branches…', () => cleanupBranches(id))
    add('Repository', 'Add remote…', () => addRemote(id))
    add('Repository', 'Change who you commit as…', () => useStore.setState({ dialog: { kind: 'identity', repoId: id } }))
    add('Repository', 'Add worktree…', () => addWorktree(id))
    add('Repository', 'What could the uncommitted changes affect?', () => showImpact(id, { kind: 'working' }))
    if ((useStore.getState().settings?.aiProvider ?? 'off') !== 'off') {
      add('AI', 'Review uncommitted changes', () => startReview(id, { kind: 'working' }))
      add('AI', 'Review staged changes', () => startReview(id, { kind: 'staged' }))
      add('AI', 'Review what will be pushed', () => startReview(id, { kind: 'outgoing' }))
      add('AI', 'Walk me through the uncommitted changes', () => startWalkthrough(id, { kind: 'working' }))
      if (active.snapshot.head.branch) add('AI', `Walk me through ${active.snapshot.head.branch}`, () => startWalkthrough(id, { kind: 'branch', branch: active.snapshot.head.branch! }))
      if (active.snapshot.head.branch) add('AI', `Review ${active.snapshot.head.branch} since it branched`, () => startReview(id, { kind: 'branch', branch: active.snapshot.head.branch! }))
      if (active.review) add('AI', 'Show the last review', () => useStore.setState((s) => ({ repos: { ...s.repos, [id]: { ...s.repos[id]!, center: { kind: 'review' } } } })))
    }
    if (active.lfs?.installed) add('Repository', 'Track files with Git LFS…', () => lfsTrack(id))
    if (active.lfs?.used) add('Repository', 'Pull LFS files', () => void lfsPull(id))
    add('Repository', 'Add submodule…', () => addSubmodule(id))
    if (active.submodules.length) add('Repository', 'Update submodules', () => void updateSubmodules(id))
    add('Repository', 'Apply patch from a file…', () => void applyPatchFile(id))
    add('Repository', 'Apply patch from the clipboard', () => void applyPatchFromClipboard(id))
    add('Repository', 'Stash all changes', () => stash(id))
    add('Repository', 'Save a snapshot of the working tree (changes stay)', () => void snapshot(id))
    add('Repository', 'Pop latest stash', () => pop(id))
    add('Repository', 'Show uncommitted changes', () => useStore.setState((s) => ({ repos: { ...s.repos, [id]: { ...s.repos[id]!, selected: { kind: 'wip' }, center: { kind: 'graph' } } } })))
    if (active.snapshot.operation) add('Repository', `Resolve conflicts (${active.snapshot.operation})`, () => useStore.setState((s) => ({ repos: { ...s.repos, [id]: { ...s.repos[id]!, center: { kind: 'conflicts' } } } })))
    add('Repository', 'Reveal in file manager', () => void window.gitsquid.revealPath(active.snapshot.path))
    for (const r of active.snapshot.refs) {
      if (r.kind === 'local' && r.shortName !== active.snapshot.head.branch) add('Check out', r.shortName, () => void checkout(id, r.name), 'local')
      if (r.kind === 'remote') add('Check out', r.shortName, () => void checkout(id, r.name), 'remote')
    }
  }
  for (const t of tabs) {
    const r = repos[t]
    if (r && t !== active?.id) add('Switch to', r.snapshot.name, () => useStore.setState({ active: t }), r.snapshot.path)
  }
  add('App', 'Open repository…', () => void openRepoDialog())
  add('App', 'Clone repository…', () => useStore.setState({ dialog: { kind: 'clone' } }))
  add('App', 'New repository…', () => void initRepo())
  add('App', 'Settings', () => useStore.setState({ page: 'settings' }))
  add('Layout', 'Reset panel sizes', () => void saveSettings({ layout: structuredClone(DEFAULT_LAYOUT) }))
  add('Layout', 'Hide side panels', () => void saveSettings({ layout: setCollapsed(setCollapsed(settings!.layout, 'left', true), 'right', true) }))
  add('App', 'Keyboard shortcuts', () => useStore.setState({ dialog: { kind: 'shortcuts' } }), '?')
  if (settings) {
    add('App', `Theme: ${settings.theme === 'light' ? 'dark' : 'light'}`, () => void saveSettings({ theme: settings.theme === 'light' ? 'dark' : 'light' }))
    for (const p of settings.recentRepos) add('Recent', p.split(/[\\/]/).pop() ?? p, () => reopen(p), p)
  }

  const groups = [...new Set(entries.map((e) => e.group))]
  return (
    <RDialogCompat open={open} onClose={close}>
      <Command label="Command palette" className="overflow-hidden rounded-lg border border-line bg-raised shadow-2xl shadow-black/40" loop>
        <Command.Input autoFocus placeholder="Type a command or branch name…" data-testid="palette-input"
          className="h-11 w-full border-b border-line bg-transparent px-4 text-[14px] outline-none" />
        <Command.List className="max-h-[50vh] overflow-y-auto p-1">
          <Command.Empty className="px-3 py-6 text-center text-sm text-faint">No matching commands</Command.Empty>
          {groups.map((g) => (
            <Command.Group key={g} heading={g} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-faint">
              {entries.filter((e) => e.group === g).map((e) => (
                <Command.Item key={e.id} value={`${e.group} ${e.label} ${e.hint ?? ''}`}
                  onSelect={() => { close(); e.run() }}
                  className="flex h-8 cursor-default items-center gap-2 rounded px-3 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{e.label}</span>
                  {e.hint && <span className="max-w-60 truncate text-xs text-faint">{e.hint}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </RDialogCompat>
  )
}
