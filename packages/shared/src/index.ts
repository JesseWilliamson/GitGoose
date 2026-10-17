// Types shared by the main process (packages/git) and the renderer.
// Everything that crosses the IPC boundary is defined here, and only plain data crosses it:
// no classes, no functions, no Dates (dates are unix seconds). That keeps structured clone happy
// and makes every message easy to log and test.

export * from './api'
export * from './conflict-markers'
export * from './settings'
export * from './command'
export * from './avatars'
export * from './layout'
export * from './merge3'

/** A commit as the graph needs it. Bodies and file lists are fetched lazily (see CommitDetails). */
export interface Commit {
  hash: string
  parents: string[]
  authorName: string
  authorEmail: string
  /** Unix seconds. */
  authorDate: number
  /** Unix seconds. */
  commitDate: number
  subject: string
  /**
   * A stash shown in the graph: its only parent here is the commit it was made on (git also
   * records helper commits for the index and untracked files; the log hides those).
   */
  stash?: boolean
}

export interface CommitDetails extends Commit {
  body: string
  committerName: string
  committerEmail: string
  files: ChangedFile[]
}

export type RefKind = 'local' | 'remote' | 'tag' | 'stash'

export interface Ref {
  /** Full name, e.g. refs/heads/main. */
  name: string
  /** Display name, e.g. main or origin/main. */
  shortName: string
  kind: RefKind
  /** The commit the ref points at (tags are peeled to their commit). */
  hash: string
  /** Full name of the upstream, for local branches that track one. */
  upstream?: string
  ahead?: number
  behind?: number
  /** True when the upstream is configured but no longer exists on the remote. */
  upstreamGone?: boolean
  /** Unix seconds of the tip commit (branches; tags with a commit date). */
  date?: number
}

export interface Head {
  /** Short branch name, or undefined when detached or unborn. */
  branch?: string
  /** Commit HEAD points at, or undefined for an unborn branch (fresh repo). */
  hash?: string
  detached: boolean
}

/** What a repository is in the middle of, read from files under .git. */
/** `am`: applying mailed patches (`git am`), stopped on a conflict. */
export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am' | null

/** One file in `git status`. Codes follow porcelain v2: '.', M, T, A, D, R, C, U. */
export interface StatusEntry {
  path: string
  /** Original path for renames and copies. */
  origPath?: string
  /** Status in the index relative to HEAD. */
  index: string
  /** Status in the working tree relative to the index. */
  worktree: string
  kind: 'changed' | 'renamed' | 'unmerged' | 'untracked'
}

export interface RepoSnapshot {
  id: string
  path: string
  name: string
  head: Head
  refs: Ref[]
  status: StatusEntry[]
  operation: RepoOperation
  /** Bumped whenever refs change, so the renderer knows to reload the log. */
  refsVersion: number
}

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'unmerged'

export interface ChangedFile {
  path: string
  oldPath?: string
  change: ChangeKind
  additions: number
  deletions: number
  binary: boolean
}

export interface DiffLine {
  /** ' ' context, '+' added, '-' removed. */
  kind: ' ' | '+' | '-'
  text: string
  oldNo?: number
  newNo?: number
  /** True when the line is followed by "\ No newline at end of file". */
  noNewline?: boolean
}

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Text after the second @@, usually the enclosing function. */
  section: string
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  oldPath?: string
  change: ChangeKind
  binary: boolean
  /** Raw header lines (diff --git, index, ---, +++ ...) needed to rebuild a patch. */
  header: string[]
  hunks: Hunk[]
}

/** Which diff to show. */
export type DiffTarget =
  | { kind: 'unstaged'; path: string }
  | { kind: 'staged'; path: string }
  | { kind: 'untracked'; path: string }
  | { kind: 'commit'; hash: string; path: string }
  /** Between two revisions, or a revision and the working tree (`to: null`). */
  | { kind: 'range'; from: string; to: string | null; path: string; oldPath?: string }

export interface Remote {
  name: string
  fetchUrl: string
  /** Only when it differs from the fetch URL (remote.<name>.pushurl). */
  pushUrl?: string
}

export interface Worktree {
  path: string
  /** The commit checked out there (absent for a bare main repository). */
  head?: string
  /** Short branch name, when a branch is checked out there. */
  branch?: string
  detached: boolean
  /** The repository's main working tree (it cannot be removed). */
  main: boolean
  /** The one this tab is showing. */
  current: boolean
  /** Locked against pruning (a removable drive, say); the reason, or '' when none was given. */
  locked?: string
  /** Its folder is gone: `worktree prune` will forget it. */
  prunable?: string
}

/** One move of a ref, newest first (`git log -g`). */
export interface ReflogEntry {
  /** The n in HEAD@{n}. */
  index: number
  hash: string
  /** When the ref moved (unix seconds), not when the commit was made. */
  date: number
  /** What moved it: commit, checkout, reset, rebase (finish), merge main, pull, … */
  action: string
  /** The rest of git's reflog message ("moving from main to topic"). */
  message: string
  /** The subject of the commit the ref moved to. */
  subject: string
  /** Reachable from no branch, tag or HEAD: only the reflog still knows it. */
  lost?: boolean
  /** The branch whose tip this was when HEAD moved away from it (a name to restore it under). */
  branchHint?: string
}

export interface StashEntry {
  index: number
  /** stash@{n} */
  ref: string
  hash: string
  message: string
  date: number
}

export interface BlameLine {
  hash: string
  author: string
  date: number
  summary: string
  lineNo: number
  text: string
}

export interface ConflictFile {
  path: string
  /** Porcelain v2 XY code, e.g. UU, AA, DU. */
  code: string
  /** Number of conflict blocks in the working tree file (0 for delete/modify conflicts). */
  blocks: number
}

export interface UndoEntry {
  id: number
  label: string
  /** Unix ms. */
  time: number
}

/** 'all': message, author, SHA, branch and tag names at once (the default, GitKraken-style). */
export type SearchField = 'all' | 'message' | 'author' | 'path' | 'hash' | 'content'

export * from './github'
export * from './ai'
