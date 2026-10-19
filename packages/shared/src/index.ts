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
export * from './version'

/** A commit as the graph needs it. Bodies and file lists are fetched lazily (see CommitDetails). */
/** Enough of a commit to show it in a list of results. */
export type CommitSummary = Pick<Commit, 'hash' | 'subject' | 'authorName' | 'authorEmail' | 'authorDate'>

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
  /**
   * Co-authors from `Co-authored-by:` trailers, in the order they appear, excluding the author
   * themselves. Absent (not an empty array) on the ordinary single-author commit, which is most
   * of them: the log holds every commit in the repository, so an empty array per commit is a
   * cost worth avoiding.
   */
  coAuthors?: Person[]
}

export interface CommitDetails extends Commit {
  body: string
  committerName: string
  committerEmail: string
  files: ChangedFile[]
  /** Present when the commit is signed (GPG, SSH or X.509). */
  signature?: Signature
}

/**
 * git's verdict on a signature (%G?): G good, U good but the key is not trusted, X expired
 * signature, Y expired key, R revoked key, B bad (the commit was changed after signing), E
 * cannot be checked (no key, or no gpg / allowed signers file).
 */
export interface Signature {
  status: 'G' | 'U' | 'X' | 'Y' | 'R' | 'B' | 'E'
  signer?: string
  key?: string
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

/**
 * The order the graph lists commits in (Settings → Graph → Commit order). Both put every child
 * above its parents. Date: newest commit date first, branches interleaved by time. Topological:
 * each branch's commits kept together, so dates run out of order.
 */
export type CommitOrder = 'date' | 'topo'

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
  /** Hidden and soloed refs for this repository's graph. */
  filter: GraphFilter
  /**
   * The main line's refs (full names) that the graph shows: the remote's default branch and its
   * local namesake, else main or master. The graph keeps them in the leftmost lane.
   */
  trunk: string[]
  /** Set while a bisect is running. */
  bisect?: BisectState
  /** The order the log (and search over it) lists commits in. */
  order: CommitOrder
  /** What git knows about the history's shape that the streaming graph layout cannot see in time. */
  graph: SnapshotGraph
}

export interface SnapshotGraph {
  /** Branch tips that sit straight on top of the trunk or of HEAD, so they can continue its lane. */
  straight: StraightTips
}

/**
 * Tips (commit hashes) whose first-parent chain runs down to the trunk tip (`overTrunk`) or to
 * HEAD (`overHead`). Empty when git is older than 2.41 (no `%(ahead-behind)`), with no trunk, or
 * with no HEAD commit. See ADR-003, "A branch on top of a reserved line continues it".
 */
export interface StraightTips {
  overTrunk: string[]
  overHead: string[]
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

/** One side of an image diff: the bytes, unless the file is over the size cap. */
export interface ImageSide {
  size: number
  data?: Uint8Array
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

/** A `git bisect` in progress: what has been marked, and how far the search has narrowed. */
export interface BisectState {
  bad?: string
  good: string[]
  skipped: string[]
  /** Commits still to test after the checked-out one, and about how many more steps (once there is a good and a bad). */
  remaining?: number
  steps?: number
  /** The first bad commit, once the search is over. */
  found?: string
}

/**
 * Which refs the graph walks. `hidden`: full ref names (or a remote's "refs/remotes/<name>/*")
 * left out; `solo`: when not empty, only these (and HEAD) are shown.
 */
export interface GraphFilter {
  hidden: string[]
  solo: string[]
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

/** History's view of the uncommitted change: forgotten companions, and whose lines it changes. */
export interface ChangeInsights {
  /** Files that usually change with a changed file but are not in this change. */
  coChange: { path: string; with: string; together: number; total: number }[]
  /** Authors of the lines being changed or removed, most lines first. */
  owners: { name: string; lines: number }[]
}

/** The state of a repository's code graph (ADR-008): what Peek and Impact wait for. */
export interface CodeGraphStatus {
  state: 'off' | 'indexing' | 'ready' | 'error'
  /** Files parsed so far, and to parse, in the sync under way. */
  done: number
  total: number
  /** Why it failed, when state is 'error'. */
  message?: string
}

/** Code Peek: where a name is defined and used, at a revision or in the working tree. */
export interface CodePeek {
  name: string
  definitions: { path: string; line: number; endLine: number; kind: string; signature: string; preview: string[] }[]
  references: { path: string; line: number; column: number; text: string }[]
  /** More matches than were read (a very common name). */
  truncated: boolean
}

/** Git LFS in this repository. */
export interface LfsInfo {
  /** git-lfs is installed (`git lfs version` works). */
  installed: boolean
  version?: string
  /** .gitattributes routes some files through LFS. */
  used: boolean
  /** The LFS filter is configured (git lfs install); without it LFS files stay pointers. */
  ready: boolean
  patterns: { pattern: string; source: string; lockable: boolean }[]
  files: { path: string; size: number; downloaded: boolean }[]
}

export interface LfsLock {
  id: string
  path: string
  owner: string
  lockedAt: string
}

/** One git process GitGoose ran (the command log). */
export interface CommandRecord {
  id: number
  /** git's arguments as GitGoose passed them (credentials in URLs masked). */
  args: string[]
  /** Started at (ms since the epoch). */
  start: number
  /** null while it is still running (the log stream, cat-file). */
  durationMs: number | null
  code: number | null
  /** The end of what it wrote to stderr. */
  stderr: string
  /** Only reads (passed --no-optional-locks). */
  readOnly: boolean
}

/** Who commits are made as, and where that comes from. */
export interface Identity {
  name?: string
  email?: string
  /** Where the effective values are set: this repository, the user's global config, or nowhere. */
  scope: 'local' | 'global' | null
  global: { name?: string; email?: string }
}

export interface Person {
  name: string
  email: string
}

export interface Submodule {
  name: string
  path: string
  url: string
  /** The commit the superproject records for it (in the index). */
  recorded?: string
  /** The commit checked out in it; absent until it is initialized and cloned. */
  checkedOut?: string
  /** It has uncommitted changes of its own. */
  dirty: boolean
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

/** 'all': message, author, SHA, branch and tag names at once (the default). */
export type SearchField = 'all' | 'message' | 'author' | 'path' | 'hash' | 'content'

export * from './github'
export * from './ai'
export * from './thread'
