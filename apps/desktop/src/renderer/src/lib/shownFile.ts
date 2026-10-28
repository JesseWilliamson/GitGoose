import type { DiffTarget } from '@gitgoose/shared'
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { shownFile } from './openFile'
import type { OpenFile, RepoView } from './store'

/**
 * The file on screen, wherever it is drawn: under the commit in Details, in the Diff pane, or wide
 * in the centre. Details knows the selection's first file (it has loaded the commit's file list)
 * and reports it here, per repository, so the Diff pane can show the same file without loading
 * anything twice.
 */
const useFirstFiles = create<Record<string, DiffTarget | null>>(() => ({}))

/** Details: this is the selection's first file (null: none, or not loaded yet). */
export function setFirstFile(repoId: string, first: DiffTarget | null): void {
  const now = useFirstFiles.getState()[repoId] ?? null
  if (JSON.stringify(now) !== JSON.stringify(first)) useFirstFiles.setState({ [repoId]: first })
}

/**
 * The first file waits until the selection has been still for a moment, so holding an arrow key
 * in the graph does not start a diff for every commit it passes; a file the user opened shows at once.
 */
export const FIRST_FILE_MS = 120

/** The file to show: the open one while it belongs to the selection, else the selection's first (lib/openFile.ts). */
export function useShownFile(view: RepoView): OpenFile | null {
  const first = useFirstFiles((s) => s[view.id] ?? null)
  return shownFile(view, useSettled(first, FIRST_FILE_MS))
}

/** `value` once it has stayed the same (by content) for `ms`; until then the previous settled value. */
function useSettled<T>(value: T, ms: number): T | null {
  const key = JSON.stringify(value)
  const [settled, setSettled] = useState<{ key: string; value: T } | null>(null)
  useEffect(() => {
    if (settled?.key === key) return
    const t = setTimeout(() => setSettled({ key, value }), ms)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by content: `value` is a new object every render
  }, [key, ms])
  return settled?.value ?? null
}
