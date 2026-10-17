/**
 * Changed files as a folder tree. Pure, so it is unit-tested; FileListView draws the rows.
 *
 * Folders with a single subfolder and no files of their own are merged into one row
 * ("src/renderer/lib"), as editors do, so deep paths do not cost a row per level.
 */
export type TreeRow =
  | { kind: 'dir'; path: string; name: string; depth: number; files: string[] }
  | { kind: 'file'; path: string; name: string; depth: number }

interface Dir {
  dirs: Map<string, Dir>
  files: string[]
}

export function treeRows(paths: string[], collapsed: ReadonlySet<string> = new Set()): TreeRow[] {
  const root: Dir = { dirs: new Map(), files: [] }
  for (const p of paths) {
    const parts = p.split('/')
    let d = root
    for (const part of parts.slice(0, -1)) {
      let next = d.dirs.get(part)
      if (!next) d.dirs.set(part, (next = { dirs: new Map(), files: [] }))
      d = next
    }
    d.files.push(p)
  }
  const all = (d: Dir): string[] => [...d.files, ...[...d.dirs.values()].flatMap(all)]
  const rows: TreeRow[] = []
  const walk = (d: Dir, prefix: string, depth: number) => {
    for (const name of [...d.dirs.keys()].sort(byName)) {
      let dir = d.dirs.get(name)!
      let label = name
      // Merge chains of folders that only hold one folder.
      while (dir.files.length === 0 && dir.dirs.size === 1) {
        const [childName, child] = [...dir.dirs.entries()][0]!
        label += `/${childName}`
        dir = child
      }
      const path = prefix + label
      rows.push({ kind: 'dir', path, name: label, depth, files: all(dir) })
      if (!collapsed.has(path)) walk(dir, `${path}/`, depth + 1)
    }
    for (const f of [...d.files].sort((a, b) => byName(baseName(a), baseName(b)))) rows.push({ kind: 'file', path: f, name: baseName(f), depth })
  }
  walk(root, '', 0)
  return rows
}

/** Every space-separated word must appear in the path (case-insensitive). */
export function matchesFilter(path: string, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const p = path.toLowerCase()
  return words.every((w) => p.includes(w))
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
