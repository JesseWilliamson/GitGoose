import type { DiffTarget } from '@gitgoose/shared'
import type { OpenFile, RepoView, Selection } from './store'

/**
 * The file in Details (ADR-011). A file belongs to a selection: a commit's file to that commit, a
 * working-copy file to the working copy, a range to the comparison it is part of. Details shows
 * the open file only while it belongs to what is selected, and otherwise the selection's first
 * file. That one rule replaces "close the diff when the selection changes": nothing has to
 * remember to close it, and coming back to a commit finds the file you were reading.
 *
 * Pure; the action that opens a file is `openFile` in lib/actions.ts.
 */

/** Is `target` one of the files of `sel`? */
export function belongsTo(target: DiffTarget, sel: Selection): boolean {
  switch (target.kind) {
    case 'unstaged':
    case 'staged':
    case 'untracked':
      return sel.kind === 'wip'
    case 'commit':
      return (sel.kind === 'commit' && sel.hash === target.hash) || (sel.kind === 'commits' && sel.hashes.includes(target.hash))
    case 'range':
      // Several consecutive commits list one combined diff, a range ending at the newest of them.
      return (sel.kind === 'compare' && sel.from === target.from && sel.to === target.to) ||
        (sel.kind === 'commits' && target.to !== null && sel.hashes.includes(target.to))
  }
}

/** The selection to make so that `target` belongs to it: `sel` itself when it already does. */
export function ownerOf(target: DiffTarget, sel: Selection): Selection {
  if (belongsTo(target, sel)) return sel
  switch (target.kind) {
    case 'unstaged':
    case 'staged':
    case 'untracked':
      return { kind: 'wip' }
    case 'commit':
      return { kind: 'commit', hash: target.hash }
    case 'range':
      return { kind: 'compare', from: target.from, to: target.to, fromLabel: label(target.from), toLabel: target.to ? label(target.to) : 'working tree' }
  }
}

/** A revision as the comparison header names it: a hash shortened, a name (HEAD, main) as it is. */
const label = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 7) : rev)

/** The file Details shows: the open one if it belongs to the selection, else `fallback` (the selection's first file). */
export function shownFile(view: Pick<RepoView, 'file' | 'selected'>, fallback: DiffTarget | null): OpenFile | null {
  if (view.file && belongsTo(view.file.target, view.selected)) return view.file
  return fallback ? { target: fallback, mode: 'diff' } : null
}

/** Is `target` the file Details shows (for a file list's highlight)? */
export function isShown(view: Pick<RepoView, 'file' | 'selected'>, fallback: DiffTarget | null, target: DiffTarget): boolean {
  const f = shownFile(view, fallback)
  return !!f && sameTarget(f.target, target)
}

export function sameTarget(a: DiffTarget, b: DiffTarget): boolean {
  if (a.kind !== b.kind || a.path !== b.path) return false
  if (a.kind === 'commit' && b.kind === 'commit') return a.hash === b.hash
  if (a.kind === 'range' && b.kind === 'range') return a.from === b.from && a.to === b.to
  return true
}
