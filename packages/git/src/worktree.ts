import type { Worktree } from '@gitsquid/shared'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Parse `git worktree list --porcelain -z`: records separated by an empty entry, each a series of
 * "key value" entries (worktree, HEAD, branch, detached, bare, locked, prunable). The first
 * record is always the main working tree.
 */
export function parseWorktrees(out: string, currentPath: string): Worktree[] {
  const list: Worktree[] = []
  for (const rec of out.split('\0\0')) {
    if (!rec.trim()) continue
    const w: Worktree = { path: '', detached: false, main: list.length === 0, current: false }
    for (const line of rec.split('\0')) {
      const sp = line.indexOf(' ')
      const key = sp < 0 ? line : line.slice(0, sp)
      const value = sp < 0 ? '' : line.slice(sp + 1)
      if (key === 'worktree') w.path = value
      else if (key === 'HEAD') w.head = value
      else if (key === 'branch') w.branch = value.replace(/^refs\/heads\//, '')
      else if (key === 'detached') w.detached = true
      else if (key === 'locked') w.locked = value
      else if (key === 'prunable') w.prunable = value || 'its folder is gone'
    }
    if (!w.path) continue
    w.current = samePath(w.path, currentPath)
    list.push(w)
  }
  return list
}

/**
 * `p` with every symlink resolved, even when `p` does not exist yet: the nearest folder that
 * does exist is resolved and the rest appended. Git reports resolved paths, so compare against
 * this, not the path as typed (on macOS the temp folder /var is a link to /private/var).
 */
export async function realPathOf(p: string): Promise<string> {
  const rest: string[] = []
  for (let dir = resolve(p); ; ) {
    try {
      return join(await realpath(dir), ...rest)
    } catch {
      const up = dirname(dir)
      if (up === dir) return resolve(p)
      rest.unshift(basename(dir))
      dir = up
    }
  }
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' || process.platform === 'darwin' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}
