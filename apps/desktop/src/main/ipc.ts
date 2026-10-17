import { GitError, Repo } from '@gitsquid/git'
import {
  API_METHODS, IPC_EVENT, IPC_INVOKE,
  type ApiMethod, type GitSquidApi, type GitSquidEvent, type IpcResult, type SerializedError,
} from '@gitsquid/shared'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { logError } from './diagnostics'
import { openInEditor, openTerminal } from './launch'
import { GITHUB_SCOPES } from '@gitsquid/shared'
import type { AiService } from './ai/service'
import type { GitHubService } from './github/service'
import type { RepoManager } from './repos'
import { forgetOpenRepo, getSettings, rememberRepo, setSettings } from './settings'

export function broadcast(event: GitSquidEvent): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC_EVENT, event)
}

/** Methods that change the repository. After each one we refresh and push a snapshot right away. */
const WRITES = new Set<ApiMethod>([
  'stagePaths', 'unstagePaths', 'discardPaths', 'applySelection', 'ignorePaths', 'commit', 'checkout', 'createBranch',
  'renameBranch', 'deleteBranch', 'merge', 'rebase', 'reset', 'cherryPick', 'cherryPickMany', 'recomposeApply', 'dropCommits', 'moveCommits', 'restoreFile', 'applyPatch', 'addWorktree', 'removeWorktree', 'lockWorktree', 'pruneWorktrees', 'addRemote', 'removeRemote', 'renameRemote', 'setRemoteUrl', 'pushTags',
  'deleteRemoteTag', 'setUpstream', 'fastForward', 'deleteBranches', 'rewordCommit', 'squashCommit', 'squashOnto', 'fixupInto', 'redo', 'revert', 'createTag',
  'deleteTag', 'fetch', 'pull', 'push', 'deleteRemoteBranch', 'stashPush', 'stashBranch', 'stashApply', 'stashPop',
  'stashDrop', 'resolveConflict', 'continueOperation', 'abortOperation', 'undo',
])

export interface PromptBroker {
  respond(id: number, answer: string | null): void
}

export function createHandlers(
  repos: RepoManager,
  prompts: PromptBroker,
  gitOpts: () => { gitPath: string; env: Record<string, string> },
  github: GitHubService,
  ai: AiService,
): GitSquidApi {
  const r = (id: string) => repos.get(id)
  const opened = async (repo: Repo) => {
    rememberRepo(repo.path)
    return repos.add(repo)
  }
  return {
    getSettings: async () => getSettings(),
    setSettings: async (patch) => setSettings(patch),
    pickDirectory: async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled ? null : (res.filePaths[0] ?? null)
    },
    openRepo: async (path) => {
      const snap = await repos.openPath(path)
      rememberRepo(snap.path)
      return snap
    },
    closeRepo: async (id) => {
      const path = await repos.close(id)
      if (path) forgetOpenRepo(path)
    },
    initRepo: async (path) => opened(await Repo.init(path, gitOpts())),
    cloneRepo: async (url, parent) => opened(await Repo.clone(url, parent, {
      ...gitOpts(), onProgress: (text) => broadcast({ type: 'progress', repoId: 'clone', text }),
    })),
    respondPrompt: async (id, answer) => prompts.respond(id, answer),

    githubStatus: async () => github.status(),
    githubSignIn: (access) => github.startSignIn(GITHUB_SCOPES[access]),
    githubWaitForSignIn: () => github.waitForSignIn(),
    githubCancelSignIn: async () => github.cancelSignIn(),
    githubOpenPage: async (page) => {
      const url = github.pageUrl(page)
      if (url) await shell.openExternal(url)
    },
    githubSignOut: async () => github.signOut(),

    aiStatus: async () => ai.status(),
    aiConsent: async () => ai.consent(),
    aiRun: (requestId, repoId, task) => ai.run(requestId, repoId, task),
    aiCancel: async (requestId) => ai.cancel(requestId),
    aiRespondPermission: async (id, optionId) => ai.respondPermission(id, optionId),
    aiAgentInfo: () => ai.agentInfo(),
    aiAuthenticate: (methodId) => ai.authenticate(methodId),
    aiSetApiKey: async (key) => ai.setApiKey(key),
    openPath: async (path) => {
      const err = await shell.openPath(path)
      if (err) throw new Error(err)
    },
    openInEditor: (path, line) => openInEditor(path, line),
    openTerminal: (id) => openTerminal(r(id).path),
    revealPath: async (path) => shell.showItemInFolder(path),
    logError: async (message) => logError('renderer', message),

    snapshot: (id) => r(id).snapshot(),
    logPage: (id, offset, count) => r(id).logPage(offset, count),
    commitDetails: (id, hash, opts) => r(id).commitDetails(hash, opts),
    diff: (id, target, opts) => r(id).diff(target, opts),
    fileHistory: (id, path) => r(id).fileHistory(path),
    blame: (id, path, rev) => r(id).blame(path, rev),
    search: (id, field, q) => r(id).search(field, q),
    stashList: (id) => r(id).stashList(),
    reflog: (id, ref) => r(id).reflog(ref),
    worktrees: (id) => r(id).worktrees(),
    addWorktree: (id, path, opts) => r(id).addWorktree(path, opts),
    removeWorktree: (id, path, opts) => r(id).removeWorktree(path, opts),
    lockWorktree: (id, path, lock, reason) => r(id).lockWorktree(path, lock, reason),
    pruneWorktrees: (id) => r(id).pruneWorktrees(),
    lastCommitMessage: (id) => r(id).lastCommitMessage(),

    stagePaths: (id, paths) => r(id).stagePaths(paths),
    unstagePaths: (id, paths) => r(id).unstagePaths(paths),
    discardPaths: (id, paths) => r(id).discardPaths(paths),
    applySelection: (id, req) => r(id).applySelection(req),
    ignorePaths: (id, paths) => r(id).ignorePaths(paths),
    commit: (id, message, opts) => r(id).commit(message, opts),

    checkout: (id, ref) => r(id).checkout(ref),
    createBranch: (id, name, opts) => r(id).createBranch(name, opts),
    renameBranch: (id, from, to) => r(id).renameBranch(from, to),
    deleteBranch: (id, name, opts) => r(id).deleteBranch(name, opts),
    merge: (id, ref, opts) => r(id).merge(ref, opts),
    rebase: (id, onto) => r(id).rebase(onto),
    reset: (id, hash, mode) => r(id).reset(hash, mode),
    cherryPick: (id, hash) => r(id).cherryPick(hash),
    cherryPickMany: (id, hashes) => r(id).cherryPickMany(hashes),
    commitsText: (id, hashes, format) => r(id).commitsText(hashes, format),
    recomposeApply: (id, hashes, commits) => r(id).recompose(hashes, commits),
    editableCommits: (id) => r(id).editableCommits(),
    remotes: (id) => r(id).remotes(),
    addRemote: (id, name, url) => r(id).addRemote(name, url),
    removeRemote: (id, name) => r(id).removeRemote(name),
    renameRemote: (id, from, to) => r(id).renameRemote(from, to),
    setRemoteUrl: (id, name, url, push) => r(id).setRemoteUrl(name, url, push),
    pushTags: (id, remote, name) => r(id).pushTags(remote, name),
    deleteRemoteTag: (id, remote, name) => r(id).deleteRemoteTag(remote, name),
    remoteTags: (id, remote) => r(id).remoteTags(remote),
    setUpstream: (id, branch, upstream) => r(id).setUpstream(branch, upstream),
    fastForward: (id, branch) => r(id).fastForward(branch),
    deleteBranches: (id, names, opts) => r(id).deleteBranches(names, opts),
    mergedBranches: (id) => r(id).mergedBranches(),
    compareFiles: (id, from, to) => r(id).compareFiles(from, to),
    mergeBase: (id, a, b) => r(id).mergeBase(a, b),
    restoreFile: (id, path, rev, opts) => r(id).restoreFile(path, rev, opts),
    openFileAt: async (id, rev, path) => {
      // A read-only copy under the temp folder, named so the editor knows the language.
      const dir = await mkdtemp(join(tmpdir(), `gitsquid-${rev.slice(0, 7)}-`))
      const file = join(dir, basename(path))
      await writeFile(file, await r(id).fileAt(rev, path))
      await chmod(file, 0o444)
      const err = await shell.openPath(file)
      if (err) throw new Error(err)
    },
    savePatches: async (id, hashes) => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { title: 'Save patches into', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (res.canceled || !res.filePaths[0]) return null
      return r(id).savePatches(hashes, res.filePaths[0])
    },
    pickPatch: async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { title: 'Apply patch', properties: ['openFile'] as 'openFile'[], filters: [{ name: 'Patches', extensions: ['patch', 'diff', 'mbox', 'eml'] }, { name: 'All files', extensions: ['*'] }] }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (res.canceled || !res.filePaths[0]) return null
      return readFile(res.filePaths[0], 'utf8')
    },
    applyPatch: (id, text) => r(id).applyPatch(text),
    saveFileAt: async (id, rev, path) => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { defaultPath: basename(path) }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return false
      await writeFile(res.filePath, await r(id).fileAt(rev, path))
      return true
    },
    dropCommits: (id, hashes) => r(id).dropCommits(hashes),
    moveCommits: (id, hashes, target, where) => r(id).moveCommits(hashes, target, where),
    rewordCommit: (id, hash, message) => r(id).rewordCommit(hash, message),
    squashCommit: (id, hash, mode) => r(id).squashCommit(hash, mode),
    squashOnto: (id, hashes, target) => r(id).squashOnto(hashes, target),
    fixupInto: (id, target) => r(id).fixupInto(target),
    preparedMessage: (id) => r(id).preparedMessage(),
    redo: (id) => r(id).redo(),
    redoList: async (id) => r(id).redoList(),
    revert: (id, hash) => r(id).revert(hash),
    createTag: (id, name, hash, message) => r(id).createTag(name, hash, message),
    deleteTag: (id, name) => r(id).deleteTag(name),

    fetch: (id, opts) => r(id).fetch(opts),
    pull: (id, opts) => r(id).pull(opts),
    push: (id, opts) => r(id).push(opts),
    deleteRemoteBranch: (id, ref) => r(id).deleteRemoteBranch(ref),

    stashPush: (id, opts) => r(id).stashPush(opts),
    stashBranch: (id, i, name) => r(id).stashBranch(i, name),
    stashApply: (id, i) => r(id).stashApply(i),
    stashPop: (id, i) => r(id).stashPop(i),
    stashDrop: (id, i) => r(id).stashDrop(i),

    conflicts: (id) => r(id).conflicts(),
    conflictVersions: (id, path) => r(id).conflictVersions(path),
    resolveConflict: (id, path, res) => r(id).resolveConflict(path, res),
    continueOperation: (id) => r(id).continueOperation(),
    abortOperation: (id) => r(id).abortOperation(),

    undoList: async (id) => r(id).undoList(),
    undo: (id, entryId) => r(id).undo(entryId),
  }
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof GitError) return { message: e.message, stderr: e.stderr, command: e.command, code: 'git' }
  // Errors that carry a string code (AI, GitHub sign-in) keep it, so the renderer can react.
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
    return typeof code === 'string' ? { message: e.message, code } : { message: e.message }
  }
  return { message: String(e) }
}

/**
 * One channel for every method. The renderer sends (method, args); we look the method up in the
 * handler table. Results and errors both come back as data (IpcResult), because Electron turns a
 * thrown error into a generic message and loses git's stderr.
 */
export function registerIpc(handlers: GitSquidApi, repos: RepoManager): void {
  const known = new Set<string>(API_METHODS)
  ipcMain.handle(IPC_INVOKE, async (_event, method: string, args: unknown[]): Promise<IpcResult<unknown>> => {
    if (!known.has(method)) return { ok: false, error: { message: `Unknown method ${method}` } }
    const fn = handlers[method as ApiMethod] as (...a: unknown[]) => Promise<unknown>
    try {
      const value = await fn(...args)
      return { ok: true, value }
    } catch (e) {
      return { ok: false, error: serializeError(e) }
    } finally {
      // Most write methods take the repo id first; refresh it now rather than waiting for the watcher.
      if (WRITES.has(method as ApiMethod) && typeof args[0] === 'string') await repos.refresh(args[0])
    }
  })
}
