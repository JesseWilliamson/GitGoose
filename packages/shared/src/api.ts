import type {
  BlameLine, Commit, CommitDetails, ConflictFile, DiffTarget, FileDiff, RepoSnapshot,
  SearchField, Settings, StashEntry, UndoEntry,
} from './index'

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
}

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
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  /** Write a line to the local diagnostics log (renderer errors). */
  logError(message: string): Promise<void>

  // Reading
  snapshot(repoId: string): Promise<RepoSnapshot>
  logPage(repoId: string, offset: number, count: number): Promise<LogPage>
  commitDetails(repoId: string, hash: string): Promise<CommitDetails>
  diff(repoId: string, target: DiffTarget): Promise<FileDiff | null>
  fileHistory(repoId: string, path: string): Promise<Commit[]>
  blame(repoId: string, path: string, rev?: string): Promise<BlameLine[]>
  search(repoId: string, field: SearchField, query: string): Promise<string[]>
  stashList(repoId: string): Promise<StashEntry[]>
  lastCommitMessage(repoId: string): Promise<string>

  // Working tree
  stagePaths(repoId: string, paths: string[]): Promise<void>
  unstagePaths(repoId: string, paths: string[]): Promise<void>
  discardPaths(repoId: string, paths: string[]): Promise<void>
  applySelection(repoId: string, req: SelectionRequest): Promise<void>
  commit(repoId: string, message: string, opts?: { amend?: boolean }): Promise<void>

  // Branches and history
  checkout(repoId: string, ref: string): Promise<void>
  createBranch(repoId: string, name: string, opts?: { at?: string; checkout?: boolean }): Promise<void>
  renameBranch(repoId: string, from: string, to: string): Promise<void>
  deleteBranch(repoId: string, name: string, opts?: { force?: boolean }): Promise<void>
  merge(repoId: string, ref: string, opts?: { noFf?: boolean; ffOnly?: boolean }): Promise<void>
  rebase(repoId: string, onto: string): Promise<void>
  reset(repoId: string, hash: string, mode: ResetMode): Promise<void>
  cherryPick(repoId: string, hash: string): Promise<void>
  revert(repoId: string, hash: string): Promise<void>
  createTag(repoId: string, name: string, hash: string, message?: string): Promise<void>
  deleteTag(repoId: string, name: string): Promise<void>

  // Remotes
  fetch(repoId: string, opts?: { remote?: string; prune?: boolean }): Promise<void>
  pull(repoId: string, opts?: { rebase?: boolean }): Promise<void>
  push(repoId: string, opts?: { force?: boolean; branch?: string; remote?: string }): Promise<void>
  deleteRemoteBranch(repoId: string, remoteRef: string): Promise<void>

  // Stash
  stashPush(repoId: string, opts?: { message?: string; includeUntracked?: boolean }): Promise<void>
  stashApply(repoId: string, index: number): Promise<void>
  stashPop(repoId: string, index: number): Promise<void>
  stashDrop(repoId: string, index: number): Promise<void>

  // Conflicts
  conflicts(repoId: string): Promise<ConflictFile[]>
  conflictVersions(repoId: string, path: string): Promise<ConflictVersions>
  resolveConflict(repoId: string, path: string, resolution: Resolution): Promise<void>
  continueOperation(repoId: string): Promise<void>
  abortOperation(repoId: string): Promise<void>

  // Undo
  undoList(repoId: string): Promise<UndoEntry[]>
  undo(repoId: string): Promise<string | null>
}

export type ApiMethod = keyof GitSquidApi

/** The runtime list of method names. The type below fails to compile if it misses one. */
export const API_METHODS = [
  'getSettings', 'setSettings', 'pickDirectory', 'openRepo', 'closeRepo', 'initRepo', 'cloneRepo',
  'respondPrompt', 'openPath', 'revealPath', 'logError',
  'snapshot', 'logPage', 'commitDetails', 'diff', 'fileHistory', 'blame', 'search', 'stashList',
  'lastCommitMessage',
  'stagePaths', 'unstagePaths', 'discardPaths', 'applySelection', 'commit',
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
