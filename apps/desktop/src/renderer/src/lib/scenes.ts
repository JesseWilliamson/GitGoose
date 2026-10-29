import type { StreamAnchor } from './stream'
import type { BlockSpec } from './useStream'
import { getLog, updateRepo, useStore, type RepoView, type Selection } from './store'

/**
 * Scenes (ADR-012). A repository window has a few fixed screens, each designed for one job,
 * instead of panes to arrange: Browse (the graph with the commit and the branches beside it),
 * Read (the diff takes the screen, with a context column on its left), Changes (the working copy,
 * the same way), and Resolve, only while an operation is stopped on conflicts. One key switches
 * (1–4), and every scene keeps its own place: coming back lands on the same line.
 */
export type Scene = 'browse' | 'read' | 'changes' | 'resolve'
export const SCENES: Scene[] = ['browse', 'read', 'changes', 'resolve']
export const SCENE_TITLES: Record<Scene, string> = { browse: 'Browse', read: 'Read', changes: 'Changes', resolve: 'Resolve' }

/** What the reading scenes' left column shows: what is around the commit, or the AI conversation. */
export type Face = 'around' | 'ai'

export interface ReadState {
  /** A branch under review: its commits, oldest first. Null: Read reads the Browse selection. */
  range: { label: string; hashes: string[] } | null
  /**
   * A file seen another way instead of the stream: its blame at a revision (Y) or its history (H).
   * A commit picked there is read next, and the lens closes (archaeology, W5). D or Esc goes back.
   */
  lens: { mode: 'blame' | 'history'; path: string; rev?: string } | null
  face: Face
  /** Where each stream was left, by its blocks' keys. */
  anchors: Record<string, StreamAnchor>
}

export const NEW_READ: ReadState = { range: null, lens: null, face: 'around', anchors: {} }

/** Is the Resolve tab there (an operation stopped, or files left unmerged)? */
export function hasConflicts(v: Pick<RepoView, 'snapshot'>): boolean {
  return v.snapshot.status.some((e) => e.kind === 'unmerged')
}

export function setScene(id: string, scene: Scene): void {
  const v = useStore.getState().repos[id]
  if (!v || v.scene === scene) return
  if (scene === 'resolve' && !hasConflicts(v) && !v.snapshot.operation) return
  updateRepo(id, { scene, center: { kind: 'graph' } })
}

/** The blocks of the working copy: unstaged (with untracked files) and staged. */
export function workingBlocks(v: RepoView): BlockSpec[] {
  const st = v.snapshot.status
  const staged = st.some((e) => e.kind !== 'untracked' && e.kind !== 'unmerged' && e.index !== '.')
  return [
    { key: 'wip:unstaged', target: { kind: 'unstaged' }, title: 'Unstaged changes' },
    ...(staged ? [{ key: 'wip:staged', target: { kind: 'staged' } as const, title: 'Staged changes' }] : []),
  ]
}

/** What Read shows: the branch under review, else the selection (a commit, several, a comparison, the working copy). */
export function readBlocks(v: RepoView): BlockSpec[] {
  if (v.read.range) return v.read.range.hashes.map((h) => commitBlock(v, h))
  return selectionBlocks(v, v.selected)
}

export function selectionBlocks(v: RepoView, sel: Selection): BlockSpec[] {
  switch (sel.kind) {
    case 'wip': return workingBlocks(v)
    case 'commit': return [commitBlock(v, sel.hash)]
    // Several commits read oldest first, the order they were written in.
    case 'commits': return [...sel.hashes].reverse().map((h) => commitBlock(v, h))
    case 'compare': return [{ key: `range:${sel.from}..${sel.to ?? ''}`, target: { kind: 'range', from: sel.from, to: sel.to }, title: `${sel.fromLabel} → ${sel.toLabel}` }]
  }
}

function commitBlock(v: RepoView, hash: string): BlockSpec {
  const log = getLog(v.id)
  const c = log.commits[log.index.get(hash) ?? -1]
  return { key: `commit:${hash}`, target: { kind: 'commit', hash }, hash, title: c?.subject ?? hash.slice(0, 7) }
}

/** Read the selection (Space / Enter in Browse): the working copy reads in Changes. */
export function readSelection(id: string): void {
  const v = useStore.getState().repos[id]
  if (!v) return
  if (v.selected.kind === 'wip') return setScene(id, 'changes')
  updateRepo(id, { read: { ...v.read, range: null } })
  setScene(id, 'read')
}

/** Review a run of commits in Read, oldest first (R on a branch: what it has that its base has not). */
export function reviewCommits(id: string, label: string, newestFirst: string[]): void {
  const v = useStore.getState().repos[id]
  if (!v || !newestFirst.length) return
  updateRepo(id, { read: { ...v.read, range: { label, hashes: [...newestFirst].reverse() } }, scene: 'read', center: { kind: 'graph' } })
}

export function setLens(id: string, lens: ReadState['lens']): void {
  updateRepo(id, (v) => ({ read: { ...v.read, lens } }))
}

export function setFace(id: string, face: Face): void {
  const v = useStore.getState().repos[id]
  if (v && v.read.face !== face) updateRepo(id, { read: { ...v.read, face } })
}

export function toggleFolded(id: string): void {
  updateRepo(id, (v) => ({ folded: !v.folded }))
}

export function setViewed(id: string, key: string, viewed: boolean): void {
  updateRepo(id, (v) => {
    const next = new Set(v.viewed)
    if (viewed) next.add(key)
    else next.delete(key)
    return { viewed: next }
  })
}

/** Remember where a stream was left (by its blocks), so the scene comes back to it. */
export function saveAnchor(id: string, streamKey: string, a: StreamAnchor): void {
  const v = useStore.getState().repos[id]
  if (!v) return
  const was = v.read.anchors[streamKey]
  if (was && was.key === a.key && was.offset === a.offset) return
  // Not through updateRepo's render path on every scroll frame: the anchor is read only when a
  // stream mounts, so it is stored without asking anything to re-render.
  v.read.anchors[streamKey] = a
}
