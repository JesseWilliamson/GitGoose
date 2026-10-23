import type { LfsInfo, PullRequest, PullRequestList, Ref, StashEntry, Submodule, Worktree } from '@gitgoose/shared'
import { buildTree, flattenTree, type TreeNode } from './refTree'

/**
 * Tower's sidebar as one flat list of rows: section headers, Workspace items, folders, branches,
 * remotes, tags, stashes and the rest, in screen order, with what is collapsed left out.
 *
 * Pure, so it can be tested without a DOM, and flat, so the sidebar can virtualize it: a
 * repository with thousands of branches and tags makes thousands of small row objects when the
 * refs change (or a folder opens), and DOM for the forty or so rows on screen.
 */

export type SectionId = 'workspace' | 'pinned' | 'branches' | 'remotes' | 'tags' | 'submodules' | 'worktrees' | 'lfs'
export type WorkspaceItem = 'working-copy' | 'history' | 'stashes' | 'pulls' | 'reflog'
/** Which tree a folder or ref row belongs to (a remote's tree is named by the remote). */
export type RefSection = 'pinned' | 'branches' | 'tags' | { remote: string }

export type SidebarRow =
  | { kind: 'header'; key: string; depth: 0; section: SectionId; title: string; count: number; open: boolean }
  | { kind: 'workspace'; key: string; depth: 1; item: WorkspaceItem; count?: number; open?: boolean }
  | { kind: 'folder'; key: string; depth: number; section: RefSection; path: string; name: string; count: number; open: boolean }
  | { kind: 'ref'; key: string; depth: number; section: RefSection; ref: Ref; label: string }
  | { kind: 'remote'; key: string; depth: 1; remote: string; count: number; open: boolean }
  | { kind: 'stash'; key: string; depth: 2; stash: StashEntry }
  | { kind: 'pull'; key: string; depth: 2; pull: PullRequest }
  | { kind: 'worktree'; key: string; depth: 1; worktree: Worktree }
  | { kind: 'submodule'; key: string; depth: 1; submodule: Submodule }
  | { kind: 'lfs-setup'; key: string; depth: 1 }
  | { kind: 'lfs-pattern'; key: string; depth: 1; pattern: LfsInfo['patterns'][number] }
  | { kind: 'lfs-missing'; key: string; depth: 1; count: number }
  /** "120 older tags · Show all" under a shortened tag list. */
  | { kind: 'more-tags'; key: string; depth: 1; hidden: number }
  /** A note in place of an empty list ("No stashes", "Not fetched yet"). `for`: what is empty. */
  | { kind: 'empty'; key: string; depth: number; text: string; for: string }

/** Header rows are a little taller than the rest. Every row has a fixed height, so the virtualizer never measures. */
export const ROW_HEIGHT = 24
export const HEADER_HEIGHT = 28
export const rowHeight = (r: SidebarRow) => (r.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT)

export interface SidebarInput {
  refs: readonly Ref[]
  headBranch?: string
  /** Pinned branch names, in pin order. */
  pins: readonly string[]
  /** Remote names, configured ones first. */
  remotes: readonly string[]
  stashes: readonly StashEntry[]
  hasGitHub: boolean
  pulls: PullRequestList | null
  pullsLoading: boolean
  worktrees: readonly Worktree[]
  submodules: readonly Submodule[]
  lfs: LfsInfo | null
  /** Group names with "/" in folders. */
  folders: boolean
  /** How many tags (newest first) to list when not filtering. */
  tagLimit: number
  /** The filter box: flattens and narrows Pinned, Branches, Remotes and Tags. */
  filter: string
  showReflog: boolean
  isOpen: (key: string) => boolean
}

/**
 * Whether a section, folder or remote starts open (the user's own choice, stored per repository,
 * wins). Tags, LFS, remotes' contents and the pull request list start closed: they are long, or
 * cost a network call. Worktrees start open only when there is more than this one.
 */
export function defaultOpen(key: string, worktrees: number): boolean {
  if (key === 'section:tags' || key === 'section:lfs' || key === 'ws:pulls' || key.startsWith('remote:')) return false
  if (key === 'section:worktrees') return worktrees > 1
  return true
}

/** The key a folder's open state is stored under. */
export function folderKey(section: RefSection, path: string): string {
  return `folder:${typeof section === 'string' ? section : `remote/${section.remote}`}:${path}`
}

export function refKey(section: RefSection, ref: Ref): string {
  return `ref:${typeof section === 'string' ? section : 'remote'}:${ref.name}`
}

function tagTime(r: Ref): number {
  return r.date ?? 0
}

export function sidebarRows(input: SidebarInput): SidebarRow[] {
  const out: SidebarRow[] = []
  const f = input.filter.trim()
  const filtering = !!f
  // While filtering, the ref sections show what matches even if collapsed: that is what the filter is for.
  const open = (key: string) => input.isOpen(key)
  const openRefs = (key: string) => filtering || input.isOpen(key)
  const header = (section: SectionId, title: string, count: number, isOpen: boolean) => {
    out.push({ kind: 'header', key: `section:${section}`, depth: 0, section, title, count, open: isOpen })
    return isOpen
  }
  const tree = (section: RefSection, nodes: TreeNode<Ref>[], depth: number) => {
    for (const row of flattenTree(nodes, { isOpen: (p) => input.isOpen(folderKey(section, p)), filter: f })) {
      if (row.kind === 'folder') out.push({ kind: 'folder', key: folderKey(section, row.path), depth: depth + row.depth, section, path: row.path, name: row.name, count: row.count, open: row.open })
      else out.push({ kind: 'ref', key: refKey(section, row.item), depth: depth + row.depth, section, ref: row.item, label: row.label })
    }
  }
  const treeOf = (refs: readonly Ref[], nameOf: (r: Ref) => string, foldersFirst: boolean): TreeNode<Ref>[] =>
    input.folders ? buildTree(refs, nameOf, { foldersFirst }) : refs.map((r) => ({ kind: 'leaf', path: nameOf(r), name: nameOf(r), item: r }))
  const matches = (name: string) => !filtering || name.toLowerCase().includes(f.toLowerCase())

  // ---- Workspace
  if (header('workspace', 'Workspace', 0, open('section:workspace'))) {
    out.push({ kind: 'workspace', key: 'ws:working-copy', depth: 1, item: 'working-copy' })
    out.push({ kind: 'workspace', key: 'ws:history', depth: 1, item: 'history' })
    const stashesOpen = open('ws:stashes')
    out.push({ kind: 'workspace', key: 'ws:stashes', depth: 1, item: 'stashes', count: input.stashes.length, open: stashesOpen })
    if (stashesOpen) {
      for (const s of input.stashes) out.push({ kind: 'stash', key: `stash:${s.hash}`, depth: 2, stash: s })
      if (!input.stashes.length) out.push({ kind: 'empty', key: 'empty:stashes', depth: 2, text: 'No stashes', for: 'stashes' })
    }
    if (input.hasGitHub) {
      const pullsOpen = open('ws:pulls')
      const list = input.pulls?.state === 'ok' ? input.pulls.pulls : []
      out.push({ kind: 'workspace', key: 'ws:pulls', depth: 1, item: 'pulls', count: list.length, open: pullsOpen })
      if (pullsOpen) {
        if (input.pullsLoading && !input.pulls) out.push({ kind: 'empty', key: 'empty:pulls', depth: 2, text: 'Asking GitHub…', for: 'pulls' })
        else if (input.pulls?.state === 'ok' && !list.length) out.push({ kind: 'empty', key: 'empty:pulls', depth: 2, text: 'No open pull requests', for: 'pulls' })
        for (const p of list) out.push({ kind: 'pull', key: `pull:${p.number}`, depth: 2, pull: p })
      }
    }
    if (input.showReflog) out.push({ kind: 'workspace', key: 'ws:reflog', depth: 1, item: 'reflog' })
  }

  // ---- Pinned: local branches, in the order they were pinned, never in folders (they are few).
  const byName = new Map(input.refs.filter((r) => r.kind === 'local').map((r) => [r.shortName, r]))
  const pinned = input.pins.map((n) => byName.get(n)).filter((r): r is Ref => !!r && matches(r.shortName))
  if (header('pinned', 'Pinned', pinned.length, openRefs('section:pinned'))) {
    for (const r of pinned) out.push({ kind: 'ref', key: refKey('pinned', r), depth: 1, section: 'pinned', ref: r, label: r.shortName })
    // Nothing pinned: just the header (the sidebar says "Drop to pin" in it while a branch is dragged).
  }

  // ---- Branches
  const locals = input.refs.filter((r) => r.kind === 'local')
  const localCount = filtering ? locals.filter((r) => matches(r.shortName)).length : locals.length
  if (header('branches', 'Branches', localCount, openRefs('section:branches'))) {
    tree('branches', treeOf(locals, (r) => r.shortName, true), 1)
    if (!locals.length && !filtering) out.push({ kind: 'empty', key: 'empty:branches', depth: 1, text: 'No branches yet', for: 'branches' })
  }

  // ---- Remotes: one node per remote, each a tree of its branches.
  const byRemote = new Map<string, Ref[]>(input.remotes.map((n) => [n, []]))
  for (const r of input.refs) {
    if (r.kind !== 'remote') continue
    const name = r.shortName.slice(0, r.shortName.indexOf('/'))
    byRemote.get(name)?.push(r)
  }
  if (header('remotes', 'Remotes', byRemote.size, open('section:remotes') || filtering)) {
    for (const [remote, refs] of byRemote) {
      const shown = refs.filter((r) => matches(r.shortName.slice(remote.length + 1)))
      if (filtering && !shown.length) continue
      const key = `remote:${remote}`
      const isOpen = filtering || open(key)
      out.push({ kind: 'remote', key, depth: 1, remote, count: filtering ? shown.length : refs.length, open: isOpen })
      if (!isOpen) continue
      tree({ remote }, treeOf(refs, (r) => r.shortName.slice(remote.length + 1), true), 2)
      if (!refs.length) out.push({ kind: 'empty', key: `empty:remote:${remote}`, depth: 2, text: 'Not fetched yet', for: `remote:${remote}` })
    }
    if (!byRemote.size && !filtering) out.push({ kind: 'empty', key: 'empty:remotes', depth: 1, text: 'No remotes', for: 'remotes' })
  }

  // ---- Tags: newest first; long lists shortened unless filtering (the filter searches them all).
  const tags = input.refs.filter((r) => r.kind === 'tag').map((r, i) => ({ r, i }))
    .sort((a, b) => tagTime(b.r) - tagTime(a.r) || b.i - a.i).map((x) => x.r)
  const tagsShown = filtering ? tags.filter((r) => matches(r.shortName)) : tags.slice(0, input.tagLimit)
  if (header('tags', 'Tags', filtering ? tagsShown.length : tags.length, openRefs('section:tags'))) {
    tree('tags', treeOf(tagsShown, (r) => r.shortName, false), 1)
    if (!filtering && tags.length > tagsShown.length) out.push({ kind: 'more-tags', key: 'more-tags', depth: 1, hidden: tags.length - tagsShown.length })
    if (!tags.length) out.push({ kind: 'empty', key: 'empty:tags', depth: 1, text: 'No tags', for: 'tags' })
  }

  // ---- Submodules, Worktrees, Git LFS: as before, only when there is something to show.
  if (input.submodules.length && header('submodules', 'Submodules', input.submodules.length, open('section:submodules'))) {
    for (const m of input.submodules) out.push({ kind: 'submodule', key: `submodule:${m.path}`, depth: 1, submodule: m })
  }
  if (header('worktrees', 'Worktrees', input.worktrees.length, open('section:worktrees'))) {
    for (const w of input.worktrees) out.push({ kind: 'worktree', key: `worktree:${w.path}`, depth: 1, worktree: w })
  }
  const lfs = input.lfs
  if (lfs?.used && header('lfs', 'Git LFS', lfs.files.length, open('section:lfs'))) {
    if (!lfs.ready) out.push({ kind: 'lfs-setup', key: 'lfs-setup', depth: 1 })
    for (const p of lfs.patterns) out.push({ kind: 'lfs-pattern', key: `lfs:${p.pattern}`, depth: 1, pattern: p })
    const missing = lfs.files.filter((x) => !x.downloaded).length
    if (missing) out.push({ kind: 'lfs-missing', key: 'lfs-missing', depth: 1, count: missing })
  }
  return out
}

/** The rows the keyboard can stop on (notes and empty-list text are skipped). */
export function focusable(r: SidebarRow): boolean {
  return r.kind !== 'empty' && r.kind !== 'lfs-missing'
}

/** Rows that open and close (headers, folders, remotes, and the Stashes and Pull Requests items). */
export function openKeyOf(r: SidebarRow): string | null {
  if (r.kind === 'header' || r.kind === 'folder' || r.kind === 'remote') return r.key
  if (r.kind === 'workspace' && r.open !== undefined) return r.key
  return null
}

/** The row a ← from row `i` goes to: the nearest row above with less depth (its folder, remote or section). */
export function parentIndex(rows: readonly SidebarRow[], i: number): number {
  const d = rows[i]?.depth ?? 0
  for (let j = i - 1; j >= 0; j--) if (rows[j]!.depth < d) return j
  return -1
}
