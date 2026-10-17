import type { PullMode, Ref, RepoSnapshot, ResetMode } from '@gitsquid/shared'
import { api, toUiError, type UiError } from './api'
import { activeRepo, addRepo, alertConflicts, choose, onSnapshot, openRepo, refreshAux, reportError, setting, toast, updateRepo, useStore } from './store'

/** The undo entry ids an action produced: a single id, an array of them (multi-step actions), or none. */
function undoIdsOf(result: unknown): number[] {
  if (typeof result === 'number') return [result]
  if (Array.isArray(result)) return result.filter((x): x is number => typeof x === 'number')
  return []
}

/**
 * Every user-visible git action goes through `run`. It shows progress, reports failures in the
 * attention bar with git's own stderr (they stay until dismissed, so they cannot be missed), and
 * offers Undo on success instead of asking "are you sure?" beforehand. Confirmation dialogs are kept for the few things undo cannot reverse (anything
 * that changes a remote).
 *
 * Undo is offered only when the operation recorded an undo entry, and the button undoes exactly
 * that entry (the main process refuses if something newer happened since). A merge that was
 * already up to date changes nothing, so it offers nothing to undo.
 */
export async function run(
  id: string,
  label: string,
  fn: () => Promise<unknown>,
  opts: {
    quiet?: boolean
    success?: string
    /**
     * Turn a specific failure into a question (return true when handled). Failures that ask the
     * user to decide something get a choice dialog; everything else goes to the attention bar.
     */
    onError?: (err: UiError) => boolean
  } = {},
): Promise<boolean> {
  updateRepo(id, { busy: label })
  try {
    const ids = undoIdsOf(await fn())
    if (ids.length) {
      toast({ kind: 'success', title: opts.success ?? label, action: { label: 'Undo', run: () => void undoEntries(id, ids) } })
    } else if (!opts.quiet) {
      toast({ kind: 'success', title: opts.success ?? label })
    }
    return true
  } catch (e) {
    // A merge, rebase, cherry-pick or pull that stops on conflicts is not a failure to report
    // as an error: it is the start of the conflict workflow.
    const snap = await api.snapshot(id).catch(() => null)
    if (snap?.status.some((x) => x.kind === 'unmerged')) {
      onSnapshot(snap)
      updateRepo(id, { center: { kind: 'conflicts' } })
      // The pushed snapshot may have arrived first (then onSnapshot saw no change): alert anyway.
      alertConflicts(id, snap)
    } else if (!opts.onError?.(toUiError(e))) {
      reportError(`${label} failed`, e)
    }
    return false
  } finally {
    updateRepo(id, { busy: null })
    void refreshAux(id)
  }
}

/** Undo the most recent operation (toolbar, Ctrl+Z / ⌘Z, palette). */
export async function undo(id: string): Promise<void> {
  updateRepo(id, { busy: 'Undo' })
  try {
    const label = await api.undo(id)
    toast({ kind: label ? 'success' : 'info', title: label ? `Undid: ${label}` : 'Nothing to undo' })
  } catch (e) {
    reportError('Undo failed', e)
  } finally {
    updateRepo(id, { busy: null })
    void refreshAux(id)
  }
}

/** Undo specific entries (a toast's Undo button), newest first. Refused if anything newer exists. */
async function undoEntries(id: string, entries: number[]): Promise<void> {
  updateRepo(id, { busy: 'Undo' })
  try {
    const labels: string[] = []
    for (const entry of [...entries].reverse()) {
      const label = await api.undo(id, entry)
      if (label) labels.push(label)
    }
    toast({ kind: 'success', title: `Undid: ${labels.join(', ')}` })
  } catch (e) {
    reportError('Undo failed', e)
  } finally {
    updateRepo(id, { busy: null })
    void refreshAux(id)
  }
}

// ------------------------------------------------------------------ dialogs

export function ask(
  title: string, label: string, confirm: string,
  onSubmit: (value: string, extra: string) => void | Promise<void>,
  opts: { initial?: string; placeholder?: string; extra?: { label: string; placeholder?: string } } = {},
): void {
  useStore.setState({ dialog: { kind: 'input', title, label, confirm, onSubmit, ...opts } })
}

export function confirmAction(title: string, message: string, confirm: string, onConfirm: () => void | Promise<void>, danger = true): void {
  useStore.setState({ dialog: { kind: 'confirm', title, message, confirm, danger, onConfirm } })
}

// ------------------------------------------------------------------ repository

export async function openRepoDialog(): Promise<void> {
  const dir = await api.pickDirectory()
  if (!dir) return
  try {
    addRepo(await api.openRepo(dir))
    useStore.setState({ settings: await api.getSettings() })
  } catch (e) {
    choose(`${dir} is not a git repository`, 'Create a new, empty repository in this folder?', [
      { label: 'Initialize repository', variant: 'primary', run: () => initRepo(dir) },
      { label: 'Cancel' },
    ], toUiError(e).message)
  }
}

export async function initRepo(dir?: string): Promise<void> {
  const target = dir ?? (await api.pickDirectory())
  if (!target) return
  try {
    addRepo(await api.initRepo(target))
  } catch (e) {
    reportError('Could not create the repository', e)
  }
}

export async function cloneRepo(url: string, parent: string): Promise<boolean> {
  useStore.setState({ cloneProgress: 'Starting clone…' })
  try {
    addRepo(await api.cloneRepo(url, parent))
    return true
  } catch (e) {
    reportError('Clone failed', e)
    return false
  } finally {
    useStore.setState({ cloneProgress: null })
  }
}

export function reopen(path: string): void {
  void openRepo(path)
}

// ------------------------------------------------------------------ branches and commits

export function shortRef(ref: Ref | string): string {
  const name = typeof ref === 'string' ? ref : ref.name
  return name.replace(/^refs\/(heads|remotes|tags)\//, '')
}

export function currentBranchRef(snap: RepoSnapshot): Ref | undefined {
  return snap.head.branch ? snap.refs.find((r) => r.name === `refs/heads/${snap.head.branch}`) : undefined
}

/** Lines git prints with tab indentation: file lists in "would be overwritten" messages. */
function listedFiles(err: UiError): string {
  return (err.stderr ?? '').split('\n').filter((l) => l.startsWith('\t')).map((l) => l.trim()).join('\n')
}

export const checkout = (id: string, ref: string) =>
  run(id, `Check out ${shortRef(ref)}`, () => api.checkout(id, ref), {
    onError: (err) => {
      if (!/would be overwritten by checkout/.test(err.message + (err.stderr ?? ''))) return false
      // A question, not just a failure: offer the usual way through.
      choose(`Local changes are in the way of ${shortRef(ref)}`,
        'Checking out would overwrite these files. Stash your changes (including untracked files) and check out? You can pop the stash afterwards, or undo.',
        [
          {
            label: 'Stash and check out', variant: 'primary',
            run: () => void run(id, `Check out ${shortRef(ref)}`, async () => [
              await api.stashPush(id, { includeUntracked: true, message: `GitSquid: before checking out ${shortRef(ref)}` }),
              await api.checkout(id, ref),
            ]),
          },
          { label: 'Cancel' },
        ], listedFiles(err) || err.stderr)
      return true
    },
  })

export function newBranch(id: string, at?: string): void {
  ask('New branch', 'Branch name', 'Create and check out', (name) => {
    void run(id, `Create branch ${name}`, () => api.createBranch(id, name.trim(), { at, checkout: true }))
  }, { placeholder: 'feature/my-change' })
}

export function renameBranch(id: string, name: string): void {
  ask(`Rename ${name}`, 'New name', 'Rename', (to) => {
    void run(id, `Rename ${name}`, () => api.renameBranch(id, name, to.trim()))
  }, { initial: name })
}

export function deleteBranch(id: string, name: string): Promise<boolean> {
  return run(id, `Delete ${name}`, () => api.deleteBranch(id, name), {
    success: `Deleted ${name}`,
    onError: (err) => {
      if (!/not fully merged/.test(err.message + (err.stderr ?? ''))) return false
      choose(`${name} is not fully merged`,
        `Some commits on ${name} are not on any other branch. Deleting the branch leaves them unreachable. You can still undo the deletion right afterwards.`,
        [
          { label: 'Delete anyway', variant: 'danger', run: () => forceDeleteBranch(id, name) },
          { label: 'Keep branch' },
        ], err.stderr)
      return true
    },
  })
}

export function forceDeleteBranch(id: string, name: string): void {
  void run(id, `Delete ${name}`, () => api.deleteBranch(id, name, { force: true }))
}

export const merge = (id: string, ref: string, opts?: { noFf?: boolean; ffOnly?: boolean }) =>
  run(id, `Merge ${shortRef(ref)}`, () => api.merge(id, ref, opts))

export const rebase = (id: string, onto: string) =>
  run(id, `Rebase onto ${shortRef(onto)}`, () => api.rebase(id, onto))

export function reset(id: string, hash: string, mode: ResetMode): Promise<boolean> {
  const go = () => run(id, `Reset (${mode}) to ${hash.slice(0, 7)}`, () => api.reset(id, hash, mode))
  if (mode !== 'hard' || !setting('confirmHardReset')) return go()
  return new Promise((resolve) => confirmAction('Reset hard?', `Moves the branch to ${hash.slice(0, 7)} and discards uncommitted changes. Undo can bring them back.`, 'Reset hard', async () => resolve(await go())))
}

/** Discard changes in files, asking first only if Settings → Confirmations says so (it is undoable). */
export function discard(id: string, paths: string[]): Promise<boolean> {
  const go = () => run(id, `Discard ${paths.length === 1 ? paths[0] : `${paths.length} files`}`, () => api.discardPaths(id, paths))
  if (!setting('confirmDiscard')) return go()
  return new Promise((resolve) => confirmAction('Discard changes?', `${paths.length === 1 ? paths[0] : `${paths.length} files`} will go back to their last committed or staged state. Undo can bring the changes back.`, 'Discard', async () => resolve(await go())))
}

export const cherryPick = (id: string, hash: string) =>
  run(id, `Cherry-pick ${hash.slice(0, 7)}`, () => api.cherryPick(id, hash))

export const cherryPickMany = (id: string, hashes: string[]) =>
  run(id, `Cherry-pick ${hashes.length} commits`, () => api.cherryPickMany(id, hashes))

/** Copy several commits as one diff or as format-patch text. */
export async function copyCommits(id: string, hashes: string[], format: 'diff' | 'patch'): Promise<void> {
  try {
    copy(await api.commitsText(id, hashes, format), format === 'diff' ? `Copied the diff of ${hashes.length} commits` : `Copied ${hashes.length} patches`)
  } catch (e) {
    reportError(`Could not copy the ${format}`, e)
  }
}

export const dropCommits = (id: string, hashes: string[]) =>
  run(id, hashes.length === 1 ? `Drop ${hashes[0]!.slice(0, 7)}` : `Drop ${hashes.length} commits`, () => api.dropCommits(id, hashes))

export const moveCommits = (id: string, hashes: string[], target: string, where: 'above' | 'below') =>
  run(id, hashes.length === 1 ? `Move ${hashes[0]!.slice(0, 7)}` : `Move ${hashes.length} commits`, () => api.moveCommits(id, hashes, target, where))

export const revert = (id: string, hash: string) =>
  run(id, `Revert ${hash.slice(0, 7)}`, () => api.revert(id, hash))

export function newTag(id: string, hash: string): void {
  ask('New tag', 'Tag name', 'Create tag', (name, message) => {
    void run(id, `Create tag ${name}`, () => api.createTag(id, name.trim(), hash, message.trim() || undefined))
  }, { placeholder: 'v1.0.0', extra: { label: 'Message (optional, makes an annotated tag)' } })
}

export const deleteTag = (id: string, name: string) =>
  run(id, `Delete tag ${name}`, () => api.deleteTag(id, name))

export function deleteRemoteBranch(id: string, ref: string): void {
  if (!setting('confirmDeleteRemoteBranch')) {
    void run(id, `Delete ${shortRef(ref)}`, () => api.deleteRemoteBranch(id, ref))
    return
  }
  confirmAction(`Delete ${shortRef(ref)} on the remote?`, 'This deletes the branch for everyone. Undo cannot reverse changes to a remote.', 'Delete remote branch', () => {
    void run(id, `Delete ${shortRef(ref)}`, () => api.deleteRemoteBranch(id, ref))
  })
}

export async function openTerminal(id: string): Promise<void> {
  try {
    await api.openTerminal(id)
  } catch (e) {
    reportError('Could not open a terminal', e)
  }
}

export async function openInEditor(path: string, line?: number): Promise<void> {
  try {
    await api.openInEditor(path, line)
  } catch (e) {
    reportError('Could not open the editor', e)
  }
}

// ------------------------------------------------------------------ remotes

export const fetchAll = (id: string, opts: { quiet?: boolean } = {}) =>
  run(id, 'Fetch', () => api.fetch(id, { prune: setting('pruneOnFetch') }), { success: 'Fetched', quiet: opts.quiet })

const PULL_LABEL: Record<PullMode, string> = { merge: 'Pull', rebase: 'Pull (rebase)', 'ff-only': 'Pull (fast-forward only)' }

/** Pull with the mode from Settings → Git, or an explicit one from the Pull menu. */
export const pull = (id: string, mode: PullMode = setting('pullMode')) =>
  run(id, PULL_LABEL[mode], () => api.pull(id, { mode }), { success: 'Pulled' })

export function push(id: string, force = false): void {
  const go = () => void run(id, force ? 'Force push' : 'Push', () => api.push(id, { force }), {
    success: 'Pushed',
    onError: (err) => {
      if (force || !/\[rejected\]|non-fast-forward|fetch first/.test(err.message + (err.stderr ?? ''))) return false
      choose('The remote has commits you do not have',
        'Someone pushed to this branch since you last pulled. Pull their commits first, then push.',
        [
          { label: 'Pull, then push', variant: 'primary', run: async () => { if (await pull(id)) push(id) } },
          { label: 'Force push (with lease)…', variant: 'danger', run: () => push(id, true) },
          { label: 'Cancel' },
        ], err.stderr)
      return true
    },
  })
  if (force && setting('confirmForcePush')) confirmAction('Force push?', 'Overwrites the remote branch with yours (with --force-with-lease, so it refuses if someone else pushed meanwhile).', 'Force push', go)
  else go()
}

// ------------------------------------------------------------------ stash

export function stash(id: string): void {
  const view = useStore.getState().repos[id]
  if (!view?.snapshot.status.length) {
    toast({ kind: 'info', title: 'No changes to stash' })
    return
  }
  void run(id, 'Stash', () => api.stashPush(id, { includeUntracked: true }), { success: 'Changes stashed' })
}

export function pop(id: string, index = 0): void {
  const view = useStore.getState().repos[id]
  if (!view?.stashes.length) {
    toast({ kind: 'info', title: 'No stashes' })
    return
  }
  void run(id, 'Pop stash', () => api.stashPop(id, index), { success: 'Stash popped' })
}

export const stashApply = (id: string, index: number) => run(id, 'Apply stash', () => api.stashApply(id, index), { success: 'Stash applied' })
export const stashDrop = (id: string, index: number) => run(id, 'Drop stash', () => api.stashDrop(id, index), { success: 'Stash dropped' })

// ------------------------------------------------------------------ drag and drop

export interface DropOption {
  label: string
  run: () => void
}

/**
 * What dropping branch `source` onto `target` can mean. GitKraken's rule of thumb: the
 * operations act on the branch that is checked out, so the options depend on which side is HEAD.
 */
export function dropOptions(id: string, snap: RepoSnapshot, source: Ref, target: { ref?: Ref; hash: string }): DropOption[] {
  const head = currentBranchRef(snap)
  const src = shortRef(source)
  const targetName = target.ref ? shortRef(target.ref) : target.hash.slice(0, 7)
  const targetRev = target.ref?.name ?? target.hash
  if (target.ref && target.ref.name === source.name) return []
  const opts: DropOption[] = []

  if (head && target.ref?.name === head.name) {
    // Dropped onto the checked-out branch: bring the source into it.
    opts.push({ label: `Merge ${src} into ${targetName}`, run: () => void merge(id, source.name) })
    opts.push({ label: `Fast-forward ${targetName} to ${src}`, run: () => void merge(id, source.name, { ffOnly: true }) })
    opts.push({ label: `Rebase ${targetName} onto ${src}`, run: () => void rebase(id, source.name) })
  } else if (head && source.name === head.name) {
    // Dragged the checked-out branch onto something else.
    opts.push({ label: `Rebase ${src} onto ${targetName}`, run: () => void rebase(id, targetRev) })
    opts.push({ label: `Merge ${targetName} into ${src}`, run: () => void merge(id, targetRev) })
    opts.push({ label: `Reset ${src} to ${targetName} (keep changes)`, run: () => void reset(id, target.hash, 'mixed') })
    opts.push({ label: `Reset ${src} to ${targetName} (hard)`, run: () => void reset(id, target.hash, 'hard') })
  } else if (target.ref?.kind === 'local' && source.kind !== 'tag') {
    opts.push({
      label: `Check out ${targetName} and merge ${src} into it`,
      run: () => void run(id, `Merge ${src} into ${targetName}`, async () => [
        await api.checkout(id, target.ref!.name),
        await api.merge(id, source.name),
      ]),
    })
  }
  if (source.kind === 'local' && !(head && source.name === head.name)) {
    opts.push({
      label: `Check out ${src} and rebase it onto ${targetName}`,
      run: () => void run(id, `Rebase ${src} onto ${targetName}`, async () => [
        await api.checkout(id, source.name),
        await api.rebase(id, targetRev),
      ]),
    })
  }
  return opts
}

export function copy(text: string, what = 'Copied'): void {
  void navigator.clipboard.writeText(text).then(() => toast({ kind: 'info', title: what }, 1500))
}

export function currentId(): string | null {
  return activeRepo()?.id ?? null
}
