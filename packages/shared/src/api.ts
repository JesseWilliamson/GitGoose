import type {
  BlameLine, Commit, CommitDetails, ConflictFile, DiffTarget, FileDiff, RepoSnapshot,
  SearchField, StashEntry, UndoEntry,
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
  lastCommitMessage(repoId: string): Promise<string>

  // Working tree
  stagePaths(repoId: string, paths: string[]): Promise<void>
  unstagePaths(repoId: string, paths: string[]): Promise<void>
  discardPaths(repoId: string, paths: string[]): Promise<UndoId>
  applySelection(repoId: string, req: SelectionRequest): Promise<UndoId>
  /** Append the paths to the repository's top-level .gitignore. */
  ignorePaths(repoId: string, paths: string[]): Promise<UndoId>
  commit(repoId: string, message: string, opts?: { amend?: boolean; signOff?: boolean; gpgSign?: boolean }): Promise<UndoId>

  // Branches and history
  checkout(repoId: string, ref: string): Promise<UndoId>
  createBranch(repoId: string, name: string, opts?: { at?: string; checkout?: boolean }): Promise<UndoId>
  renameBranch(repoId: string, from: string, to: string): Promise<UndoId>
  deleteBranch(repoId: string, name: string, opts?: { force?: boolean }): Promise<UndoId>
  merge(repoId: string, ref: string, opts?: { noFf?: boolean; ffOnly?: boolean }): Promise<UndoId>
  rebase(repoId: string, onto: string): Promise<UndoId>
  reset(repoId: string, hash: string, mode: ResetMode): Promise<UndoId>
  cherryPick(repoId: string, hash: string): Promise<UndoId>
  revert(repoId: string, hash: string): Promise<UndoId>
  createTag(repoId: string, name: string, hash: string, message?: string): Promise<UndoId>
  deleteTag(repoId: string, name: string): Promise<UndoId>

  // Remotes
  fetch(repoId: string, opts?: { remote?: string; prune?: boolean }): Promise<void>
  pull(repoId: string, opts?: { mode?: PullMode }): Promise<UndoId>
  push(repoId: string, opts?: { force?: boolean; branch?: string; remote?: string }): Promise<void>
  deleteRemoteBranch(repoId: string, remoteRef: string): Promise<void>

  // Stash
  stashPush(repoId: string, opts?: { message?: string; includeUntracked?: boolean }): Promise<UndoId>
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
}

export type ApiMethod = keyof GitSquidApi

/** The runtime list of method names. The type below fails to compile if it misses one. */
export const API_METHODS = [
  'getSettings', 'setSettings', 'pickDirectory', 'openRepo', 'closeRepo', 'initRepo', 'cloneRepo',
  'respondPrompt', 'openPath', 'openInEditor', 'openTerminal', 'revealPath', 'logError',
  'githubStatus', 'githubSignIn', 'githubWaitForSignIn', 'githubCancelSignIn', 'githubOpenPage', 'githubSignOut',
  'aiStatus', 'aiConsent', 'aiRun', 'aiCancel', 'aiRespondPermission', 'aiAgentInfo', 'aiAuthenticate', 'aiSetApiKey',
  'snapshot', 'logPage', 'commitDetails', 'diff', 'fileHistory', 'blame', 'search', 'stashList',
  'lastCommitMessage',
  'stagePaths', 'unstagePaths', 'discardPaths', 'applySelection', 'ignorePaths', 'commit',
  'checkout', 'createBranch', 'renameBranch', 'deleteBranch', 'merge', 'rebase', 'reset',
  'cherryPick', 'revert', 'createTag', 'deleteTag',
  'fetch', 'pull', 'push', 'deleteRemoteBranch',
  'stashPush', 'stashApply', 'stashPop', 'stashDrop',
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
