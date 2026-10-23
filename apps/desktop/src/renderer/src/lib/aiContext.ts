import type { AiContextRef } from '@gitgoose/shared'
import { useEffect } from 'react'
import { create } from 'zustand'
import type { DragSource } from './dnd'
import { getLog, type RepoView, type Selection } from './store'

/**
 * The AI panel's context chips. A chip is a reference (AiContextRef), never text: the renderer
 * does not read git for them. Main renders the references when the message is sent
 * (main/ai/context.ts), with the size cap, so this file is only bookkeeping:
 *
 *   - the **selection chip** follows `view.selected` by itself (nothing is stored for it, it is
 *     derived); the user can remove it, and it stays removed for as long as the selection stays
 *     the same, then comes back with the next selection;
 *   - **dropped chips** (commits, branches, tags, stashes, files dropped on the panel) are kept
 *     until the next message carries them.
 */

export type ChipKind = 'commit' | 'commits' | 'branch' | 'tag' | 'stash' | 'files' | 'wip' | 'compare'

export interface ContextChip {
  /** The reference as JSON: chips with the same key are the same chip. */
  key: string
  kind: ChipKind
  /** "commit a1b2c3d Fix the thing", "3 commits", "branch main", "uncommitted changes", "a1b2c3d..HEAD". */
  label: string
  /** Longer than the label when the label was shortened. */
  title: string
  ref: AiContextRef
  /** Made by the selection (× hides it until the selection changes) and not dropped. */
  fromSelection: boolean
}

interface PerRepo {
  dropped: AiContextRef[]
  /** The key of the selection chip the user removed, while that selection stays. */
  dismissed: string | null
}

const EMPTY: PerRepo = { dropped: [], dismissed: null }

export const useContextChips = create<Record<string, PerRepo>>(() => ({}))

const of = (id: string): PerRepo => useContextChips.getState()[id] ?? EMPTY
const set = (id: string, patch: Partial<PerRepo>) => useContextChips.setState((s) => ({ [id]: { ...(s[id] ?? EMPTY), ...patch } }) as Record<string, PerRepo>)

export const refKey = (ref: AiContextRef): string => JSON.stringify(ref)

/** The selection as a reference (null: nothing to attach). */
export function selectionRef(sel: Selection): AiContextRef | null {
  switch (sel.kind) {
    case 'commit': return { kind: 'commits', hashes: [sel.hash] }
    case 'commits': return sel.hashes.length ? { kind: 'commits', hashes: sel.hashes } : null
    case 'wip': return { kind: 'wip' }
    case 'compare': return { kind: 'compare', from: sel.from, to: sel.to }
  }
}

/** What a drag carries, as a reference. */
export function sourceRef(source: DragSource): AiContextRef {
  switch (source.kind) {
    case 'ref': return { kind: 'ref', name: source.ref.name }
    case 'commits': return { kind: 'commits', hashes: source.hashes }
    case 'stash': return { kind: 'stash', ref: source.ref, index: source.index }
    case 'files': return { kind: 'files', rev: source.rev, paths: source.paths }
  }
}

const short = (h: string) => h.slice(0, 7)
const shortName = (name: string) => name.replace(/^refs\/(heads|remotes|tags)\//, '')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A chip for a reference. `compareLabel` is the selection's own "a..b" (names, not hashes). */
export function chipOf(repoId: string, ref: AiContextRef, fromSelection = false, compareLabel?: string): ContextChip {
  const key = refKey(ref)
  const make = (kind: ChipKind, label: string, title = label): ContextChip => ({ key, kind, label, title, ref, fromSelection })
  switch (ref.kind) {
    case 'commits': {
      if (ref.hashes.length !== 1) return make('commits', `${ref.hashes.length} commits`, ref.hashes.map(short).join(' '))
      const log = getLog(repoId)
      const subject = log.commits[log.index.get(ref.hashes[0]!) ?? -1]?.subject ?? ''
      const full = `commit ${short(ref.hashes[0]!)}${subject ? ` ${subject}` : ''}`
      return make('commit', clip(full, 44), full)
    }
    case 'ref': {
      const tag = ref.name.startsWith('refs/tags/')
      return make(tag ? 'tag' : 'branch', `${tag ? 'tag' : 'branch'} ${shortName(ref.name)}`)
    }
    case 'stash': return make('stash', ref.ref)
    case 'files': {
      const one = ref.paths.length === 1
      const where = ref.rev === 'worktree' ? '' : ` at ${short(ref.rev)}`
      return make('files', one ? clip(ref.paths[0]!.split('/').at(-1)!, 30) : `${ref.paths.length} files`, `${ref.paths.join(', ')}${where}`)
    }
    case 'wip': return make('wip', 'uncommitted changes')
    case 'compare': {
      const label = compareLabel ?? `${short(ref.from)}..${ref.to ? short(ref.to) : 'working tree'}`
      return make('compare', clip(label, 30), label)
    }
  }
}

/** The chips on screen: the selection's (unless removed), then the dropped ones, each once. */
export function chipsOf(view: Pick<RepoView, 'id' | 'selected'>, state: PerRepo = of(view.id)): ContextChip[] {
  const out: ContextChip[] = []
  const seen = new Set<string>()
  const add = (c: ContextChip) => {
    if (seen.has(c.key)) return
    seen.add(c.key)
    out.push(c)
  }
  const sel = selectionRef(view.selected)
  if (sel && refKey(sel) !== state.dismissed) add(chipOf(view.id, sel, true, view.selected.kind === 'compare' ? `${view.selected.fromLabel}..${view.selected.toLabel}` : undefined))
  for (const ref of state.dropped) add(chipOf(view.id, ref))
  return out
}

/** The chips of a repository's AI panel, live. */
export function useChips(view: RepoView): ContextChip[] {
  const state = useContextChips((s) => s[view.id]) ?? EMPTY
  const sel = selectionRef(view.selected)
  const selKey = sel ? refKey(sel) : null
  // A removed selection chip stays removed only while the selection is the same one.
  useEffect(() => {
    if (state.dismissed && state.dismissed !== selKey) set(view.id, { dismissed: null })
  }, [view.id, state.dismissed, selKey])
  return chipsOf(view, state)
}

/** Something was dropped on the panel: it becomes a chip (the same thing twice is one chip). */
export function addDropped(repoId: string, source: DragSource): void {
  const ref = sourceRef(source)
  if (!of(repoId).dropped.some((r) => refKey(r) === refKey(ref))) set(repoId, { dropped: [...of(repoId).dropped, ref] })
}

/** The × on a chip. */
export function removeChip(repoId: string, chip: ContextChip): void {
  const state = of(repoId)
  set(repoId, {
    dropped: state.dropped.filter((r) => refKey(r) !== chip.key),
    ...(chip.fromSelection ? { dismissed: chip.key } : {}),
  })
}

/** A message went out with the chips: the dropped ones are used up, the selection's stays. */
export function clearDropped(repoId: string): void {
  if (of(repoId).dropped.length) set(repoId, { dropped: [] })
}
