import { GitError, Repo, secretPushCheck } from '@gitgoose/git'
import {
  API_METHODS, IPC_EVENT, IPC_INVOKE, askToThread, threadToAsk,
  type ApiMethod, type GitGooseApi, type GitGooseEvent, type IpcResult, type PushCheckPlan, type ReviewScope, type SerializedError,
} from '@gitgoose/shared'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { logError } from './diagnostics'
import { openInEditor, openTerminal } from './launch'
import type { AiService } from './ai/service'
import type { GitHubService } from './github/service'
import type { CodeGraphService } from './codegraph'
import type { RepoManager } from './repos'
import { decisionKey, linters } from './ai/linters'
import { forgetOpenRepo, getSettings, rememberRepo, setSettings } from './settings'

/** The revision a review scope's line numbers refer to, for the code graph: null the working tree, '' the index. */
function scopeRev(scope: ReviewScope): string | null {
  return scope.kind === 'working' ? null : scope.kind === 'staged' ? '' : scope.kind === 'commits' ? scope.hashes[0]! : scope.kind === 'branch' ? scope.branch : (scope.branch ?? 'HEAD')
}

export function broadcast(event: GitGooseEvent): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC_EVENT, event)
}

/** Methods that change the repository. Each runs with the watcher held back, then pushes one snapshot. */
const WRITES = new Set<ApiMethod>([
  'stagePaths', 'unstagePaths', 'discardPaths', 'applySelection', 'ignorePaths', 'commit', 'checkout', 'createBranch',
  'renameBranch', 'renameBranchInto', 'pinBranch', 'cherryPickOnto', 'applyFileFrom', 'deleteBranch', 'merge', 'rebase', 'reset', 'cherryPick', 'cherryPickMany', 'recomposeApply', 'dropCommits', 'moveCommits', 'restoreFile', 'applySuggestion', 'writeFileChecked', 'checkoutPullRequest', 'mergeTool', 'lfsInstall', 'lfsTrack', 'lfsPull', 'lfsLock', 'applyPatch', 'setIdentity', 'bisectMark', 'bisectReset', 'setGraphFilter', 'updateSubmodules', 'syncSubmodules', 'addSubmodule', 'removeSubmodule', 'addWorktree', 'removeWorktree', 'lockWorktree', 'pruneWorktrees', 'addRemote', 'removeRemote', 'renameRemote', 'setRemoteUrl', 'pushTags',
  'deleteRemoteTag', 'setUpstream', 'fastForward', 'deleteBranches', 'rewordCommit', 'squashCommit', 'squashOnto', 'fixupInto', 'redo', 'revert', 'createTag',
  'deleteTag', 'fetch', 'pull', 'push', 'deleteRemoteBranch', 'stashPush', 'snapshotWorkTree', 'stashBranch', 'stashApply', 'stashPop',
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
  codegraph: CodeGraphService,
): GitGooseApi {
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
      // Its conversations end their sessions now (they stay saved).
      ai.closeRepo(id)
      const path = await repos.close(id)
      if (path) forgetOpenRepo(path)
    },
    initRepo: async (path) => opened(await Repo.init(path, gitOpts())),
    cloneRepo: async (url, parent) => opened(await Repo.clone(url, parent, {
      ...gitOpts(), onProgress: (text) => broadcast({ type: 'progress', repoId: 'clone', text }),
    })),
    respondPrompt: async (id, answer) => prompts.respond(id, answer),

    pullRequests: (id) => github.pullRequests(r(id)),
    createPullRequest: async (id, pr) => {
      // Main builds the URL from the repository's own remote, and opens only GitHub pages.
      const url = await github.compareUrl(r(id), pr)
      if (!github.isGitHubUrl(url)) throw new Error('Not a GitHub page')
      await shell.openExternal(url)
      return url
    },
    checkoutPullRequest: async (id, num, branch) => {
      const remote = await github.remoteName(r(id))
      if (!remote) throw new Error('This repository has no GitHub remote.')
      return r(id).checkoutPullRequest(remote, num, branch)
    },
    openPullRequest: async (url) => {
      if (!github.isGitHubUrl(url)) throw new Error('Not a GitHub page')
      await shell.openExternal(url)
    },

    aiStatus: async () => ai.status(),
    aiConsent: async () => ai.consent(),
    aiRun: async (requestId, repoId, task, opts) => {
      // Review, walkthrough and ask read the code graph for context. The tree they need is
      // usually indexed already (HEAD, the index, the working tree); a commit costs only its
      // changed blobs. A first index of a big repository is not waited for: a slightly poorer
      // context beats a blocked review (ADR-008).
      const rev = task.kind === 'review' || task.kind === 'walkthrough' ? scopeRev(task.scope) : task.kind === 'ask' ? task.rev : undefined
      if (rev !== undefined && repoId) await Promise.race([codegraph.ensure(repoId, rev).catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
      return ai.run(requestId, repoId, task, opts)
    },
    aiCancel: async (requestId) => ai.cancel(requestId),
    aiThreadOpen: (repoId, anchor, resume) => ai.openThread(repoId, anchor, resume),
    aiThreadSend: async (threadId, text, opts) => {
      // Ask's first answer reads the code graph, as aiRun's did; the same short wait.
      const anchor = ai.threadAnchor(threadId)
      if (anchor?.kind === 'ask') {
        const rev = anchor.rev === 'worktree' ? null : anchor.rev
        await Promise.race([codegraph.ensure(ai.threadRepo(threadId)!, rev).catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
      }
      return ai.sendThread(threadId, text, opts)
    },
    aiThreadCancel: async (threadId) => ai.cancelThread(threadId),
    aiThreadClose: async (threadId) => ai.closeThread(threadId),
    aiThreads: async (repoId) => ai.listThreads(repoId),
    aiThreadDelete: async (repoId, threadId) => ai.deleteThread(repoId, threadId),
    aiThreadPermission: async (permissionId, answer) => ai.answerPermission(permissionId, answer),
    aiThreadArtifact: (threadId, kind, json) => ai.checkArtifact(threadId, kind, json),
    openExternal: async (url) => {
      // Links in AI answers: web pages and mail only, never file: or app schemes.
      if (!/^(https?:\/\/|mailto:)/i.test(url)) throw new Error('Only web links can be opened.')
      await shell.openExternal(url)
    },
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
    searchCommits: (id, field, q, limit) => r(id).searchCommits(field, q, limit),
    listFiles: (id) => r(id).listFiles(),
    stashList: (id) => r(id).stashList(),
    reflog: (id, ref) => r(id).reflog(ref),
    setGraphFilter: async (id, filter) => {
      const repo = r(id)
      repo.setGraphFilter(filter)
      const all = { ...getSettings().graphFilters }
      if (filter.hidden.length || filter.solo.length) all[repo.path] = filter
      else delete all[repo.path]
      setSettings({ graphFilters: all })
    },
    submodules: (id) => r(id).submodules(),
    updateSubmodules: (id, paths) => r(id).updateSubmodules(paths),
    syncSubmodules: (id) => r(id).syncSubmodules(),
    addSubmodule: (id, url, path) => r(id).addSubmodule(url, path),
    removeSubmodule: (id, path) => r(id).removeSubmodule(path),
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
    // Peek and Impact answer from the code graph once the tree they need is indexed; they wait
    // for it (the renderer shows the progress). With the graph off they fall back to text search.
    codePeek: async (id, name, rev) => {
      await codegraph.ensure(id, rev).catch(() => {})
      return r(id).codePeek(name, rev)
    },
    codeGraphStatus: async (id) => codegraph.status(id),
    reindexCode: (id) => codegraph.reindex(id),
    changeInsights: (id) => r(id).changeInsights(),
    impact: async (id, scope) => {
      await codegraph.ensure(id, scopeRev(scope)).catch(() => {})
      return r(id).impact(scope)
    },
    // The Ask methods of earlier versions, over the AI threads that replaced them.
    askThreads: async (id) => ai.listThreads(id).flatMap((t) => threadToAsk(t) ?? []),
    saveAskThread: async (id, thread) => ai.saveThread(id, askToThread(thread, id)),
    deleteAskThread: async (id, threadId) => ai.deleteThread(id, threadId),
    reviewLearnings: async (id) => getSettings().reviewLearnings[r(id).path] ?? [],
    pushCheckPlan: async (id, branch) => {
      const repo = r(id)
      const out = await repo.outgoing(branch)
      const empty: PushCheckPlan = { label: out.label, commits: out.commits.length, checks: [], local: [] }
      if (!out.commits.length) return empty
      const settings = getSettings()
      const checks: PushCheckPlan['checks'] = [
        ...(await repo.customChecks(out.head)).map((c) => ({ ...c, source: 'repo' as const })),
        ...(settings.pushChecks[repo.path] ?? []).map((c) => ({ ...c, source: 'settings' as const })),
      ]
      // The secret scan reads every pushed line (a big budget): a key in the 40th file still counts.
      const local = settings.pushSecretCheck ? [secretPushCheck((await repo.reviewInput({ kind: 'outgoing', branch }, 5_000_000)).files)] : []
      return { ...empty, checks, local }
    },
    pushCheckRules: async (id) => {
      const repo = r(id)
      return { repo: await repo.customChecks('HEAD').catch(() => []), mine: getSettings().pushChecks[repo.path] ?? [] }
    },
    setPushChecks: async (id, checks) => {
      const all = { ...getSettings().pushChecks }
      if (checks.length) all[r(id).path] = checks
      else delete all[r(id).path]
      setSettings({ pushChecks: all })
    },
    linters: async (id) => linters(r(id).path, getSettings(), await r(id).listFiles()),
    decideLinter: async (id, command, allow) => {
      const all = { ...getSettings().linterDecisions }
      const key = decisionKey(r(id).path, command)
      if (allow === null) delete all[key]
      else all[key] = allow
      setSettings({ linterDecisions: all })
    },
    setReviewLearnings: async (id, learnings) => {
      const all = { ...getSettings().reviewLearnings }
      if (learnings.length) all[r(id).path] = learnings
      else delete all[r(id).path]
      setSettings({ reviewLearnings: all })
    },
    applySuggestion: (id, path, start, end, original, replacement) => r(id).applySuggestion(path, start, end, original, replacement),
    writeFileChecked: (id, path, expected, content) => r(id).writeFileChecked(path, expected, content, `Apply AI fix to ${path}`),
    workingText: (id, path) => r(id).workingText(path),
    lfsInfo: (id) => r(id).lfsInfo(),
    lfsInstall: (id) => r(id).lfsInstall(),
    lfsTrack: (id, pattern, track) => r(id).lfsTrack(pattern, track),
    lfsPull: (id) => r(id).lfsPull(),
    lfsLocks: (id) => r(id).lfsLocks(),
    lfsLock: (id, path, lock, force) => r(id).lfsLock(path, lock, force),
    commandLog: async (id, afterId) => r(id).commandLog(afterId),
    bisectMark: (id, rev, term) => r(id).bisectMark(rev, term),
    bisectReset: (id) => r(id).bisectReset(),
    identity: (id) => r(id).identity(),
    setIdentity: (id, scope, name, email) => r(id).setIdentity(scope, name, email),
    commitTemplate: (id) => r(id).commitTemplate(),
    recentAuthors: (id) => r(id).recentAuthors(),

    checkout: (id, ref) => r(id).checkout(ref),
    createBranch: (id, name, opts) => r(id).createBranch(name, opts),
    renameBranch: (id, from, to) => r(id).renameBranch(from, to),
    renameBranchInto: (id, branch, folder) => r(id).renameBranchInto(branch, folder),
    pinnedBranches: (id) => r(id).pins(),
    lastFetched: (id) => r(id).lastFetched(),
    pinBranch: (id, branch, pin) => r(id).pinBranch(branch, pin),
    deleteBranch: (id, name, opts) => r(id).deleteBranch(name, opts),
    merge: (id, ref, opts) => r(id).merge(ref, opts),
    rebase: (id, onto) => r(id).rebase(onto),
    reset: (id, hash, mode) => r(id).reset(hash, mode),
    cherryPick: (id, hash) => r(id).cherryPick(hash),
    cherryPickMany: (id, hashes) => r(id).cherryPickMany(hashes),
    cherryPickOnto: (id, branch, hashes) => r(id).cherryPickOnto(branch, hashes),
    applyFileFrom: (id, rev, paths, opts) => r(id).applyFileFrom(rev, paths, opts),
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
      const dir = await mkdtemp(join(tmpdir(), `gitgoose-${rev.slice(0, 7)}-`))
      const file = join(dir, basename(path))
      await writeFile(file, await r(id).fileAt(rev, path))
      await chmod(file, 0o444)
      const err = await shell.openPath(file)
      if (err) throw new Error(err)
    },
    diffTool: (id, target) => r(id).diffTool(target, getSettings().diffTool || undefined),
    mergeTool: (id, path) => r(id).mergeTool(path, getSettings().mergeTool || undefined),
    imagePair: (id, target) => r(id).imagePair(target),
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
    squashOnto: (id, hashes, target, opts) => r(id).squashOnto(hashes, target, opts),
    fixupInto: (id, target) => r(id).fixupInto(target),
    preparedMessage: (id) => r(id).preparedMessage(),
    redo: (id) => r(id).redo(),
    redoList: async (id) => r(id).redoList(),
    revert: (id, hash) => r(id).revert(hash),
    createTag: (id, name, hash, message, opts) => r(id).createTag(name, hash, message, opts),
    deleteTag: (id, name) => r(id).deleteTag(name),

    fetch: (id, opts) => r(id).fetch(opts),
    pull: (id, opts) => r(id).pull(opts),
    push: (id, opts) => r(id).push(opts),
    deleteRemoteBranch: (id, ref) => r(id).deleteRemoteBranch(ref),

    stashPush: (id, opts) => r(id).stashPush(opts),
    stashBranch: (id, i, name) => r(id).stashBranch(i, name),
    snapshotWorkTree: (id, message) => r(id).snapshotWorkTree(message),
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
  // Errors that carry a string code (AI, GitHub's rate limit) keep it, so the renderer can react.
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
export function registerIpc(handlers: GitGooseApi, repos: RepoManager): void {
  const known = new Set<string>(API_METHODS)
  ipcMain.handle(IPC_INVOKE, async (_event, method: string, args: unknown[]): Promise<IpcResult<unknown>> => {
    if (!known.has(method)) return { ok: false, error: { message: `Unknown method ${method}` } }
    const fn = handlers[method as ApiMethod] as (...a: unknown[]) => Promise<unknown>
    // Most write methods take the repo id first. The watcher stays quiet while the write runs, and
    // one refresh right after it pushes the result, rather than waiting for the watcher.
    const writes = WRITES.has(method as ApiMethod) && typeof args[0] === 'string' ? args[0] : null
    try {
      const value = writes ? await repos.during(writes, () => fn(...args)) : await fn(...args)
      return { ok: true, value }
    } catch (e) {
      return { ok: false, error: serializeError(e) }
    }
  })
}
