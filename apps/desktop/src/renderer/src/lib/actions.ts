import type { Ref, RepoSnapshot, ResetMode } from '@gitsquid/shared'
import { api } from './api'
import { toUiError } from './api'
import { activeRepo, addRepo, onSnapshot, openRepo, refreshAux, toast, toastError, updateRepo, useStore } from './store'

/** The undo entry ids an action produced: a single id, an array of them (multi-step actions), or none. */
function undoIdsOf(result: unknown): number[] {
  if (typeof result === 'number') return [result]
  if (Array.isArray(result)) return result.filter((x): x is number => typeof x === 'number')
  return []
}

/**
 * Every user-visible git action goes through `run`. It shows progress, turns failures into a
 * toast with git's own stderr, and offers Undo on success instead of asking "are you sure?"
 * beforehand. Confirmation dialogs are kept for the few things undo cannot reverse (anything
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
  opts: { quiet?: boolean; success?: string } = {},
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
    if (snap?.operation && snap.status.some((x) => x.kind === 'unmerged')) {
      onSnapshot(snap)
      updateRepo(id, { center: { kind: 'conflicts' } })
      toast({ kind: 'info', title: `${capitalize(snap.operation)} stopped on conflicts`, detail: 'Resolve them, then continue.' })
    } else {
      toastError(`${label} failed`, e)
    }
    return false
  } finally {
    updateRepo(id, { busy: null })
    void refreshAux(id)
  }
}

function capitalize(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1)
}

/** Undo the most recent operation (toolbar, Ctrl/Cmd+Z, palette). */
export async function undo(id: string): Promise<void> {
  updateRepo(id, { busy: 'Undo' })
  try {
    const label = await api.undo(id)
    toast({ kind: label ? 'success' : 'info', title: label ? `Undid: ${label}` : 'Nothing to undo' })
  } catch (e) {
    toastError('Undo failed', e)
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
    toastError('Undo failed', e)
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
    toast({
      kind: 'error', title: `${dir} is not a git repository`, detail: String((e as Error).message ?? e),
      action: { label: 'Initialize it', run: () => void initRepo(dir) },
    })
  }
}

export async function initRepo(dir?: string): Promise<void> {
  const target = dir ?? (await api.pickDirectory())
  if (!target) return
  try {
    addRepo(await api.initRepo(target))
  } catch (e) {
    toastError('Could not create the repository', e)
  }
}

export async function cloneRepo(url: string, parent: string): Promise<boolean> {
  useStore.setState({ cloneProgress: 'Starting clone…' })
  try {
    addRepo(await api.cloneRepo(url, parent))
    return true
  } catch (e) {
    toastError('Clone failed', e)
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

export const checkout = (id: string, ref: string) =>
  run(id, `Check out ${shortRef(ref)}`, () => api.checkout(id, ref))

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

export async function deleteBranch(id: string, name: string): Promise<void> {
  try {
    const entry = await api.deleteBranch(id, name)
    toast({ kind: 'success', title: `Deleted ${name}`, ...(entry !== null ? { action: { label: 'Undo', run: () => void undoEntries(id, [entry]) } } : {}) })
  } catch (e) {
    const err = toUiError(e)
    if (/not fully merged/.test(err.message + (err.stderr ?? ''))) {
      toast({ kind: 'error', title: `${name} is not fully merged`, detail: 'Its commits are not on any other branch. Deleting is still undoable.',
        action: { label: 'Delete anyway', run: () => forceDeleteBranch(id, name) } })
    } else toastError(`Delete ${name} failed`, e)
  } finally {
    void refreshAux(id)
  }
}

export function forceDeleteBranch(id: string, name: string): void {
  void run(id, `Delete ${name}`, () => api.deleteBranch(id, name, { force: true }))
}

export const merge = (id: string, ref: string, opts?: { noFf?: boolean; ffOnly?: boolean }) =>
  run(id, `Merge ${shortRef(ref)}`, () => api.merge(id, ref, opts))

export const rebase = (id: string, onto: string) =>
  run(id, `Rebase onto ${shortRef(onto)}`, () => api.rebase(id, onto))

export const reset = (id: string, hash: string, mode: ResetMode) =>
  run(id, `Reset (${mode}) to ${hash.slice(0, 7)}`, () => api.reset(id, hash, mode))

export const cherryPick = (id: string, hash: string) =>
  run(id, `Cherry-pick ${hash.slice(0, 7)}`, () => api.cherryPick(id, hash))

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
  confirmAction(`Delete ${shortRef(ref)} on the remote?`, 'This deletes the branch for everyone. Undo cannot reverse changes to a remote.', 'Delete remote branch', () => {
    void run(id, `Delete ${shortRef(ref)}`, () => api.deleteRemoteBranch(id, ref))
  })
}

// ------------------------------------------------------------------ remotes

export const fetchAll = (id: string) => run(id, 'Fetch', () => api.fetch(id, { prune: true }), { success: 'Fetched' })

export const pull = (id: string, rebaseMode = false) =>
  run(id, rebaseMode ? 'Pull (rebase)' : 'Pull', () => api.pull(id, { rebase: rebaseMode }), { success: 'Pulled' })

export function push(id: string, force = false): void {
  const go = () => void run(id, force ? 'Force push' : 'Push', () => api.push(id, { force }), { success: 'Pushed' })
  if (force) confirmAction('Force push?', 'Overwrites the remote branch with yours (with --force-with-lease, so it refuses if someone else pushed meanwhile).', 'Force push', go)
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
