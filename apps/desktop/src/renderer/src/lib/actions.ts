import { parseGitHubRemote, type DiffTarget, type GraphFilter, type PullMode, type Ref, type RepoSnapshot, type ResetMode, type Worktree } from '@gitsquid/shared'
import { api, toUiError, type UiError } from './api'
import { withPushChecks } from './pushchecks'
import { activeRepo, addRepo, alertConflicts, ensureLoaded, choose, onSnapshot, openRepo, refreshAux, reportError, setting, toast, updateRepo, useStore } from './store'

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

export const merge = (id: string, ref: string, opts?: { noFf?: boolean; ffOnly?: boolean; squash?: boolean; noCommit?: boolean }) =>
  run(id, opts?.squash ? `Squash ${shortRef(ref)}` : `Merge ${shortRef(ref)}`, () => api.merge(id, ref, opts), {
    success: opts?.squash ? `${shortRef(ref)}'s changes are staged: commit them to finish` : opts?.noCommit ? 'Merged without committing: adjust, then commit' : undefined,
  }).then((ok) => {
    // The changes wait in the commit box, with git's prepared message.
    if (ok && (opts?.squash || opts?.noCommit)) updateRepo(id, { selected: { kind: 'wip' }, center: { kind: 'graph' } })
    return ok
  })

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

export const squashOnto = (id: string, hashes: string[], target: string) =>
  run(id, `Squash into ${target.slice(0, 7)}`, () => api.squashOnto(id, hashes, target))

/** Squash several selected commits (graph order, newest first) into one: the rest fold into the oldest. */
export const squashTogether = (id: string, hashes: string[]) =>
  run(id, `Squash ${hashes.length} commits`, () => api.squashOnto(id, hashes.slice(0, -1), hashes[hashes.length - 1]!))

export const squashCommit = (id: string, hash: string, mode: 'squash' | 'fixup') =>
  run(id, `${mode === 'squash' ? 'Squash' : 'Fixup'} ${hash.slice(0, 7)}`, () => api.squashCommit(id, hash, mode))

export const fixupInto = (id: string, target: string) =>
  run(id, `Fixup into ${target.slice(0, 7)}`, () => api.fixupInto(id, target))

/** Edit a commit's whole message (subject and body) in a text dialog. */
export async function reword(id: string, hash: string): Promise<void> {
  let current = ''
  try {
    const d = await api.commitDetails(id, hash)
    current = d.body ? `${d.subject}\n\n${d.body}` : d.subject
  } catch (e) {
    reportError('Could not read the commit', e)
    return
  }
  useStore.setState({
    dialog: {
      kind: 'text', title: `Reword ${hash.slice(0, 7)}`, initial: current, confirm: 'Reword',
      onSubmit: (message) => void run(id, `Reword ${hash.slice(0, 7)}`, () => api.rewordCommit(id, hash, message)),
    },
  })
}

export async function redo(id: string): Promise<void> {
  updateRepo(id, { busy: 'Redo' })
  try {
    const label = await api.redo(id)
    toast({ kind: label ? 'success' : 'info', title: label ? `Redid: ${label}` : 'Nothing to redo' })
  } catch (e) {
    reportError('Redo failed', e)
  } finally {
    updateRepo(id, { busy: null })
    void refreshAux(id)
  }
}

export const moveCommits = (id: string, hashes: string[], target: string, where: 'above' | 'below') =>
  run(id, hashes.length === 1 ? `Move ${hashes[0]!.slice(0, 7)}` : `Move ${hashes.length} commits`, () => api.moveCommits(id, hashes, target, where))

/** Show what differs between two revisions (or a revision and the working tree) in the details panel. */
export function compare(id: string, from: string, to: string | null, fromLabel = from.slice(0, 7), toLabel = to ? to.slice(0, 7) : 'working tree'): void {
  updateRepo(id, { selected: { kind: 'compare', from, to, fromLabel, toLabel }, center: { kind: 'graph' } })
}

/** What a branch changed since it forked from another (three-dot, like a pull request shows). */
export async function compareSinceFork(id: string, base: string, branch: string): Promise<void> {
  try {
    const fork = await api.mergeBase(id, base, branch)
    compare(id, fork, branch, `fork point of ${shortRef(base)}`, shortRef(branch))
  } catch (e) {
    reportError('Could not find where they forked', e)
  }
}

// ------------------------------------------------------------------ GitHub pull requests

/** Does any remote point at GitHub? (Decides whether pull request features show at all.) */
export function hasGitHubRemote(view: { remotes: { fetchUrl: string }[] }): boolean {
  return view.remotes.some((r) => parseGitHubRemote(r.fetchUrl))
}

/** Ask GitHub for the open pull requests (only on request: opening the list, or refresh). */
export async function loadPulls(id: string): Promise<void> {
  updateRepo(id, { pullsLoading: true })
  try {
    updateRepo(id, { pulls: await api.pullRequests(id) })
  } catch (e) {
    reportError('Could not load pull requests', e)
  } finally {
    updateRepo(id, { pullsLoading: false })
  }
}

export const checkoutPull = (id: string, num: number) =>
  run(id, `Check out pull request #${num}`, () => api.checkoutPullRequest(id, num))

export function openPull(url: string): void {
  void api.openPullRequest(url).catch((e) => reportError('Could not open the pull request', e))
}

export function createPull(id: string, branch: string): void {
  useStore.setState({ dialog: { kind: 'create-pr', repoId: id, branch } })
}

// ------------------------------------------------------------------ Git LFS

export const lfsSetUp = (id: string) => run(id, 'Set up Git LFS', () => api.lfsInstall(id), { success: 'Git LFS is set up in this repository' })

export function lfsTrack(id: string, pattern?: string): void {
  if (pattern) {
    void run(id, `Track ${pattern} with LFS`, () => api.lfsTrack(id, pattern, true), { success: `${pattern} goes through LFS now (commit .gitattributes)` })
    return
  }
  ask('Track with Git LFS', 'Pattern', 'Track', (p) => lfsTrack(id, p.trim()), { placeholder: '*.psd' })
}

export const lfsUntrack = (id: string, pattern: string) =>
  run(id, `Stop tracking ${pattern} with LFS`, () => api.lfsTrack(id, pattern, false))

export const lfsPull = (id: string) => run(id, 'Pull LFS files', () => api.lfsPull(id), { success: 'LFS files downloaded' })

export const lfsLock = (id: string, path: string, lock: boolean, force = false) =>
  run(id, `${lock ? 'Lock' : 'Unlock'} ${path}`, () => api.lfsLock(id, path, lock, force), { success: `${lock ? 'Locked' : 'Unlocked'} ${path}` })

/** The LFS pattern a file would be tracked under: its extension, or the file itself. */
export function lfsPatternFor(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `*${name.slice(dot)}` : path
}

// ------------------------------------------------------------------ external tools

/**
 * Open a diff in the external diff tool. Not through run(): the call lasts until the tool is
 * closed, and the repository should not look busy all that time.
 */
export async function openDiffTool(id: string, target: DiffTarget): Promise<void> {
  toast({ kind: 'info', title: `Opening ${target.path} in ${setting('diffTool') || 'your diff tool'}…` }, 2000)
  try {
    await api.diffTool(id, target)
  } catch (e) {
    reportError('The diff tool failed', e)
  }
}

/** Resolve a conflicted file in the external merge tool; the snapshot afterwards shows the result. */
export async function openMergeTool(id: string, path: string): Promise<void> {
  toast({ kind: 'info', title: `Opening ${path} in ${setting('mergeTool') || 'your merge tool'}…` }, 2000)
  try {
    await api.mergeTool(id, path)
  } catch (e) {
    reportError('The merge tool failed', e)
  }
}

// ------------------------------------------------------------------ patches

export async function savePatches(id: string, hashes: string[]): Promise<void> {
  try {
    const paths = await api.savePatches(id, hashes)
    if (paths) toast({ kind: 'success', title: `Saved ${paths.length} patch${paths.length === 1 ? '' : 'es'}`, detail: paths.map((p) => p.split(/[\\/]/).pop()).join('\n') })
  } catch (e) {
    reportError('Could not save the patches', e)
  }
}

/** format-patch output carries authors and messages, so it becomes commits; a bare diff becomes changes. */
const isMailbox = (text: string) => /^From [0-9a-f]{40} /m.test(text)

function applyPatchText(id: string, text: string): Promise<boolean> {
  const mail = isMailbox(text)
  return run(id, mail ? 'Apply patches' : 'Apply patch', () => api.applyPatch(id, text), {
    success: mail ? 'Applied as commits' : 'Patch applied: the changes are staged',
  }).then((ok) => {
    if (ok && !mail) updateRepo(id, { selected: { kind: 'wip' }, center: { kind: 'graph' } })
    return ok
  })
}

export async function applyPatchFile(id: string): Promise<void> {
  const text = await api.pickPatch().catch((e) => {
    reportError('Could not read the patch', e)
    return null
  })
  if (text !== null) await applyPatchText(id, text)
}

export async function applyPatchFromClipboard(id: string): Promise<void> {
  const text = await navigator.clipboard.readText().catch(() => '')
  if (!text.trim()) {
    toast({ kind: 'info', title: 'The clipboard has no text to apply' })
    return
  }
  await applyPatchText(id, text)
}

export const revert = (id: string, hash: string) =>
  run(id, `Revert ${hash.slice(0, 7)}`, () => api.revert(id, hash))

export function newTag(id: string, hash: string): void {
  ask('New tag', 'Tag name', 'Create tag', (name, message) => {
    const sign = setting('signTags')
    void run(id, `Create tag ${name}`, () => api.createTag(id, name.trim(), hash, message.trim() || undefined, { sign }), { success: sign ? `Created signed tag ${name.trim()}` : undefined })
  }, { placeholder: 'v1.0.0', extra: { label: setting('signTags') ? 'Message (signed tags are annotated; default: the tag name)' : 'Message (optional, makes an annotated tag)' } })
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
  // The checks run before the force-push question: no point confirming a push they will stop.
  const checked = () => void withPushChecks(id, undefined, go)
  if (force && setting('confirmForcePush')) confirmAction('Force push?', 'Overwrites the remote branch with yours (with --force-with-lease, so it refuses if someone else pushed meanwhile).', 'Force push', checked)
  else checked()
}

// ------------------------------------------------------------------ managing remotes, tags and tracking

/** Remote names: configured ones first, then any only known from their branches. */
export function remoteNames(view: { remotes: { name: string }[]; snapshot: RepoSnapshot }): string[] {
  const names = view.remotes.map((r) => r.name)
  for (const r of view.snapshot.refs) {
    if (r.kind !== 'remote') continue
    const name = r.shortName.split('/')[0]!
    if (!names.includes(name)) names.push(name)
  }
  return names
}

export function addRemote(id: string): void {
  const taken = useStore.getState().repos[id]?.remotes.some((r) => r.name === 'origin')
  ask('Add remote', 'Name', 'Add remote', (name, url) => {
    if (!url.trim()) {
      reportError('Add remote failed', new Error('A remote needs a URL.'))
      return
    }
    void run(id, `Add remote ${name.trim()}`, () => api.addRemote(id, name.trim(), url.trim())).then((ok) => {
      // A new remote has no branches until it is fetched; fetching is what the user wants next.
      if (ok) void run(id, `Fetch ${name.trim()}`, () => api.fetch(id, { remote: name.trim() }), { quiet: true })
    })
  }, { initial: taken ? 'upstream' : 'origin', extra: { label: 'URL', placeholder: 'https://github.com/owner/repo.git' } })
}

export const fetchRemote = (id: string, remote: string) =>
  run(id, `Fetch ${remote}`, () => api.fetch(id, { remote, prune: setting('pruneOnFetch') }), { success: `Fetched ${remote}` })

export function renameRemote(id: string, remote: string): void {
  ask(`Rename remote ${remote}`, 'New name', 'Rename', (to) => {
    void run(id, `Rename ${remote}`, () => api.renameRemote(id, remote, to.trim()))
  }, { initial: remote })
}

/** Edit a remote's URL, or its push URL (`push`): an empty push URL means "push where you fetch". */
export function editRemoteUrl(id: string, remote: string, push = false): void {
  const r = useStore.getState().repos[id]?.remotes.find((x) => x.name === remote)
  const initial = push ? (r?.pushUrl ?? r?.fetchUrl ?? '') : (r?.fetchUrl ?? '')
  ask(push ? `Push URL for ${remote}` : `URL for ${remote}`, push ? 'Push URL' : 'URL', 'Save', (url) => {
    void run(id, `Change ${remote}'s URL`, () => api.setRemoteUrl(id, remote, url.trim(), push))
  }, { initial })
}

export const clearPushUrl = (id: string, remote: string) =>
  run(id, `Change ${remote}'s push URL`, () => api.setRemoteUrl(id, remote, null, true))

/** Remove a remote. Only local configuration changes (and its remote-tracking branches go), so it is undoable. */
export const removeRemote = (id: string, remote: string) =>
  run(id, `Remove remote ${remote}`, () => api.removeRemote(id, remote))

export function pushTags(id: string, remote: string, name: string | null): Promise<boolean> {
  return run(id, name ? `Push tag ${name}` : 'Push tags', () => api.pushTags(id, remote, name), {
    success: name ? `Pushed ${name} to ${remote}` : `Pushed all tags to ${remote}`,
  }).then(async (ok) => {
    // Keep a check the user already ran up to date (it is local knowledge now, no new request).
    const checked = useStore.getState().repos[id]?.remoteTags
    if (ok && checked?.remote === remote) {
      const local = useStore.getState().repos[id]!.snapshot.refs.filter((r) => r.kind === 'tag').map((r) => r.shortName)
      updateRepo(id, { remoteTags: { remote, names: [...new Set([...checked.names, ...(name ? [name] : local)])] } })
    }
    return ok
  })
}

export function deleteRemoteTag(id: string, remote: string, name: string): void {
  confirmAction(`Delete tag ${name} on ${remote}?`, 'This deletes the tag for everyone. Undo cannot reverse changes to a remote; your local tag stays.', 'Delete remote tag', () => {
    void run(id, `Delete ${name} on ${remote}`, () => api.deleteRemoteTag(id, remote, name)).then((ok) => {
      const checked = useStore.getState().repos[id]?.remoteTags
      if (ok && checked?.remote === remote) updateRepo(id, { remoteTags: { remote, names: checked.names.filter((n) => n !== name) } })
    })
  })
}

/** Ask a remote which tags it has, so the sidebar can mark the ones that exist only here. */
export async function checkRemoteTags(id: string, remote: string): Promise<void> {
  updateRepo(id, { busy: `Asking ${remote} for its tags` })
  try {
    const names = await api.remoteTags(id, remote)
    updateRepo(id, { remoteTags: { remote, names } })
    const local = useStore.getState().repos[id]!.snapshot.refs.filter((r) => r.kind === 'tag' && !names.includes(r.shortName)).length
    toast({ kind: 'info', title: local ? `${local} tag${local === 1 ? ' is' : 's are'} not on ${remote}` : `Every tag is on ${remote}` })
  } catch (e) {
    reportError(`Could not list ${remote}'s tags`, e)
  } finally {
    updateRepo(id, { busy: null })
  }
}

/** Push a branch to a remote branch that may have another name (and track it). */
export function pushTo(id: string, branch: string, remote: string): void {
  ask(`Push ${branch} to ${remote}`, `Branch name on ${remote}`, 'Push', (remoteBranch) => {
    void withPushChecks(id, branch, () => void run(id, `Push ${branch}`, () => api.push(id, { branch, remote, remoteBranch: remoteBranch.trim() }), { success: `Pushed ${branch} to ${remote}/${remoteBranch.trim()}` }))
  }, { initial: branch })
}

/** Push a branch that is not checked out to its upstream (or the default remote). */
export const pushBranch = (id: string, branch: string) =>
  withPushChecks(id, branch, () => void run(id, `Push ${branch}`, () => api.push(id, { branch }), { success: `Pushed ${branch}` }))

export const setUpstream = (id: string, branch: string, upstream: string | null) =>
  run(id, upstream ? `Track ${shortRef(upstream)}` : `Stop tracking for ${branch}`, () => api.setUpstream(id, branch, upstream))

export const fastForward = (id: string, branch: string) =>
  run(id, `Fast-forward ${branch}`, () => api.fastForward(id, branch))

/** Days without a commit after which a branch counts as stale in the sidebar and cleanup. */
export const STALE_DAYS = 90

export function isStale(r: Ref, now = Date.now()): boolean {
  return r.date !== undefined && now / 1000 - r.date > STALE_DAYS * 86_400
}

/**
 * Branches the cleanup dialog offers: merged into HEAD or stale. Never one that is checked out,
 * here or in another worktree: git refuses to delete those, and the cleanup would stop half-way.
 */
export function cleanupCandidates(view: { snapshot: RepoSnapshot; merged: string[]; worktrees: Worktree[] }, now = Date.now()) {
  const checkedOut = new Set(view.worktrees.map((w) => w.branch).filter(Boolean))
  return view.snapshot.refs
    .filter((r) => r.kind === 'local' && r.shortName !== view.snapshot.head.branch && !checkedOut.has(r.shortName))
    .map((r) => ({ name: r.shortName, date: r.date, merged: view.merged.includes(r.shortName), stale: isStale(r, now) }))
    .filter((c) => c.merged || c.stale)
}

export function cleanupBranches(id: string): void {
  useStore.setState({ dialog: { kind: 'cleanup', repoId: id } })
}

/**
 * Delete several branches in one undoable step. `force` is needed when some are not merged
 * (stale ones usually are not); the dialog says so before the user confirms.
 */
export const deleteBranches = (id: string, names: string[], force: boolean) =>
  run(id, `Delete ${names.length} branch${names.length === 1 ? '' : 'es'}`, () => api.deleteBranches(id, names, { force }))

// ------------------------------------------------------------------ bisect

const BISECT_LABEL = { good: 'Mark good', bad: 'Mark bad', skip: 'Skip' } as const

/** Mark a commit for bisect; git checks out the next one to test (the graph follows HEAD there). */
export const bisectMark = (id: string, rev: string, term: 'good' | 'bad' | 'skip') =>
  run(id, BISECT_LABEL[term], () => api.bisectMark(id, rev, term), { quiet: true }).then(async (ok) => {
    if (!ok) return ok
    // Select the commit git just checked out for testing (or the culprit, once found).
    const snap = await api.snapshot(id)
    onSnapshot(snap)
    const show = snap.bisect?.found ?? snap.head.hash
    if (show) {
      updateRepo(id, { selected: { kind: 'commit', hash: show }, center: { kind: 'graph' } })
      void ensureLoaded(id, show)
    }
    return ok
  })

export const bisectReset = (id: string) => run(id, 'Stop bisecting', () => api.bisectReset(id), { success: 'Bisect finished: back where you started' })

// ------------------------------------------------------------------ hide and solo in the graph

function setFilter(id: string, change: (f: GraphFilter) => GraphFilter): void {
  const view = useStore.getState().repos[id]
  if (!view) return
  const next = change(view.snapshot.filter ?? { hidden: [], solo: [] })
  void api.setGraphFilter(id, next).catch((e) => reportError('Could not change what the graph shows', e))
}

/** Hide a ref (a full name, or "refs/remotes/<remote>/*" for all of a remote) in the graph. */
export const hideInGraph = (id: string, ref: string) =>
  setFilter(id, (f) => ({ hidden: [...f.hidden, ref], solo: f.solo.filter((r) => r !== ref) }))
export const showInGraph = (id: string, ref: string) => setFilter(id, (f) => ({ ...f, hidden: f.hidden.filter((r) => r !== ref) }))
/** Add a ref to the solo set: the graph then shows only soloed refs (and HEAD). */
export const soloInGraph = (id: string, ref: string) =>
  setFilter(id, (f) => ({ hidden: f.hidden.filter((r) => r !== ref), solo: [...f.solo, ref] }))
export const unsoloInGraph = (id: string, ref: string) => setFilter(id, (f) => ({ ...f, solo: f.solo.filter((r) => r !== ref) }))
export const showAllInGraph = (id: string) => setFilter(id, () => ({ hidden: [], solo: [] }))

// ------------------------------------------------------------------ worktrees

/** Where a new worktree goes by default: beside the repository, named after it and the branch. */
export function defaultWorktreePath(repoPath: string, branch: string): string {
  const sep = repoPath.includes('\\') && !repoPath.includes('/') ? '\\' : '/'
  const trimmed = repoPath.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return `${trimmed.slice(0, cut)}${sep}${trimmed.slice(cut + 1)}-${branch.replace(/[^\w.-]+/g, '-')}`
}

/** Check out a branch in a new worktree, or (no branch) make a new branch in one. Opens it as a tab. */
export function addWorktree(id: string, branch?: string): void {
  const repoPath = useStore.getState().repos[id]?.snapshot.path ?? ''
  const go = (path: string, opts: { branch?: string; newBranch?: string }) =>
    void run(id, 'Add worktree', () => api.addWorktree(id, path, opts), { success: `Worktree ready at ${path}` }).then((ok) => {
      if (ok) void openRepo(path)
    })
  if (branch) {
    ask(`Check out ${branch} in a new worktree`, 'Folder', 'Create worktree', (path) => go(path.trim(), { branch }), { initial: defaultWorktreePath(repoPath, branch) })
  } else {
    ask('New worktree', 'New branch', 'Create worktree', (name, folder) => go(folder.trim() || defaultWorktreePath(repoPath, name.trim()), { newBranch: name.trim() }),
      { placeholder: 'feature/next', extra: { label: 'Folder (empty: next to this repository)' } })
  }
}

export function removeWorktree(id: string, path: string): void {
  void run(id, 'Remove worktree', () => api.removeWorktree(id, path), {
    onError: (err) => {
      if (!/modified or untracked|is dirty|contains/.test(err.message + (err.stderr ?? ''))) return false
      choose('The worktree has changes', 'Removing it deletes uncommitted changes and untracked files in it. Undo cannot bring those back.', [
        { label: 'Delete the worktree and its changes', variant: 'danger', run: () => void run(id, 'Remove worktree', () => api.removeWorktree(id, path, { force: true })) },
        { label: 'Keep it' },
      ], err.stderr)
      return true
    },
  })
}

export const lockWorktree = (id: string, path: string, lock: boolean) =>
  run(id, lock ? 'Lock worktree' : 'Unlock worktree', () => api.lockWorktree(id, path, lock))

export const pruneWorktrees = (id: string) => run(id, 'Prune worktrees', () => api.pruneWorktrees(id), { success: 'Forgot worktrees whose folders are gone' })

// ------------------------------------------------------------------ submodules

export function addSubmodule(id: string): void {
  ask('Add submodule', 'Repository URL', 'Add submodule', (url, folder) => {
    const path = folder.trim() || url.trim().replace(/\.git$/, '').split(/[\\/:]/).filter(Boolean).pop() || 'submodule'
    void run(id, `Add submodule ${path}`, () => api.addSubmodule(id, url.trim(), path), { success: `Added ${path}: commit to record it` }).then(showStaged(id))
  }, { placeholder: 'https://github.com/owner/library.git', extra: { label: 'Folder (empty: the repository name)' } })
}

/** Check out the commits the repository records (cloning ones that are missing). */
export const updateSubmodules = (id: string, paths?: string[]) =>
  run(id, paths?.length === 1 ? `Update ${paths[0]}` : 'Update submodules', () => api.updateSubmodules(id, paths), { success: 'Submodules are at their recorded commits' })

export const syncSubmodules = (id: string) => run(id, 'Sync submodule URLs', () => api.syncSubmodules(id), { success: 'Submodule URLs copied from .gitmodules' })

export const removeSubmodule = (id: string, path: string) =>
  run(id, `Remove submodule ${path}`, () => api.removeSubmodule(id, path), { success: `Removed ${path}: commit to record it` }).then(showStaged(id))

/** After an action that leaves staged changes to commit: show them in the commit box. */
const showStaged = (id: string) => (ok: boolean) => {
  if (ok) updateRepo(id, { selected: { kind: 'wip' }, center: { kind: 'graph' } })
  return ok
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

/** The stash variants: only some files, only what is staged, or everything but leave the staged part in place. */
export function stashWith(id: string, opts: { paths?: string[]; staged?: boolean; keepIndex?: boolean; message?: string }): Promise<boolean> {
  const what = opts.paths?.length === 1 ? opts.paths[0] : opts.paths ? `${opts.paths.length} files` : opts.staged ? 'staged changes' : 'changes'
  return run(id, `Stash ${what}`, () => api.stashPush(id, { includeUntracked: !opts.staged, ...opts }), {
    success: opts.keepIndex ? 'Stashed; the staged changes are still in place' : `Stashed ${what}`,
  })
}

/** Tower's snapshot: a stash entry of the working tree, which stays exactly as it is. */
export const snapshot = (id: string) =>
  run(id, 'Snapshot', () => api.snapshotWorkTree(id), { success: 'Snapshot saved in the stash list; your changes are untouched' })

export function stashWithMessage(id: string): void {
  ask('Stash changes', 'Message', 'Stash', (message) => void stashWith(id, { message: message.trim() }), { placeholder: 'What these changes are' })
}

/** A branch where the stash was made, with the stash applied: for a stash that no longer applies here. */
export function stashToBranch(id: string, index: number): void {
  ask(`Create a branch from stash@{${index}}`, 'Branch name', 'Create branch', (name) => {
    void run(id, `Stash to branch ${name.trim()}`, () => api.stashBranch(id, index, name.trim())).then((ok) => {
      // The stash is gone; what it held is now uncommitted changes on the new branch.
      if (ok) updateRepo(id, { selected: { kind: 'wip' }, center: { kind: 'graph' } })
    })
  }, { placeholder: 'rescued-work' })
}

/**
 * Restore a file in the working copy to its version at `rev`, which may be a stash (then a file
 * the stash saved as untracked is found too).
 */
export function restoreFileFrom(id: string, path: string, rev: string): Promise<boolean> {
  const stash = useStore.getState().repos[id]?.stashes.find((s) => s.hash === rev)
  return run(id, stash ? `Take ${path} from ${stash.ref}` : `Restore ${path}`, () => api.restoreFile(id, path, rev, { stash: !!stash }))
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
    opts.push({ label: `Squash ${src} into ${targetName}`, run: () => void merge(id, source.name, { squash: true }) })
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
