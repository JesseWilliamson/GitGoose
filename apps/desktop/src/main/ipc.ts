import { GitError, Repo } from '@gitsquid/git'
import {
  API_METHODS, IPC_EVENT, IPC_INVOKE,
  type ApiMethod, type GitSquidApi, type GitSquidEvent, type IpcResult, type SerializedError,
} from '@gitsquid/shared'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { logError } from './diagnostics'
import type { RepoManager } from './repos'
import { forgetOpenRepo, getSettings, rememberRepo, setSettings } from './settings'

export function broadcast(event: GitSquidEvent): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC_EVENT, event)
}

/** Methods that change the repository. After each one we refresh and push a snapshot right away. */
const WRITES = new Set<ApiMethod>([
  'stagePaths', 'unstagePaths', 'discardPaths', 'applySelection', 'ignorePaths', 'commit', 'checkout', 'createBranch',
  'renameBranch', 'deleteBranch', 'merge', 'rebase', 'reset', 'cherryPick', 'revert', 'createTag',
  'deleteTag', 'fetch', 'pull', 'push', 'deleteRemoteBranch', 'stashPush', 'stashApply', 'stashPop',
  'stashDrop', 'resolveConflict', 'continueOperation', 'abortOperation', 'undo',
])

export interface PromptBroker {
  respond(id: number, answer: string | null): void
}

export function createHandlers(repos: RepoManager, prompts: PromptBroker, gitOpts: () => { gitPath: string; env: Record<string, string> }): GitSquidApi {
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
    openPath: async (path) => {
      const err = await shell.openPath(path)
      if (err) throw new Error(err)
    },
    revealPath: async (path) => shell.showItemInFolder(path),
    logError: async (message) => logError('renderer', message),

    snapshot: (id) => r(id).snapshot(),
    logPage: (id, offset, count) => r(id).logPage(offset, count),
    commitDetails: (id, hash, opts) => r(id).commitDetails(hash, opts),
    diff: (id, target) => r(id).diff(target),
    fileHistory: (id, path) => r(id).fileHistory(path),
    blame: (id, path, rev) => r(id).blame(path, rev),
    search: (id, field, q) => r(id).search(field, q),
    stashList: (id) => r(id).stashList(),
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
    revert: (id, hash) => r(id).revert(hash),
    createTag: (id, name, hash, message) => r(id).createTag(name, hash, message),
    deleteTag: (id, name) => r(id).deleteTag(name),

    fetch: (id, opts) => r(id).fetch(opts),
    pull: (id, opts) => r(id).pull(opts),
    push: (id, opts) => r(id).push(opts),
    deleteRemoteBranch: (id, ref) => r(id).deleteRemoteBranch(ref),

    stashPush: (id, opts) => r(id).stashPush(opts),
    stashApply: (id, i) => r(id).stashApply(i),
    stashPop: (id, i) => r(id).stashPop(i),
    stashDrop: (id, i) => r(id).stashDrop(i),

    conflicts: (id) => r(id).conflicts(),
    conflictVersions: (id, path) => r(id).conflictVersions(path),
    resolveConflict: (id, path, res) => r(id).resolveConflict(path, res),
    continueOperation: (id) => r(id).continueOperation(),
    abortOperation: (id) => r(id).abortOperation(),

    undoList: async (id) => r(id).undoList(),
    undo: (id) => r(id).undo(),
  }
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof GitError) return { message: e.message, stderr: e.stderr, command: e.command, code: 'git' }
  if (e instanceof Error) return { message: e.message }
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
