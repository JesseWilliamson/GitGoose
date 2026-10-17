import type {
  BlameLine, ChangedFile, CommandRecord, GraphFilter, ImageSide, Identity, Person, Commit, CommitDetails, ConflictFile, DiffTarget, FileDiff, RepoSnapshot,
  ReflogEntry, Remote, SearchField, Submodule, Worktree, StashEntry, UndoEntry,
} from './index'
import type { AgentInfo, AiPermissionRequest, AiResult, AiStatus, AiTask } from './ai'
import type { DeviceCodeInfo, GitHubAccount, GitHubStatus } from './github'
import type { Settings } from './settings'

export interface LogPage {
  commits: Commit[]
  /** True when the log has no more commits after this page. */
  done: boolean
  /** Which log walk this page came from. A new walk starts whenever refs change. */
  generation: number
}

/** Which lines of which hunks to act on. Omit `lines` to take the whole hunk. */
export interface HunkSelection {
  hunk: number
  /** Indexes into hunk.lines; only '+' and '-' lines matter. */
  lines?: number[]
}

export interface SelectionRequest {
  target: Extract<DiffTarget, { kind: 'unstaged' | 'staged' | 'untracked' }>
  action: 'stage' | 'unstage' | 'discard'
  hunks: HunkSelection[]
  /** Context lines of the diff the selection was made on; hunk indexes depend on it. */
  context?: number
}

export interface DiffOptions {
  /** Unchanged lines around each change (git's -U). */
  context?: number
  /** Hide whitespace-only changes (-w). Display only: line staging refuses such diffs. */
  ignoreWhitespace?: boolean
}

export type PullMode = 'merge' | 'rebase' | 'ff-only'

/**
 * What an undoable write returns: the id of the undo entry it recorded, or null when nothing
 * changed (a merge that was already up to date, a stash with nothing to stash).
 */
export type UndoId = number | null

export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep'

export type Resolution = 'ours' | 'theirs' | { content: string }

export interface ConflictVersions {
  base: string | null
  ours: string | null
  theirs: string | null
  /** The working tree file, with conflict markers. */
  merged: string | null
}

/**
 * Everything the renderer can ask the main process to do.
 *
 * Each method is a request/response over one IPC channel. The preload script builds the client
 * from API_METHODS below and the main process registers one handler per method, so adding a
 * method here without implementing it is a type error in both places.
 */
export interface GitSquidApi {
  // App
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  pickDirectory(): Promise<string | null>
  openRepo(path: string): Promise<RepoSnapshot>
  closeRepo(repoId: string): Promise<void>
  initRepo(path: string): Promise<RepoSnapshot>
  cloneRepo(url: string, parentDir: string): Promise<RepoSnapshot>
  respondPrompt(promptId: number, answer: string | null): Promise<void>

  // GitHub sign-in (device flow; see apps/desktop/src/main/github/)
  githubStatus(): Promise<GitHubStatus>
  /** Start signing in; 'repo' also asks for access to repositories (HTTPS push and fetch). */
  githubSignIn(access: 'basic' | 'repo'): Promise<DeviceCodeInfo>
  /** Resolves when the user has approved on github.com; rejects on denial, expiry or cancel. */
  githubWaitForSignIn(): Promise<GitHubAccount>
  githubCancelSignIn(): Promise<void>
  /** Open a GitHub page in the browser: where to enter the code, or where to revoke access. */
  githubOpenPage(page: 'verification' | 'applications'): Promise<void>
  githubSignOut(): Promise<void>

  // AI (see apps/desktop/src/main/ai/)
  aiStatus(): Promise<AiStatus>
  /** The user agreed to send content to the configured provider (asked once per provider/agent). */
  aiConsent(): Promise<AiStatus>
  /** Run a task. Text streams as 'ai-text' events with the same requestId; tool calls ask via 'ai-permission'. */
  aiRun(requestId: string, repoId: string, task: AiTask): Promise<AiResult>
  aiCancel(requestId: string): Promise<void>
  aiRespondPermission(permissionId: number, optionId: string | null): Promise<void>
  /** Start the agent (if needed) and say who it is and how it logs in. */
  aiAgentInfo(): Promise<AgentInfo>
  /** Log in with a method the agent handles itself. */
  aiAuthenticate(methodId: string): Promise<void>
  aiSetApiKey(key: string | null): Promise<AiStatus>
  openPath(path: string): Promise<void>
  /** Open a file in the configured external editor (Settings → Integrations), at a line if given. */
  openInEditor(path: string, line?: number): Promise<void>
  /** Open the configured terminal in the repository folder. */
  openTerminal(repoId: string): Promise<void>
  revealPath(path: string): Promise<void>
  /** Write a line to the local diagnostics log (renderer errors). */
  logError(message: string): Promise<void>

  // Reading
  snapshot(repoId: string): Promise<RepoSnapshot>
  logPage(repoId: string, offset: number, count: number): Promise<LogPage>
  /** `stash: true` also lists untracked files saved in a stash (they live in its third parent). */
  commitDetails(repoId: string, hash: string, opts?: { stash?: boolean }): Promise<CommitDetails>
  diff(repoId: string, target: DiffTarget, opts?: DiffOptions): Promise<FileDiff | null>
  fileHistory(repoId: string, path: string): Promise<Commit[]>
  blame(repoId: string, path: string, rev?: string): Promise<BlameLine[]>
  search(repoId: string, field: SearchField, query: string): Promise<string[]>
  stashList(repoId: string): Promise<StashEntry[]>
  /** Hide or solo branches in this repository's graph (remembered per repository). */
  setGraphFilter(repoId: string, filter: GraphFilter): Promise<void>
  submodules(repoId: string): Promise<Submodule[]>
  /** Init, clone if needed, and check out the recorded commits (all, or just `paths`). */
  updateSubmodules(repoId: string, paths?: string[]): Promise<void>
  syncSubmodules(repoId: string): Promise<void>
  addSubmodule(repoId: string, url: string, path: string): Promise<UndoId>
  removeSubmodule(repoId: string, path: string): Promise<UndoId>
  worktrees(repoId: string): Promise<Worktree[]>
  addWorktree(repoId: string, path: string, opts: { branch?: string; newBranch?: string; at?: string }): Promise<UndoId>
  /** Without force, git refuses if the worktree has changes (and undo can check it out again). */
  removeWorktree(repoId: string, path: string, opts?: { force?: boolean }): Promise<UndoId>
  lockWorktree(repoId: string, path: string, lock: boolean, reason?: string): Promise<void>
  pruneWorktrees(repoId: string): Promise<void>
  /** A ref's reflog (default HEAD), newest first; commits nothing else reaches are marked lost. */
  reflog(repoId: string, ref?: string): Promise<ReflogEntry[]>
  lastCommitMessage(repoId: string): Promise<string>

  // Working tree
  stagePaths(repoId: string, paths: string[]): Promise<void>
  unstagePaths(repoId: string, paths: string[]): Promise<void>
  discardPaths(repoId: string, paths: string[]): Promise<UndoId>
  applySelection(repoId: string, req: SelectionRequest): Promise<UndoId>
  /** Append the paths to the repository's top-level .gitignore. */
  ignorePaths(repoId: string, paths: string[]): Promise<UndoId>
  /** `noVerify` skips the commit hooks. */
  commit(repoId: string, message: string, opts?: { amend?: boolean; signOff?: boolean; gpgSign?: boolean; noVerify?: boolean }): Promise<UndoId>
  /** Git commands GitSquid ran for this repository, newest first (only newer than `afterId`). */
  commandLog(repoId: string, afterId?: number): Promise<CommandRecord[]>
  /** Mark a commit for bisect (starts one if needed); git checks out the next commit to test. */
  bisectMark(repoId: string, rev: string, term: 'good' | 'bad' | 'skip'): Promise<void>
  bisectReset(repoId: string): Promise<void>
  identity(repoId: string): Promise<Identity>
  /** null clears the value (for the repository: the global one applies again). */
  setIdentity(repoId: string, scope: 'local' | 'global', name: string | null, email: string | null): Promise<UndoId>
  commitTemplate(repoId: string): Promise<string | null>
  recentAuthors(repoId: string): Promise<Person[]>

  // Branches and history
  checkout(repoId: string, ref: string): Promise<UndoId>
  createBranch(repoId: string, name: string, opts?: { at?: string; checkout?: boolean }): Promise<UndoId>
  renameBranch(repoId: string, from: string, to: string): Promise<UndoId>
  deleteBranch(repoId: string, name: string, opts?: { force?: boolean }): Promise<UndoId>
  merge(repoId: string, ref: string, opts?: { noFf?: boolean; ffOnly?: boolean; squash?: boolean; noCommit?: boolean }): Promise<UndoId>
  /** The message git prepared for the next commit (after a squash merge or a stopped merge), or ''. */
  preparedMessage(repoId: string): Promise<string>
  rebase(repoId: string, onto: string): Promise<UndoId>
  reset(repoId: string, hash: string, mode: ResetMode): Promise<UndoId>
  cherryPick(repoId: string, hash: string): Promise<UndoId>
  /** Several commits, given in graph order (newest first); applied oldest first, one undo entry. */
  cherryPickMany(repoId: string, hashes: string[]): Promise<UndoId>
  /**
   * Replace a run of commits on the current branch with new ones (messages and unit ids from a
   * RecomposeProposal, oldest first). The branch ends at the same tree; one undo entry.
   */
  recomposeApply(repoId: string, hashes: string[], commits: { message: string; units: string[] }[]): Promise<UndoId>
  /** New message for a commit on the current branch. */
  rewordCommit(repoId: string, hash: string, message: string): Promise<UndoId>
  /** Fold a commit into the one below it: 'squash' keeps both messages, 'fixup' the lower one's. */
  squashCommit(repoId: string, hash: string, mode: 'squash' | 'fixup'): Promise<UndoId>
  /** Fold commits into `target` (drag onto), keeping all messages. */
  squashOnto(repoId: string, hashes: string[], target: string): Promise<UndoId>
  /** Commit the staged changes into an older commit on the current branch. */
  fixupInto(repoId: string, target: string): Promise<UndoId>
  /** Files that differ between two revisions, or a revision and the working tree (`to` null). */
  compareFiles(repoId: string, from: string, to: string | null): Promise<ChangedFile[]>
  /** Where two revisions forked from each other. */
  mergeBase(repoId: string, a: string, b: string): Promise<string>
  /** Put a working-tree file back to its content at `rev` (undoable). */
  /** Open the diff in the external diff tool (Settings → Diff, else git's diff.tool); resolves when it closes. */
  diffTool(repoId: string, target: DiffTarget): Promise<void>
  /** Resolve a conflicted file in the external merge tool; resolves when it closes. */
  mergeTool(repoId: string, path: string): Promise<void>
  /** Both versions of an image file for a diff (null: not there on that side). */
  imagePair(repoId: string, target: DiffTarget): Promise<{ old: ImageSide | null; new: ImageSide | null }>
  /** Save commits as .patch files in a folder the user picks; the paths written, or null if cancelled. */
  savePatches(repoId: string, hashes: string[]): Promise<string[] | null>
  /** Ask for a .patch / .diff file and return its text (null if cancelled). */
  pickPatch(): Promise<string | null>
  /** Apply patch text: mailbox patches become commits (am), plain diffs change the working tree and index. */
  applyPatch(repoId: string, text: string): Promise<UndoId>
  /** `stash`: rev is a stash commit, whose untracked files live in its third parent. */
  restoreFile(repoId: string, path: string, rev: string, opts?: { stash?: boolean }): Promise<UndoId>
  /** Open a file as it was at `rev` in the default app (a read-only temporary copy). */
  openFileAt(repoId: string, rev: string, path: string): Promise<void>
  /** Save a file as it was at `rev` where the user chooses; false when they cancel. */
  saveFileAt(repoId: string, rev: string, path: string): Promise<boolean>
  /** Commits on the current branch that drop/move can edit (newest first; stops at a merge). */
  editableCommits(repoId: string): Promise<string[]>
  /** Remove commits from the current branch; later commits are replayed (may stop on conflicts). */
  dropCommits(repoId: string, hashes: string[]): Promise<UndoId>
  /** Move commits to just above (newer) or below (older) `target` on the current branch. */
  moveCommits(repoId: string, hashes: string[], target: string, where: 'above' | 'below'): Promise<UndoId>
  /** Several commits as a diff or as format-patch text (graph order in, oldest first out). */
  commitsText(repoId: string, hashes: string[], format: 'diff' | 'patch'): Promise<string>
  revert(repoId: string, hash: string): Promise<UndoId>
  createTag(repoId: string, name: string, hash: string, message?: string, opts?: { sign?: boolean }): Promise<UndoId>
  deleteTag(repoId: string, name: string): Promise<UndoId>

  // Remotes
  fetch(repoId: string, opts?: { remote?: string; prune?: boolean }): Promise<void>
  pull(repoId: string, opts?: { mode?: PullMode }): Promise<UndoId>
  push(repoId: string, opts?: { force?: boolean; branch?: string; remote?: string; remoteBranch?: string }): Promise<void>
  remotes(repoId: string): Promise<Remote[]>
  addRemote(repoId: string, name: string, url: string): Promise<UndoId>
  removeRemote(repoId: string, name: string): Promise<UndoId>
  renameRemote(repoId: string, from: string, to: string): Promise<UndoId>
  /** A remote's URL, or with `push` its separate push URL (null removes that). */
  setRemoteUrl(repoId: string, name: string, url: string | null, push?: boolean): Promise<UndoId>
  /** Push one tag, or all (name null). Changes the remote: not undoable. */
  pushTags(repoId: string, remote: string, name: string | null): Promise<void>
  deleteRemoteTag(repoId: string, remote: string, name: string): Promise<void>
  /** Tag names on a remote (asks the remote). */
  remoteTags(repoId: string, remote: string): Promise<string[]>
  setUpstream(repoId: string, branch: string, upstream: string | null): Promise<UndoId>
  /** Move a branch that is not checked out forward to its upstream. */
  fastForward(repoId: string, branch: string): Promise<UndoId>
  deleteBranches(repoId: string, names: string[], opts?: { force?: boolean }): Promise<UndoId>
  /** Local branches already contained in HEAD (safe to delete). */
  mergedBranches(repoId: string): Promise<string[]>
  deleteRemoteBranch(repoId: string, remoteRef: string): Promise<void>

  // Stash
  stashPush(repoId: string, opts?: { message?: string; includeUntracked?: boolean; paths?: string[]; staged?: boolean; keepIndex?: boolean }): Promise<UndoId>
  /** A new branch at the stash's base with the stash applied (and dropped). */
  stashBranch(repoId: string, index: number, name: string): Promise<UndoId>
  stashApply(repoId: string, index: number): Promise<void>
  stashPop(repoId: string, index: number): Promise<UndoId>
  stashDrop(repoId: string, index: number): Promise<UndoId>

  // Conflicts
  conflicts(repoId: string): Promise<ConflictFile[]>
  conflictVersions(repoId: string, path: string): Promise<ConflictVersions>
  resolveConflict(repoId: string, path: string, resolution: Resolution): Promise<void>
  continueOperation(repoId: string): Promise<void>
  abortOperation(repoId: string): Promise<void>

  // Undo
  undoList(repoId: string): Promise<UndoEntry[]>
  /** Undo the latest operation; with `entryId`, only if that entry is still the latest. */
  undo(repoId: string, entryId?: number): Promise<string | null>
  /** Redo the operation undone last, if nothing happened since. Returns its label, or null. */
  redo(repoId: string): Promise<string | null>
  redoList(repoId: string): Promise<UndoEntry[]>
}

export type ApiMethod = keyof GitSquidApi

/** The runtime list of method names. The type below fails to compile if it misses one. */
export const API_METHODS = [
  'getSettings', 'setSettings', 'pickDirectory', 'openRepo', 'closeRepo', 'initRepo', 'cloneRepo',
  'respondPrompt', 'openPath', 'openInEditor', 'openTerminal', 'revealPath', 'logError',
  'githubStatus', 'githubSignIn', 'githubWaitForSignIn', 'githubCancelSignIn', 'githubOpenPage', 'githubSignOut',
  'aiStatus', 'aiConsent', 'aiRun', 'aiCancel', 'aiRespondPermission', 'aiAgentInfo', 'aiAuthenticate', 'aiSetApiKey',
  'snapshot', 'logPage', 'commitDetails', 'diff', 'fileHistory', 'blame', 'search', 'stashList', 'reflog', 'setGraphFilter', 'submodules', 'updateSubmodules', 'syncSubmodules', 'addSubmodule', 'removeSubmodule', 'worktrees', 'addWorktree', 'removeWorktree', 'lockWorktree', 'pruneWorktrees',
  'lastCommitMessage',
  'stagePaths', 'unstagePaths', 'discardPaths', 'applySelection', 'ignorePaths', 'commit', 'commandLog', 'bisectMark', 'bisectReset', 'identity', 'setIdentity', 'commitTemplate', 'recentAuthors',
  'checkout', 'createBranch', 'renameBranch', 'deleteBranch', 'merge', 'rebase', 'reset',
  'cherryPick', 'cherryPickMany', 'commitsText', 'recomposeApply', 'compareFiles', 'mergeBase', 'restoreFile', 'diffTool', 'mergeTool', 'imagePair', 'savePatches', 'pickPatch', 'applyPatch', 'openFileAt', 'saveFileAt', 'editableCommits', 'dropCommits', 'moveCommits', 'rewordCommit', 'squashCommit', 'squashOnto', 'fixupInto', 'preparedMessage', 'redo', 'redoList', 'revert', 'createTag', 'deleteTag',
  'fetch', 'pull', 'push', 'deleteRemoteBranch', 'remotes', 'addRemote', 'removeRemote', 'renameRemote', 'setRemoteUrl',
  'pushTags', 'deleteRemoteTag', 'remoteTags', 'setUpstream', 'fastForward', 'deleteBranches', 'mergedBranches',
  'stashPush', 'stashBranch', 'stashApply', 'stashPop', 'stashDrop',
  'conflicts', 'conflictVersions', 'resolveConflict', 'continueOperation', 'abortOperation',
  'undoList', 'undo',
] as const satisfies readonly ApiMethod[]

// Compile-time exhaustiveness: if a method is missing from API_METHODS, this resolves to the
// missing name instead of `never` and the assignment fails.
type Missing = Exclude<ApiMethod, (typeof API_METHODS)[number]>
const _exhaustive: [Missing] extends [never] ? true : Missing = true
void _exhaustive

/** Pushed from main to renderer. */
export type GitSquidEvent =
  | { type: 'snapshot'; snapshot: RepoSnapshot }
  /** Files changed on disk (sent even when the snapshot did not change, so open diffs reload). */
  | { type: 'worktree'; repoId: string }
  | { type: 'prompt'; promptId: number; repoId: string | null; message: string; secret: boolean }
  | { type: 'progress'; repoId: string; text: string | null }
  | { type: 'command'; name: string }
  /** Settings changed (from any window, or main): every window re-applies theme, fonts, scale. */
  | { type: 'settings'; settings: Settings }
  /** Signed in or out of GitHub. */
  | { type: 'github'; status: GitHubStatus }
  /** An AI request's reply so far. */
  | { type: 'ai-text'; requestId: string; text: string }
  /** The agent wants to use a tool: ask the user. */
  | { type: 'ai-permission'; request: AiPermissionRequest }
  /** A permission question no longer needs an answer (its request ended). */
  | { type: 'ai-permission-closed'; permissionId: number }

/** Errors cross IPC as data, so the renderer gets git's stderr intact. */
export interface SerializedError {
  message: string
  stderr?: string
  command?: string
  code?: string
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: SerializedError }

export const IPC_INVOKE = 'gitsquid:invoke'
export const IPC_EVENT = 'gitsquid:event'
