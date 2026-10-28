import type {
  BlameLine, ChangedFile, ChangeInsights, CodeGraphStatus, CodePeek, CommandRecord, GraphFilter, ImageSide, LfsInfo, LfsLock, Identity, Person, Commit, CommitDetails, CommitSummary, ConflictFile, DiffTarget, FileDiff, RepoSnapshot,
  ReflogEntry, Remote, SearchField, Submodule, Worktree, StashEntry, StreamFile, StreamTarget, UndoEntry,
} from './index'
import type {
  AgentInfo, AiArtifactResult, AiModelList, PromptPreview, AiPermissionRequest, AiResult, AiRunOptions, AiStatus, AiTarget, AiTask, AiThread, AiUpdate, ArtifactKind, AskThread, ImpactResult, LinterInfo, PermissionAnswer, PushCheck, PushCheckPlan,
  ReviewLearning, ReviewScope, ThreadAnchor,
} from './ai'
import type { PullRequestList } from './github'
import type { PromptText } from './prompts'
import type { Settings } from './settings'

export interface LogPage {
  commits: Commit[]
  /** True when the log has no more commits after this page. */
  done: boolean
  /** Which log walk this page came from. A new walk starts whenever refs change. */
  generation: number
}

/**
 * The size of the log's first page: small, so the first screen paints fast (later pages are
 * larger to cut round trips). The main process reads it ahead for repositories it opens at
 * startup, so it must match what the renderer asks for.
 */
export const FIRST_LOG_PAGE = 300

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

export interface DiffStreamOptions extends DiffOptions {
  /** Only these files (the paths a stream shows), else all. */
  paths?: string[]
  /**
   * Diffs come back for the files in order until their changed lines pass this (default 6,000);
   * the rest come back with numbers only, and the reader asks for them as they scroll into view.
   */
  maxLines?: number
}

export type PullMode = 'merge' | 'rebase' | 'ff-only'

/**
 * What an undoable write returns: the id of the undo entry it recorded, or null when nothing
 * changed (a merge that was already up to date, a stash with nothing to stash).
 */
export type UndoId = number | null

export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep'

/**
 * How to resolve a conflicted file. With `expected` (a proposal made earlier, such as the AI's),
 * the file is written only while it still reads exactly that and is still in conflict.
 */
export type Resolution = 'ours' | 'theirs' | { content: string; expected?: string }

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
export interface GitGooseApi {
  // App
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  pickDirectory(): Promise<string | null>
  // Window chrome (the title bar is the tab bar, see TabBar.tsx)
  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<void>
  windowClose(): Promise<void>
  windowIsMaximized(): Promise<boolean>
  /** Windows: the native caption buttons' colours, so they match the theme. */
  windowSetOverlay(colors: { color: string; symbolColor: string }): Promise<void>
  /** Pop the application menu up at the pointer (Windows and Linux hide the menu bar). */
  menuPopup(): Promise<void>
  openRepo(path: string): Promise<RepoSnapshot>
  closeRepo(repoId: string): Promise<void>
  initRepo(path: string): Promise<RepoSnapshot>
  cloneRepo(url: string, parentDir: string): Promise<RepoSnapshot>
  respondPrompt(promptId: number, answer: string | null): Promise<void>

  // GitHub pull requests, without signing in (see apps/desktop/src/main/github/)
  /** Network: the GitHub remote's open pull requests (only when the user opens the list). Public repositories only. */
  pullRequests(repoId: string): Promise<PullRequestList>
  /**
   * Open GitHub's "new pull request" page in the browser, filled in with the title, description
   * and base (the branch must be on GitHub already). Returns the URL opened.
   */
  createPullRequest(repoId: string, pr: { branch: string; base: string; title: string; body: string }): Promise<string>
  /** Fetch pull/N/head into pr/N (or `branch`) and check it out. Undoable. */
  checkoutPullRequest(repoId: string, num: number, branch?: string): Promise<UndoId>
  /** Open a pull request's page (GitHub URLs only). */
  openPullRequest(url: string): Promise<void>

  // AI (see apps/desktop/src/main/ai/)
  /** Status of a target (omitted: Settings → AI). */
  aiStatus(target?: AiTarget): Promise<AiStatus>
  /** The user agreed to send content to this target's provider (asked once per provider/agent; omitted: Settings → AI). */
  aiConsent(target?: AiTarget): Promise<AiStatus>
  /**
   * The models a target can use, without starting anything: for an agent the list from its last
   * session (known: false if there was none yet); for the API key, the API's model list.
   */
  aiModels(target: AiTarget): Promise<AiModelList>
  /** The user asked for an agent's models: start it, open a session to read them, close it. */
  aiLoadModels(target: AiTarget): Promise<AiModelList>
  /**
   * What `task` would send, without sending it: the prompt's parts with the context built from
   * the repository now (read-only git; linters are not run, they run when the review is sent).
   * `prompt` previews unsaved words.
   */
  aiPromptPreview(repoId: string, task: AiTask, prompt?: PromptText): Promise<PromptPreview>
  /**
   * Run a task: a thread whose first message is the task's prompt, closed when the answer is in
   * (or, with opts.keepThread, kept for the view to chat on: AiResult.threadId). Text streams as
   * 'ai-text' events with the same requestId; tool calls ask via 'ai-permission'.
   */
  aiRun(requestId: string, repoId: string, task: AiTask, opts?: AiRunOptions): Promise<AiResult>
  /**
   * Open a conversation for a view: a new one about `anchor`, or `resume` a saved one. Nothing is
   * sent and no agent starts until the first message. Its events arrive as 'ai-update'.
   */
  aiThreadOpen(repoId: string, anchor: ThreadAnchor, resume?: string): Promise<AiThread>
  /** Send a message; resolves with the turn's request id once it has started (refusals, like a secret in the text, throw first). */
  aiThreadSend(threadId: string, text: string, opts?: AiRunOptions): Promise<string>
  aiThreadCancel(threadId: string): Promise<void>
  /** The view closed: the agent session stays for 10 minutes, then ends. The thread stays saved. */
  aiThreadClose(threadId: string): Promise<void>
  /** This repository's saved conversations, most recently used first. */
  aiThreads(repoId: string): Promise<AiThread[]>
  /**
   * Which of this repository's conversations no longer describe it: thread id to the sentence
   * saying why (threads that are still good are left out). Read-only git, worked out once per
   * distinct anchor, so the history list can mark them all in one call.
   */
  aiThreadsStale(repoId: string): Promise<Record<string, string>>
  /**
   * The result a conversation owns (a review, a plan, a walkthrough), checked with the feature's
   * own verifier so reopening it shows exactly what Apply would: the newest answer in the thread
   * that carries one, or null when it has none. The thread must be open (aiThreadOpen).
   */
  aiThreadResult(threadId: string): Promise<AiArtifactResult | null>
  aiThreadDelete(repoId: string, threadId: string): Promise<void>
  /** Answer a permission card in a thread. 'session' also answers the same question for the rest of the session. */
  aiThreadPermission(permissionId: number, answer: Exclude<PermissionAnswer, 'expired'>): Promise<void>
  /** Check an artifact (a json:<kind> block) with the feature's own verifier; nothing is applied. */
  aiThreadArtifact(threadId: string, kind: ArtifactKind, json: string): Promise<AiArtifactResult>
  /** Open a web link (from an AI answer) in the browser: http, https and mailto only. */
  openExternal(url: string): Promise<void>
  aiCancel(requestId: string): Promise<void>
  aiRespondPermission(permissionId: number, optionId: string | null): Promise<void>
  /** Start the agent (if needed) and say who it is and how it logs in (omitted: Settings → AI's agent). */
  aiAgentInfo(target?: AiTarget): Promise<AgentInfo>
  /** Log in with a method the agent handles itself. */
  aiAuthenticate(methodId: string, target?: AiTarget): Promise<void>
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
  /** Every file of a commit, range or the working copy, with diffs within a line budget, from one git run (ADR-012). */
  diffStream(repoId: string, target: StreamTarget, opts?: DiffStreamOptions): Promise<StreamFile[]>
  fileHistory(repoId: string, path: string): Promise<Commit[]>
  blame(repoId: string, path: string, rev?: string): Promise<BlameLine[]>
  search(repoId: string, field: SearchField, query: string): Promise<string[]>
  /** search(), with the first `limit` hits described (for the omni search's results). */
  searchCommits(repoId: string, field: SearchField, query: string, limit?: number): Promise<{ total: number; commits: CommitSummary[] }>
  /** Every file in the working tree, tracked or not (not ignored), for finding a file by name. */
  listFiles(repoId: string): Promise<string[]>
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
  /** Replace a finding's lines with its suggestion, if the working file still has them as reviewed. Undoable. */
  applySuggestion(repoId: string, path: string, startLine: number, endLine: number, original: string[], replacement: string): Promise<UndoId>
  /** Write an accepted AI fix, if the file still reads `expected`. Undoable. */
  writeFileChecked(repoId: string, path: string, expected: string, content: string): Promise<UndoId>
  workingText(repoId: string, path: string): Promise<string | null>
  /** What a change could affect: touched definitions, their uses elsewhere, tests, usual companions. Local only. */
  impact(repoId: string, scope: ReviewScope): Promise<ImpactResult>
  /** Question threads about this repository's code (pinned to commits): the ask-anchored AI threads, in the old shape. */
  askThreads(repoId: string): Promise<AskThread[]>
  saveAskThread(repoId: string, thread: AskThread): Promise<void>
  deleteAskThread(repoId: string, id: string): Promise<void>
  /** Learnings sent with this repository's reviews. */
  reviewLearnings(repoId: string): Promise<ReviewLearning[]>
  setReviewLearnings(repoId: string, learnings: ReviewLearning[]): Promise<void>
  /** What a push of the branch (default: current) would be checked against, and the checks that need no AI, already run. */
  pushCheckPlan(repoId: string, branch?: string): Promise<PushCheckPlan>
  /** The repository's checks (.coderabbit.yaml, read-only here) and the user's own. */
  pushCheckRules(repoId: string): Promise<{ repo: PushCheck[]; mine: PushCheck[] }>
  setPushChecks(repoId: string, checks: PushCheck[]): Promise<void>
  /** Linters a review of this repository can run, with the user's answer for each. */
  linters(repoId: string): Promise<LinterInfo[]>
  /** Allow (true) or refuse (false) one exact linter command for this repository; null forgets the answer. */
  decideLinter(repoId: string, command: string, allow: boolean | null): Promise<void>
  /** History's hints for the uncommitted change: usual companions missing, and whose lines it changes. */
  changeInsights(repoId: string): Promise<ChangeInsights>
  /** Where an identifier is defined and used, at `rev` (null: the working tree). */
  codePeek(repoId: string, name: string, rev: string | null): Promise<CodePeek>
  /** The code graph's state now; changes arrive as `codegraph` events. */
  codeGraphStatus(repoId: string): Promise<CodeGraphStatus>
  /** Throw the graph away and parse the repository again. */
  reindexCode(repoId: string): Promise<void>
  lfsInfo(repoId: string): Promise<LfsInfo>
  lfsInstall(repoId: string): Promise<void>
  /** Track (or stop tracking) a pattern with LFS: edits .gitattributes, undoable. */
  lfsTrack(repoId: string, pattern: string, track: boolean): Promise<UndoId>
  lfsPull(repoId: string): Promise<void>
  /** Network: asks the LFS server. */
  lfsLocks(repoId: string): Promise<LfsLock[]>
  lfsLock(repoId: string, path: string, lock: boolean, force?: boolean): Promise<void>
  /** Git commands GitGoose ran for this repository, newest first (only newer than `afterId`). */
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
  /** Rename a branch into a sidebar folder: `topic` into `feature` becomes `feature/topic`. Undoable. */
  renameBranchInto(repoId: string, branch: string, folder: string): Promise<UndoId>
  /** When this repository last fetched (unix seconds), or null: for the tracking badge's tooltip. */
  lastFetched(repoId: string): Promise<number | null>
  /** Branch names pinned to the top of the sidebar (git config gitgoose.pin, shared by worktrees). */
  pinnedBranches(repoId: string): Promise<string[]>
  /** Pin or unpin a branch; null when it already was (or was not). Undoable. */
  pinBranch(repoId: string, branch: string, pin: boolean): Promise<UndoId>
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
   * Cherry-pick commits (graph order) onto a branch that is not checked out, without checking it
   * out (merge-tree, git 2.40+). Refused, changing nothing, when they conflict. Undoable.
   */
  cherryPickOnto(repoId: string, branch: string, hashes: string[]): Promise<UndoId>
  /** Apply the change a commit (or stash: `stash`) made to these files to the working tree. Undoable. */
  applyFileFrom(repoId: string, rev: string, paths: string[], opts?: { stash?: boolean }): Promise<UndoId>
  /**
   * Replace a run of commits on the current branch with new ones (messages and unit ids from a
   * RecomposeProposal, oldest first). The branch ends at the same tree; one undo entry.
   */
  recomposeApply(repoId: string, hashes: string[], commits: { message: string; units: string[] }[]): Promise<UndoId>
  /** New message for a commit on the current branch. */
  rewordCommit(repoId: string, hash: string, message: string): Promise<UndoId>
  /** Fold a commit into the one below it: 'squash' keeps both messages, 'fixup' the lower one's. */
  squashCommit(repoId: string, hash: string, mode: 'squash' | 'fixup'): Promise<UndoId>
  /** Fold commits into `target` (drag onto), keeping all messages, or (`fixup`) only the target's. */
  squashOnto(repoId: string, hashes: string[], target: string, opts?: { fixup?: boolean }): Promise<UndoId>
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
  /** Pull HEAD's upstream, or with `remote` and `branch` that remote branch, into HEAD. */
  pull(repoId: string, opts?: { mode?: PullMode; remote?: string; branch?: string }): Promise<UndoId>
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
  /** Save the working tree (untracked files too) as a stash entry, leaving it untouched. */
  snapshotWorkTree(repoId: string, message?: string): Promise<UndoId>
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

export type ApiMethod = keyof GitGooseApi

/** The runtime list of method names. The type below fails to compile if it misses one. */
export const API_METHODS = [
  'getSettings', 'setSettings', 'pickDirectory', 'windowMinimize', 'windowToggleMaximize', 'windowClose', 'windowIsMaximized', 'windowSetOverlay', 'menuPopup', 'openRepo', 'closeRepo', 'initRepo', 'cloneRepo',
  'respondPrompt', 'openPath', 'openInEditor', 'openTerminal', 'revealPath', 'logError',
  'pullRequests', 'createPullRequest', 'checkoutPullRequest', 'openPullRequest',
  'aiStatus', 'aiConsent', 'aiModels', 'aiLoadModels', 'aiPromptPreview', 'aiRun', 'aiCancel', 'aiRespondPermission', 'aiAgentInfo', 'aiAuthenticate', 'aiSetApiKey',
  'aiThreadOpen', 'aiThreadSend', 'aiThreadCancel', 'aiThreadClose', 'aiThreads', 'aiThreadsStale', 'aiThreadResult', 'aiThreadDelete', 'aiThreadPermission', 'aiThreadArtifact', 'openExternal',
  'snapshot', 'logPage', 'commitDetails', 'diff', 'diffStream', 'fileHistory', 'blame', 'search', 'searchCommits', 'listFiles', 'stashList', 'reflog', 'setGraphFilter', 'submodules', 'updateSubmodules', 'syncSubmodules', 'addSubmodule', 'removeSubmodule', 'worktrees', 'addWorktree', 'removeWorktree', 'lockWorktree', 'pruneWorktrees',
  'lastCommitMessage',
  'stagePaths', 'unstagePaths', 'discardPaths', 'applySelection', 'ignorePaths', 'commit', 'codePeek', 'codeGraphStatus', 'reindexCode', 'impact', 'askThreads', 'saveAskThread', 'deleteAskThread', 'reviewLearnings', 'setReviewLearnings', 'linters', 'decideLinter', 'pushCheckPlan', 'pushCheckRules', 'setPushChecks', 'changeInsights', 'applySuggestion', 'writeFileChecked', 'workingText', 'lfsInfo', 'lfsInstall', 'lfsTrack', 'lfsPull', 'lfsLocks', 'lfsLock', 'commandLog', 'bisectMark', 'bisectReset', 'identity', 'setIdentity', 'commitTemplate', 'recentAuthors',
  'checkout', 'createBranch', 'renameBranch', 'renameBranchInto', 'lastFetched', 'pinnedBranches', 'pinBranch', 'deleteBranch', 'merge', 'rebase', 'reset',
  'cherryPick', 'cherryPickMany', 'cherryPickOnto', 'applyFileFrom', 'commitsText', 'recomposeApply', 'compareFiles', 'mergeBase', 'restoreFile', 'diffTool', 'mergeTool', 'imagePair', 'savePatches', 'pickPatch', 'applyPatch', 'openFileAt', 'saveFileAt', 'editableCommits', 'dropCommits', 'moveCommits', 'rewordCommit', 'squashCommit', 'squashOnto', 'fixupInto', 'preparedMessage', 'redo', 'redoList', 'revert', 'createTag', 'deleteTag',
  'fetch', 'pull', 'push', 'deleteRemoteBranch', 'remotes', 'addRemote', 'removeRemote', 'renameRemote', 'setRemoteUrl',
  'pushTags', 'deleteRemoteTag', 'remoteTags', 'setUpstream', 'fastForward', 'deleteBranches', 'mergedBranches',
  'stashPush', 'snapshotWorkTree', 'stashBranch', 'stashApply', 'stashPop', 'stashDrop',
  'conflicts', 'conflictVersions', 'resolveConflict', 'continueOperation', 'abortOperation',
  'undoList', 'undo',
] as const satisfies readonly ApiMethod[]

// Compile-time exhaustiveness: if a method is missing from API_METHODS, this resolves to the
// missing name instead of `never` and the assignment fails.
type Missing = Exclude<ApiMethod, (typeof API_METHODS)[number]>
const _exhaustive: [Missing] extends [never] ? true : Missing = true
void _exhaustive

/** Pushed from main to renderer. */
export type GitGooseEvent =
  | { type: 'snapshot'; snapshot: RepoSnapshot }
  /** Files changed on disk (sent even when the snapshot did not change, so open diffs reload). */
  | { type: 'worktree'; repoId: string }
  | { type: 'prompt'; promptId: number; repoId: string | null; message: string; secret: boolean }
  | { type: 'progress'; repoId: string; text: string | null }
  /** The code graph's state changed (indexing progress, ready, failed). */
  | { type: 'codegraph'; repoId: string; status: CodeGraphStatus }
  | { type: 'command'; name: string }
  /** The window was maximised, restored or changed full-screen state. */
  | { type: 'window-state'; maximized: boolean }
  /** Settings changed (from any window, or main): every window re-applies theme, fonts, scale. */
  | { type: 'settings'; settings: Settings }
  /** An AI request's reply so far. */
  | { type: 'ai-text'; requestId: string; text: string }
  /** The agent wants to use a tool: ask the user. */
  | { type: 'ai-permission'; request: AiPermissionRequest }
  /** A permission question no longer needs an answer (its request ended). */
  | { type: 'ai-permission-closed'; permissionId: number }
  /** One event of a conversation (see reduceThread): the renderer folds it into its copy. */
  | { type: 'ai-update'; threadId: string; requestId: string; update: AiUpdate }

/** Errors cross IPC as data, so the renderer gets git's stderr intact. */
export interface SerializedError {
  message: string
  stderr?: string
  command?: string
  code?: string
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: SerializedError }

export const IPC_INVOKE = 'gitgoose:invoke'
export const IPC_EVENT = 'gitgoose:event'
