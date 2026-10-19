/**
 * Branch and tag names as a folder tree on "/", the way the sidebar shows them:
 * `feature/login` and `feature/search` sit in a `feature` folder.
 *
 * Two steps, both pure. `buildTree` turns a list of items into folders and leaves once per change
 * of the refs; `flattenTree` turns the tree into the rows on screen, given which folders are
 * collapsed and what the filter box says. The sidebar virtualizes those rows, so a repository
 * with thousands of branches costs a walk of the tree per change, and DOM only for what shows.
 */

export interface TreeLeaf<T> {
  kind: 'leaf'
  /** The full name ("feature/login"). */
  path: string
  /** The last part ("login"). */
  name: string
  item: T
}

export interface TreeFolder<T> {
  kind: 'folder'
  /** "feature", or "feature/ui" for a folder inside a folder. */
  path: string
  name: string
  children: TreeNode<T>[]
  /** Leaves anywhere below, for the count beside the folder. */
  count: number
}

export type TreeNode<T> = TreeLeaf<T> | TreeFolder<T>

export interface BuildOptions {
  /**
   * Folders before the branches next to them (alphabetical lists, like Branches). Off keeps the
   * input order throughout, folders where their first item came (Tags: newest first).
   */
  foldersFirst?: boolean
}

/**
 * Items (in the order they should show) → a tree on "/". Order is kept: a folder sits where its
 * first item would have, and its children keep their order.
 */
export function buildTree<T>(items: readonly T[], nameOf: (item: T) => string, opts: BuildOptions = {}): TreeNode<T>[] {
  const root: TreeFolder<T> = { kind: 'folder', path: '', name: '', children: [], count: 0 }
  const folders = new Map<string, TreeFolder<T>>([['', root]])
  for (const item of items) {
    const full = nameOf(item)
    // Empty parts ("a//b", a trailing "/") are not folders git would make; keep them in the name.
    const parts = full.split('/')
    if (parts.some((p) => !p)) {
      root.children.push({ kind: 'leaf', path: full, name: full, item })
      root.count++
      continue
    }
    let parent = root
    parent.count++
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let f = folders.get(path)
      if (!f) {
        f = { kind: 'folder', path, name: parts[i]!, children: [], count: 0 }
        folders.set(path, f)
        parent.children.push(f)
      }
      f.count++
      parent = f
    }
    parent.children.push({ kind: 'leaf', path: full, name: parts[parts.length - 1]!, item })
  }
  if (opts.foldersFirst) sortFoldersFirst(root)
  return root.children
}

function sortFoldersFirst<T>(f: TreeFolder<T>): void {
  // A stable partition: folders keep their order among themselves, leaves theirs.
  f.children = [...f.children.filter((c) => c.kind === 'folder'), ...f.children.filter((c) => c.kind === 'leaf')]
  for (const c of f.children) if (c.kind === 'folder') sortFoldersFirst(c)
}

/** One row of a flattened tree. */
export type TreeRow<T> =
  | { kind: 'folder'; path: string; name: string; depth: number; count: number; open: boolean }
  | { kind: 'leaf'; path: string; label: string; depth: number; item: T }

export interface FlattenOptions {
  /** Whether a folder (by path) is open. */
  isOpen: (path: string) => boolean
  /**
   * The filter box. While it is not empty the tree is flat: every leaf whose full name contains
   * it (ignoring case), labelled with its full name, no folders. Clearing it brings the tree back
   * exactly as it was, because which folders are collapsed is not touched by filtering.
   */
  filter?: string
}

export function flattenTree<T>(nodes: readonly TreeNode<T>[], opts: FlattenOptions, out: TreeRow<T>[] = [], depth = 0): TreeRow<T>[] {
  const f = opts.filter?.trim().toLowerCase()
  if (f) {
    walkLeaves(nodes, (leaf) => {
      if (leaf.path.toLowerCase().includes(f)) out.push({ kind: 'leaf', path: leaf.path, label: leaf.path, depth, item: leaf.item })
    })
    return out
  }
  for (const n of nodes) {
    if (n.kind === 'leaf') {
      out.push({ kind: 'leaf', path: n.path, label: n.name, depth, item: n.item })
      continue
    }
    const open = opts.isOpen(n.path)
    out.push({ kind: 'folder', path: n.path, name: n.name, depth, count: n.count, open })
    if (open) flattenTree(n.children, { isOpen: opts.isOpen }, out, depth + 1)
  }
  return out
}

export function walkLeaves<T>(nodes: readonly TreeNode<T>[], visit: (leaf: TreeLeaf<T>) => void): void {
  for (const n of nodes) {
    if (n.kind === 'leaf') visit(n)
    else walkLeaves(n.children, visit)
  }
}

/** The folders a name sits in, outermost first: "a/b/c" → ["a", "a/b"]. To open them all (reveal). */
export function foldersOf(name: string): string[] {
  const parts = name.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}
