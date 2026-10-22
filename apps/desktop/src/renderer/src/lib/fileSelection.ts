/**
 * Selecting several files in a list of changes, the way every file manager does: a click picks
 * one file, Shift-click picks the run from the anchor (the last file clicked without Shift) to
 * here, Ctrl/Cmd-click adds or removes one file. `order` is the list as it is shown (flat or
 * tree, filtered, folders collapsed), because a range means "the rows between", not "the paths
 * between" alphabetically.
 */
export interface FileSelection {
  /** Selected paths, in `order`'s order. */
  paths: string[]
  /** Where the next Shift-click range starts. */
  anchor: string | null
}

export const NO_FILES: FileSelection = { paths: [], anchor: null }

export function clickFile(sel: FileSelection, order: readonly string[], path: string, mods: { range?: boolean; toggle?: boolean } = {}): FileSelection {
  if (mods.range && sel.anchor !== null) {
    const a = order.indexOf(sel.anchor)
    const b = order.indexOf(path)
    if (a >= 0 && b >= 0) return { paths: order.slice(Math.min(a, b), Math.max(a, b) + 1), anchor: sel.anchor }
  }
  if (mods.toggle) {
    const set = new Set(sel.paths)
    if (set.has(path)) set.delete(path)
    else set.add(path)
    return { paths: order.filter((p) => set.has(p)), anchor: path }
  }
  return { paths: [path], anchor: path }
}

/** Drop paths that are no longer listed (staged, discarded, committed). */
export function pruneFiles(sel: FileSelection, present: readonly string[]): FileSelection {
  const have = new Set(present)
  const paths = sel.paths.filter((p) => have.has(p))
  const anchor = sel.anchor !== null && have.has(sel.anchor) ? sel.anchor : null
  return paths.length === sel.paths.length && anchor === sel.anchor ? sel : { paths, anchor }
}

/**
 * What an action on one row acts on: the whole selection when the row is part of a selection
 * of several, otherwise just that row (as in the graph's commit menu).
 */
export function actOn(sel: FileSelection, path: string): string[] {
  return sel.paths.length > 1 && sel.paths.includes(path) ? sel.paths : [path]
}
