import { DEFAULT_LAYOUT, setCollapsed } from '@gitgoose/shared'
import {
  lfsPull, lfsTrack, snapshot, addRemote, addSubmodule, applyPatchFile, updateSubmodules, addWorktree, applyPatchFromClipboard, cleanupBranches, fetchAll, initRepo, newBranch, openRepoDialog, openTerminal, pop, pull, push, reopen, stash, undo,
} from './actions'
import { startReview } from './review'
import { startWalkthrough } from './walkthrough'
import { showImpact } from './impact'
import { saveSettings, useStore } from './store'

export interface CommandEntry {
  id: string
  label: string
  group: string
  hint?: string
  run: () => void
}

/**
 * Every action GitGoose has, for the omni search (Ctrl+P shows only these). Built fresh each time
 * from the current state, so it always fits the active repository: an operation in progress
 * offers "Resolve conflicts", a repository with submodules "Update submodules", and so on.
 * Branches are not here: they are search results of their own (Ctrl+Enter checks one out).
 */
export function commandEntries(): CommandEntry[] {
  const { active: activeId, repos, tabs, settings } = useStore.getState()
  const active = activeId ? repos[activeId] : null
  const entries: CommandEntry[] = []
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
    add('Repository', 'Reveal in file manager', () => void window.gitgoose.revealPath(active.snapshot.path))
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
    const compact = settings.graphStyle === 'compact'
    add('Layout', compact ? 'Graph: two-line rows' : 'Graph: one-line rows',
      () => void saveSettings({ graphStyle: compact ? 'comfortable' : 'compact' }), 'Also in Settings → Appearance')
    const topo = settings.commitOrder === 'topo'
    add('Layout', topo ? 'Commit order: by date' : 'Commit order: topological',
      () => void saveSettings({ commitOrder: topo ? 'date' : 'topo' }), 'Also in Settings → Graph')
    add('App', `Theme: ${settings.theme === 'light' ? 'dark' : 'light'}`, () => void saveSettings({ theme: settings.theme === 'light' ? 'dark' : 'light' }))
    for (const p of settings.recentRepos) add('Recent', p.split(/[\\/]/).pop() ?? p, () => reopen(p), p)
  }

  return entries
}
